//! SFTP 파일 전송. SSH 셸 세션과 별개로, SFTP 브라우저 전용 연결을 따로 맺는다
//! (host/port/user/password 재사용). russh-sftp 로 subsystem "sftp" 를 연다.
//! API 경로는 독립 크레이트 cargo build 로 검증됨.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, Handle};
use russh::keys::ssh_key;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use std::sync::Arc as StdArc;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// SFTP 연결 하나. Handle 을 함께 보관해 연결이 조기 종료되지 않게 유지.
pub struct SftpConn {
    sftp: SftpSession,
    _handle: Handle<Client>,
    /// 이 서버의 파일명 문자셋(None = UTF-8). 세션 설정(charset)을 그대로 쓴다.
    encoding: Option<&'static encoding_rs::Encoding>,
}

// ── 파일명 문자셋 변환 ────────────────────────────────────────────────────────
// SFTP v3 는 파일명 인코딩을 규정하지 않는다 = 서버가 쓰는 바이트 그대로다. 동봉한
// russh-sftp 사본은 와이어 바이트를 코드포인트 하나당 한 바이트로 무손실 전달하므로
// (vendor/russh-sftp/PATCH.md), 여기서 세션 문자셋으로 해석·인코딩한다.
// UTF-8 세션은 두 함수가 항등이라 기존 동작과 완전히 같다.

/// 와이어 문자열(바이트 보존) → 화면·프런트용 UTF-8 문자열.
fn wire_to_text(s: &str, enc: Option<&'static encoding_rs::Encoding>) -> String {
    let bytes: Vec<u8> = s.chars().map(|c| c as u32 as u8).collect();
    match enc {
        Some(e) => e.decode_without_bom_handling(&bytes).0.into_owned(),
        None => String::from_utf8_lossy(&bytes).into_owned(),
    }
}

/// 프런트가 준 UTF-8 문자열 → 와이어 문자열(바이트 보존).
fn text_to_wire(s: &str, enc: Option<&'static encoding_rs::Encoding>) -> String {
    let bytes: Vec<u8> = match enc {
        Some(e) => e.encode(s).0.into_owned(),
        None => s.as_bytes().to_vec(),
    };
    bytes.into_iter().map(|b| b as char).collect()
}

pub type SftpMap = Mutex<HashMap<String, Arc<SftpConn>>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// 수정 시각(unix 초, 없으면 0).
    pub modified: u32,
    /// 심볼릭 링크 여부. READDIR 은 lstat 기준이라 링크는 링크로 온다 — 즉 디렉터리를
    /// 가리키는 링크도 `is_dir` 은 false 다. 목록에서 색으로만 구분하고 취급은 바꾸지 않는다.
    pub is_symlink: bool,
}

/// 셸 세션과 완전히 같은 호스트키 검증을 적용한다(첫 접속은 지문 확인 후에만 수락).
struct Client {
    app: AppHandle,
    host: String,
    port: u16,
    /// 호스트키 문제로 끊었음을 connect() 에 알리는 플래그(오류 메시지 구분용).
    refused: Arc<AtomicBool>,
}

impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(&mut self, pk: &ssh_key::PublicKey) -> Result<bool, Self::Error> {
        match crate::hostkey::check(&self.app, &self.host, self.port, pk).await {
            crate::hostkey::Decision::Accept => Ok(true),
            _ => {
                self.refused.store(true, Ordering::SeqCst);
                Ok(false)
            }
        }
    }
}

fn join_path(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn get_conn(state: &SftpMap, id: &str) -> Result<Arc<SftpConn>, String> {
    state
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "SFTP 세션을 찾을 수 없습니다".to_string())
}

// ── 커맨드 구현 ────────────────────────────────────────────────────────────────

