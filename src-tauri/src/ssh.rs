use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use russh::client::{self, Config, Handle};
use russh::keys::ssh_key::{self, HashAlg};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::hostkey;

/// Managed Tauri state: session id -> command sender.
pub type SessionMap = Mutex<HashMap<String, SessionHandle>>;

/// Handle stored per live session; the read/drive task owns the channel.
pub struct SessionHandle {
    tx: mpsc::UnboundedSender<SessionCommand>,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone, Serialize)]
struct DataPayload {
    id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct ClosedPayload {
    id: String,
    message: String,
}

/// russh client event handler. 호스트키는 TOFU 로 검증한다 —
/// 처음 보는 호스트는 지문을 저장하고 수락, 저장된 지문과 다르면 거부.
struct Client {
    app: AppHandle,
    host: String,
    port: u16,
    /// 지문 불일치로 거부했음을 connect() 에 알리는 플래그(오류 메시지 구분용).
    mismatch: Arc<AtomicBool>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        match hostkey::verify(&self.app, &self.host, self.port, &fp) {
            hostkey::Verdict::New | hostkey::Verdict::Match => Ok(true),
            hostkey::Verdict::Mismatch => {
                self.mismatch.store(true, Ordering::SeqCst);
                Ok(false)
            }
        }
    }
}

/// 세션 문자셋을 encoding_rs 인코딩으로 해석. UTF-8(또는 미지정)이면 None = 변환 없음.
fn resolve_encoding(charset: &str) -> Option<&'static encoding_rs::Encoding> {
    let label = charset.trim();
    if label.is_empty() {
        return None;
    }
    let enc = match label.to_ascii_uppercase().as_str() {
        "UTF-8" | "UTF8" => return None,
        // CP949/MS949 는 EUC-KR 의 확장 — encoding_rs 의 EUC_KR 이 이를 포함한다.
        "EUC-KR" | "CP949" | "MS949" => encoding_rs::EUC_KR,
        _ => encoding_rs::Encoding::for_label(label.as_bytes())?,
    };
    if enc == encoding_rs::UTF_8 {
        None
    } else {
        Some(enc)
    }
}

/// 세션 로그 파일을 연다(설정 폴더의 logs/). 실패해도 접속은 계속되어야 하므로 Option.
pub(crate) fn open_session_log(app: &AppHandle, name: &str, session_id: &str) -> Option<std::fs::File> {
    let dir = app.path().app_config_dir().ok()?.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{safe}-{stamp}-{}.log", &session_id[..8.min(session_id.len())])))
        .ok()
}

