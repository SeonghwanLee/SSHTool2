//! RDP 세션 실행 — Windows 기본 클라이언트(mstsc.exe)를 별도 창으로 띄운다.
//!
//! 화면을 앱 안에 넣지 않는 이유: RDP 는 픽셀을 주고받는 그래픽 프로토콜이라 터미널 영역
//! (xterm, 텍스트)에 그대로 들어갈 수 없다. 임베딩하려면 코덱·입력·클립보드 채널을 직접
//! 구현해야 해서 규모가 앱 전체에 맞먹는다. 여기서는 세션 관리(호스트·계정·폴더·볼트)만
//! 맡고 화면은 mstsc 에 넘긴다.
//!
//! 비밀번호는 넘기지 않는다 — mstsc 가 자기 창에서 묻는다. 자동 로그인을 하려면 cmdkey 로
//! Windows 자격 증명 관리자에 심어야 하는데, 앱이 끝난 뒤에도 남아 정리 책임이 생긴다.

use std::path::PathBuf;

/// mstsc 가 파일을 읽을 시간을 준 뒤 지운다. 바로 지우면 실행과 경쟁한다.
#[cfg(windows)]
const CLEANUP_AFTER_SECS: u64 = 60;

/// 임시 파일 이름 앞머리. 이 앱이 만든 것만 골라 지우려고 쓴다.
const FILE_PREFIX: &str = "sshtool2-";

/// 지난 실행에서 남은 `.rdp` 임시 파일을 지운다.
///
/// 앱이 지연 삭제(60초)를 마치기 전에 종료되면 호스트·계정이 담긴 파일이 temp 에 남는다.
/// 지연 삭제만으로는 그 경우를 못 지우므로, 새로 만들기 전에 오래된 것을 먼저 훑는다.
/// 실패는 무시한다 — 청소가 안 됐다고 접속을 막을 이유는 없다.
fn sweep_stale(older_than: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(FILE_PREFIX) || !name.ends_with(".rdp") {
            continue;
        }
        // 방금 다른 창을 띄우며 만든 파일을 뺏어 지우지 않도록 나이를 확인한다.
        // 나이를 못 읽으면 그냥 둔다 — 남의 파일을 지우는 쪽이 더 나쁘다.
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .map_or(false, |age| age >= older_than);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `.rdp` 파일 한 줄 값에 들어가면 안 되는 문자를 막는다.
/// 호스트·계정은 사용자가 입력한 값이므로 개행이 섞이면 다른 설정 줄을 주입할 수 있다.
fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '\r' && *c != '\n' && *c != '\0')
        .collect()
}

/// 접속 정보를 담은 임시 `.rdp` 파일 경로를 만든다(비밀번호는 담지 않는다).
fn write_rdp_file(host: &str, port: u16, user: &str) -> Result<PathBuf, String> {
    let target = if port == 3389 {
        sanitize(host)
    } else {
        format!("{}:{}", sanitize(host), port)
    };
    let mut body = format!("full address:s:{target}\r\n");
    let account = sanitize(user);
    if !account.is_empty() {
        body.push_str(&format!("username:s:{account}\r\n"));
    }

    let path = std::env::temp_dir().join(format!("{FILE_PREFIX}{}.rdp", uuid::Uuid::new_v4()));
    std::fs::write(&path, body).map_err(|e| format!("RDP 파일 생성 실패: {e}"))?;
    Ok(path)
}

/// mstsc.exe 를 띄운다. 앱은 기다리지 않는다 — 원격 데스크톱은 별도 창에서 계속된다.
pub fn launch(host: String, port: u16, user: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        if host.trim().is_empty() {
            return Err("호스트가 비어 있습니다.".into());
        }
        let cleanup_after = std::time::Duration::from_secs(CLEANUP_AFTER_SECS);
        sweep_stale(cleanup_after);

        let path = write_rdp_file(&host, port, &user)?;
        std::process::Command::new("mstsc.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("원격 데스크톱 실행 실패: {e}"))?;

        // 임시 파일은 잠시 뒤 지운다 — 호스트·계정이 담겨 있어 남겨 둘 이유가 없다.
        //
        // tokio::spawn 을 쓰면 안 된다. 이 커맨드는 동기 함수라 토키오 런타임 컨텍스트 밖에서
        // 돌고, 그 자리의 tokio::spawn 은 "there is no reactor running" 으로 패닉한다.
        // 릴리스 프로파일이 panic = "abort" 이므로 패닉은 앱 전체를 즉시 끝낸다.
        std::thread::spawn(move || {
            std::thread::sleep(cleanup_after);
            let _ = std::fs::remove_file(&path);
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (host, port, user);
        Err("원격 데스크톱(RDP)은 Windows 에서만 실행할 수 있습니다.".into())
    }
}
