//! 설정 파일 암호화 (AES-256-GCM) — sessions.json · settings.json.
//!
//! 키는 랜덤 32B 를 OS 자격증명 저장소(keystore.rs 의 "file-key")에 두고, 파일 맨 앞에
//! 매직 헤더(`STB2`+버전)를 붙여 평문과 구분한다. 매직이 없으면 이관 전 평문으로 읽고
//! 다음 저장에서 자동으로 암호문이 된다(사용자 조작 불필요).
//!
//! 막는 것: 파일이 **계정 밖으로 나가는 경로**(백업 SW·로밍 프로필·공유 폴더·USB·폴더째 전달).
//! 막지 못하는 것: 키가 OS 자격증명 저장소에 있으므로 **같은 계정으로 실행되는 코드는
//! 그대로 읽는다.** 이관해도 디스크에 남은 과거 평문 흔적은 지워지지 않는다.

use std::fs;
use std::path::Path;

use aes_gcm::aead::{rand_core::RngCore, Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};

/// 암호문 매직 + 버전. 백업 컨테이너(backup.rs 의 `STB1`)와는 별개의 형식이다.
const MAGIC: &[u8; 4] = b"STB2";
const VERSION: u8 = 1;
/// MAGIC(4) + 버전(1) + nonce(12)
const HEADER: usize = 17;

/// 이 모듈이 암호화하는 파일. 백업 내보내기/복원도 이 목록을 기준으로 복호/재암호화한다.
pub const MANAGED: [&str; 2] = ["sessions.json", "settings.json"];

const REFUSE: &str = "이미 암호화된 설정 파일이 있는데 이 계정의 저장 키를 읽지 못해 \
저장을 중단했습니다. 평문으로 덮어쓰면 암호화가 풀리고 기존 내용도 잃게 됩니다. \
OS 자격증명 저장소 접근을 확인한 뒤 다시 시도하거나, 백업에서 복원하세요.";

// ── 크립토 ────────────────────────────────────────────────────────────────────

fn seal(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12바이트
    let ct = cipher
        .encrypt(&nonce, plain)
        .map_err(|e| format!("설정 암호화 실패: {e}"))?;
    let mut out = Vec::with_capacity(HEADER + ct.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ct);
    Ok(out)
}

fn unseal(key: &[u8; 32], bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < HEADER {
        return Err("설정 파일이 손상되었습니다(길이 부족).".into());
    }
    if bytes[4] != VERSION {
        return Err("더 새로운 형식의 설정 파일입니다. 앱을 업데이트하세요.".into());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let pt = cipher
        .decrypt(Nonce::from_slice(&bytes[5..HEADER]), &bytes[HEADER..])
        .map_err(|_| "설정 파일을 복호화하지 못했습니다(키 불일치 또는 손상).".to_string())?;
    String::from_utf8(pt).map_err(|e| format!("설정 파일 인코딩 오류: {e}"))
}

// ── 키 ────────────────────────────────────────────────────────────────────────

fn to_key(raw: &[u8]) -> Result<[u8; 32], String> {
    <[u8; 32]>::try_from(raw).map_err(|_| "파일 키 길이가 올바르지 않습니다".to_string())
}

/// 저장된 파일 키. 없음=Ok(None), 접근 오류=Err — 둘을 섞으면 접근 오류를 '키 없음'으로
/// 오인해 평문으로 되돌아간다.
fn load_key() -> Result<Option<[u8; 32]>, String> {
    let Some(b64) = crate::keystore::load_file_key()? else {
        return Ok(None);
    };
    let raw = B64
        .decode(b64.trim())
        .map_err(|e| format!("파일 키 디코드 실패: {e}"))?;
    Ok(Some(to_key(&raw)?))
}

/// 새 키를 만들어 자격증명 저장소에 넣는다. 저장에 실패하면 그 키는 버린다 —
/// 다음 실행에서 읽을 수 없는 파일이 남으면 안 된다.
fn create_key() -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    crate::keystore::store_file_key(&B64.encode(key))?;
    Ok(key)
}

// ── 평문/암호문 판별 ──────────────────────────────────────────────────────────

fn is_encrypted(path: &Path) -> bool {
    fs::read(path).is_ok_and(|b| b.starts_with(MAGIC))
}

/// 같은 폴더의 관리 대상 중 하나라도 이미 암호문이면 true.
/// 한 파일만 보면, 아직 암호화되지 않은 쪽을 통해 평문 저장이 열려 버린다.
fn any_encrypted(dir: &Path) -> bool {
    MANAGED.iter().any(|name| is_encrypted(&dir.join(name)))
}

// ── 읽기/쓰기 ─────────────────────────────────────────────────────────────────

/// 설정 파일을 평문 문자열로 읽는다. 파일이 없거나 비었으면 Ok(None).
pub fn read_text(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| format!("설정 파일 읽기 실패: {e}"))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if !bytes.starts_with(MAGIC) {
        // 이관 전 평문 파일 — 그대로 읽는다(다음 저장에서 암호문이 된다).
        return String::from_utf8(bytes)
            .map(Some)
            .map_err(|e| format!("설정 파일 인코딩 오류: {e}"));
    }
    let key = load_key()?.ok_or_else(|| {
        "암호화된 설정 파일인데 이 계정의 저장 키를 찾을 수 없습니다. \
다른 PC·계정에서 복사해 온 파일이거나, 자격증명 저장소 항목이 삭제된 경우입니다."
            .to_string()
    })?;
    unseal(&key, &bytes).map(Some)
}

/// 설정 파일을 원자적으로 쓴다. 키가 있으면 암호화, 없으면 평문.
///
/// **다운그레이드 방지**: 이미 암호문인 설정 파일이 있는데 키를 얻지 못하면 평문으로
/// 덮어쓰지 않고 저장을 거부한다. 이 조건이 없으면 자격증명 항목만 지워서 암호화를 끌 수 있다.
/// 평문 폴백은 한 번도 암호화된 적 없는 최초 상태에서만 허용한다.
pub fn write_text(path: &Path, data: &str) -> Result<(), String> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let key = match load_key() {
        Ok(Some(k)) => Some(k),
        Ok(None) | Err(_) if any_encrypted(dir) => return Err(REFUSE.to_string()),
        // 최초 상태 — 키를 만들어 붙인다. 자격증명 저장소를 쓸 수 없는 환경이면 평문으로 둔다
        // (여기서 실패하고 끝내면 저장 자체가 불가능해진다).
        Ok(None) => create_key().ok(),
        // 접근 오류 + 암호문 없음 — 새 키를 만들면 기존 항목을 덮어쓸 위험이 있어 평문 유지.
        Err(_) => None,
    };
    match key {
        Some(k) => crate::paths::write_atomic_bytes(path, &seal(&k, data.as_bytes())?),
        None => crate::paths::write_atomic(path, data),
    }
}

/// 백업 복원 직전에 관리 대상 파일을 지운다.
///
/// 복원은 '전부 갈아엎기'라 다운그레이드 방지 조건에 걸릴 이유가 없는데, 키를 잃어
/// 읽지 못하게 된 암호문이 남아 있으면 write_text 가 저장을 거부해 **복구 자체가 막힌다**.
/// 호출 측이 원본을 import_backup/ 으로 옮긴 뒤에만 부른다.
pub fn clear_managed(dir: &Path) {
    for name in MANAGED {
        let _ = fs::remove_file(dir.join(name));
    }
}