/// Connect, authenticate with a password, open a PTY shell, and spawn the
/// read/drive loop. Returns the new session id on success.
pub async fn connect(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    cols: u32,
    rows: u32,
    charset: String,
    // Some(세션명) 이면 수신 내용을 logs/<이름>-<시각>-<id>.log 에 기록.
    // (파라미터에는 /// 문서 주석을 달 수 없다 — 컴파일 에러가 된다)
    log_name: Option<String>,
) -> Result<String, String> {
    // 대화형 셸은 오래 유휴 상태일 수 있으므로 inactivity 타임아웃으로 끊지 않는다.
    // 대신 keepalive로 죽은 연결(피어 무응답)을 감지해 정리한다.
    let config = Arc::new(Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let mismatch = Arc::new(AtomicBool::new(false));
    let client = Client {
        app: app.clone(),
        host: host.clone(),
        port,
        mismatch: mismatch.clone(),
    };
    let mut handle: Handle<Client> = match client::connect(config, (host.as_str(), port), client)
        .await
    {
        Ok(h) => h,
        Err(e) => {
            return Err(if mismatch.load(Ordering::SeqCst) {
                format!(
                    "호스트 키가 이전과 다릅니다 — 중간자 공격일 수 있습니다. \
                     서버를 재설치한 경우처럼 정당한 변경이라면 설정에서 \
                     '{host}:{port}' 의 알려진 호스트 항목을 삭제한 뒤 다시 접속하세요."
                )
            } else {
                format!("연결 실패: {e}")
            });
        }
    };

    let auth = handle
        .authenticate_password(user, password)
        .await
        .map_err(|e| format!("인증 오류: {e}"))?;
    if !auth.success() {
        return Err("인증 실패: 아이디 또는 비밀번호를 확인하세요".into());
    }

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("채널 열기 실패: {e}"))?;

    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("PTY 요청 실패: {e}"))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("셸 요청 실패: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<SessionCommand>();

    {
        let state = app.state::<SessionMap>();
        state
            .lock()
            .unwrap()
            .insert(id.clone(), SessionHandle { tx });
    }

    let task_id = id.clone();
    let encoding = resolve_encoding(&charset);
    // 같은 세션을 같은 초에 두 번 열어도 파일이 섞이지 않도록 세션 id 를 붙인다.
    let mut log_file = log_name
        .as_deref()
        .and_then(|n| open_session_log(&app, n, &task_id));
    tokio::spawn(async move {
        let mut reason = String::from("세션이 종료되었습니다");
        // 비-UTF-8 세션은 스트리밍 디코더로 변환한다(청크 경계에 걸친 멀티바이트 보존).
        let mut decoder = encoding.map(|e| e.new_decoder());

        // 수신 바이트 → 프론트로 보낼 UTF-8 바이트.
        macro_rules! to_utf8 {
            ($bytes:expr) => {{
                let raw: Vec<u8> = $bytes;
                match decoder.as_mut() {
                    Some(d) => {
                        let need = d.max_utf8_buffer_length(raw.len()).unwrap_or(raw.len() * 3);
                        let mut s = String::with_capacity(need);
                        let _ = d.decode_to_string(&raw, &mut s, false);
                        s.into_bytes()
                    }
                    None => raw,
                }
            }};
        }

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let out = to_utf8!(data.to_vec());
                            if let Some(f) = log_file.as_mut() {
                                use std::io::Write;
                                let _ = f.write_all(&out);
                            }
                            let _ = app.emit(
                                "ssh://data",
                                DataPayload { id: task_id.clone(), data: out },
                            );
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let out = to_utf8!(data.to_vec());
                            if let Some(f) = log_file.as_mut() {
                                use std::io::Write;
                                let _ = f.write_all(&out); // stderr 도 화면에 나오므로 함께 기록
                            }
                            let _ = app.emit(
                                "ssh://data",
                                DataPayload { id: task_id.clone(), data: out },
                            );
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            reason = format!("종료 코드 {exit_status}");
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                        None => break,
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Write(bytes)) => {
                            // 프론트는 항상 UTF-8 로 보낸다 → 세션 문자셋으로 변환해 전송.
                            let bytes = match encoding {
                                Some(e) => {
                                    let text = String::from_utf8_lossy(&bytes);
                                    let (cow, _, _) = e.encode(&text);
                                    cow.into_owned()
                                }
                                None => bytes,
                            };
                            if channel.data(&bytes[..]).await.is_err() {
                                reason = "쓰기 실패로 연결이 끊어졌습니다".into();
                                break;
                            }
                        }
                        Some(SessionCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        Some(SessionCommand::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
            }
        }

        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        app.state::<SessionMap>().lock().unwrap().remove(&task_id);
        let _ = app.emit(
            "ssh://closed",
            ClosedPayload { id: task_id.clone(), message: reason },
        );
    });

    Ok(id)
}

pub fn write(app: &AppHandle, id: &str, data: Vec<u8>) -> Result<(), String> {
    let state = app.state::<SessionMap>();
    let map = state.lock().unwrap();
    let handle = map.get(id).ok_or("세션을 찾을 수 없습니다")?;
    handle
        .tx
        .send(SessionCommand::Write(data))
        .map_err(|_| "세션이 이미 종료되었습니다".to_string())
}

pub fn resize(app: &AppHandle, id: &str, cols: u32, rows: u32) -> Result<(), String> {
    let state = app.state::<SessionMap>();
    let map = state.lock().unwrap();
    let handle = map.get(id).ok_or("세션을 찾을 수 없습니다")?;
    handle
        .tx
        .send(SessionCommand::Resize { cols, rows })
        .map_err(|_| "세션이 이미 종료되었습니다".to_string())
}

pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<SessionMap>();
    let map = state.lock().unwrap();
    if let Some(handle) = map.get(id) {
        let _ = handle.tx.send(SessionCommand::Close);
    }
    Ok(())
}
