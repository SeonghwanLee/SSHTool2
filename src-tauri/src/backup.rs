//! 설정 내보내기/가져오기 + 완전 초기화 (WPF 0.23.0 / 0.30.0 대응).
//!
//! 설정 폴더의 파일들(세션·설정·볼트·알려진 호스트)을 JSON 번들 하나로 묶는다.
//! 비밀번호류는 **마스터 비밀번호로 암호화된 상태 그대로** 담기므로 번들에 평문 비밀은 없다.
//! 가져온 뒤에는 번들을 만든 PC 의 마스터 비밀번호로 잠금 해제해야 한다.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 경로 확인 실패: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더 생성 실패: {e}"))?;
    Ok(dir)
}

/// 설정 폴더의 파일들을 번들로 묶어 지정 경로에 저장한다.
pub fn export(app: &AppHandle, target: &str) -> Result<usize, String> {
    let dir = config_dir(app)?;
    let mut files = std::collections::BTreeMap::new();
    for name in FILES {
        let p = dir.join(name);
        if let Ok(content) = fs::read_to_string(&p) {
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
    let data = serde_json::to_string_pretty(&bundle).map_err(|e| format!("직렬화 실패: {e}"))?;
    fs::write(target, data).map_err(|e| format!("내보내기 실패: {e}"))?;
    Ok(count)
}

/// 번들을 읽어 설정 폴더에 복원한다. 기존 파일은 import_backup/ 으로 먼저 옮겨 보관한다.
pub fn import(app: &AppHandle, source: &str) -> Result<usize, String> {
    let raw = fs::read_to_string(source).map_err(|e| format!("번들 읽기 실패: {e}"))?;
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

    let mut restored = 0usize;
    for (name, content) in &bundle.files {
        // 번들 안의 파일명은 화이트리스트만 허용(경로 조작 방지).
        if !FILES.contains(&name.as_str()) {
            continue;
        }
        fs::write(dir.join(name), content).map_err(|e| format!("{name} 복원 실패: {e}"))?;
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