pub async fn connect(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    auth_type: String,
    private_key_path: String,
    allow_legacy_algorithms: bool,
    charset: String,
) -> Result<String, String> {
    let config = crate::ssh::client_config(allow_legacy_algorithms);

    let refused = Arc::new(AtomicBool::new(false));
    let client = Client {
        app: app.clone(),
        host: host.clone(),
        port,
        refused: refused.clone(),
    };
    let mut handle: Handle<Client> = client::connect(config, (host.as_str(), port), client)
        .await
        .map_err(|e| {
            if refused.load(Ordering::SeqCst) {
                "SFTP 연결 실패 — 호스트 키를 확인하지 않았거나 이전과 다릅니다.".to_string()
            } else {
                format!("SFTP 연결 실패: {e}")
            }
        })?;

    let ok = if auth_type == "key" {
        let passphrase = if password.is_empty() { None } else { Some(password.as_str()) };
        let key = load_secret_key(&private_key_path, passphrase)
            .map_err(|e| format!("SFTP 개인키 로드 실패: {e}"))?;
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| format!("SFTP 인증 협상 오류: {e}"))?
            .flatten();
        handle
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(StdArc::new(key), hash))
            .await
            .map_err(|e| format!("SFTP 인증 오류: {e}"))?
            .success()
    } else {
        // 셸과 동일하게 password → keyboard-interactive(PAM) 폴백.
        crate::ssh::password_or_keyboard_interactive(&mut handle, &user, &password).await?
    };
    if !ok {
        return Err("SFTP 인증 실패: 자격증명을 확인하세요".into());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("SFTP 채널 실패: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP 서브시스템 실패: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP 초기화 실패: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let state = app.state::<SftpMap>();
    state.lock().unwrap().insert(
        id.clone(),
        Arc::new(SftpConn {
            sftp,
            _handle: handle,
            encoding: crate::ssh::resolve_encoding(&charset),
        }),
    );
    Ok(id)
}

pub async fn list(state: &SftpMap, id: &str, path: &str) -> Result<Vec<SftpEntry>, String> {
    let conn = get_conn(state, id)?;
    let dir = path.trim();
    let dir = if dir.is_empty() { "." } else { dir };
    // 서버에 보낼 때는 세션 문자셋 바이트로, 받아온 이름은 그 반대로 되돌린다.
    let dir_wire = text_to_wire(dir, conn.encoding);
    let entries = conn
        .sftp
        .read_dir(&dir_wire)
        .await
        .map_err(|e| format!("목록 조회 실패: {e}"))?;

    let mut out: Vec<SftpEntry> = entries
        .map(|e| {
            let name_wire = e.file_name();
            let path_wire = join_path(&dir_wire, &name_wire);
            let name = wire_to_text(&name_wire, conn.encoding);
            let meta = e.metadata();
            SftpEntry {
                path: wire_to_text(&path_wire, conn.encoding),
                name,
                is_dir: meta.is_dir(),
                is_symlink: meta.file_type().is_symlink(),
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.unwrap_or(0),
            }
        })
        .collect();

    // 폴더 먼저, 그다음 이름순.
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// 진행 중인 전송의 취소 플래그. transferId -> flag.
pub type TransferCancel = Mutex<HashMap<String, Arc<AtomicBool>>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    transfer_id: String,
    name: String,
    done: u64,
    total: u64,
}

const CHUNK: usize = 64 * 1024;
/// 진행률 통지 주기. 예전에는 256KB 마다 보냈는데, 빠른 전송에서는 초당 수백 번이 되어
/// 진행바 숫자가 눈에 띄게 튀었다(그만큼 IPC 도 낭비였다). 시간 기준으로 두면 전송 속도와
/// 무관하게 주기가 일정하다. 완료 시점의 마지막 통지는 루프 밖에서 따로 보내므로,
/// 주기 사이에 끝나는 짧은 전송도 100% 가 정확히 찍힌다.
const EMIT_EVERY: Duration = Duration::from_secs(1);

// ── 전송 속도 제한(0.75.0) ────────────────────────────────────────────────────
//
// 초당 바이트. 0 = 무제한. 전송 도중에 바꿔도 다음 조각부터 곧바로 듣는다 —
// "지금 이 전송이 회선을 다 먹으니 줄이자"가 실제 상황이라 시작 시점 값에 묶으면
// 쓸모가 절반이다. 그래서 값을 전송 인자로 받지 않고 공유 상태에서 매 조각 읽는다.
//
// SFTP 는 읽기도 우리가 요청해야 오는 구조라, 받는 쪽도 요청을 늦추면 실제 회선
// 사용량이 그만큼 내려간다(터미널 수신과 달리 별도 흐름제어가 필요 없다).
pub type RateLimit = std::sync::atomic::AtomicU64;

/// 이번 조각으로 읽을 바이트 수. 제한이 낮을수록 조각을 잘게 썬다 —
/// 조각이 크면 그만큼 오래 자게 되고, 취소 반응도 그만큼 늦어진다(1/8초 목표).
fn chunk_for(limit: u64) -> usize {
    if limit == 0 {
        return CHUNK;
    }
    (limit / 8).clamp(8 * 1024, CHUNK as u64) as usize
}

/// 조각 하나를 옮기는 데 허용된 시간을 채운다. 조각마다 독립 계산이라 제한값을
/// 바꾸면 즉시 반영되고, 누적 오차가 쌓이지 않는다(느리게 틀리는 쪽이라 안전하다).
///
/// 쉬는 동안에도 취소 플래그를 본다 — 아주 낮은 제한(예: 1KB/s)에서는 한 조각을
/// 기다리는 시간이 몇 초가 되어, 통째로 자면 취소 버튼이 그만큼 먹통이 된다.
async fn pace(limit: u64, moved: usize, started: Instant, flag: &AtomicBool) {
    if limit == 0 || moved == 0 {
        return;
    }
    let want = Duration::from_secs_f64(moved as f64 / limit as f64);
    let mut left = want.saturating_sub(started.elapsed());
    const SLICE: Duration = Duration::from_millis(200);
    while !left.is_zero() {
        if flag.load(Ordering::SeqCst) {
            return; // 취소됐다 — 남은 시간을 채울 이유가 없다
        }
        let step = left.min(SLICE);
        tokio::time::sleep(step).await;
        left -= step;
    }
}

fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// 이미 등록된 플래그가 있으면 그것을 쓴다 — 커맨드 진입 직전에 취소가 눌린 경우
/// (프론트가 transferId 를 먼저 잡고 invoke 하므로 발생 가능) 그 취소를 존중해야 한다.
fn register_cancel(cancels: &TransferCancel, transfer_id: &str) -> Arc<AtomicBool> {
    cancels
        .lock()
        .unwrap()
        .entry(transfer_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

/// 진행 중인 전송을 취소한다(대용량 전송 도중에도 즉시 중단).
/// 아직 시작 전이면 플래그를 미리 심어 두어 시작하자마자 중단되게 한다.
pub fn cancel(cancels: &TransferCancel, transfer_id: &str) {
    cancels
        .lock()
        .unwrap()
        .entry(transfer_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::SeqCst);
}

/// 이어받기 위치가 실제 부분 파일 크기와 맞는지 본다. 어긋나면 이어 쓰면 안 된다 —
/// 그 자리부터 붙이면 조용히 깨진 파일이 만들어진다. 처음부터 받도록 오류로 끊는다.
fn check_part_len(actual: u64, expect: u64) -> Result<(), String> {
    if actual == expect {
        return Ok(());
    }
    Err(format!(
        "이어받을 위치가 맞지 않습니다(부분 파일 {actual}바이트, 기대 {expect}바이트). 처음부터 다시 받으세요."
    ))
}

pub async fn download(
    app: AppHandle,
    state: &SftpMap,
    cancels: &TransferCancel,
    id: &str,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    // 0 이 아니면 그 바이트 위치부터 이어받는다(.part 뒤에 붙여 쓴다).
    resume_from: u64,
    rate: &RateLimit,
) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    let flag = register_cancel(cancels, &transfer_id);
    let name = base_name(&remote_path); // 화면 표시는 원래 텍스트 그대로
    // 서버로 나가는 경로는 세션 문자셋 바이트로(로컬 경로는 OS 가 처리하므로 그대로).
    let remote_path = text_to_wire(&remote_path, conn.encoding);

    // 받는 동안에는 .part 로 쓰고 성공했을 때만 대상 자리로 옮긴다.
    // (곧바로 대상에 쓰면 실패·취소 시 기존 파일이 잘리거나 지워진다)
    let part_path = format!("{local_path}.part");

    let result = async {
        let total = conn
            .sftp
            .metadata(remote_path.clone())
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0);

        let mut remote = conn
            .sftp
            .open(&remote_path)
            .await
            .map_err(|e| format!("원격 파일 열기 실패: {e}"))?;
        let mut local = if resume_from > 0 {
            let have = tokio::fs::metadata(&part_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            check_part_len(have, resume_from)?;
            remote
                .seek(std::io::SeekFrom::Start(resume_from))
                .await
                .map_err(|e| format!("원격 위치 이동 실패: {e}"))?;
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(&part_path)
                .await
                .map_err(|e| format!("부분 파일 열기 실패: {e}"))?
        } else {
            tokio::fs::File::create(&part_path)
                .await
                .map_err(|e| format!("로컬 파일 생성 실패: {e}"))?
        };

        let mut buf = vec![0u8; CHUNK];
        // 이미 받아 둔 만큼을 진행에 포함한다 — 진행바가 0% 부터 다시 차오르지 않게.
        let mut done = resume_from;
        // None = 아직 한 번도 안 보냄 → 첫 청크에서 즉시 보낸다.
        // 1초를 기다리면 그동안 진행바가 뜨지 않아 멈춘 것처럼 보인다.
        let mut last_emit: Option<Instant> = None;
        loop {
            if flag.load(Ordering::SeqCst) {
                return Err("전송이 취소되었습니다".to_string());
            }
            let limit = rate.load(Ordering::Relaxed);
            let step = chunk_for(limit);
            let started = Instant::now();
            let n = remote
                .read(&mut buf[..step])
                .await
                .map_err(|e| format!("원격 읽기 실패: {e}"))?;
            if n == 0 {
                break;
            }
            local
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("로컬 쓰기 실패: {e}"))?;
            done += n as u64;
            pace(limit, n, started, &flag).await;
            if last_emit.map_or(true, |t| t.elapsed() >= EMIT_EVERY) {
                last_emit = Some(Instant::now());
                let _ = app.emit(
                    "sftp://progress",
                    ProgressPayload { transfer_id: transfer_id.clone(), name: name.clone(), done, total },
                );
            }
        }
        local
            .flush()
            .await
            .map_err(|e| format!("로컬 flush 실패: {e}"))?;
        drop(local); // 파일 핸들을 닫아야 Windows 에서 rename 이 가능하다
        // 완전히 받은 뒤에만 대상 자리로 옮긴다. 덮어쓰기 대상을 **먼저 지우면**
        // rename 실패 시 원본까지 잃는다(진단 0.62.0) — 백업 이름으로 비켜 두고
        // 새 파일을 넣은 뒤 백업을 지운다. 어느 시점에 끊겨도 원본이나 새 파일이 남는다.
        let bak_path = format!("{local_path}.stbakold");
        let had_old = tokio::fs::metadata(&local_path).await.is_ok();
        if had_old {
            let _ = tokio::fs::remove_file(&bak_path).await;
            tokio::fs::rename(&local_path, &bak_path)
                .await
                .map_err(|e| format!("기존 파일 대피 실패: {e}"))?;
        }
        match tokio::fs::rename(&part_path, &local_path).await {
            Ok(()) => {
                if had_old {
                    let _ = tokio::fs::remove_file(&bak_path).await;
                }
            }
            Err(e) => {
                // 복원 실패 시 .stbakold 가 남는다 — 원본을 지우는 것보다 낫다.
                if had_old {
                    let _ = tokio::fs::rename(&bak_path, &local_path).await;
                }
                return Err(format!("파일 교체 실패: {e}"));
            }
        }
        let _ = app.emit(
            "sftp://progress",
            ProgressPayload { transfer_id: transfer_id.clone(), name: name.clone(), done, total: total.max(done) },
        );
        Ok(())
    }
    .await;

    cancels.lock().unwrap().remove(&transfer_id);
    if result.is_err() {
        // 받다 만 조각은 **남긴다** — 다음에 이어받기로 쓰기 위해서다(0.74.0).
        // 기존 대상 파일은 어느 경우에도 건드리지 않는다.
        // 한 바이트도 못 받았으면 남길 이유가 없으니 지운다(빈 .part 가 쌓이지 않게).
        if tokio::fs::metadata(&part_path).await.map(|m| m.len()).unwrap_or(0) == 0 {
            let _ = tokio::fs::remove_file(&part_path).await;
        }
    }
    result
}

pub async fn upload(
    app: AppHandle,
    state: &SftpMap,
    cancels: &TransferCancel,
    id: &str,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    // 0 이 아니면 그 바이트 위치부터 이어 올린다(서버의 .part 뒤에 붙여 쓴다).
    resume_from: u64,
    rate: &RateLimit,
) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    let flag = register_cancel(cancels, &transfer_id);
    let name = base_name(&local_path);
    // 서버에 만들 파일명을 세션 문자셋으로 인코딩한다 — 이게 없으면 EUC-KR 서버에
    // UTF-8 바이트가 그대로 올라가 터미널에서 한글 파일명이 깨진다(0.64.0).
    let remote_path = text_to_wire(&remote_path, conn.encoding);
    // 다운로드와 같은 이유로 .part 에 올린 뒤 성공 시에만 대상 이름으로 옮긴다.
    let part_path = format!("{remote_path}.part");

    let result = async {
        let total = tokio::fs::metadata(&local_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        let mut local = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| format!("로컬 읽기 실패: {e}"))?;
        let mut remote = if resume_from > 0 {
            let have = conn
                .sftp
                .metadata(part_path.clone())
                .await
                .ok()
                .and_then(|m| m.size)
                .unwrap_or(0);
            check_part_len(have, resume_from)?;
            local
                .seek(std::io::SeekFrom::Start(resume_from))
                .await
                .map_err(|e| format!("로컬 위치 이동 실패: {e}"))?;
            // TRUNCATE 없이 열어야 이미 올라간 앞부분이 남는다.
            let mut f = conn
                .sftp
                .open_with_flags(&part_path, OpenFlags::WRITE | OpenFlags::CREATE)
                .await
                .map_err(|e| format!("원격 부분 파일 열기 실패: {e}"))?;
            f.seek(std::io::SeekFrom::Start(resume_from))
                .await
                .map_err(|e| format!("원격 위치 이동 실패: {e}"))?;
            f
        } else {
            conn.sftp
                .create(&part_path)
                .await
                .map_err(|e| format!("원격 파일 생성 실패: {e}"))?
        };

        let mut buf = vec![0u8; CHUNK];
        // 이미 올린 만큼을 진행에 포함한다(다운로드와 같은 이유).
        let mut done = resume_from;
        // None = 아직 한 번도 안 보냄 → 첫 청크에서 즉시 보낸다.
        // 1초를 기다리면 그동안 진행바가 뜨지 않아 멈춘 것처럼 보인다.
        let mut last_emit: Option<Instant> = None;
        loop {
            if flag.load(Ordering::SeqCst) {
                return Err("전송이 취소되었습니다".to_string());
            }
            let limit = rate.load(Ordering::Relaxed);
            let step = chunk_for(limit);
            let started = Instant::now();
            let n = local
                .read(&mut buf[..step])
                .await
                .map_err(|e| format!("로컬 읽기 실패: {e}"))?;
            if n == 0 {
                break;
            }
            remote
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("원격 쓰기 실패: {e}"))?;
            done += n as u64;
            pace(limit, n, started, &flag).await;
            if last_emit.map_or(true, |t| t.elapsed() >= EMIT_EVERY) {
                last_emit = Some(Instant::now());
                let _ = app.emit(
                    "sftp://progress",
                    ProgressPayload { transfer_id: transfer_id.clone(), name: name.clone(), done, total },
                );
            }
        }
        remote.flush().await.map_err(|e| format!("flush 실패: {e}"))?;
        remote
            .shutdown()
            .await
            .map_err(|e| format!("close 실패: {e}"))?;
        // SFTP rename 은 대상이 있으면 실패한다. 대상을 **먼저 지우면** rename 실패 시
        // 원본까지 잃는다(진단 0.62.0) — 백업 이름으로 비켜 두고 새 파일을 넣은 뒤
        // 백업을 지운다. 어느 시점에 끊겨도 원본이나 새 파일이 서버에 남는다.
        let bak_path = format!("{remote_path}.stbakold");
        let had_old = conn.sftp.metadata(remote_path.clone()).await.is_ok();
        if had_old {
            let _ = conn.sftp.remove_file(&bak_path).await;
            conn.sftp
                .rename(&remote_path, &bak_path)
                .await
                .map_err(|e| format!("기존 원격 파일 대피 실패: {e}"))?;
        }
        match conn.sftp.rename(&part_path, &remote_path).await {
            Ok(()) => {
                if had_old {
                    let _ = conn.sftp.remove_file(&bak_path).await;
                }
            }
            Err(e) => {
                // 복원 실패 시 .stbakold 가 남는다 — 원본을 지우는 것보다 낫다.
                if had_old {
                    let _ = conn.sftp.rename(&bak_path, &remote_path).await;
                }
                return Err(format!("원격 파일 교체 실패: {e}"));
            }
        }
        let _ = app.emit(
            "sftp://progress",
            ProgressPayload { transfer_id: transfer_id.clone(), name: name.clone(), done, total: total.max(done) },
        );
        Ok(())
    }
    .await;

    cancels.lock().unwrap().remove(&transfer_id);
    if result.is_err() {
        // 다운로드와 같은 이유로 조각을 남긴다 — 빈 것만 지운다.
        let empty = conn
            .sftp
            .metadata(part_path.clone())
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0)
            == 0;
        if empty {
            let _ = conn.sftp.remove_file(&part_path).await;
        }
    }
    result
}

