// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod filecrypt;
mod hostkey;
mod import;
mod keystore;
mod localfs;
mod localshell;
mod paths;
mod portfwd;
mod browser;
mod debuglog;
mod rdp;
mod sftp;
mod sftpcmd;
mod ssh;
mod stage;
mod store;
mod vault;
mod windowfit;

use localshell::LocalMap;
use sftp::SftpMap;
use ssh::SessionMap;
use tauri::{AppHandle, State};
use vault::VaultState;

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    cols: u32,
    rows: u32,
    charset: String,
    log_name: Option<String>,
    port_forwards: String,
    auth_type: String,
    private_key_path: String,
    allow_legacy_algorithms: bool,
) -> Result<String, String> {
    ssh::connect(
        app,
        host,
        port,
        user,
        password,
        cols,
        rows,
        charset,
        log_name,
        port_forwards,
        auth_type,
        private_key_path,
        allow_legacy_algorithms,
    )
    .await
}

/// 자격증명을 묻기 전에 서버가 실제로 붙는지 확인한다(호스트키 확인 포함).
/// 반환값 = 서버가 알려 온 인증 방식 표기(빈 문자열이면 알 수 없음).
#[tauri::command]
async fn ssh_probe(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    allow_legacy_algorithms: bool,
) -> Result<String, String> {
    ssh::probe(app, host, port, user, allow_legacy_algorithms).await
}

/// 진단 로그(debug.log)에 모아 둔 줄을 덧붙인다. 프런트가 버퍼링해 호출한다.
#[tauri::command]
fn debug_log_append(app: AppHandle, text: String) -> Result<(), String> {
    debuglog::append(&app, &text)
}

/// 진단 로그를 비우고 새로 시작한다(로깅을 켜는 시점).
#[tauri::command]
fn debug_log_reset(app: AppHandle) -> Result<(), String> {
    debuglog::reset(&app)
}

/// 진단 로그 파일 경로.
#[tauri::command]
fn debug_log_path(app: AppHandle) -> Result<String, String> {
    debuglog::path(&app)
}

/// 세션 호스트의 웹 서비스를 브라우저로 연다(http/https 만).
#[tauri::command]
fn browser_open(browser: String, url: String) -> Result<(), String> {
    browser::open(browser, url)
}

/// RDP 세션 접속 — Windows 기본 클라이언트(mstsc.exe)를 별도 창으로 띄운다.
#[tauri::command]
fn rdp_launch(host: String, port: u16, user: String) -> Result<(), String> {
    rdp::launch(host, port, user)
}

#[tauri::command]
fn ssh_pause(app: AppHandle, id: String, on: bool) {
    ssh::pause(&app, &id, on);
}

#[tauri::command]
fn ssh_write(app: AppHandle, id: String, data: Vec<u8>) -> Result<(), String> {
    ssh::write(&app, &id, data)
}

#[tauri::command]
fn ssh_resize(app: AppHandle, id: String, cols: u32, rows: u32) -> Result<(), String> {
    ssh::resize(&app, &id, cols, rows)
}

#[tauri::command]
fn ssh_close(app: AppHandle, id: String) -> Result<(), String> {
    ssh::close(&app, &id)
}

#[tauri::command]
fn sessions_load(app: AppHandle) -> Result<Vec<store::SessionInfo>, String> {
    store::load(&app)
}

#[tauri::command]
fn sessions_save(app: AppHandle, sessions: Vec<store::SessionInfo>) -> Result<(), String> {
    store::save(&app, sessions)
}

/// PuTTY/SecureCRT/MobaXterm 세션 스캔(레지스트리·ini). 소스 하나가 없어도 나머지는 계속.
/// 레지스트리 열거 + 디렉터리 재귀 워크라 블로킹 — 전용 스레드로 넘겨 UI 를 막지 않는다.
#[tauri::command]
async fn import_scan(source: String) -> Result<Vec<import::ImportedSession>, String> {
    tokio::task::spawn_blocking(move || import::scan_source(&source))
        .await
        .map_err(|e| format!("세션 스캔 실패: {e}"))
}

#[tauri::command]
fn hostkeys_list(app: AppHandle) -> Vec<hostkey::KnownHostEntry> {
    hostkey::list(&app)
}

/// 호스트키가 정당하게 바뀐 경우(서버 재설치 등) 항목을 지워 재등록되게 한다.
#[tauri::command]
fn hostkey_remove(app: AppHandle, target: String) {
    hostkey::remove(&app, &target);
}

