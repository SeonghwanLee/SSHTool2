//! 설정 내보내기/가져오기 + 완전 초기화 (WPF 0.23.0 / 0.30.0 대응).
//!
//! 설정 폴더의 파일들(세션·설정·볼트·알려진 호스트)을 하나의 번들로 묶는다.
//! 비밀번호류는 볼트에서 마스터로 암호화된 상태이지만, 세션의 **호스트 IP·사용자명 등은
//! 평문**이라 번들 전체를 사용자 **패스프레이즈로 암호화한 바이너리**로 저장한다.
//! (구버전 평문 JSON 백업도 가져오기는 계속 지원 — 매직바이트로 형식 자동 판별)
//!
//! 세션·설정 파일은 filecrypt 로 암호화돼 있고 그 키는 **PC마다 다르다**. 암호화된 채로
//! 담으면 다른 PC 에서 복원할 수 없으므로, 내보낼 때 복호화해 담고 복원할 때 그 PC 의 키로
//! 다시 암호화한다. 번들 자체는 어차피 패스프레이즈로 암호화되므로 보호 수준은 그대로다.

use std::fs;
use std::path::PathBuf;

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use tauri::AppHandle;

/// 암호화 백업 컨테이너 매직 + 버전. 이 바이트로 시작하면 암호화 형식으로 판별한다.
const MAGIC: &[u8; 4] = b"STB1";
const ENC_VERSION: u8 = 1;
const KDF_ROUNDS: u32 = 300_000;

fn derive_key(pass: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha512>(pass.as_bytes(), salt, KDF_ROUNDS, &mut key);
    key
}

/// 번들 JSON 을 패스프레이즈로 암호화 → [MAGIC|ver|salt(16)|nonce(12)|ciphertext] 바이너리.
fn encrypt_bundle(plain: &str, password: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12 bytes
    let ct = cipher
        .encrypt(&nonce, plain.as_bytes())
        .map_err(|e| format!("암호화 실패: {e}"))?;
    let mut out = Vec::with_capacity(4 + 1 + 16 + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.push(ENC_VERSION);
    out.extend_from_slice(&salt);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 암호화 바이너리 → 번들 JSON 문자열.
fn decrypt_bundle(bytes: &[u8], password: &str) -> Result<String, String> {
    if bytes.len() < 4 + 1 + 16 + 12 {
        return Err("백업 파일이 손상되었습니다.".into());
    }
    if bytes[4] != ENC_VERSION {
        return Err("지원하지 않는 백업 버전입니다. 앱을 업데이트하세요.".into());
    }
    let salt = &bytes[5..21];
    let nonce = &bytes[21..33];
    let ct = &bytes[33..];
    let key = derive_key(password, salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "암호가 올바르지 않거나 파일이 손상되었습니다.".to_string())?;
    String::from_utf8(pt).map_err(|e| format!("복호 데이터 오류: {e}"))
}

/// 번들에 담는 파일 목록. 기기에 묶인 상태(전송 취소 플래그 등)는 담지 않는다.
const FILES: [&str; 4] = [
    "sessions.json",
    "settings.json",
    "vault.json",
    "known_hosts.json",
];

const BUNDLE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Bundle {
    version: u32,
    /// 파일명 → 내용(UTF-8 텍스트 그대로)
    files: std::collections::BTreeMap<String, String>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::paths::config_dir(app)
}

/// 설정 폴더 파일들을 번들로 묶어 암호화한 바이트와 파일 수를 만든다(export / export_zip 공용).
fn build_encrypted(app: &AppHandle, password: &str) -> Result<(Vec<u8>, usize), String> {
    if password.chars().count() < 12 {
        return Err("백업 암호는 12자 이상이어야 합니다.".into());
    }
    let dir = config_dir(app)?;
    let mut files = std::collections::BTreeMap::new();
    for name in FILES {
        let p = dir.join(name);
        // 읽기에 실패하면 조용히 건너뛰지 않고 중단한다 — 세션이 빠진 '반쪽 백업'은
        // 정작 복원할 때가 되어서야 드러난다.
        if let Some(content) = crate::filecrypt::read_text(&p)? {
            files.insert(name.to_string(), content);
        }
    }
    if files.is_empty() {
        return Err("내보낼 설정이 없습니다".into());
    }
    let count = files.len();
    let bundle = Bundle {
        version: BUNDLE_VERSION,
        files,
    };
    let data = serde_json::to_string(&bundle).map_err(|e| format!("직렬화 실패: {e}"))?;
    let bytes = encrypt_bundle(&data, password)?;
    Ok((bytes, count))
}

/// 설정 폴더의 파일들을 번들로 묶어 **패스프레이즈로 암호화**해 지정 경로에 저장한다.
pub fn export(app: &AppHandle, target: &str, password: &str) -> Result<usize, String> {
    let (bytes, count) = build_encrypted(app, password)?;
    fs::write(target, bytes).map_err(|e| format!("내보내기 실패: {e}"))?;
    Ok(count)
}

/// ZIP 내보내기 결과. app_included=false 면 오프라인 등으로 앱은 빠지고 백업만 담겼다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipResult {
    pub count: usize,
    pub app_included: bool,
}

/// GitHub 최신 릴리스의 Windows 설치본(.exe)을 내려받는다. 실패(오프라인 등) 시 Err.
fn download_latest_installer() -> Result<(String, Vec<u8>), String> {
    use std::io::Read;
    use std::time::Duration;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(6))
        .timeout(Duration::from_secs(180))
        .build();
    let api = "https://api.github.com/repos/SeonghwanLee/SSHTool2/releases/latest";
    let body = agent
        .get(api)
        .set("User-Agent", "SSHTool2")
        .call()
        .map_err(|e| format!("릴리스 조회 실패: {e}"))?
        .into_string()
        .map_err(|e| format!("릴리스 응답 읽기 실패: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("릴리스 파싱 실패: {e}"))?;
    let assets = json["assets"]
        .as_array()
        .ok_or("릴리스 에셋 목록이 없습니다".to_string())?;
    // NSIS 설치본(-setup.exe) 우선, 없으면 임의의 .exe(.sig 제외).
    let pick = assets
        .iter()
        .find(|a| {
            a["name"]
                .as_str()
                .is_some_and(|n| n.ends_with(".exe") && n.contains("setup"))
        })
        .or_else(|| {
            assets
                .iter()
                .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(".exe")))
        })
        .ok_or("설치 파일(.exe)을 찾지 못했습니다".to_string())?;
    let name = pick["name"].as_str().unwrap_or("SSHTool2-setup.exe").to_string();
    let url = pick["browser_download_url"]
        .as_str()
        .ok_or("다운로드 URL 이 없습니다".to_string())?;
    let mut buf = Vec::new();
    agent
        .get(url)
        .set("User-Agent", "SSHTool2")
        .call()
        .map_err(|e| format!("설치본 다운로드 실패: {e}"))?
        .into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("설치본 읽기 실패: {e}"))?;
    Ok((name, buf))
}

