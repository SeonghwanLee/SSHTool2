//! 자격증명 볼트. 마스터 비밀번호 → PBKDF2-HMAC-SHA256(200k)로 32바이트 키 유도 →
//! 각 세션 비밀번호를 AES-256-GCM(세션별 랜덤 nonce)으로 암호화해 vault.json 에 보관.
//! 유도 키는 unlock 후 메모리(VaultState)에만 존재하고 디스크엔 절대 저장하지 않는다.
//! 마스터 검증은 고정 평문(verifier)을 복호화해 GCM 인증 태그가 통과하는지로 판단.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{rand_core::RngCore, Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Manager};

const ROUNDS: u32 = 200_000;
const VERIFIER_PLAINTEXT: &[u8] = b"sshtool2-vault-v1";

#[derive(Serialize, Deserialize, Default)]
struct VaultFile {
    /// base64(salt 16B)
    salt: String,
    /// base64(nonce 12B || ciphertext) — VERIFIER_PLAINTEXT 암호문
    verifier: String,
    /// sessionId -> base64(nonce 12B || ciphertext)
    #[serde(default)]
    entries: HashMap<String, String>,
}

/// unlock 후 메모리에만 유지되는 유도 키.
#[derive(Default)]
pub struct VaultState {
    key: Mutex<Option<[u8; 32]>>,
}

#[derive(Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

// ── 크립토 (독립 크레이트 cargo run 으로 검증됨) ───────────────────────────────

fn derive_key(master: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(master.as_bytes(), salt, ROUNDS, &mut key);
    key
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("암호화 실패: {e}"))?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct);
    Ok(B64.encode(blob))
}

fn decrypt(key: &[u8; 32], blob_b64: &str) -> Result<Vec<u8>, String> {
    let blob = B64.decode(blob_b64).map_err(|e| format!("디코드 실패: {e}"))?;
    if blob.len() < 12 {
        return Err("손상된 볼트 항목".into());
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "복호화 실패(잘못된 키 또는 손상)".to_string())
}

// ── 파일 I/O ──────────────────────────────────────────────────────────────────

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 경로 확인 실패: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더 생성 실패: {e}"))?;
    Ok(dir.join("vault.json"))
}

fn read_file(app: &AppHandle) -> Result<Option<VaultFile>, String> {
    let path = vault_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("볼트 읽기 실패: {e}"))?;
    let vf: VaultFile = serde_json::from_str(&data).map_err(|e| format!("볼트 파싱 실패: {e}"))?;
    Ok(Some(vf))
}

fn write_file(app: &AppHandle, vf: &VaultFile) -> Result<(), String> {
    let path = vault_path(app)?;
    let data = serde_json::to_string_pretty(vf).map_err(|e| format!("볼트 직렬화 실패: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("볼트 쓰기 실패: {e}"))
}

fn current_key(state: &VaultState) -> Result<[u8; 32], String> {
    state
        .key
        .lock()
        .unwrap()
        .ok_or_else(|| "볼트가 잠겨 있습니다".to_string())
}

// ── 커맨드 구현 ────────────────────────────────────────────────────────────────

pub fn status(app: &AppHandle, state: &VaultState) -> Result<VaultStatus, String> {
    Ok(VaultStatus {
        exists: read_file(app)?.is_some(),
        unlocked: state.key.lock().unwrap().is_some(),
    })
}

/// 볼트 최초 생성(마스터 설정). 이미 있으면 오류.
pub fn init(app: &AppHandle, state: &VaultState, master: String) -> Result<(), String> {
    if read_file(app)?.is_some() {
        return Err("볼트가 이미 존재합니다".into());
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key(&master, &salt);
    let verifier = encrypt(&key, VERIFIER_PLAINTEXT)?;
    let vf = VaultFile {
        salt: B64.encode(salt),
        verifier,
        entries: HashMap::new(),
    };
    write_file(app, &vf)?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

/// 마스터로 잠금 해제. 성공 시 메모리에 키 보관하고 true.
pub fn unlock(app: &AppHandle, state: &VaultState, master: String) -> Result<bool, String> {
    let Some(vf) = read_file(app)? else {
        return Err("볼트가 아직 없습니다".into());
    };
    let salt = B64
        .decode(&vf.salt)
        .map_err(|e| format!("볼트 salt 손상: {e}"))?;
    let key = derive_key(&master, &salt);
    match decrypt(&key, &vf.verifier) {
        Ok(pt) if pt == VERIFIER_PLAINTEXT => {
            *state.key.lock().unwrap() = Some(key);
            Ok(true)
        }
        _ => Ok(false),
    }
}

pub fn lock(state: &VaultState) {
    *state.key.lock().unwrap() = None;
}

pub fn set_password(
    app: &AppHandle,
    state: &VaultState,
    session_id: String,
    password: String,
) -> Result<(), String> {
    let key = current_key(state)?;
    let mut vf = read_file(app)?.ok_or("볼트가 아직 없습니다")?;
    vf.entries
        .insert(session_id, encrypt(&key, password.as_bytes())?);
    write_file(app, &vf)
}

pub fn get_password(
    app: &AppHandle,
    state: &VaultState,
    session_id: &str,
) -> Result<Option<String>, String> {
    let key = current_key(state)?;
    let Some(vf) = read_file(app)? else {
        return Ok(None);
    };
    let Some(blob) = vf.entries.get(session_id) else {
        return Ok(None);
    };
    let bytes = decrypt(&key, blob)?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

pub fn delete_password(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let Some(mut vf) = read_file(app)? else {
        return Ok(());
    };
    if vf.entries.remove(session_id).is_some() {
        write_file(app, &vf)?;
    }
    Ok(())
}
