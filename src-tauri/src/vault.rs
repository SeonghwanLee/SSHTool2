//! 자격증명 볼트 (형식 v2).
//!
//! 구조: 실제 비밀은 랜덤 **DEK**(데이터 암호화 키)로 암호화하고, DEK 자체를
//! ① 마스터 비밀번호에서 유도한 키와 ② 복구 키에서 유도한 키로 각각 감싸(wrap) 보관한다.
//! - 마스터 비밀번호 변경 = DEK 재포장만 하면 되므로 **전체 재암호화가 불필요**
//! - 마스터를 잊어도 복구 키로 DEK 를 풀어 새 마스터를 설정할 수 있음
//!
//! KDF: PBKDF2-HMAC-SHA512 300k (WPF SSHTool 스킴), 암호화: AES-256-GCM(항목별 랜덤 nonce).
//! DEK 는 unlock 후 메모리(VaultState)에만 존재하고 디스크엔 절대 평문으로 남지 않는다.
//!
//! v1(마스터 유도 키로 항목을 직접 암호화) 파일은 unlock 시 자동으로 v2 로 이관한다.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{rand_core::RngCore, Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use tauri::AppHandle;

const ROUNDS: u32 = 300_000;
const VERIFIER_PLAINTEXT: &[u8] = b"sshtool2-vault-v1";
const VERSION_V2: u32 = 2;

#[derive(Serialize, Deserialize, Default)]
struct VaultFile {
    /// 2 = DEK 방식. 없거나 0/1 이면 v1(구형).
    #[serde(default)]
    version: u32,
    /// 마스터 KDF salt (base64)
    salt: String,
    /// v1 호환 필드 — 마스터 유도 키로 암호화한 고정 평문
    #[serde(default)]
    verifier: String,
    /// v2: 마스터 유도 키로 감싼 DEK
    #[serde(default)]
    wrapped_dek: String,
    /// v2: 복구 키 KDF salt
    #[serde(default)]
    recovery_salt: String,
    /// v2: 복구 키 유도 키로 감싼 DEK
    #[serde(default)]
    recovery_wrapped_dek: String,
    /// sessionId -> base64(nonce 12B || ciphertext), DEK 로 암호화
    #[serde(default)]
    entries: HashMap<String, String>,
}

/// unlock 후 메모리에만 유지되는 DEK.
#[derive(Default)]
pub struct VaultState {
    dek: Mutex<Option<[u8; 32]>>,
}

/// unlock 결과. v1→v2 이관이 일어나면 새로 발급된 복구 키를 함께 돌려준다
/// (버리면 이관된 볼트는 복구 수단이 영영 없어진다).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockOutcome {
    pub ok: bool,
    pub migrated_recovery: Option<String>,
}

#[derive(Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

// ── 크립토 ────────────────────────────────────────────────────────────────────

fn derive_key(secret: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha512>(secret.as_bytes(), salt, ROUNDS, &mut key);
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

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

fn to_key(bytes: Vec<u8>) -> Result<[u8; 32], String> {
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| "DEK 길이가 올바르지 않습니다".to_string())
}