#[tauri::command]
fn hostkeys_clear(app: AppHandle) {
    hostkey::clear(&app);
}

/// 첫 접속 지문 확인 결과를 접속 대기 중인 쪽으로 전달한다(ssh://hostkey-prompt 의 응답).
#[tauri::command]
fn hostkey_answer(app: AppHandle, id: String, accept: bool) {
    hostkey::answer(&app, &id, accept);
}

#[tauri::command]
fn settings_load(app: AppHandle) -> Result<serde_json::Value, String> {
    store::load_settings(&app)
}

#[tauri::command]
fn settings_save(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    store::save_settings(&app, value)
}

#[tauri::command]
fn vault_status(app: AppHandle, state: State<'_, VaultState>) -> Result<vault::VaultStatus, String> {
    vault::status(&app, &state)
}

// 볼트 잠금해제·생성·마스터 변경은 PBKDF2 300k 라운드를 돈다. 동기 커맨드는
// 메인 스레드에서 실행되어 그동안 창 전체가 굳으므로(진단 0.62.0), backup_export_zip
// 과 같은 spawn_blocking 패턴으로 뺀다. State 는 'static 이 아니라 클로저에 못
// 넘기므로 AppHandle 에서 다시 꺼낸다.

/// 볼트 생성. 반환값 = 1회성 복구 키(사용자에게 보여주고 보관하게 할 것).
#[tauri::command]
async fn vault_init(app: AppHandle, master: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        vault::init(&app, &app.state::<VaultState>(), master)
    })
    .await
    .map_err(|e| format!("볼트 작업 실패: {e}"))?
}

/// 마스터를 잊었을 때 복구 키로 해제. 이후 vault_change_master 로 새 비밀번호를 설정한다.
#[tauri::command]
async fn vault_unlock_recovery(app: AppHandle, recovery: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        vault::unlock_with_recovery(&app, &app.state::<VaultState>(), recovery)
    })
    .await
    .map_err(|e| format!("볼트 작업 실패: {e}"))?
}

/// 마스터 변경(해제 상태에서). 반환값 = 새 복구 키(기존 키는 무효).
#[tauri::command]
async fn vault_change_master(app: AppHandle, new_master: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        vault::change_master(&app, &app.state::<VaultState>(), new_master)
    })
    .await
    .map_err(|e| format!("볼트 작업 실패: {e}"))?
}

#[tauri::command]
async fn vault_unlock(app: AppHandle, master: String) -> Result<vault::UnlockOutcome, String> {
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        vault::unlock(&app, &app.state::<VaultState>(), master)
    })
    .await
    .map_err(|e| format!("볼트 작업 실패: {e}"))?
}

#[tauri::command]
fn vault_lock(state: State<'_, VaultState>) {
    vault::lock(&state);
}

#[tauri::command]
fn vault_set_password(
    app: AppHandle,
    state: State<'_, VaultState>,
    session_id: String,
    password: String,
) -> Result<(), String> {
    vault::set_password(&app, &state, session_id, password)
}

#[tauri::command]
fn vault_get_password(
    app: AppHandle,
    state: State<'_, VaultState>,
    session_id: String,
) -> Result<Option<String>, String> {
    vault::get_password(&app, &state, &session_id)
}

#[tauri::command]
fn vault_delete_password(app: AppHandle, session_id: String) -> Result<(), String> {
    vault::delete_password(&app, &session_id)
}

/// 세션 편집기의 '비밀 값'(트리거·시작 명령) — 키는 "{세션id}:triggers" 형식.
#[tauri::command]
fn vault_set_secret(
    app: AppHandle,
    state: State<'_, VaultState>,
    key: String,
    value: String,
) -> Result<(), String> {
    vault::set_secret(&app, &state, key, value)
}

#[tauri::command]
fn vault_get_secret(
    app: AppHandle,
    state: State<'_, VaultState>,
    key: String,
) -> Result<Option<String>, String> {
    vault::get_secret(&app, &state, &key)
}

#[tauri::command]
fn vault_delete_secret(app: AppHandle, key: String) -> Result<(), String> {
    vault::delete_secret(&app, &key)
}


