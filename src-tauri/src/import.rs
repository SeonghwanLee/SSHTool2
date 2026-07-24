//! 외부 SSH 클라이언트(PuTTY·SecureCRT·MobaXterm)의 세션 가져오기.
//!
//! Host/Port/계정/폴더 구조만 가져온다 — 세 프로그램 모두 비밀번호는 미저장(PuTTY)이거나
//! 자체 암호화라 안전하게 옮길 수 없다. 빈 자격증명은 이 앱의 "첫 접속 시 입력 → 성공하면
//! 볼트 저장" 플로우가 채운다.
//!
//! 파서(`parse_securecrt_ini` / `parse_mobaxterm_ini`)는 순수 로직이라 OS 무관하게 동작하고,
//! 레지스트리를 쓰는 PuTTY 부분만 `#[cfg(windows)]` 뒤에 있다(비 Windows 는 빈 Vec).

use std::fs;
use std::path::{Path, PathBuf};

/// 가져온 세션 한 건. 프론트(JS)와 camelCase 로 1:1.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSession {
    /// "PuTTY" | "SecureCRT" | "MobaXterm"
    pub source: String,
    /// 원본 프로그램에서의 하위 폴더 경로. 없으면 "". "/" 구분자, 소스명은 포함하지 않는다.
    pub folder: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    /// 알 수 없으면 ""
    pub user: String,
}

const DEFAULT_PORT: u16 = 22;

/// 세 프로그램 전부 스캔. 한 소스가 없거나 읽기 실패해도 전체를 실패시키지 않고 건너뛴다.
pub fn scan() -> Vec<ImportedSession> {
    let mut found = Vec::new();
    found.extend(scan_putty());
    found.extend(scan_securecrt());
    found.extend(scan_mobaxterm());
    found
}

// ─────────────────────────── 공통: 인코딩 ───────────────────────────

/// BOM 존중, BOM 없으면 UTF-8 → CP949(EUC_KR) 폴백.
/// 구형 프로그램의 ini·레지스트리 문자열은 ANSI 코드페이지가 흔하다.
fn decode_bytes_best_effort(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return text.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        // encoding_rs 의 EUC_KR 은 CP949(확장 완성형)를 포함한다.
        Err(_) => encoding_rs::EUC_KR.decode(bytes).0.into_owned(),
    }
}

/// 파일을 바이트로 읽어 best-effort 디코딩. 읽기 실패는 None(해당 파일만 건너뜀).
fn read_text_best_effort(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|bytes| decode_bytes_best_effort(&bytes))
}

/// 1~65535 범위만 유효한 포트로 인정, 그 외에는 기본 22.
fn sanitize_port(value: u32) -> u16 {
    if value >= 1 && value <= u16::MAX as u32 {
        value as u16
    } else {
        DEFAULT_PORT
    }
}

// ─────────────────────────── PuTTY ───────────────────────────
// HKCU\Software\SimonTatham\PuTTY\Sessions — 서브키 1개 = 세션 1개, 키 이름이 세션명.

/// PuTTY 세션명 디코딩. `%XX` 이스케이프된 바이트는 UTF-8 이 아니라 저장 당시
/// ANSI 코드페이지(한국어 Windows = CP949)라서, 먼저 raw 바이트로 풀고
/// UTF-8 → CP949 순서로 디코딩해야 한글이 깨지지 않는다.
fn decode_putty_name(encoded: &str) -> String {
    let src = encoded.as_bytes();
    let mut bytes = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        let hex = (src.len() > i + 2)
            .then(|| std::str::from_utf8(&src[i + 1..i + 3]).ok())
            .flatten()
            .filter(|_| src[i] == b'%')
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(byte) => {
                bytes.push(byte);
                i += 3;
            }
            None => {
                bytes.push(src[i]);
                i += 1;
            }
        }
    }
    decode_bytes_best_effort(&bytes)
}

#[cfg(windows)]
fn scan_putty() -> Vec<ImportedSession> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\SimonTatham\PuTTY\Sessions")
    else {
        return Vec::new(); // PuTTY 미설치 — 조용히 건너뛴다.
    };

    root.enum_keys()
        .flatten()
        // PuTTY 의 전역 기본값 항목은 세션이 아니다.
        .filter(|key_name| !key_name.eq_ignore_ascii_case("Default%20Settings"))
        .filter_map(|key_name| {
            let key = root.open_subkey(&key_name).ok()?;
            putty_session_from_key(&key, &key_name)
        })
        .collect()
}

