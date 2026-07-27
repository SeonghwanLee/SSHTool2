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

    let path = std::env::temp_dir().join(format!("sshtool2-{}.rdp", uuid::Uuid::new_v4()));
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
        let path = write_rdp_file(&host, port, &user)?;
        std::process::Command::new("mstsc.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("원격 데스크톱 실행 실패: {e}"))?;

        // 임시 파일은 잠시 뒤 지운다 — 호스트·계정이 담겨 있어 남겨 둘 이유가 없다.
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(CLEANUP_AFTER_SECS)).await;
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