/// 파일이 있는 폴더를 탐색기로 열고 **그 파일을 선택해** 보여 준다.
/// 경로를 클립보드에 넣어 주는 것보다 한 단계 적다 — 사용자는 파일을 찾는 게 목적이다.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // explorer 의 /select 는 인자 이스케이프에 까다롭다 — 공백이 든 경로가 깨지지
        // 않도록 원문 그대로(raw_arg) 넘긴다.
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map_err(|e| format!("탐색기 실행 실패: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // 다른 OS 에서는 파일이 든 폴더를 연다(선택 표시는 지원이 제각각이다).
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "상위 폴더를 찾을 수 없습니다".to_string())?;
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(not(target_os = "macos"))]
        let program = "xdg-open";
        std::process::Command::new(program)
            .arg(dir)
            .spawn()
            .map_err(|e| format!("파일 관리자 실행 실패: {e}"))?;
        Ok(())
    }
}

/// 설정 폴더를 OS 파일 탐색기로 연다(로그·known_hosts 등 확인용).
#[tauri::command]
fn open_config_dir(app: AppHandle) -> Result<(), String> {
    let dir = paths::config_dir(&app)?;
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(dir)
        .spawn()
        .map_err(|e| format!("폴더 열기 실패: {e}"))?;
    Ok(())
}

// ── OS 키체인 자동 잠금해제 ───────────────────────────────────────────────────

/// 마스터를 OS 키체인에 저장(이 PC 자동 해제 활성화).
#[tauri::command]
fn keystore_store(master: String) -> Result<(), String> {
    keystore::store(&master)
}

/// 시작 시 자동 해제용으로 저장된 마스터를 꺼낸다(없으면 null).
#[tauri::command]
fn keystore_get() -> Result<Option<String>, String> {
    keystore::load()
}

#[tauri::command]
fn keystore_has() -> Result<bool, String> {
    keystore::has()
}

#[tauri::command]
fn keystore_clear() -> Result<(), String> {
    keystore::clear()
}

// ── 설정 백업/복원/초기화 ────────────────────────────────────────────────────

/// 설정 폴더를 패스프레이즈로 암호화한 바이너리 백업으로 내보낸다(호스트 IP 등 평문 노출 방지).
#[tauri::command]
fn backup_export(app: AppHandle, target: String, password: String) -> Result<usize, String> {
    backup::export(&app, &target, &password)
}

/// 암호화 백업 + GitHub 최신 설치본을 ZIP 하나로 내보낸다(오프라인이면 앱 제외).
/// 네트워크 다운로드가 있어 블로킹 스레드에서 처리(UI 프리즈 방지).
#[tauri::command]
async fn backup_export_zip(
    app: AppHandle,
    target: String,
    password: String,
) -> Result<backup::ZipResult, String> {
    tokio::task::spawn_blocking(move || backup::export_zip(&app, &target, &password))
        .await
        .map_err(|e| format!("내보내기 작업 실패: {e}"))?
}

/// 백업을 복원한다(암호화 형식이면 password 로 복호). 기존 설정은 import_backup/ 에 보관된다.
#[tauri::command]
fn backup_import(app: AppHandle, source: String, password: String) -> Result<usize, String> {
    // 가져온 볼트의 마스터는 이 PC 키체인의 값과 다르므로 자동해제를 초기화한다.
    let _ = keystore::clear();
    backup::import(&app, &source, &password)
}

/// 설정 폴더 전체 삭제(첫 설치 상태로) + OS 키체인의 마스터도 함께 제거.
#[tauri::command]
fn factory_reset(app: AppHandle) -> Result<(), String> {
    let _ = keystore::clear(); // 키체인 실패해도 파일 삭제는 진행
    backup::factory_reset(&app)
}

// ── 로컬 셸 세션(서버 없이 cmd/PowerShell 실행) ──────────────────────────────

#[tauri::command]
fn local_open(
    app: AppHandle,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    log_name: Option<String>,
) -> Result<String, String> {
    localshell::open(app, shell, cwd, cols, rows, log_name)
}

/// PTY 쓰기는 입력 파이프가 차면 블로킹된다 — 메인 스레드에서 하면 창이 멈추므로
/// 전용 블로킹 스레드로 넘긴다(SSH 쪽은 채널이라 애초에 블로킹되지 않음).
#[tauri::command]
async fn local_write(app: AppHandle, id: String, data: Vec<u8>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || localshell::write(&app, &id, data))
        .await
        .map_err(|e| format!("쓰기 태스크 실패: {e}"))?
}

