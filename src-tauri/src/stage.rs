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
pub fn sweep() {
    let temp = std::env::temp_dir();
    let Ok(rd) = fs::read_dir(&temp) else { return };
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().starts_with(PREFIX) {
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
