//! 로컬 셸 세션 — SSH 없이 cmd/PowerShell 등을 앱 안의 터미널로 실행한다
//! (WPF 0.4.0 ConPTY 대응). portable-pty 로 OS PTY 를 열고, 읽기는 전용 스레드에서
//! 돌며 SSH 세션과 **동일한 이벤트**(`ssh://data` / `ssh://closed`)를 보내
//! 프론트의 터미널 표시 경로를 그대로 재사용한다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub type LocalMap = Mutex<HashMap<String, LocalHandle>>;

pub struct LocalHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone, Serialize)]
struct DataPayload {
    id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct ClosedPayload {
    id: String,
    message: String,
}

/// 지정한 셸을 PTY 로 실행한다. shell 이 비면 OS 기본 셸을 쓴다.
pub fn open(
    app: AppHandle,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    log_name: Option<String>,
) -> Result<String, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("PTY 열기 실패: {e}"))?;

    let exe = if shell.trim().is_empty() {
        default_shell()
    } else {
        shell
    };
    // "pwsh -NoLogo" 처럼 인자를 함께 적을 수 있게 공백으로 나눈다.
    let mut parts = exe.split_whitespace();
    let program = parts.next().unwrap_or("").to_string();
    let mut cmd = CommandBuilder::new(&program);
    for a in parts {
        cmd.arg(a);
    }
    if !cwd.trim().is_empty() {
        cmd.cwd(cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("셸 실행 실패({program}): {e}"))?;
    // slave 는 자식이 물고 있으므로 부모 쪽 핸들은 닫아야 EOF 가 정상 전달된다.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("PTY 읽기 실패: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("PTY 쓰기 실패: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();

    {
        let state = app.state::<LocalMap>();
        state.lock().unwrap().insert(
            id.clone(),
            LocalHandle {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
            },
        );
    }

    // PTY 읽기는 블로킹이라 전용 OS 스레드에서 돌린다(tokio 워커를 막지 않음).
    let task_id = id.clone();
    let mut log_file = log_name
        .as_deref()
        .and_then(|n| crate::ssh::open_session_log(&app, n, &task_id));
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if let Some(f) = log_file.as_mut() {
                        let _ = f.write_all(chunk);
                    }
                    let _ = app.emit(
                        "ssh://data",
                        DataPayload {
                            id: task_id.clone(),
                            data: chunk.to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        // PTY 정리는 잠금 밖에서 — 종료가 블로킹이라 다른 로컬 세션까지 멈춘다.
        let removed = app.state::<LocalMap>().lock().unwrap().remove(&task_id);
        drop(removed);
        let _ = app.emit(
            "ssh://closed",
            ClosedPayload {
                id: task_id.clone(),
                message: "로컬 셸이 종료되었습니다".into(),
            },
        );
    });

    Ok(id)
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

pub fn write(app: &AppHandle, id: &str, data: Vec<u8>) -> Result<(), String> {
    let state = app.state::<LocalMap>();
    let map = state.lock().unwrap();
    let handle = map.get(id).ok_or("로컬 셸 세션을 찾을 수 없습니다")?;
    let writer = handle.writer.clone();
    drop(map); // 쓰기 동안 세션 맵 잠금을 잡고 있지 않는다
    let mut w = writer.lock().unwrap();
    w.write_all(&data).map_err(|e| format!("쓰기 실패: {e}"))?;
    w.flush().map_err(|e| format!("flush 실패: {e}"))
}

pub fn resize(app: &AppHandle, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<LocalMap>();
    let map = state.lock().unwrap();
    let handle = map.get(id).ok_or("로컬 셸 세션을 찾을 수 없습니다")?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("크기 변경 실패: {e}"))
}

pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    // 맵에서 빼는 것까지만 잠금 안에서 하고, 프로세스 종료·PTY 해제는 밖에서 한다
    // (kill 은 최대 수백 ms 블로킹이라 다른 로컬 세션의 입력까지 막힌다).
    let removed = {
        let state = app.state::<LocalMap>();
        let mut map = state.lock().unwrap();
        map.remove(id)
    };
    if let Some(mut handle) = removed {
        let _ = handle.child.kill();
        let _ = handle.child.wait(); // 좀비 프로세스 회수
    }
    Ok(())
}
