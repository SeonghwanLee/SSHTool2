// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hostkey;
mod import;
mod sftp;
mod ssh;
mod store;
mod vault;

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
) -> Result<String, String> {
    ssh::connect(app, host, port, user, password, cols, rows, charset).await
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

#[tauri::command]
fn vault_init(app: AppHandle, state: State<'_, VaultState>, master: String) -> Result<(), String> {
    vault::init(&app, &state, master)
}

#[tauri::command]
fn vault_unlock(app: AppHandle, state: State<'_, VaultState>, master: String) -> Result<bool, String> {
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
) -> Result<String, String> {
    sftp::connect(app, host, port, user, password).await
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
    state: State<'_, SftpMap>,
    id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    sftp::download(&state, &id, remote_path, local_path).await
}

#[tauri::command]
async fn sftp_upload(
    state: State<'_, SftpMap>,
    id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    sftp::upload(&state, &id, local_path, remote_path).await
}

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionMap::default())
        .manage(VaultState::default())
        .manage(SftpMap::default())
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
            sftp_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running SSHTool2");
}
