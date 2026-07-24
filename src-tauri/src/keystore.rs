//! OS 키체인 저장 — '이 PC에서 자동 잠금 해제'용 (WPF 0.21.0 DPAPI 대응).
//!
//! 마스터 비밀번호를 OS 자격증명 저장소(Windows Credential Manager / macOS Keychain /
//! Linux keyutils)에 보관한다. OS 가 현재 사용자 계정으로 보호하므로 다른 PC·다른 계정에서는
//! 접근할 수 없다. 시작 시 여기서 마스터를 꺼내 볼트를 자동 해제한다.

use keyring::{Entry, Error};

const SERVICE: &str = "com.seonghwanlee.sshtool2";
const ACCOUNT: &str = "vault-master";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("키체인 접근 실패: {e}"))
}

pub fn store(secret: &str) -> Result<(), String> {
    entry()?
        .set_password(secret)
        .map_err(|e| format!("키체인 저장 실패: {e}"))
}

/// 저장된 마스터. 없음=Ok(None), 접근 오류(잠김 등)=Err — '없음'과 구분한다.
pub fn load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("키체인 조회 실패: {e}")),
    }
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(_) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("키체인 삭제 실패: {e}")),
    }
}

/// true = 항목 있음, false = 확실히 없음, Err = 접근 불가(오인 방지).
pub fn has() -> Result<bool, String> {
    Ok(load()?.is_some())
}
