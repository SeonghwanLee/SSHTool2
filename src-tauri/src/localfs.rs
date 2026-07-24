//! 로컬 파일시스템 탐색 — SFTP 4분할의 왼쪽(로컬) 패널용.
//! 웹뷰는 파일시스템에 직접 접근할 수 없으므로 백엔드가 목록/조작을 대신한다.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// 수정 시각(unix 초, 알 수 없으면 0).
    pub modified: u64,
}

fn to_string(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// 시작 위치: 다운로드 폴더가 있으면 그곳, 없으면 홈.
pub fn default_dir() -> String {
    let home = dirs_home();
    let downloads = home.join("Downloads");
    if downloads.is_dir() {
        to_string(&downloads)
    } else {
        to_string(&home)
    }
}

fn dirs_home() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:/"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    }
}

/// 트리 루트 목록 — Windows 는 드라이브(C:/, D:/…), 그 외는 "/".
pub fn roots() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut out = Vec::new();
        for c in b'A'..=b'Z' {
            let drive = format!("{}:/", c as char);
            if Path::new(&drive).is_dir() {
                out.push(drive);
            }
        }
        if out.is_empty() {
            out.push("C:/".to_string());
        }
        out
    }
    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

pub fn list(path: &str) -> Result<Vec<LocalEntry>, String> {
    let dir = if path.trim().is_empty() {
        dirs_home()
    } else {
        PathBuf::from(path)
    };
    let rd = fs::read_dir(&dir).map_err(|e| format!("폴더를 열 수 없습니다: {e}"))?;

    let mut out = Vec::new();
    for entry in rd.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // 권한 없는 항목은 건너뜀
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(LocalEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: to_string(&entry.path()),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
        });
    }
    // 폴더 먼저, 그다음 이름순.
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// 상위 폴더 경로("" 이면 최상위라 더 올라갈 수 없음).
pub fn parent(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(to_string)
        .unwrap_or_else(|| path.to_string())
}

pub fn mkdir(path: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("폴더 생성 실패: {e}"))
}

pub fn remove(path: &str, is_dir: bool) -> Result<(), String> {
    if is_dir {
        fs::remove_dir_all(path).map_err(|e| format!("폴더 삭제 실패: {e}"))
    } else {
        fs::remove_file(path).map_err(|e| format!("파일 삭제 실패: {e}"))
    }
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| format!("이름 변경 실패: {e}"))
}

/// 해당 경로가 이미 존재하는지(충돌 확인용).
pub fn exists(path: &str) -> bool {
    Path::new(path).exists()
}
