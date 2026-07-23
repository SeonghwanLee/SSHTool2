// 백엔드 IPC 얇은 래퍼. 계약(CONTRACT.md)의 명령/이벤트를 타입 안전하게 감싼다.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionInfo } from "./types";

// ── SSH ─────────────────────────────────────────────────────────────────────

export interface ConnectArgs {
  host: string;
  port: number;
  user: string;
  password: string;
  cols: number;
  rows: number;
}

export const sshConnect = (a: ConnectArgs): Promise<string> =>
  invoke<string>("ssh_connect", { ...a });

export const sshWrite = (id: string, data: Uint8Array): Promise<void> =>
  invoke("ssh_write", { id, data: Array.from(data) });

export const sshResize = (id: string, cols: number, rows: number): Promise<void> =>
  invoke("ssh_resize", { id, cols, rows });

export const sshClose = (id: string): Promise<void> => invoke("ssh_close", { id });

// ── 세션 저장소 ───────────────────────────────────────────────────────────────

export const sessionsLoad = (): Promise<SessionInfo[]> =>
  invoke<SessionInfo[]>("sessions_load");

export const sessionsSave = (sessions: SessionInfo[]): Promise<void> =>
  invoke("sessions_save", { sessions });

export const settingsLoad = (): Promise<Record<string, unknown>> =>
  invoke<Record<string, unknown>>("settings_load");

export const settingsSave = (value: unknown): Promise<void> =>
  invoke("settings_save", { value });

// ── 볼트(자격증명) ────────────────────────────────────────────────────────────

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export const vaultStatus = (): Promise<VaultStatus> => invoke<VaultStatus>("vault_status");
export const vaultInit = (master: string): Promise<void> => invoke("vault_init", { master });
export const vaultUnlock = (master: string): Promise<boolean> =>
  invoke<boolean>("vault_unlock", { master });
export const vaultLock = (): Promise<void> => invoke("vault_lock");
export const vaultSetPassword = (sessionId: string, password: string): Promise<void> =>
  invoke("vault_set_password", { sessionId, password });
export const vaultGetPassword = (sessionId: string): Promise<string | null> =>
  invoke<string | null>("vault_get_password", { sessionId });
export const vaultDeletePassword = (sessionId: string): Promise<void> =>
  invoke("vault_delete_password", { sessionId });

// ── SFTP ──────────────────────────────────────────────────────────────────────

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export const sftpConnect = (
  host: string,
  port: number,
  user: string,
  password: string,
): Promise<string> => invoke<string>("sftp_connect", { host, port, user, password });

export const sftpList = (id: string, path: string): Promise<SftpEntry[]> =>
  invoke<SftpEntry[]>("sftp_list", { id, path });

export const sftpDownload = (id: string, remotePath: string, localPath: string): Promise<void> =>
  invoke("sftp_download", { id, remotePath, localPath });

export const sftpUpload = (id: string, localPath: string, remotePath: string): Promise<void> =>
  invoke("sftp_upload", { id, localPath, remotePath });

export const sftpMkdir = (id: string, path: string): Promise<void> =>
  invoke("sftp_mkdir", { id, path });

export const sftpRemove = (id: string, path: string, isDir: boolean): Promise<void> =>
  invoke("sftp_remove", { id, path, isDir });

export const sftpRename = (id: string, from: string, to: string): Promise<void> =>
  invoke("sftp_rename", { id, from, to });

export const sftpDisconnect = (id: string): Promise<void> => invoke("sftp_disconnect", { id });

// ── 이벤트 ────────────────────────────────────────────────────────────────────

export interface DataEvent {
  id: string;
  data: number[];
}
export interface ClosedEvent {
  id: string;
  message: string;
}

export const onSshData = (cb: (e: DataEvent) => void): Promise<UnlistenFn> =>
  listen<DataEvent>("ssh://data", (e) => cb(e.payload));

export const onSshClosed = (cb: (e: ClosedEvent) => void): Promise<UnlistenFn> =>
  listen<ClosedEvent>("ssh://closed", (e) => cb(e.payload));
