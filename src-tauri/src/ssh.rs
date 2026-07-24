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
use crate::portfwd;
use tokio::task::AbortHandle;

/// Managed Tauri state: session id -> command sender.
pub type SessionMap = Mutex<HashMap<String, SessionHandle>>;

/// Handle stored per live session; the read/drive task owns the channel.
pub struct SessionHandle {
    tx: mpsc::UnboundedSender<SessionCommand>,
    /// 이 세션에 붙은 포트 포워딩 리스너들. 세션 종료 시 abort 한다.
    forwards: Vec<AbortHandle>,
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
    /// -R 원격 포워딩: 서버 바인드 포트 → (대상 호스트, 대상 포트).
    remote_forwards: Arc<Mutex<HashMap<u32, (String, u16)>>>,
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

    /// -R: 서버가 원격 포워딩된 연결을 넘겨줄 때 — 대상에 연결해 중계한다.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _handle: russh::ChannelOpenHandleInner<russh::client::Msg>,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let dest = self
            .remote_forwards
            .lock()
            .unwrap()
            .get(&connected_port)
            .cloned();
        if let Some((host, port)) = dest {
            tokio::spawn(portfwd::pump_forwarded(channel, host, port));
        } else {
            let _ = connected_address; // 매핑 없는 포트는 무시
        }
        Ok(())
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
    log_name: Option<String>,
    // 포트 포워딩 규칙(줄 단위). L:로컬:대상호스트:대상포트 / R:...
    port_forwards: String,
) -> Result<String, String> {
    // 대화형 셸은 오래 유휴 상태일 수 있으므로 inactivity 타임아웃으로 끊지 않는다.
    // 대신 keepalive로 죽은 연결(피어 무응답)을 감지해 정리한다.
    let config = Arc::new(Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    // 포워딩 규칙 미리 파싱 — -R 매핑을 Client(핸들러)에 넘겨야 한다.
    let (fwd_rules, fwd_bad) = portfwd::parse(&port_forwards);
    let remote_forwards: Arc<Mutex<HashMap<u32, (String, u16)>>> = Arc::new(Mutex::new(
        fwd_rules
            .iter()
            .filter(|r| !r.local)
            .map(|r| (r.bind_port as u32, (r.dest_host.clone(), r.dest_port)))
            .collect(),
    ));

    let mismatch = Arc::new(AtomicBool::new(false));
    let client = Client {
        app: app.clone(),
        host: host.clone(),
        port,
        mismatch: mismatch.clone(),
        remote_forwards: remote_forwards.clone(),
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
    let task_id = id.clone();

    // 포워딩·종료(disconnect)를 위해 핸들을 여러 태스크가 공유한다.
    let handle = Arc::new(handle);

    // 포트 포워딩 리스너 기동. 상태 문구는 이 세션 터미널에 표시한다.
    let mut forwards: Vec<AbortHandle> = Vec::new();
    {
        let notify_app = app.clone();
        let notify_id = task_id.clone();
        let notify = move |msg: String| {
            let _ = notify_app.emit(
                "ssh://data",
                DataPayload {
                    id: notify_id.clone(),
                    data: format!("\r\n\x1b[36m{msg}\x1b[0m\r\n").into_bytes(),
                },
            );
        };
        for line in &fwd_bad {
            notify(format!("[포워딩] 형식 오류로 건너뜀: {line}"));
        }
        for rule in &fwd_rules {
            if rule.local {
                forwards.push(portfwd::spawn_local(handle.clone(), rule.clone(), notify.clone()));
            } else {
                // -R: 서버에 원격 포워딩 요청. 이후 연결은 위 콜백이 처리한다.
                match handle.tcpip_forward("0.0.0.0", rule.bind_port as u32).await {
                    Ok(_) => notify(format!(
                        "[포워딩] R:{} → {}:{} 시작",
                        rule.bind_port, rule.dest_host, rule.dest_port
                    )),
                    Err(e) => notify(format!("[포워딩] R:{} 요청 실패 — {e}", rule.bind_port)),
                }
            }
        }
    }

    {
        let state = app.state::<SessionMap>();
        state
            .lock()
            .unwrap()
            .insert(id.clone(), SessionHandle { tx, forwards });
    }

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
        // 세션이 끝나면 이 세션의 포워딩 리스너도 정리한다.
        if let Some(h) = app.state::<SessionMap>().lock().unwrap().remove(&task_id) {
            for a in h.forwards {
                a.abort();
            }
        }
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
        for a in &handle.forwards {
            a.abort();
        }
    }
    Ok(())
}
