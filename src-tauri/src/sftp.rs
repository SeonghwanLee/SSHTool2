//! SFTP 파일 전송. SSH 셸 세션과 별개로, SFTP 브라우저 전용 연결을 따로 맺는다
//! (host/port/user/password 재사용). russh-sftp 로 subsystem "sftp" 를 연다.
//! API 경로는 독립 크레이트 cargo build 로 검증됨.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Config, Handle};
use russh::keys::ssh_key;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
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
) -> Result<String, String> {
    let config = Arc::new(Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let client = Client {
        app: app.clone(),
        host: host.clone(),
        port,
    };
    let mut handle: Handle<Client> = client::connect(config, (host.as_str(), port), client)
        .await
        .map_err(|e| format!("SFTP 연결 실패(호스트 키 변경 시에도 발생): {e}"))?;

    let auth = handle
        .authenticate_password(user, password)
        .await
        .map_err(|e| format!("SFTP 인증 오류: {e}"))?;
    if !auth.success() {
        return Err("SFTP 인증 실패: 아이디 또는 비밀번호를 확인하세요".into());
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

pub async fn download(
    state: &SftpMap,
    id: &str,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    let mut file = conn
        .sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("원격 파일 열기 실패: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| format!("원격 읽기 실패: {e}"))?;
    std::fs::write(&local_path, &buf).map_err(|e| format!("로컬 저장 실패: {e}"))
}

pub async fn upload(
    state: &SftpMap,
    id: &str,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let conn = get_conn(state, id)?;
    let data = std::fs::read(&local_path).map_err(|e| format!("로컬 읽기 실패: {e}"))?;
    let mut file = conn
        .sftp
        .create(&remote_path)
        .await
        .map_err(|e| format!("원격 파일 생성 실패: {e}"))?;
    file.write_all(&data)
        .await
        .map_err(|e| format!("원격 쓰기 실패: {e}"))?;
    file.flush().await.map_err(|e| format!("flush 실패: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("close 실패: {e}"))
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
