//! 세션 목록 영속화. 앱 설정 디렉터리의 sessions.json 에 평문 JSON 으로 저장한다.
//! 비밀번호는 여기 담지 않는다 — 자격증명은 별도 볼트(vault.rs, AES-GCM)에 암호화 보관.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 패턴 감지 → 자동 입력 규칙. 평문 저장이므로 비밀번호를 넣지 않도록 UI 에서 경고한다.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRule {
    pub pattern: String,
    pub send: String,
    #[serde(default)]
    pub regex: bool,
}

/// 저장되는 세션 정의. JS(프론트)와 camelCase 로 1:1.
/// 신규 필드는 모두 #[serde(default)] — 기존 sessions.json 을 그대로 읽을 수 있어야 한다.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// 저장 세션의 안정적 식별자(접속 때마다 바뀌는 live id 와 다름).
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 사이드바 트리 폴더 경로. "" = 루트, "a/b" = 중첩.
    #[serde(default)]
    pub folder: String,
    /// true 면 접속 성공 시 비밀번호를 볼트에 저장(볼트 기능에서 사용).
    #[serde(default)]
    pub save_password: bool,
    /// 같은 폴더 안에서의 수동 정렬 순서(작을수록 위).
    #[serde(default)]
    pub sort_order: i32,
    /// 터미널 문자셋("UTF-8" | "EUC-KR" | "CP949").
    #[serde(default = "default_charset")]
    pub charset: String,
    /// 접속 직후 자동 실행할 명령(줄바꿈 구분).
    #[serde(default)]
    pub startup_commands: String,
    /// 패턴 감지 자동 입력 규칙.
    #[serde(default)]
    pub triggers: Vec<TriggerRule>,
}

fn default_charset() -> String {
    "UTF-8".to_string()
}

fn sessions_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 경로 확인 실패: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더 생성 실패: {e}"))?;
    Ok(dir.join("sessions.json"))
}

pub fn load(app: &AppHandle) -> Result<Vec<SessionInfo>, String> {
    let path = sessions_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("세션 파일 읽기 실패: {e}"))?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&data).map_err(|e| format!("세션 파일 파싱 실패: {e}"))
}

pub fn save(app: &AppHandle, sessions: Vec<SessionInfo>) -> Result<(), String> {
    let path = sessions_path(app)?;
    let data =
        serde_json::to_string_pretty(&sessions).map_err(|e| format!("세션 직렬화 실패: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("세션 파일 쓰기 실패: {e}"))
}

// ── 앱 설정(테마·폰트 등). 스키마는 프론트가 소유 → serde_json::Value 로 통째 저장. ──

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 경로 확인 실패: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더 생성 실패: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> Result<serde_json::Value, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(serde_json::Value::Object(Default::default()));
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("설정 읽기 실패: {e}"))?;
    if data.trim().is_empty() {
        return Ok(serde_json::Value::Object(Default::default()));
    }
    serde_json::from_str(&data).map_err(|e| format!("설정 파싱 실패: {e}"))
}

pub fn save_settings(app: &AppHandle, value: serde_json::Value) -> Result<(), String> {
    let path = settings_path(app)?;
    let data = serde_json::to_string_pretty(&value).map_err(|e| format!("설정 직렬화 실패: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("설정 쓰기 실패: {e}"))
}
