//! 설정 폴더 경로. identifier 폴더(예: %APPDATA%\com.seonghwanlee.sshtool2) 대신
//! **제품명 폴더**(%APPDATA%\SSHTool2)를 쓴다. 최초 1회 구 폴더의 상태 파일을 복사해 오되
//! **구 폴더는 그대로 보존**한다(문제 시 기존 데이터가 남아 안전).

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const APP_DIR: &str = "SSHTool2";
/// 새 폴더로 1회 복사할 상태 파일(볼트·세션·설정·알려진 호스트).
const MIGRATE: [&str; 4] = ["sessions.json", "settings.json", "vault.json", "known_hosts.json"];

/// 임시 파일에 쓴 뒤 제자리로 옮긴다.
///
/// `fs::write` 는 대상 파일을 먼저 0바이트로 자르므로, 쓰는 도중 크래시하거나 전원이 나가면
/// 내용이 통째로 사라진다. 세션 목록·설정·알려진 호스트는 한 파일이 곧 전부여서 그 손실이
/// 곧바로 데이터 유실이 된다. rename 은 같은 볼륨에서 원자적이라 절단 상태가 생기지 않는다.
pub fn write_atomic(path: &PathBuf, data: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| format!("임시 파일 쓰기 실패({}): {e}", tmp.display()))?;
    // fs::rename 은 Windows 에서도 기존 파일을 덮어쓴다(MOVEFILE_REPLACE_EXISTING).
    // 미리 지우면 파일이 없는 순간이 생겨 원자성이 깨지므로 그대로 교체한다.
    fs::rename(&tmp, path).map_err(|e| format!("파일 교체 실패({}): {e}", path.display()))
}

/// 설정 루트 폴더를 반환하고, 없으면 생성한다(필요 시 구 폴더에서 1회 이전 복사).
pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let id_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 경로 확인 실패: {e}"))?;
    let base = id_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| id_dir.clone());
    let dir = base.join(APP_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더 생성 실패: {e}"))?;

    // 구 identifier 폴더의 상태 파일을 새 폴더로 1회 이전(구 폴더는 보존).
    // '.migrated' 마커가 생기기 전까지는 매 실행마다 '없는 파일만' 복사한다 →
    // 첫 이전이 중간에 끊겨도(전원 차단 등) 다음 실행에서 재개된다. 모든 대상이 복사되면
    // 마커를 남겨 이후엔 이전하지 않는다(정상 사용 중 사용자가 지운 파일을 되살리지 않도록).
    let marker = dir.join(".migrated");
    if !marker.exists() && id_dir != dir && id_dir.exists() {
        let mut complete = true;
        for name in MIGRATE {
            let src = id_dir.join(name);
            let dst = dir.join(name);
            if src.exists() && !dst.exists() && fs::copy(&src, &dst).is_err() {
                complete = false; // 복사 실패 — 마커를 남기지 않고 다음 실행에서 재시도
            }
        }
        if complete {
            let _ = fs::write(&marker, b"1");
        }
    }
    Ok(dir)
}

/// Result 대신 Option 이 필요한 곳(로그 경로 등)용.
pub fn config_dir_opt(app: &AppHandle) -> Option<PathBuf> {
    config_dir(app).ok()
}