/// 원격 파일의 크기·수정시각(초). 없으면 None — 이어받기 판단과 폴더 비교에 쓴다.
pub async fn stat(state: &SftpMap, id: &str, path: String) -> Result<Option<(u64, u64)>, String> {
    let conn = get_conn(state, id)?;
    let wire = text_to_wire(&path, conn.encoding);
    Ok(conn
        .sftp
        .metadata(wire)
        .await
        .ok()
        .map(|m| (m.size.unwrap_or(0), u64::from(m.mtime.unwrap_or(0)))))
}

/// 원격 경로를 절대경로로 정규화(초기 "." → 실제 홈 경로). 상위 폴더 이동에 필요.
pub async fn canonicalize(state: &SftpMap, id: &str, path: String) -> Result<String, String> {
    let conn = get_conn(state, id)?;
    conn.sftp
        .canonicalize(text_to_wire(&path, conn.encoding))
        .await
        .map(|p| wire_to_text(&p, conn.encoding))
        .map_err(|e| format!("경로 확인 실패: {e}"))
}

pub async fn mkdir(state: &SftpMap, id: &str, path: String) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    conn.sftp
        .create_dir(text_to_wire(&path, conn.encoding))
        .await
        .map_err(|e| format!("폴더 생성 실패: {e}"))
}

pub async fn remove(state: &SftpMap, id: &str, path: String, is_dir: bool) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    if is_dir {
        conn.sftp
            .remove_dir(text_to_wire(&path, conn.encoding))
            .await
            .map_err(|e| format!("폴더 삭제 실패: {e}"))
    } else {
        conn.sftp
            .remove_file(text_to_wire(&path, conn.encoding))
            .await
            .map_err(|e| format!("파일 삭제 실패: {e}"))
    }
}

pub async fn rename(state: &SftpMap, id: &str, from: String, to: String) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    conn.sftp
        .rename(
            text_to_wire(&from, conn.encoding),
            text_to_wire(&to, conn.encoding),
        )
        .await
        .map_err(|e| format!("이름 변경 실패: {e}"))
}

pub fn disconnect(state: State<'_, SftpMap>, id: &str) {
    state.lock().unwrap().remove(id);
}
