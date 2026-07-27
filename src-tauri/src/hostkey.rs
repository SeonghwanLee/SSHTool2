//! SSH 호스트키 검증(TOFU). 첫 접속 시 SHA-256 지문을 known_hosts.json 에 저장하고,
//! 이후 접속에서 지문이 다르면 거부한다(중간자 공격 방어 — WPF 0.36.0 대응).
//! 신뢰하는 변경이라면 사용자가 해당 항목을 삭제한 뒤 다시 접속하면 재등록된다.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use russh::keys::ssh_key;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

/// "host:port" -> "SHA256:..." 지문.
type KnownHosts = HashMap<String, String>;

#[derive(Serialize, Deserialize)]
pub struct KnownHostEntry {
    pub target: String,
    pub fingerprint: String,
}

pub enum Verdict {
    /// 처음 보는 호스트 — 사용자에게 지문을 확인받아야 한다(자동 수락하지 않는다).
    New,
    /// 저장된 지문과 일치 — 수락.
    Match,
    /// 지문 불일치 — 거부.
    Mismatch,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::config_dir(app)?.join("known_hosts.json"))
}

fn load(app: &AppHandle) -> KnownHosts {
    let Ok(p) = path(app) else {
        return KnownHosts::new();
    };
    if !p.exists() {
        return KnownHosts::new();
    }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store(app: &AppHandle, hosts: &KnownHosts) {
    if let Ok(p) = path(app) {
        if let Ok(data) = serde_json::to_string_pretty(hosts) {
            let _ = crate::paths::write_atomic(&p, &data);
        }
    }
}

fn key_of(host: &str, port: u16) -> String {
    format!("{}:{}", host.to_ascii_lowercase(), port)
}

/// 저장된 지문과 대조만 한다. **저장하지 않는다** — 처음 보는 호스트를 조용히 신뢰하면
/// 첫 접속 시점의 중간자가 그대로 성립하고, 이후 그 가짜 키가 '정상'으로 굳는다.
/// New 는 호출자가 사용자에게 지문을 확인받은 뒤 `remember()` 로 확정해야 한다.
pub fn verify(app: &AppHandle, host: &str, port: u16, fingerprint: &str) -> Verdict {
    let hosts = load(app);
    match hosts.get(&key_of(host, port)) {
        Some(known) if known == fingerprint => Verdict::Match,
        Some(_) => Verdict::Mismatch,
        None => Verdict::New,
    }
}

/// 사용자가 첫 접속 지문을 수락했을 때 등록한다.
pub fn remember(app: &AppHandle, host: &str, port: u16, fingerprint: &str) {
    let mut hosts = load(app);
    hosts.insert(key_of(host, port), fingerprint.to_string());
    store(app, &hosts);
}

// ── 첫 접속 지문 확인(프론트 왕복) ────────────────────────────────────────────

/// 대기 중인 확인 요청(요청 id → 응답 채널). 접속은 이 응답이 올 때까지 멈춰 있다.
#[derive(Default)]
pub struct HostKeyPrompts(Mutex<HashMap<String, oneshot::Sender<bool>>>);

/// 응답이 없을 때 접속이 영영 매달리지 않도록 하는 상한.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptPayload {
    id: String,
    host: String,
    port: u16,
    fingerprint: String,
    key_type: String,
}

/// 호스트키 검사 결과. Accept 외에는 접속을 끊는다.
pub enum Decision {
    Accept,
    /// 저장된 지문과 다름 — 중간자일 수 있다.
    Mismatch,
    /// 처음 보는 호스트인데 사용자가 수락하지 않음(거부·시간 초과·창 없음).
    Rejected,
}

/// 지문을 대조하고, 처음 보는 호스트면 사용자에게 물어본 뒤 수락 시 등록한다.
/// 터미널·SFTP 가 같은 판단을 하도록 두 경로가 이 함수를 공유한다.
pub async fn check(
    app: &AppHandle,
    host: &str,
    port: u16,
    pk: &ssh_key::PublicKey,
) -> Decision {
    let fp = pk.fingerprint(ssh_key::HashAlg::Sha256).to_string();
    match verify(app, host, port, &fp) {
        Verdict::Match => Decision::Accept,
        Verdict::Mismatch => Decision::Mismatch,
        Verdict::New => {
            // 임시값 차용이 await 를 넘지 않도록 먼저 소유값으로 받는다.
            let key_type = pk.algorithm().as_str().to_string();
            if ask(app, host, port, &fp, &key_type).await {
                remember(app, host, port, &fp);
                Decision::Accept
            } else {
                Decision::Rejected
            }
        }
    }
}

async fn ask(app: &AppHandle, host: &str, port: u16, fingerprint: &str, key_type: &str) -> bool {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    let prompts = app.state::<HostKeyPrompts>();
    // 락은 emit/await 전에 반드시 놓는다 — 응답 커맨드가 같은 락을 잡아야 하므로.
    prompts.0.lock().unwrap().insert(id.clone(), tx);

    let payload = PromptPayload {
        id: id.clone(),
        host: host.to_string(),
        port,
        fingerprint: fingerprint.to_string(),
        key_type: key_type.to_string(),
    };
    if app.emit("ssh://hostkey-prompt", payload).is_err() {
        prompts.0.lock().unwrap().remove(&id);
        return false; // 물어볼 창이 없으면 수락하지 않는다.
    }

    match tokio::time::timeout(PROMPT_TIMEOUT, rx).await {
        Ok(Ok(accepted)) => accepted,
        // 시간 초과 또는 채널 소실(창 닫힘 등) — 대기 목록을 정리하고 거부.
        _ => {
            prompts.0.lock().unwrap().remove(&id);
            false
        }
    }
}

/// 프론트의 확인 결과를 접속 대기 중인 쪽으로 전달한다.
pub fn answer(app: &AppHandle, id: &str, accept: bool) {
    let tx = app.state::<HostKeyPrompts>().0.lock().unwrap().remove(id);
    if let Some(tx) = tx {
        let _ = tx.send(accept);
    }
}

pub fn list(app: &AppHandle) -> Vec<KnownHostEntry> {
    let mut out: Vec<KnownHostEntry> = load(app)
        .into_iter()
        .map(|(target, fingerprint)| KnownHostEntry {
            target,
            fingerprint,
        })
        .collect();
    out.sort_by(|a, b| a.target.cmp(&b.target));
    out
}

/// 항목 삭제 — 호스트키가 정당하게 바뀐 경우(서버 재설치 등) 재등록용.
pub fn remove(app: &AppHandle, target: &str) {
    let mut hosts = load(app);
    if hosts.remove(target).is_some() {
        store(app, &hosts);
    }
}

pub fn clear(app: &AppHandle) {
    store(app, &KnownHosts::new());
}
