//! SFTP 파일 전송. SSH 셸 세션과 별개로, SFTP 브라우저 전용 연결을 따로 맺는다
//! (host/port/user/password 재사용). russh-sftp 로 subsystem "sftp" 를 연다.
//! API 경로는 독립 크레이트 cargo build 로 검증됨.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};
use russh::keys::ssh_key;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use std::sync::Arc as StdArc;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// SFTP 연결 하나. Handle 을 함께 보관해 연결이 조기 종료되지 않게 유지.
pub struct SftpConn {
    sftp: SftpSession,
    _handle: Handle<Client>,
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
}

/// 셸 세션과 동일한 TOFU 호스트키 검증을 적용한다.
struct Client {
    app: AppHandle,
    host: String,
    port: u16,
}

impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(&mut self, pk: &ssh_key::PublicKey) -> Result<bool, Self::Error> {
        let fp = pk.fingerprint(ssh_key::HashAlg::Sha256).to_string();
        Ok(!matches!(
            crate::hostkey::verify(&self.app, &self.host, self.port, &fp),
            crate::hostkey::Verdict::Mismatch
        ))
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
) -> Result<String, String> {
    let config = crate::ssh::client_config(allow_legacy_algorithms);

    let client = Client {
        app: app.clone(),
        host: host.clone(),
        port,
    };
    let mut handle: Handle<Client> = client::connect(config, (host.as_str(), port), client)
        .await
        .map_err(|e| format!("SFTP 연결 실패(호스트 키 변경 시에도 발생): {e}"))?;

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
        }),
    );
    Ok(id)
}

pub async fn list(state: &SftpMap, id: &str, path: &str) -> Result<Vec<SftpEntry>, String> {
    let conn = get_conn(state, id)?;
    let dir = path.trim();
    let dir = if dir.is_empty() { "." } else { dir };
    let entries = conn
        .sftp
        .read_dir(dir)
        .await
        .map_err(|e| format!("목록 조회 실패: {e}"))?;

    let mut out: Vec<SftpEntry> = entries
        .map(|e| {
            let name = e.file_name();
            let meta = e.metadata();
            SftpEntry {
                path: join_path(dir, &name),
                name,
                is_dir: meta.is_dir(),
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
/// 진행률 이벤트를 너무 자주 보내지 않도록 하는 간격.
const EMIT_STEP: u64 = 256 * 1024;

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

pub async fn download(
    app: AppHandle,
    state: &SftpMap,
    cancels: &TransferCancel,
    id: &str,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    let flag = register_cancel(cancels, &transfer_id);
    let name = base_name(&remote_path);

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
        let mut local = tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| format!("로컬 파일 생성 실패: {e}"))?;

        let mut buf = vec![0u8; CHUNK];
        let (mut done, mut marked) = (0u64, 0u64);
        loop {
            if flag.load(Ordering::SeqCst) {
                return Err("전송이 취소되었습니다".to_string());
            }
            let n = remote
                .read(&mut buf)
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
            if done - marked >= EMIT_STEP {
                marked = done;
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
        // 완전히 받은 뒤에만 대상 자리로 옮긴다(덮어쓰기 대상이 있으면 그때 교체).
        let _ = tokio::fs::remove_file(&local_path).await;
        tokio::fs::rename(&part_path, &local_path)
            .await
            .map_err(|e| format!("파일 교체 실패: {e}"))?;
        let _ = app.emit(
            "sftp://progress",
            ProgressPayload { transfer_id: transfer_id.clone(), name: name.clone(), done, total: total.max(done) },
        );
        Ok(())
    }
    .await;

    cancels.lock().unwrap().remove(&transfer_id);
    if result.is_err() {
        // 부분 파일만 지운다 — 기존 대상 파일은 건드리지 않는다.
        let _ = tokio::fs::remove_file(&part_path).await;
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
) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    let flag = register_cancel(cancels, &transfer_id);
    let name = base_name(&local_path);
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
        let mut remote = conn
            .sftp
            .create(&part_path)
            .await
            .map_err(|e| format!("원격 파일 생성 실패: {e}"))?;

        let mut buf = vec![0u8; CHUNK];
        let (mut done, mut marked) = (0u64, 0u64);
        loop {
            if flag.load(Ordering::SeqCst) {
                return Err("전송이 취소되었습니다".to_string());
            }
            let n = local
                .read(&mut buf)
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
            if done - marked >= EMIT_STEP {
                marked = done;
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
        // SFTP rename 은 대상이 있으면 실패하므로 먼저 치운다(덮어쓰기를 택한 경우).
        let _ = conn.sftp.remove_file(&remote_path).await;
        conn.sftp
            .rename(&part_path, &remote_path)
            .await
            .map_err(|e| format!("원격 파일 교체 실패: {e}"))?;
        let _ = app.emit(
            "sftp://progress",
            ProgressPayload { transfer_id: transfer_id.clone(), name: name.clone(), done, total: total.max(done) },
        );
        Ok(())
    }
    .await;

    cancels.lock().unwrap().remove(&transfer_id);
    if result.is_err() {
        // 부분 파일만 지운다 — 기존 원격 파일은 건드리지 않는다.
        let _ = conn.sftp.remove_file(&part_path).await;
    }
    result
}

/// 원격 경로를 절대경로로 정규화(초기 "." → 실제 홈 경로). 상위 폴더 이동에 필요.
pub async fn canonicalize(state: &SftpMap, id: &str, path: String) -> Result<String, String> {
    let conn = get_conn(state, id)?;
    conn.sftp
        .canonicalize(path)
        .await
        .map_err(|e| format!("경로 확인 실패: {e}"))
}

pub async fn mkdir(state: &SftpMap, id: &str, path: String) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    conn.sftp
        .create_dir(&path)
        .await
        .map_err(|e| format!("폴더 생성 실패: {e}"))
}

pub async fn remove(state: &SftpMap, id: &str, path: String, is_dir: bool) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    if is_dir {
        conn.sftp
            .remove_dir(&path)
            .await
            .map_err(|e| format!("폴더 삭제 실패: {e}"))
    } else {
        conn.sftp
            .remove_file(&path)
            .await
            .map_err(|e| format!("파일 삭제 실패: {e}"))
    }
}

pub async fn rename(state: &SftpMap, id: &str, from: String, to: String) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    conn.sftp
        .rename(&from, &to)
        .await
        .map_err(|e| format!("이름 변경 실패: {e}"))
}

pub fn disconnect(state: State<'_, SftpMap>, id: &str) {
    state.lock().unwrap().remove(id);
}