/// [암호화 백업 + GitHub 최신 설치본] 을 ZIP 하나로 저장한다. 오프라인이면 앱은 제외.
pub fn export_zip(app: &AppHandle, target: &str, password: &str) -> Result<ZipResult, String> {
    use std::io::Write;
    let (bytes, count) = build_encrypted(app, password)?;
    let file = fs::File::create(target).map_err(|e| format!("ZIP 생성 실패: {e}"))?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zw.start_file("sshtool2-backup.stbak", opts)
        .map_err(|e| format!("ZIP 쓰기 실패: {e}"))?;
    zw.write_all(&bytes)
        .map_err(|e| format!("ZIP 쓰기 실패: {e}"))?;
    // 최신 설치본은 있으면 담고, 실패(오프라인 등)면 조용히 건너뛴다.
    let app_included = match download_latest_installer() {
        Ok((name, installer)) => {
            zw.start_file(&name, opts)
                .map_err(|e| format!("ZIP 쓰기 실패: {e}"))?;
            zw.write_all(&installer)
                .map_err(|e| format!("ZIP 쓰기 실패: {e}"))?;
            true
        }
        Err(_) => false,
    };
    zw.finish().map_err(|e| format!("ZIP 마무리 실패: {e}"))?;
    Ok(ZipResult {
        count,
        app_included,
    })
}

/// 번들을 읽어 설정 폴더에 복원한다. 기존 파일은 import_backup/ 으로 먼저 옮겨 보관한다.
/// 암호화(신규) 형식이면 password 로 복호, 매직바이트가 없으면 구버전 평문 JSON 으로 처리한다.
pub fn import(app: &AppHandle, source: &str, password: &str) -> Result<usize, String> {
    let bytes = fs::read(source).map_err(|e| format!("번들 읽기 실패: {e}"))?;
    let raw = if bytes.starts_with(MAGIC) {
        if password.trim().is_empty() {
            return Err("암호화된 백업입니다. 암호를 입력하세요.".into());
        }
        decrypt_bundle(&bytes, password)?
    } else {
        // 구버전 평문 JSON 번들(하위 호환).
        String::from_utf8(bytes).map_err(|e| format!("번들 읽기 실패: {e}"))?
    };
    let bundle: Bundle = serde_json::from_str(&raw).map_err(|e| format!("번들 파싱 실패: {e}"))?;
    if bundle.version > BUNDLE_VERSION {
        return Err("더 새로운 버전의 백업입니다. 앱을 업데이트하세요.".into());
    }

    let dir = config_dir(app)?;
    // 되돌릴 수 있도록 기존 설정을 먼저 보관한다.
    let backup = dir.join("import_backup");
    fs::create_dir_all(&backup).map_err(|e| format!("백업 폴더 생성 실패: {e}"))?;
    for name in FILES {
        let p = dir.join(name);
        if p.exists() {
            let _ = fs::copy(&p, backup.join(name));
        }
    }

    // 원본을 보관한 뒤 세션·설정 파일을 치운다. 키를 잃어 읽지 못하게 된 암호문이 남아 있으면
    // 다운그레이드 방지 조건이 저장을 막아 복구 자체가 불가능해진다.
    crate::filecrypt::clear_managed(&dir);

    let mut restored = 0usize;
    for (name, content) in &bundle.files {
        // 번들 안의 파일명은 화이트리스트만 허용(경로 조작 방지).
        if !FILES.contains(&name.as_str()) {
            continue;
        }
        let target = dir.join(name);
        // 세션·설정은 이 PC 의 파일 키로 다시 암호화한다(번들 안에서는 평문).
        if crate::filecrypt::MANAGED.contains(&name.as_str()) {
            crate::filecrypt::write_text(&target, content)?;
        } else {
            fs::write(&target, content).map_err(|e| format!("{name} 복원 실패: {e}"))?;
        }
        restored += 1;
    }
    Ok(restored)
}

/// 설정 폴더 전체를 지운다(세션·볼트·설정·로그). 다음 실행은 첫 설치 상태가 된다.
pub fn factory_reset(app: &AppHandle) -> Result<(), String> {
    let dir = config_dir(app)?;
    for entry in fs::read_dir(&dir).map_err(|e| format!("설정 폴더 열기 실패: {e}"))? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let _ = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
    }
    Ok(())
}