/// 서브키 1개 → 세션 1건. 값이 없거나 타입이 다르면 건너뛴다(패닉 없음).
#[cfg(windows)]
fn putty_session_from_key(key: &winreg::RegKey, key_name: &str) -> Option<ImportedSession> {
    // Protocol 값이 있고 ssh 가 아니면(telnet·serial 등) 제외. 값이 없으면 통과시킨다.
    let protocol: String = key.get_value("Protocol").unwrap_or_default();
    if !protocol.is_empty() && !protocol.eq_ignore_ascii_case("ssh") {
        return None;
    }

    let mut host: String = key
        .get_value::<String, _>("HostName")
        .unwrap_or_default()
        .trim()
        .to_string();
    if host.is_empty() {
        return None;
    }
    let mut user: String = key
        .get_value::<String, _>("UserName")
        .unwrap_or_default()
        .trim()
        .to_string();

    // PuTTY 는 "user@host" 를 HostName 에 통째로 담기도 한다.
    if user.is_empty() {
        if let Some((left, right)) = host.split_once('@') {
            if !left.is_empty() && !right.is_empty() {
                user = left.to_string();
                host = right.to_string();
            }
        }
    }

    let port = sanitize_port(key.get_value::<u32, _>("PortNumber").unwrap_or(0));

    Some(ImportedSession {
        source: "PuTTY".into(),
        folder: String::new(), // PuTTY 는 폴더 개념이 없다.
        name: decode_putty_name(key_name),
        host,
        port,
        user,
    })
}

/// 비 Windows: 레지스트리가 없으므로 항상 빈 목록(크레이트는 그대로 컴파일된다).
#[cfg(not(windows))]
fn scan_putty() -> Vec<ImportedSession> {
    let _ = decode_putty_name; // Windows 전용 경로에서만 쓰이는 헬퍼 — 미사용 경고 억제
    Vec::new()
}

// ─────────────────────────── SecureCRT ───────────────────────────
// %APPDATA%\VanDyke\Config\Sessions\**\*.ini — 디렉터리 구조가 곧 폴더 구조.

fn scan_securecrt() -> Vec<ImportedSession> {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(appdata).join("VanDyke").join("Config").join("Sessions");
    if !root.is_dir() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_ini_files(&root, &mut files);

    files
        .iter()
        .filter_map(|path| securecrt_session_from_file(&root, path))
        .collect()
}

/// .ini 파일 재귀 수집. 읽을 수 없는 디렉터리는 조용히 건너뛴다.
fn collect_ini_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_ini_files(&path, out);
        } else if has_ini_extension(&path) {
            out.push(path);
        }
    }
}

fn has_ini_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ini"))
}

fn securecrt_session_from_file(root: &Path, path: &Path) -> Option<ImportedSession> {
    let name = path.file_stem()?.to_str()?.to_string();
    // __FolderData__ 는 폴더 메타데이터, Default 는 신규 세션 템플릿 — 둘 다 세션이 아니다.
    if name == "__FolderData__" || name == "Default" {
        return None;
    }
    let folder = relative_folder(root, path);
    let content = read_text_best_effort(path)?;
    parse_securecrt_ini(&name, &content, &folder)
}

/// Sessions\ 기준 상대 디렉터리 경로를 "/" 구분자 폴더 문자열로. 최상위면 "".
fn relative_folder(root: &Path, file: &Path) -> String {
    file.parent()
        .and_then(|dir| dir.strip_prefix(root).ok())
        .map(|rel| {
            rel.components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

/// SecureCRT .ini 한 개 파싱.
/// 형식: `S:"Hostname"=1.2.3.4`, `D:"[SSH2] Port"=00000016`(8자리 16진), `S:"Username"=root`.
pub fn parse_securecrt_ini(name: &str, content: &str, folder: &str) -> Option<ImportedSession> {
    let mut host = String::new();
    let mut user = String::new();
    let mut protocol = String::new();
    let mut port_specific: Option<u16> = None; // "[SSH2] Port" 등 프로토콜 전용 키
    let mut port_generic: Option<u16> = None; // 범용 "Port" 키

    for line in content.lines() {
        let line = line.trim();
        if let Some(value) = ini_string_value(line, "Hostname") {
            host = value.to_string();
        } else if let Some(value) = ini_string_value(line, "Username") {
            user = value.to_string();
        } else if let Some(value) = ini_string_value(line, "Protocol Name") {
            protocol = value.to_string();
        } else if let Some(value) = ini_dword_value(line, "[SSH2] Port") {
            port_specific = Some(value);
        } else if let Some(value) = ini_dword_value(line, "[SSH1] Port") {
            port_specific = port_specific.or(Some(value));
        } else if let Some(value) = ini_dword_value(line, "Port") {
            port_generic = Some(value);
        }
    }

    if host.is_empty() {
        return None;
    }
    // 프로토콜이 명시돼 있고 SSH 계열(SSH1/SSH2)이 아니면 제외(telnet·serial·rlogin 등).
    if !protocol.is_empty() && !protocol.to_ascii_uppercase().starts_with("SSH") {
        return None;
    }

    Some(ImportedSession {
        source: "SecureCRT".into(),
        folder: folder.to_string(),
        name: name.to_string(),
        host,
        port: port_specific.or(port_generic).unwrap_or(DEFAULT_PORT),
        user,
    })
}

/// `S:"<key>"=<value>` 한 줄에서 값 추출.
fn ini_string_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.strip_prefix(&format!("S:\"{key}\"=")).map(str::trim)
}

/// `D:"<key>"=<8자리 16진>` 한 줄에서 포트 추출. 0·범위 밖은 무시(None).
fn ini_dword_value(line: &str, key: &str) -> Option<u16> {
    let raw = line.strip_prefix(&format!("D:\"{key}\"="))?.trim();
    let parsed = u32::from_str_radix(raw, 16).ok()?;
    (parsed >= 1 && parsed <= u16::MAX as u32).then_some(parsed as u16)
}

// ─────────────────────────── MobaXterm ───────────────────────────
// MobaXterm.ini 의 [Bookmarks*] 섹션. SubRep = 폴더 경로, 나머지 키 = 세션.

fn scan_mobaxterm() -> Vec<ImportedSession> {
    for path in mobaxterm_ini_candidates() {
        if !path.is_file() {
            continue;
        }
        let Some(content) = read_text_best_effort(&path) else {
            continue;
        };
        let sessions = parse_mobaxterm_ini(&content);
        // 후보가 여러 개일 때 빈 파일에 걸려 멈추지 않도록 결과가 있는 첫 파일을 채택.
        if !sessions.is_empty() {
            return sessions;
        }
    }
    Vec::new()
}

/// 설치 방식(포터블/설치판)에 따라 ini 위치가 달라 후보를 순서대로 확인한다.
fn mobaxterm_ini_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = PathBuf::from(appdata);
        candidates.push(appdata.join("MobaXterm").join("MobaXterm.ini"));
        candidates.push(appdata.join("Mobatek").join("MobaXterm").join("MobaXterm.ini"));
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let profile = PathBuf::from(profile);
        candidates.push(profile.join("Documents").join("MobaXterm").join("MobaXterm.ini"));
        candidates.push(profile.join("MobaXterm.ini"));
    }
    candidates
}

