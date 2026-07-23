// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ssh;

use ssh::SessionMap;
use tauri::AppHandle;

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SessionMap::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running SSHTool2");
}