#[tauri::command]
fn local_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    localshell::resize(&app, &id, cols, rows)
}

#[tauri::command]
fn local_close(app: AppHandle, id: String) -> Result<(), String> {
    localshell::close(&app, &id)
}

// ── 로컬 파일시스템(SFTP 좌측 패널) ──────────────────────────────────────────

#[tauri::command]
fn local_default_dir() -> String {
    localfs::default_dir()
}

#[tauri::command]
fn local_roots() -> Vec<String> {
    localfs::roots()
}

#[tauri::command]
fn local_list(path: String) -> Result<Vec<localfs::LocalEntry>, String> {
    localfs::list(&path)
}

#[tauri::command]
fn local_parent(path: String) -> String {
    localfs::parent(&path)
}

#[tauri::command]
fn local_mkdir(path: String) -> Result<(), String> {
    localfs::mkdir(&path)
}

#[tauri::command]
fn local_remove(path: String, is_dir: bool) -> Result<(), String> {
    localfs::remove(&path, is_dir)
}

#[tauri::command]
fn local_rename(from: String, to: String) -> Result<(), String> {
    localfs::rename(&from, &to)
}

#[tauri::command]
fn local_exists(path: String) -> bool {
    localfs::exists(&path)
}

/// 파일/폴더를 OS 기본 연결 프로그램으로 연다(탐색기 더블클릭과 동일).
/// SFTP 파일 열기 — 로컬은 원본을, 원격은 임시폴더로 내려받은 사본을 연다.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    // cmd 파서(& ^ % 등 메타문자)를 거치지 않도록 explorer.exe 로 연다.
    // explorer 는 인자를 파일 경로로만 취급해 파일명에 의한 명령 인젝션이 불가능하다.
    #[cfg(windows)]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("열기 실패: {e}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("열기 실패: {e}"))?;
    #[cfg(all(not(windows), not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("열기 실패: {e}"))?;
    Ok(())
}

/// 파일 크기·수정시각(unix 초). 없으면 null — 원격 파일 편집 감시에 쓴다.
#[tauri::command]
fn local_stat(path: String) -> Option<(u64, u64)> {
    localfs::stat(&path)
}

/// 원격 파일 임시 열람용 폴더(OS 임시 경로).
#[tauri::command]
fn local_temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}


/// 하루 지난 스테이징 잔재 제거(드롭 시작 시 fire-and-forget 로 호출).
#[tauri::command]
fn stage_sweep() {
    stage::sweep();
}

/// 텍스트 파일 저장(스크롤백 내보내기) — 경로는 OS 저장 대화상자가 고른 것이다.
#[tauri::command]
fn local_write_text(path: String, text: String) -> Result<(), String> {
    localfs::write_text(&path, &text)
}

/// 창을 지금 화면 가운데로 되돌린다 — 화면 밖으로 나가 잡을 수 없을 때의 탈출구.
/// 실행 중 모니터를 빼거나 해상도를 바꾸면 시작 시 정렬만으로는 부족하다.
#[tauri::command]
fn window_fit_to_screen(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
    windowfit::fit(&win, true).map_err(|e| format!("창 위치 조정 실패: {e}"))
}