/// MobaXterm.ini 전체 파싱. `[Bookmarks]`, `[Bookmarks_1]` … 섹션만 본다.
pub fn parse_mobaxterm_ini(content: &str) -> Vec<ImportedSession> {
    let mut found = Vec::new();
    let mut in_bookmarks = false;
    let mut sub_rep = String::new();

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // 섹션이 바뀌면 SubRep(폴더)도 초기화된다.
            in_bookmarks = line.to_ascii_lowercase().starts_with("[bookmarks");
            sub_rep = String::new();
            continue;
        }
        if !in_bookmarks || line.is_empty() || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.eq_ignore_ascii_case("SubRep") {
            sub_rep = value.trim().to_string();
            continue;
        }
        if let Some(session) = parse_moba_entry(key, value.trim(), &sub_rep) {
            found.push(session);
        }
    }
    found
}

/// 북마크 항목 1건 파싱.
/// 값 형식: `#<아이콘>#<타입>%<host>%<port>%<user>%…` (타입 0 = SSH).
/// 첫 숫자는 세션마다 다른 아이콘 번호라 이걸로 판별하면 안 된다(구버전 `#109#` 고정 비교 버그).
fn parse_moba_entry(key: &str, value: &str, sub_rep: &str) -> Option<ImportedSession> {
    if key.is_empty() || key.eq_ignore_ascii_case("ImgNum") || key.eq_ignore_ascii_case("SubRep") {
        return None;
    }
    if moba_session_type(value)? != 0 {
        return None; // 0(SSH) 외 telnet·RDP·VNC 등은 제외
    }

    // 헤더(parts[0]) 뒤로 host / port / user 순.
    let parts: Vec<&str> = value.split('%').collect();
    let host = parts.get(1)?.trim();
    if host.is_empty() {
        return None;
    }
    let port = parts
        .get(2)
        .and_then(|p| p.trim().parse::<u32>().ok())
        .map(sanitize_port)
        .unwrap_or(DEFAULT_PORT);
    let user = parts.get(3).map(|u| u.trim()).unwrap_or("").to_string();

    Some(ImportedSession {
        source: "MobaXterm".into(),
        folder: sub_rep.replace('\\', "/").trim_matches('/').to_string(),
        name: key.to_string(),
        host: host.to_string(),
        port,
        user,
    })
}

/// 선행 `#` 과 첫 `%` 사이의 `#` 구분 토큰에서 세션 타입을 뽑는다.
/// `#109#0%…` → 토큰 [109, 0] → 마지막(= `%` 직전) 값이 타입.
/// `#0%…` 처럼 토큰이 하나뿐인 변형도 그 값을 타입으로 취급한다(방어적 처리).
fn moba_session_type(value: &str) -> Option<u32> {
    let body = value.strip_prefix('#')?;
    let header = body.split('%').next()?;
    header
        .split('#')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .filter_map(|token| token.parse::<u32>().ok())
        .next_back()
}
