//! SFTP 커맨드 — 프런트가 부르는 얇은 래퍼 모음.
//!
//! 실제 구현은 `sftp.rs` 에 있고 여기서는 상태(State)를 꺼내 넘기기만 한다.
//! main.rs 가 앱 조립과 커맨드 정의로 900줄에 가까워져 이 묶음을 떼어 냈다
//! (사내 규칙 800줄). 동작은 그대로다.

use crate::sftp::{self, SftpMap};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn sftp_connect(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    auth_type: String,
    private_key_path: String,
    allow_legacy_algorithms: bool,
    charset: String,
) -> Result<String, String> {
    sftp::connect(
        app,
        host,
        port,
        user,
        password,
        auth_type,
        private_key_path,
        allow_legacy_algorithms,
        charset,
    )
    .await
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpMap>,
    id: String,
    path: String,
) -> Result<Vec<sftp::SftpEntry>, String> {
    sftp::list(&state, &id, &path).await
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SftpMap>,
    cancels: State<'_, sftp::TransferCancel>,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    resume_from: u64,
    rate: State<'_, sftp::RateLimit>,
) -> Result<(), String> {
    sftp::download(
        app,
        &state,
        &cancels,
        &id,
        remote_path,
        local_path,
        transfer_id,
        resume_from,
        &rate,
    )
    .await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SftpMap>,
    cancels: State<'_, sftp::TransferCancel>,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    resume_from: u64,
    rate: State<'_, sftp::RateLimit>,
) -> Result<(), String> {
    sftp::upload(
        app,
        &state,
        &cancels,
        &id,
        local_path,
        remote_path,
        transfer_id,
        resume_from,
        &rate,
    )
    .await
}

/// 전송 속도 상한(KB/s, 0 = 무제한). 전송 도중에 바꿔도 다음 조각부터 듣는다.
#[tauri::command]
pub fn sftp_set_rate_limit(rate: State<'_, sftp::RateLimit>, kbps: u64) {
    rate.store(kbps.saturating_mul(1024), std::sync::atomic::Ordering::Relaxed);
}

/// 드롭 업로드(스트리밍) — 조각을 원격 .part 에 이어 쓴다. 내용은 base64 로 받는다
/// (숫자 배열로 넘기면 4MB 조각이 수십 MB JSON 이 된다).
#[tauri::command]
pub async fn sftp_upload_chunk(
    state: State<'_, SftpMap>,
    rate: State<'_, sftp::RateLimit>,
    id: String,
    remote_path: String,
    offset: u64,
    data_b64: String,
) -> Result<(), String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("조각 해독 실패: {e}"))?;
    sftp::upload_chunk(&state, &rate, &id, remote_path, offset, data).await
}

#[tauri::command]
pub async fn sftp_upload_finish(
    state: State<'_, SftpMap>,
    id: String,
    remote_path: String,
) -> Result<(), String> {
    sftp::upload_finish(&state, &id, remote_path).await
}

#[tauri::command]
pub async fn sftp_upload_discard(
    state: State<'_, SftpMap>,
    id: String,
    remote_path: String,
) -> Result<(), String> {
    sftp::upload_discard(&state, &id, remote_path).await
}

/// 원격 파일의 크기·수정시각 — 이어받기 판단(.part 크기)과 폴더 비교에 쓴다.
#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, SftpMap>,
    id: String,
    path: String,
) -> Result<Option<(u64, u64)>, String> {
    sftp::stat(&state, &id, path).await
}

#[tauri::command]
pub fn sftp_cancel(cancels: State<'_, sftp::TransferCancel>, transfer_id: String) {
    sftp::cancel(&cancels, &transfer_id);
}

#[tauri::command]
pub async fn sftp_canonicalize(
    state: State<'_, SftpMap>,
    id: String,
    path: String,
) -> Result<String, String> {
    sftp::canonicalize(&state, &id, path).await
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SftpMap>, id: String, path: String) -> Result<(), String> {
    sftp::mkdir(&state, &id, path).await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SftpMap>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    sftp::remove(&state, &id, path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpMap>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    sftp::rename(&state, &id, from, to).await
}

#[tauri::command]
pub fn sftp_disconnect(state: State<'_, SftpMap>, id: String) {
    sftp::disconnect(state, &id);
}
