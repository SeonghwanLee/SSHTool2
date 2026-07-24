// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod hostkey;
mod import;
mod keystore;
mod localfs;
mod localshell;
mod portfwd;
mod sftp;
mod ssh;
mod store;
mod vault;

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
) -> Result<String, String> {
    ssh::connect(
        app, host, port, user, password, cols, rows, charset, log_name, port_forwards, auth_type,
        private_key_path,
    )
    .await
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
async fn import_scan() -> Result<Vec<import::ImportedSession>, String> {
    tokio::task::spawn_blocking(import::scan)
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

/// 볼트 생성. 반환값 = 1회성 복구 키(사용자에게 보여주고 보관하게 할 것).
#[tauri::command]
fn vault_init(app: AppHandle, state: State<'_, VaultState>, master: String) -> Result<String, String> {
    vault::init(&app, &state, master)
}

/// 마스터를 잊었을 때 복구 키로 해제. 이후 vault_change_master 로 새 비밀번호를 설정한다.
#[tauri::command]
fn vault_unlock_recovery(
    app: AppHandle,
    state: State<'_, VaultState>,
    recovery: String,
) -> Result<bool, String> {
    vault::unlock_with_recovery(&app, &state, recovery)
}

/// 마스터 변경(해제 상태에서). 반환값 = 새 복구 키(기존 키는 무효).
#[tauri::command]
fn vault_change_master(
    app: AppHandle,
    state: State<'_, VaultState>,
    new_master: String,
) -> Result<String, String> {
    vault::change_master(&app, &state, new_master)
}

#[tauri::command]
fn vault_unlock(
    app: AppHandle,
    state: State<'_, VaultState>,
    master: String,
) -> Result<vault::UnlockOutcome, String> {
    vault::unlock(&app, &state, master)
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

#[tauri::command]
async fn sftp_connect(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    auth_type: String,
    private_key_path: String,
) -> Result<String, String> {
    sftp::connect(app, host, port, user, password, auth_type, private_key_path).await
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, SftpMap>,
    id: String,
    path: String,
) -> Result<Vec<sftp::SftpEntry>, String> {
    sftp::list(&state, &id, &path).await
}

#[tauri::command]
async fn sftp_download(
    app: AppHandle,
    state: State<'_, SftpMap>,
    cancels: State<'_, sftp::TransferCancel>,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), String> {
    sftp::download(app, &state, &cancels, &id, remote_path, local_path, transfer_id).await
}

#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SftpMap>,
    cancels: State<'_, sftp::TransferCancel>,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    sftp::upload(app, &state, &cancels, &id, local_path, remote_path, transfer_id).await
}

#[tauri::command]
fn sftp_cancel(cancels: State<'_, sftp::TransferCancel>, transfer_id: String) {
    sftp::cancel(&cancels, &transfer_id);
}

#[tauri::command]
async fn sftp_canonicalize(
    state: State<'_, SftpMap>,
    id: String,
    path: String,
) -> Result<String, String> {
    sftp::canonicalize(&state, &id, path).await
}

/// 설정 폴더를 OS 파일 탐색기로 연다(로그·known_hosts 등 확인용).
#[tauri::command]
fn open_config_dir(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 경로 확인 실패: {e}"))?;
    std::fs::create_dir_all(&dir).ok();
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

/// 설정 폴더를 JSON 번들로 내보낸다(비밀번호는 암호화된 상태 그대로).
#[tauri::command]
fn backup_export(app: AppHandle, target: String) -> Result<usize, String> {
    backup::export(&app, &target)
}

/// 번들을 복원한다. 기존 설정은 import_backup/ 에 보관된다.
#[tauri::command]
fn backup_import(app: AppHandle, source: String) -> Result<usize, String> {
    // 가져온 볼트의 마스터는 이 PC 키체인의 값과 다르므로 자동해제를 초기화한다.
    let _ = keystore::clear();
    backup::import(&app, &source)
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

/// 원격 파일 임시 열람용 폴더(OS 임시 경로).
#[tauri::command]
fn local_temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
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

#[tauri::command]
async fn sftp_mkdir(state: State<'_, SftpMap>, id: String, path: String) -> Result<(), String> {
    sftp::mkdir(&state, &id, path).await
}

#[tauri::command]
async fn sftp_remove(
    state: State<'_, SftpMap>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    sftp::remove(&state, &id, path, is_dir).await
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, SftpMap>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    sftp::rename(&state, &id, from, to).await
}

#[tauri::command]
fn sftp_disconnect(state: State<'_, SftpMap>, id: String) {
    sftp::disconnect(state, &id);
}

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionMap::default())
        .manage(VaultState::default())
        .manage(SftpMap::default())
        .manage(sftp::TransferCancel::default())
        .manage(LocalMap::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
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
            vault_status,
            vault_init,
            vault_unlock,
            vault_unlock_recovery,
            vault_change_master,
            vault_lock,
            vault_set_password,
            vault_get_password,
            vault_delete_password,
            sftp_connect,
            sftp_list,
            sftp_download,
            sftp_upload,
            sftp_mkdir,
            sftp_remove,
            sftp_rename,
            sftp_disconnect,
            sftp_cancel,
            sftp_canonicalize,
            open_config_dir,
            keystore_store,
            keystore_get,
            keystore_has,
            keystore_clear,
            backup_export,
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
            ime_set_english
        ])
        .run(tauri::generate_context!())
        .expect("error while running SSHTool2");
}
