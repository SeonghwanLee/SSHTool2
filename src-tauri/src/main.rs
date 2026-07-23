// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ssh;
mod store;
mod vault;

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
) -> Result<String, String> {
    ssh::connect(app, host, port, user, password, cols, rows).await
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SessionMap::default())
        .manage(VaultState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_close,
            sessions_load,
            sessions_save,
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
            vault_set_password,
            vault_get_password,
            vault_delete_password
        ])
        .run(tauri::generate_context!())
        .expect("error while running SSHTool2");
}
