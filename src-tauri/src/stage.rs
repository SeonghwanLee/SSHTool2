// 탐색기 드래그앤드롭 스테이징 — 웹뷰는 드롭된 파일의 OS 경로를 주지 않으므로
// (경로를 주는 네이티브 드롭을 켜면 앱 내부 HTML5 드래그가 전부 죽는다), 파일 내용을
// 조각으로 받아 임시 폴더에 복원한 뒤 기존 SFTP 업로드 경로에 태운다.
// 쓰기는 항상 %TEMP%/sshtool2-drop-* 아래로만 제한한다 — 웹뷰가 주는 경로를 그대로
// 믿고 쓰면 임의 파일 덮어쓰기 통로가 된다.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const PREFIX: &str = "sshtool2-drop-";

/// %XX 퍼센트 인코딩 해제(UTF-8). invoke 헤더는 ASCII 만 안전해서
/// 한글 경로를 encodeURIComponent 로 보내고 여기서 되돌린다.
fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3).ok_or("잘린 퍼센트 인코딩")?;
            let hv = std::str::from_utf8(hex)
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or("퍼센트 인코딩 오류")?;
            out.push(hv);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "UTF-8 이 아닙니다".into())
}

/// 대상 경로 검증 — 임시 폴더의 sshtool2-drop-* 바로 아래이고, 성분에 .. 등이 없어야 한다.
fn checked(path: &str, temp: &Path) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let rel = p
        .strip_prefix(temp)
        .map_err(|_| "임시 폴더 밖 경로는 쓸 수 없습니다".to_string())?;
    match rel.components().next() {
        Some(Component::Normal(first)) if first.to_string_lossy().starts_with(PREFIX) => {}
        _ => return Err("스테이징 폴더가 아닙니다".into()),
    }
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("경로에 허용되지 않는 성분이 있습니다".into());
    }
    Ok(p)
}


/// 하루 지난 스테이징 잔재 제거 — 전송 중 강제 종료되면 임시 폴더가 남는다.
/// 정상 흐름은 전송 직후 프론트가 지우므로, 여기는 사고 뒷정리 전용이다.
///
/// 업데이터 잔재도 같이 걷는다. tauri-plugin-updater 는 내려받은 인스톨러를
/// `%TEMP%/SSHTool2-<버전>-updater-<난수>/` 에 풀고 `.keep()` 으로 **일부러 남긴다**
/// — 앱이 죽은 뒤 그 인스톨러가 실행돼야 하므로 자기가 지울 수 없다. 그래서 업데이트
/// 할 때마다 8MB 짜리 폴더가 하나씩 쌓인다. 지금 실행 중인 버전의 것은 건드리지
/// 않는다(방금 설치를 끝낸 그 폴더일 수 있다).
pub fn sweep() {
    let temp = std::env::temp_dir();
    let Ok(rd) = fs::read_dir(&temp) else { return };
    for e in rd.flatten() {
        if !is_sweepable(&e.file_name().to_string_lossy(), env!("CARGO_PKG_VERSION")) {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|d| d.as_secs() > 24 * 3600);
        if old {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// 지워도 되는 임시 폴더 이름인가 — 나이 판단은 호출부가 한다.
/// 이름만 보고 정하므로 여기에만 규칙을 두고 시험한다.
fn is_sweepable(name: &str, current_version: &str) -> bool {
    if name.starts_with(PREFIX) {
        return true;
    }
    let updater = name.starts_with("SSHTool2-") && name.contains("-updater-");
    updater && !name.contains(&format!("-{current_version}-updater-"))
}

#[cfg(test)]
mod tests {
    use super::is_sweepable;

    #[test]
    fn 드롭_스테이징과_지난_업데이터만_걷는다() {
        // 드롭 스테이징은 버전과 무관하게 대상이다.
        assert!(is_sweepable("sshtool2-drop-abc123", "0.76.4"));
        // 지난 버전의 업데이터 잔재 — 8MB 인스톨러가 들어 있다.
        assert!(is_sweepable("SSHTool2-0.76.2-updater-Xy9", "0.76.4"));
        // 지금 도는 버전의 것은 방금 설치를 끝낸 그 폴더일 수 있어 남긴다.
        assert!(!is_sweepable("SSHTool2-0.76.4-updater-Xy9", "0.76.4"));
        // 남의 폴더는 절대 건드리지 않는다.
        assert!(!is_sweepable("SSHTool2Backup", "0.76.4"));
        assert!(!is_sweepable("chrome_installer", "0.76.4"));
        assert!(!is_sweepable("SSHTool2-0.76.2-installer.exe", "0.76.4"));
    }
}