// ── 복구 키 (RFC4648 base32, 160비트) ──────────────────────────────────────────

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// 20바이트(160비트) → "XXXX-XXXX-…" 8그룹 32자.
fn make_recovery_key() -> String {
    let raw = random_bytes::<20>();
    let mut chars = String::with_capacity(32);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in raw {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            chars.push(B32[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    chars
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// 사용자가 입력한 복구 키 정규화(하이픈·공백 제거, 대문자화).
fn normalize_recovery(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

// ── 파일 I/O ──────────────────────────────────────────────────────────────────

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::config_dir(app)?.join("vault.json"))
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

/// 임시 파일에 쓴 뒤 교체한다. 볼트는 마스터·복구키·모든 항목이 한 파일에 있어
/// 쓰기 도중 중단되면 전부 소실되므로 절단(truncate) 상태를 만들지 않는다.
fn write_file(app: &AppHandle, vf: &VaultFile) -> Result<(), String> {
    let path = vault_path(app)?;
    let data = serde_json::to_string_pretty(vf).map_err(|e| format!("볼트 직렬화 실패: {e}"))?;
    // 설정·세션과 같은 원자적 쓰기를 쓴다(임시 파일 → fsync → 교체).
    crate::paths::write_atomic(&path, &data)
}

fn current_dek(state: &VaultState) -> Result<[u8; 32], String> {
    state
        .dek
        .lock()
        .unwrap()
        .ok_or_else(|| "볼트가 잠겨 있습니다".to_string())
}

/// DEK 를 마스터/복구 키로 각각 감싸 파일 필드를 채운다.
fn wrap_dek(vf: &mut VaultFile, dek: &[u8; 32], master: &str) -> Result<String, String> {
    let salt = random_bytes::<16>();
    vf.salt = B64.encode(salt);
    vf.wrapped_dek = encrypt(&derive_key(master, &salt), dek)?;

    let recovery = make_recovery_key();
    let rsalt = random_bytes::<16>();
    vf.recovery_salt = B64.encode(rsalt);
    vf.recovery_wrapped_dek = encrypt(&derive_key(&normalize_recovery(&recovery), &rsalt), dek)?;

    vf.version = VERSION_V2;
    vf.verifier = String::new(); // v2 에서는 사용하지 않음
    Ok(recovery)
}

// ── 커맨드 구현 ────────────────────────────────────────────────────────────────

pub fn status(app: &AppHandle, state: &VaultState) -> Result<VaultStatus, String> {
    Ok(VaultStatus {
        exists: read_file(app)?.is_some(),
        unlocked: state.dek.lock().unwrap().is_some(),
    })
}

/// 볼트 최초 생성. 반환값 = 1회성 복구 키(사용자에게 보여주고 보관시킬 것).
pub fn init(app: &AppHandle, state: &VaultState, master: String) -> Result<String, String> {
    if read_file(app)?.is_some() {
        return Err("볼트가 이미 존재합니다".into());
    }
    let dek = random_bytes::<32>();
    let mut vf = VaultFile::default();
    let recovery = wrap_dek(&mut vf, &dek, &master)?;
    write_file(app, &vf)?;
    *state.dek.lock().unwrap() = Some(dek);
    Ok(recovery)
}

/// 마스터로 잠금 해제. v1 파일은 이 시점에 v2 로 이관한다.
pub fn unlock(app: &AppHandle, state: &VaultState, master: String) -> Result<UnlockOutcome, String> {
    let Some(mut vf) = read_file(app)? else {
        return Err("볼트가 아직 없습니다".into());
    };
    let salt = B64
        .decode(&vf.salt)
        .map_err(|e| format!("볼트 salt 손상: {e}"))?;
    let mk = derive_key(&master, &salt);

    if vf.version >= VERSION_V2 {
        let Ok(raw) = decrypt(&mk, &vf.wrapped_dek) else {
            return Ok(UnlockOutcome { ok: false, migrated_recovery: None });
        };
        *state.dek.lock().unwrap() = Some(to_key(raw)?);
        return Ok(UnlockOutcome { ok: true, migrated_recovery: None });
    }

    // ── v1 → v2 이관: 기존 항목은 마스터 유도 키로 암호화돼 있다 ──
    match decrypt(&mk, &vf.verifier) {
        Ok(pt) if pt == VERIFIER_PLAINTEXT => {}
        _ => return Ok(UnlockOutcome { ok: false, migrated_recovery: None }),
    }

    // 항목 하나라도 복호화에 실패하면 이관을 중단한다 — 그대로 진행하면 그 항목이
    // 조용히 사라진 상태로 파일이 덮어써져 되돌릴 수 없다.
    let mut plain: HashMap<String, String> = HashMap::new();
    for (k, blob) in &vf.entries {
        let bytes = decrypt(&mk, blob).map_err(|_| {
            format!("볼트 항목 '{k}' 을(를) 복호화할 수 없어 이관을 중단했습니다. 파일이 손상되었을 수 있으니 백업 후 문의하세요.")
        })?;
        plain.insert(k.clone(), String::from_utf8_lossy(&bytes).into_owned());
    }

    let dek = random_bytes::<32>();
    let recovery = wrap_dek(&mut vf, &dek, &master)?; // 이관 시 복구 키가 새로 발급된다
    vf.entries = plain
        .into_iter()
        .map(|(k, v)| encrypt(&dek, v.as_bytes()).map(|blob| (k, blob)))
        .collect::<Result<HashMap<_, _>, _>>()?;
    write_file(app, &vf)?;
    *state.dek.lock().unwrap() = Some(dek);
    Ok(UnlockOutcome { ok: true, migrated_recovery: Some(recovery) })
}

/// 복구 키로 잠금 해제(마스터를 잊었을 때). 이후 change_master 로 새 비밀번호를 설정해야 한다.
pub fn unlock_with_recovery(
    app: &AppHandle,
    state: &VaultState,
    recovery: String,
) -> Result<bool, String> {
    let Some(vf) = read_file(app)? else {
        return Err("볼트가 아직 없습니다".into());
    };
    if vf.recovery_wrapped_dek.is_empty() {
        return Err("이 볼트에는 복구 키가 없습니다(구형 볼트).".into());
    }
    let rsalt = B64
        .decode(&vf.recovery_salt)
        .map_err(|e| format!("복구 salt 손상: {e}"))?;
    let rk = derive_key(&normalize_recovery(&recovery), &rsalt);
    let Ok(raw) = decrypt(&rk, &vf.recovery_wrapped_dek) else {
        return Ok(false);
    };
    *state.dek.lock().unwrap() = Some(to_key(raw)?);
    Ok(true)
}

/// 마스터 비밀번호 변경(잠금 해제 상태에서). 항목 재암호화 없이 DEK 만 다시 감싼다.
/// 반환값 = 새로 발급된 복구 키(기존 복구 키는 무효가 된다).
pub fn change_master(
    app: &AppHandle,
    state: &VaultState,
    new_master: String,
) -> Result<String, String> {
    let dek = current_dek(state)?;
    let mut vf = read_file(app)?.ok_or("볼트가 아직 없습니다")?;
    let recovery = wrap_dek(&mut vf, &dek, &new_master)?;
    write_file(app, &vf)?;
    Ok(recovery)
}

pub fn lock(state: &VaultState) {
    *state.dek.lock().unwrap() = None;
}

/// 임의의 비밀 값을 볼트에 넣는다.
///
/// `entries` 키는 네임스페이스로 구분한다 — `"{세션id}"` 는 비밀번호(기존 그대로),
/// `"{세션id}:triggers"`·`"{세션id}:startup"` 은 세션 편집기의 비밀 필드.
/// 기존 키는 UUID 라 `:` 가 들어갈 일이 없어 충돌하지 않는다.
pub fn set_secret(
    app: &AppHandle,
    state: &VaultState,
    key: String,
    value: String,
) -> Result<(), String> {
    let dek = current_dek(state)?;
    let mut vf = read_file(app)?.ok_or("볼트가 아직 없습니다")?;
    vf.entries.insert(key, encrypt(&dek, value.as_bytes())?);
    write_file(app, &vf)
}

pub fn get_secret(
    app: &AppHandle,
    state: &VaultState,
    key: &str,
) -> Result<Option<String>, String> {
    let dek = current_dek(state)?;
    let Some(vf) = read_file(app)? else {
        return Ok(None);
    };
    let Some(blob) = vf.entries.get(key) else {
        return Ok(None);
    };
    let bytes = decrypt(&dek, blob)?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// 세션 비밀번호 — 키가 세션 id 그대로인 `set_secret`.
pub fn set_password(
    app: &AppHandle,
    state: &VaultState,
    session_id: String,
    password: String,
) -> Result<(), String> {
    set_secret(app, state, session_id, password)
}

pub fn get_password(
    app: &AppHandle,
    state: &VaultState,
    session_id: &str,
) -> Result<Option<String>, String> {
    get_secret(app, state, session_id)
}

/// 세션 하나에 딸린 항목을 모두 지운다 — 비밀번호(`{id}`)와 네임스페이스 항목(`{id}:*`).
/// 세션을 지울 때 볼트에 유령 항목이 남지 않도록 접두사로 함께 훑는다.
pub fn delete_password(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let Some(mut vf) = read_file(app)? else {
        return Ok(());
    };
    let prefix = format!("{session_id}:");
    let before = vf.entries.len();
    vf.entries
        .retain(|k, _| k != session_id && !k.starts_with(&prefix));
    if vf.entries.len() != before {
        write_file(app, &vf)?;
    }
    Ok(())
}

/// 개별 비밀 항목 삭제 — 사용자가 '비밀 값' 체크를 해제했을 때.
pub fn delete_secret(app: &AppHandle, key: &str) -> Result<(), String> {
    let Some(mut vf) = read_file(app)? else {
        return Ok(());
    };
    if vf.entries.remove(key).is_some() {
        write_file(app, &vf)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 볼트는 실패의 대가가 가장 큰 자리다 — 여기가 어긋나면 저장한 비밀번호를 영영 꺼낼 수
    // 없다. 파일·키체인이 없어도 확인할 수 있는 부분(크립토·감싸기·복구 키)만 다룬다.

    #[test]
    fn same_secret_and_salt_give_the_same_key() {
        let salt = [7u8; 16];
        assert_eq!(derive_key("hunter2", &salt), derive_key("hunter2", &salt));
    }

    #[test]
    fn different_salt_gives_a_different_key() {
        // salt 가 무시되면 서로 다른 볼트가 같은 키를 쓰게 된다.
        assert_ne!(derive_key("hunter2", &[1u8; 16]), derive_key("hunter2", &[2u8; 16]));
    }

    #[test]
    fn different_secret_gives_a_different_key() {
        let salt = [7u8; 16];
        assert_ne!(derive_key("hunter2", &salt), derive_key("hunter3", &salt));
    }

    #[test]
    fn encrypt_then_decrypt_returns_the_original() {
        let key = derive_key("master", &[3u8; 16]);
        let secret = "비밀번호 ünïcode\n둘째 줄".as_bytes();
        let blob = encrypt(&key, secret).unwrap();
        assert_eq!(decrypt(&key, &blob).unwrap(), secret);
    }

    #[test]
    fn the_same_plaintext_encrypts_differently_each_time() {
        // nonce 를 재사용하면 같은 암호문이 나오고, AES-GCM 에서 그것은 치명적이다.
        let key = derive_key("master", &[3u8; 16]);
        assert_ne!(encrypt(&key, b"x").unwrap(), encrypt(&key, b"x").unwrap());
    }

    #[test]
    fn a_wrong_key_cannot_decrypt() {
        let blob = encrypt(&derive_key("right", &[3u8; 16]), b"secret").unwrap();
        assert!(decrypt(&derive_key("wrong", &[3u8; 16]), &blob).is_err());
    }

    #[test]
    fn a_tampered_blob_is_rejected() {
        // GCM 은 변조를 잡아낸다 — 잡지 못하면 손상된 볼트를 조용히 읽게 된다.
        let key = derive_key("master", &[3u8; 16]);
        let blob = encrypt(&key, b"secret").unwrap();
        let mut raw = B64.decode(&blob).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        assert!(decrypt(&key, &B64.encode(raw)).is_err());
    }

    #[test]
    fn a_short_blob_is_rejected_instead_of_panicking() {
        let key = derive_key("master", &[3u8; 16]);
        assert!(decrypt(&key, &B64.encode([0u8; 5])).is_err());
    }

    #[test]
    fn to_key_accepts_only_32_bytes() {
        assert!(to_key(vec![0u8; 32]).is_ok());
        assert!(to_key(vec![0u8; 31]).is_err());
        assert!(to_key(vec![0u8; 33]).is_err());
    }

    #[test]
    fn recovery_key_has_the_documented_shape() {
        let k = make_recovery_key();
        let groups: Vec<&str> = k.split('-').collect();
        assert_eq!(groups.len(), 8, "8그룹이어야 한다: {k}");
        assert!(groups.iter().all(|g| g.len() == 4), "각 그룹은 4자: {k}");
        assert!(
            k.chars().all(|c| c == '-' || B32.contains(&(c as u8))),
            "base32 글자만 나와야 한다: {k}"
        );
    }

    #[test]
    fn recovery_keys_are_not_repeated() {
        assert_ne!(make_recovery_key(), make_recovery_key());
    }

    #[test]
    fn recovery_input_is_normalized_the_same_way_it_was_made() {
        // 사용자가 하이픈을 빼거나 소문자로 적어도 같은 키로 읽혀야 한다.
        let k = make_recovery_key();
        let plain = normalize_recovery(&k);
        assert_eq!(normalize_recovery(&k.to_lowercase()), plain);
        assert_eq!(normalize_recovery(&k.replace('-', " ")), plain);
        assert_eq!(normalize_recovery(&format!("  {k}  ")), plain);
        assert_eq!(plain.len(), 32);
    }

    #[test]
    fn wrapped_dek_opens_with_the_master() {
        let mut vf = VaultFile::default();
        let dek = [9u8; 32];
        wrap_dek(&mut vf, &dek, "master!").unwrap();
        let salt = B64.decode(&vf.salt).unwrap();
        let got = decrypt(&derive_key("master!", &salt), &vf.wrapped_dek).unwrap();
        assert_eq!(to_key(got).unwrap(), dek);
        assert_eq!(vf.version, VERSION_V2);
        assert!(vf.verifier.is_empty(), "v2 에서는 verifier 를 쓰지 않는다");
    }

    #[test]
    fn wrapped_dek_opens_with_the_recovery_key() {
        // 마스터를 잊었을 때 남는 유일한 길 — 여기가 어긋나면 복구가 불가능해진다.
        let mut vf = VaultFile::default();
        let dek = [4u8; 32];
        let recovery = wrap_dek(&mut vf, &dek, "master!").unwrap();
        let rsalt = B64.decode(&vf.recovery_salt).unwrap();
        let key = derive_key(&normalize_recovery(&recovery), &rsalt);
        let got = decrypt(&key, &vf.recovery_wrapped_dek).unwrap();
        assert_eq!(to_key(got).unwrap(), dek);
    }

    #[test]
    fn rewrapping_keeps_the_same_dek_so_entries_stay_readable() {
        // 마스터를 바꿔도 항목은 다시 암호화하지 않는다(키만 다시 감싼다). DEK 가 바뀌면
        // 저장해 둔 비밀번호가 통째로 읽히지 않게 된다.
        let mut vf = VaultFile::default();
        let dek = [5u8; 32];
        wrap_dek(&mut vf, &dek, "old").unwrap();
        let entry = encrypt(&dek, "저장된 비밀번호".as_bytes()).unwrap();
        wrap_dek(&mut vf, &dek, "new").unwrap();
        let salt = B64.decode(&vf.salt).unwrap();
        let opened = to_key(decrypt(&derive_key("new", &salt), &vf.wrapped_dek).unwrap()).unwrap();
        assert_eq!(decrypt(&opened, &entry).unwrap(), "저장된 비밀번호".as_bytes());
    }

    #[test]
    fn rewrapping_invalidates_the_old_master_and_old_recovery_key() {
        let mut vf = VaultFile::default();
        let dek = [6u8; 32];
        let old_recovery = wrap_dek(&mut vf, &dek, "old").unwrap();
        wrap_dek(&mut vf, &dek, "new").unwrap();
        let salt = B64.decode(&vf.salt).unwrap();
        assert!(decrypt(&derive_key("old", &salt), &vf.wrapped_dek).is_err());
        let rsalt = B64.decode(&vf.recovery_salt).unwrap();
        let old_key = derive_key(&normalize_recovery(&old_recovery), &rsalt);
        assert!(decrypt(&old_key, &vf.recovery_wrapped_dek).is_err());
    }

    #[test]
    fn locked_vault_refuses_to_hand_out_the_dek() {
        let state = VaultState::default();
        assert!(current_dek(&state).is_err());
        *state.dek.lock().unwrap() = Some([1u8; 32]);
        assert_eq!(current_dek(&state).unwrap(), [1u8; 32]);
    }
}
