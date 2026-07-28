//! 진단 로그 — `<설정폴더>/debug.log`.
//!
//! 세션별 로그(`enableLog`)와는 다른 물건이다. 그쪽은 "이 세션에서 무엇을 했나"를 남기는
//! 기록이고, 이쪽은 "앱이 왜 그렇게 동작했나"를 쫓기 위한 것이다 — 접속·끊김, 터미널이
//! 받은 원시 바이트, 프런트에서 터진 예외가 시각과 함께 한 줄기로 들어온다.
//!
//! **기본은 꺼져 있다.** 터미널이 받은 바이트를 그대로 적으므로 화면에 뜬 설정값·키·토큰이
//! 그대로 파일에 남는다. 켤 때마다 파일을 새로 시작하는 것도 그래서다 — 예전 세션의 내용이
//! 남아 있으면 문제를 재현해 넘길 때 무엇이 딸려 가는지 알 수 없다.
//!
//! 프런트가 줄을 모아 보낸다. 청크마다 IPC 를 부르면 출력이 많은 세션에서 호출만으로
//! 부담이 되므로, 모아서 한 번에 붙이는 쪽을 골랐다.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use tauri::AppHandle;

use crate::paths;

/// 파일이 이만큼 커지면 잘라내고 다시 시작한다. 진단은 최근 것이 중요하고,
/// 무한정 커지면 사용자 디스크를 갉아먹는다.
const MAX_BYTES: u64 = 20 * 1024 * 1024;

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(paths::config_dir(app)?.join("debug.log"))
}

/// 로그 파일 경로(설정 화면에서 '폴더 열기' 등에 쓴다). 폴더가 없으면 만든다.
pub fn path(app: &AppHandle) -> Result<String, String> {
    Ok(log_path(app)?.to_string_lossy().to_string())
}

/// 파일을 비우고 새로 시작한다. 로깅을 켜는 시점에 호출한다.
pub fn reset(app: &AppHandle) -> Result<(), String> {
    let path = log_path(app)?;
    let header = format!("=== SSHTool2 진단 로그 시작 {} ===\n", now());
    std::fs::write(&path, header).map_err(|e| format!("진단 로그 초기화 실패: {e}"))
}

/// 모아 둔 줄을 파일 끝에 붙인다.
pub fn append(app: &AppHandle, text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let path = log_path(app)?;

    // 너무 커졌으면 버리고 다시 시작한다. 회전(.1, .2)까지 두지 않는 이유는 이 파일이
    // 문제를 재현하는 동안에만 켜 두는 물건이라서다.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let _ = std::fs::write(
                &path,
                format!("=== 크기 한계({MAX_BYTES} 바이트)로 잘라냄 {} ===\n", now()),
            );
        }
    }

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("진단 로그 열기 실패: {e}"))?;
    f.write_all(text.as_bytes())
        .map_err(|e| format!("진단 로그 쓰기 실패: {e}"))
}

/// `YYYY-MM-DD HH:MM:SS` — 로컬 시각. 날짜 계산용 크레이트를 새로 들이지 않으려고
/// UTC 초에서 직접 환산한다(진단용이라 초 단위면 충분하다).
fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // 1970-01-01 부터의 일수를 연·월·일로 — 그레고리력 규칙 그대로.
    let mut year = 1970i64;
    let mut d = days as i64;
    loop {
        let len = if is_leap(year) { 366 } else { 365 };
        if d < len {
            break;
        }
        d -= len;
        year += 1;
    }
    let months = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for len in months {
        if d < len {
            break;
        }
        d -= len;
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{:02} {h:02}:{mi:02}:{s:02} UTC",
        d + 1
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
