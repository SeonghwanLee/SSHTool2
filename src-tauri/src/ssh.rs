use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use russh::client::{self, Config, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::ssh_key::{self, HashAlg};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{cipher, kex, mac, ChannelMsg, Disconnect, Preferred};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::hostkey;
use crate::portfwd;

/// CentOS 5 / OpenSSH 4.x 같은 구형 서버는 SHA-1 계열 KEX·MAC 과 CBC 암호밖에 제공하지
/// 않는다. 이들은 오늘날 안전하지 않아 russh 기본 목록에서 빠져 있고, 그래서 접속이
/// "No common Kex algorithm" 으로 끊긴다.
///
/// 세션에서 명시적으로 허용했을 때만 기본 목록 *뒤에* 덧붙인다. 협상은 클라이언트 선호
/// 순서를 따르므로, 최신 알고리즘을 지원하는 서버와의 결과는 이 옵션과 무관하게 같다.
/// 즉 약한 알고리즘은 "그것뿐인 서버" 에서만 실제로 쓰인다.
fn preferred_algorithms(allow_legacy: bool) -> Preferred {
    let base = Preferred::DEFAULT;
    if !allow_legacy {
        return base;
    }
    Preferred {
        kex: [
            base.kex.as_ref(),
            &[kex::DH_GEX_SHA1, kex::DH_G14_SHA1, kex::DH_G1_SHA1],
        ]
        .concat()
        .into(),
        // 3des-cbc 는 넣지 않는다 — russh 의 `des` 피처가 필요한 데다 64비트 블록이라
        // AES-CBC 보다 약하고, OpenSSH 4.x 는 이미 AES-CBC 를 지원한다.
        cipher: [
            base.cipher.as_ref(),
            &[
                cipher::AES_256_CBC,
                cipher::AES_192_CBC,
                cipher::AES_128_CBC,
            ],
        ]
        .concat()
        .into(),
        mac: [base.mac.as_ref(), &[mac::HMAC_SHA1]].concat().into(),
        key: base.key,
        compression: base.compression,
    }
}

/// 터미널·SFTP 가 공유하는 클라이언트 설정.
/// 대화형 셸은 오래 유휴 상태일 수 있으므로 inactivity 타임아웃으로 끊지 않는다.
/// 대신 keepalive 로 죽은 연결(피어 무응답)을 감지해 정리한다.
pub fn client_config(allow_legacy: bool) -> Arc<Config> {
    Arc::new(Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        preferred: preferred_algorithms(allow_legacy),
        ..Default::default()
    })
}

/// 알고리즘 불일치로 끊긴 경우, 해결 방법을 실제 화면 문구로 알려 준다.
/// (russh 는 KEX·암호·MAC 각각 다른 문구를 내므로 공통 키워드로 판별한다.)
fn algorithm_hint(err: &str, allow_legacy: bool) -> Option<&'static str> {
    if allow_legacy || !err.contains("No common") {
        return None;
    }
    Some(
        "\n\n서버가 지원하는 암호 알고리즘이 모두 구형입니다(CentOS 5 등). \
         세션 편집 → '구형 서버 호환(레거시 알고리즘 허용)' 을 켜고 다시 접속하세요.",
    )
}

/// 비밀번호 인증을 시도하고, 서버가 password 방식을 끄고 keyboard-interactive(PAM)만
/// 허용하는 경우(사내 RHEL/Rocky 등에 흔함) 같은 비밀번호로 대화형 프롬프트에 응답한다.
/// SSH.NET(구 WPF)이 자동으로 하던 동작을 재현한다.
pub(crate) async fn password_or_keyboard_interactive<H: client::Handler>(
    handle: &mut Handle<H>,
    user: &str,
    password: &str,
) -> Result<bool, String> {
    if handle
        .authenticate_password(user.to_string(), password.to_string())
        .await
        .map_err(|e| format!("인증 오류: {e}"))?
        .success()
    {
        return Ok(true);
    }

    let mut res = handle
        .authenticate_keyboard_interactive_start(user.to_string(), None)
        .await
        .map_err(|e| format!("인증 오류: {e}"))?;
    loop {
        match res {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                // 모든 프롬프트(대개 "Password:")에 같은 비밀번호로 응답.
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                res = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| format!("인증 오류: {e}"))?;
            }
        }
    }
}
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
        handle: russh::ChannelOpenHandleInner<russh::client::Msg>,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let dest = self
            .remote_forwards
            .lock()
            .unwrap()
            .get(&connected_port)
            .cloned();
        match dest {
            Some((host, port)) => {
                // 반드시 accept 해야 채널이 등록되어 데이터가 라우팅된다.
                // handle 을 그냥 drop 하면 russh 가 자동으로 거부(AdministrativelyProhibited)한다.
                handle.accept().await;
                tokio::spawn(portfwd::pump_forwarded(channel, host, port));
            }
            None => {
                let _ = connected_address; // 매핑 없는 포트는 거부(handle drop = 자동 reject)
            }
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
    let dir = crate::paths::config_dir_opt(app)?.join("logs");
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
    port_forwards: String,
    // 인증: "password" | "key". key 면 private_key_path 사용, password 는 자격증명(빈 문자열 가능).
    auth_type: String,
    private_key_path: String,
    allow_legacy_algorithms: bool,
) -> Result<String, String> {
    let config = client_config(allow_legacy_algorithms);

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
                let msg = e.to_string();
                let hint = algorithm_hint(&msg, allow_legacy_algorithms).unwrap_or("");
                format!("연결 실패: {msg}{hint}")
            });
        }
    };

    let ok = if auth_type == "key" {
        // 개인키 인증 — password 필드는 키 암호(passphrase)로 사용한다.
        let passphrase = if password.is_empty() { None } else { Some(password.as_str()) };
        let key = load_secret_key(&private_key_path, passphrase)
            .map_err(|e| format!("개인키 로드 실패({private_key_path}): {e}"))?;
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| format!("인증 협상 오류: {e}"))?
            .flatten();
        handle
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| format!("인증 오류: {e}"))?
            .success()
    } else {
        password_or_keyboard_interactive(&mut handle, &user, &password).await?
    };
    if !ok {
        return Err(if auth_type == "key" {
            "인증 실패: 개인키 또는 키 암호를 확인하세요".into()
        } else {
            "인증 실패: 아이디 또는 비밀번호를 확인하세요".to_string()
        });
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
