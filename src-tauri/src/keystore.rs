//! OS 키체인 저장 — '이 PC에서 자동 잠금 해제'용 (WPF 0.21.0 DPAPI 대응).
//!
//! 마스터 비밀번호를 OS 자격증명 저장소(Windows Credential Manager / macOS Keychain /
//! Linux keyutils)에 보관한다. OS 가 현재 사용자 계정으로 보호하므로 다른 PC·다른 계정에서는
//! 접근할 수 없다. 시작 시 여기서 마스터를 꺼내 볼트를 자동 해제한다.
//!
//! 같은 저장소에 설정 파일 암호화 키(filecrypt)도 별도 항목으로 둔다.

use keyring::{Entry, Error};

const SERVICE: &str = "com.seonghwanlee.sshtool2";
const ACCOUNT: &str = "vault-master";
/// 설정 파일 암호화 키(filecrypt). 마스터와 용도가 달라 항목을 분리한다 —
/// 마스터 자동해제를 꺼도 파일 암호화는 유지돼야 한다.
const ACCOUNT_FILE_KEY: &str = "file-key";

fn entry_of(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("키체인 접근 실패: {e}"))
}

fn read(account: &str) -> Result<Option<String>, String> {
    match entry_of(account)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("키체인 조회 실패: {e}")),
    }
}

pub fn store(secret: &str) -> Result<(), String> {
    entry_of(ACCOUNT)?
        .set_password(secret)
        .map_err(|e| format!("키체인 저장 실패: {e}"))
}

/// 저장된 마스터. 없음=Ok(None), 접근 오류(잠김 등)=Err — '없음'과 구분한다.
pub fn load() -> Result<Option<String>, String> {
    read(ACCOUNT)
}

pub fn clear() -> Result<(), String> {
    match entry_of(ACCOUNT)?.delete_credential() {
        Ok(_) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("키체인 삭제 실패: {e}")),
    }
}

/// true = 항목 있음, false = 확실히 없음, Err = 접근 불가(오인 방지).
pub fn has() -> Result<bool, String> {
    Ok(load()?.is_some())
}

// ── 설정 파일 암호화 키 ───────────────────────────────────────────────────────

/// 파일 키(base64) 저장. 이미 있으면 덮어쓴다.
pub fn store_file_key(key_b64: &str) -> Result<(), String> {
    entry_of(ACCOUNT_FILE_KEY)?
        .set_password(key_b64)
        .map_err(|e| format!("파일 키 저장 실패: {e}"))
}

/// 파일 키(base64). 없음=Ok(None), 접근 오류=Err — 여기서 둘을 섞으면
/// 접근 오류를 '키 없음'으로 오인해 평문으로 덮어쓸 수 있다.
pub fn load_file_key() -> Result<Option<String>, String> {
    read(ACCOUNT_FILE_KEY)
}