/// 세션(터미널) 시작 시 IME 를 영문(ALPHANUMERIC) 모드로 전환한다(Windows, best-effort).
/// 포커스된 입력 창(WebView2 자식 HWND)의 IME 컨텍스트를 GetGUIThreadInfo 로 찾아 설정한다.
#[cfg(windows)]
#[tauri::command]
fn ime_set_english() {
    use std::os::raw::c_void;
    #[repr(C)]
    struct GuiThreadInfo {
        cb_size: u32,
        flags: u32,
        hwnd_active: *mut c_void,
        hwnd_focus: *mut c_void,
        hwnd_capture: *mut c_void,
        hwnd_menu_owner: *mut c_void,
        hwnd_move_size: *mut c_void,
        hwnd_caret: *mut c_void,
        rc_caret: [i32; 4],
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetGUIThreadInfo(id_thread: u32, lpgui: *mut GuiThreadInfo) -> i32;
    }
    #[link(name = "imm32")]
    extern "system" {
        fn ImmGetContext(hwnd: *mut c_void) -> *mut c_void;
        fn ImmSetConversionStatus(himc: *mut c_void, conversion: u32, sentence: u32) -> i32;
        fn ImmReleaseContext(hwnd: *mut c_void, himc: *mut c_void) -> i32;
    }
    const IME_CMODE_ALPHANUMERIC: u32 = 0x0000;
    const IME_SMODE_NONE: u32 = 0x0000;
    unsafe {
        let mut gti: GuiThreadInfo = std::mem::zeroed();
        gti.cb_size = std::mem::size_of::<GuiThreadInfo>() as u32;
        let mut hwnd = if GetGUIThreadInfo(0, &mut gti) != 0 && !gti.hwnd_focus.is_null() {
            gti.hwnd_focus
        } else {
            std::ptr::null_mut()
        };
        if hwnd.is_null() {
            hwnd = GetForegroundWindow();
        }
        if hwnd.is_null() {
            return;
        }
        let himc = ImmGetContext(hwnd);
        if himc.is_null() {
            return;
        }
        ImmSetConversionStatus(himc, IME_CMODE_ALPHANUMERIC, IME_SMODE_NONE);
        ImmReleaseContext(hwnd, himc);
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn ime_set_english() {}


fn main() {
    tauri::Builder::default()
        // 중복 실행 방지 — 이미 실행 중이면 두 번째 인스턴스는 종료되고, 이 콜백이
        // 기존 인스턴스에서 실행돼 창을 앞으로 가져오고 프런트에 알림 이벤트를 보낸다.
        // (single-instance 는 다른 플러그인보다 먼저 등록해야 한다 — Tauri 권장)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::{Emitter, Manager};
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit("second-instance", ());
        }))
        // 창 위치/크기/최대화 상태를 종료 시 저장하고 다음 실행 때 복원.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionMap::default())
        .manage(VaultState::default())
        .manage(SftpMap::default())
        .manage(sftp::TransferCancel::default())
        .manage(sftp::RateLimit::new(0))
        .manage(LocalMap::default())
        .manage(hostkey::HostKeyPrompts::default())
        // 창을 화면 안으로 — window-state 플러그인이 되살린 뒤에 손봐야 한다.
        // 설정 파일의 창은 여기 setup 이 돌기 전에 만들어지고(복원도 그때 끝난다),
        // 그래서 이 자리에서 보면 이미 복원된 크기·위치가 잡힌다.
        .setup(|app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                if let Err(e) = windowfit::fit(&win, false) {
                    eprintln!("창을 화면 안으로 들여놓지 못했습니다: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_probe,
            rdp_launch,
            browser_open,
            debug_log_append,
            debug_log_reset,
            debug_log_path,
            ssh_write,
            ssh_pause,
            ssh_resize,
            ssh_close,
            sessions_load,
            sessions_save,
            settings_load,
            settings_save,
            import_scan,
            hostkeys_list,
            hostkey_remove,
            hostkeys_clear,
            hostkey_answer,
            vault_status,
            vault_init,
            vault_unlock,
            vault_unlock_recovery,
            vault_change_master,
            vault_lock,
            vault_set_password,
            vault_get_password,
            vault_delete_password,
            vault_set_secret,
            vault_get_secret,
            vault_delete_secret,
            sftpcmd::sftp_connect,
            sftpcmd::sftp_list,
            sftpcmd::sftp_download,
            sftpcmd::sftp_upload,
            sftpcmd::sftp_mkdir,
            sftpcmd::sftp_remove,
            sftpcmd::sftp_rename,
            sftpcmd::sftp_disconnect,
            sftpcmd::sftp_cancel,
            sftpcmd::sftp_canonicalize,
            sftpcmd::sftp_stat,
            sftpcmd::sftp_upload_chunk,
            sftpcmd::sftp_upload_finish,
            sftpcmd::sftp_upload_discard,
            sftpcmd::sftp_set_rate_limit,
            open_config_dir,
            reveal_path,
            keystore_store,
            keystore_get,
            keystore_has,
            keystore_clear,
            backup_export,
            backup_export_zip,
            backup_import,
            factory_reset,
            local_open,
            local_write,
            local_resize,
            local_close,
            local_default_dir,
            local_roots,
            local_list,
            local_parent,
            local_mkdir,
            local_remove,
            local_rename,
            local_exists,
            open_path,
            local_temp_dir,
            local_stat,
            stage_sweep,
            local_write_text,
            window_fit_to_screen,
            ime_set_english
        ])
        .run(tauri::generate_context!())
        .expect("error while running SSHTool2");
}
