//! SSH 호스트키 검증(TOFU). 첫 접속 시 SHA-256 지문을 known_hosts.json 에 저장하고,
//! 이후 접속에서 지문이 다르면 거부한다(중간자 공격 방어 — WPF 0.36.0 대응).
//! 신뢰하는 변경이라면 사용자가 해당 항목을 삭제한 뒤 다시 접속하면 재등록된다.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// "host:port" -> "SHA256:..." 지문.
type KnownHosts = HashMap<String, String>;

#[derive(Serialize, Deserialize)]
pub struct KnownHostEntry {
    pub target: String,
    pub fingerprint: String,
}

pub enum Verdict {
    /// 처음 보는 호스트 — 저장하고 수락.
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
            let _ = fs::write(p, data);
        }
    }
}

fn key_of(host: &str, port: u16) -> String {
    format!("{}:{}", host.to_ascii_lowercase(), port)
}

/// 지문을 확인하고, 처음 보는 호스트면 저장한다(TOFU).
pub fn verify(app: &AppHandle, host: &str, port: u16, fingerprint: &str) -> Verdict {
    let mut hosts = load(app);
    let key = key_of(host, port);
    match hosts.get(&key) {
        Some(known) if known == fingerprint => Verdict::Match,
        Some(_) => Verdict::Mismatch,
        None => {
            hosts.insert(key, fingerprint.to_string());
            store(app, &hosts);
            Verdict::New
        }
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
