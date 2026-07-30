//! 웹 서비스 열기 — 세션 호스트의 특정 포트를 브라우저로 연다.
//!
//! 브라우저는 열거값만 받는다. 임의 실행 파일 경로를 받으면 이 커맨드가 "아무 프로그램이나
//! 실행하는 통로"가 돼버린다 — 프런트가 뚫리는 날 곧장 코드 실행으로 이어진다.
//!
//! URL 은 http/https 만 허용한다. 스킴을 열어 두면 file:// 로 로컬 파일을 읽히거나
//! 사용자 정의 프로토콜 핸들러를 두드리는 자리가 된다. 값 검증은 여기(백엔드)에서 한다 —
//! 프런트 검증은 UX 용이지 방어선이 아니다.

/// 허용 스킴 검사. 대소문자 무시, 앞뒤 공백·제어문자 거부.
fn validate_url(url: &str) -> Result<(), String> {
    let u = url.trim();
    if u != url || u.chars().any(|c| c.is_control() || c == ' ') {
        return Err("URL 에 공백이나 제어문자가 있습니다.".into());
    }
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("http/https 주소만 열 수 있습니다.".into());
    }
    Ok(())
}

/// 브라우저를 띄운다. 앱은 기다리지 않는다.
pub fn open(browser: String, url: String) -> Result<(), String> {
    validate_url(&url)?;

    #[cfg(windows)]
    {
        match browser.as_str() {
            // OS 기본 브라우저. cmd /c start 는 URL 의 & 를 명령 구분자로 먹는 함정이 있어
            // rundll32 의 프로토콜 핸들러 경로를 쓴다(인자를 그대로 넘긴다).
            "default" => {
                std::process::Command::new("rundll32.exe")
                    .args(["url.dll,FileProtocolHandler", &url])
                    .spawn()
                    .map_err(|e| format!("기본 브라우저 실행 실패: {e}"))?;
            }
            "chrome" | "edge" => {
                let exe = find_browser(&browser)
                    .ok_or_else(|| format!("{} 를 찾지 못했습니다. 설치돼 있는지 확인하세요.", pretty(&browser)))?;
                std::process::Command::new(exe)
                    .arg(&url)
                    .spawn()
                    .map_err(|e| format!("{} 실행 실패: {e}", pretty(&browser)))?;
            }
            other => return Err(format!("지원하지 않는 브라우저: {other}")),
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (browser, url);
        Err("웹 서비스 열기는 Windows 에서만 지원합니다.".into())
    }
}

#[cfg(windows)]
fn pretty(browser: &str) -> &'static str {
    match browser {
        "chrome" => "Chrome",
        "edge" => "Edge",
        _ => "브라우저",
    }
}

/// 레지스트리 App Paths 에서 브라우저 실행 파일을 찾는다. 설치 방식(시스템/사용자)과
/// 무관하게 등록되는 표준 위치라 경로를 하드코딩하는 것보다 견고하다. 없으면 대표
/// 설치 경로 두 곳을 마저 본다.
#[cfg(windows)]
fn find_browser(browser: &str) -> Option<std::path::PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let exe = match browser {
        "chrome" => "chrome.exe",
        "edge" => "msedge.exe",
        _ => return None,
    };
    let subkey = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        if let Ok(key) = RegKey::predef(hive).open_subkey(&subkey) {
            // 기본값("")이 실행 파일 전체 경로다.
            if let Ok(path) = key.get_value::<String, _>("") {
                let p = std::path::PathBuf::from(path.trim_matches('"'));
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    // 레지스트리에 없을 때의 마지막 시도 — 대표 설치 위치.
    let candidates: &[String] = &[
        format!(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        format!(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        format!(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        format!(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ];
    candidates
        .iter()
        .filter(|p| p.to_ascii_lowercase().contains(&exe[..exe.len() - 4]))
        .map(std::path::PathBuf::from)
        .find(|p| p.exists())
}
