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
  /** 터미널 문자셋. 비-UTF-8 이면 백엔드가 변환한다. */
  charset: string;
  /** 세션 로그를 남길 이름(없으면 기록하지 않음). */
  logName: string | null;
}

export const sshConnect = (a: ConnectArgs): Promise<string> =>
  invoke<string>("ssh_connect", { ...a });

export const sshWrite = (id: string, data: Uint8Array): Promise<void> =>
  invoke("ssh_write", { id, data: Array.from(data) });

export const sshResize = (id: string, cols: number, rows: number): Promise<void> =>
  invoke("ssh_resize", { id, cols, rows });

export const sshClose = (id: string): Promise<void> => invoke("ssh_close", { id });

// ── 설정 백업/복원/초기화 ─────────────────────────────────────────────────────

export const backupExport = (target: string): Promise<number> =>
  invoke<number>("backup_export", { target });
export const backupImport = (source: string): Promise<number> =>
  invoke<number>("backup_import", { source });
export const factoryReset = (): Promise<void> => invoke("factory_reset");

// ── 로컬 셸(서버 없이 cmd/PowerShell 실행) — 이벤트는 SSH 와 동일 ─────────────

export const localOpen = (
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
  logName: string | null,
): Promise<string> => invoke<string>("local_open", { shell, cwd, cols, rows, logName });

export const localWrite = (id: string, data: Uint8Array): Promise<void> =>
  invoke("local_write", { id, data: Array.from(data) });

export const localResize = (id: string, cols: number, rows: number): Promise<void> =>
  invoke("local_resize", { id, cols, rows });

export const localClose = (id: string): Promise<void> => invoke("local_close", { id });

// ── 세션 저장소 ───────────────────────────────────────────────────────────────

export const sessionsLoad = (): Promise<SessionInfo[]> =>
  invoke<SessionInfo[]>("sessions_load");

export const sessionsSave = (sessions: SessionInfo[]): Promise<void> =>
  invoke("sessions_save", { sessions });

/** 다른 SSH 클라이언트에서 스캔한 세션 후보(백엔드 import::ImportedSession). */
export interface ImportedSession {
  source: string;
  folder: string;
  name: string;
  host: string;
  port: number;
  user: string;
}

export const importScan = (): Promise<ImportedSession[]> =>
  invoke<ImportedSession[]>("import_scan");

/** 저장된 호스트키(TOFU) 항목. */
export interface KnownHostEntry {
  target: string;
  fingerprint: string;
}

export const hostkeysList = (): Promise<KnownHostEntry[]> =>
  invoke<KnownHostEntry[]>("hostkeys_list");
export const hostkeyRemove = (target: string): Promise<void> =>
  invoke("hostkey_remove", { target });
export const hostkeysClear = (): Promise<void> => invoke("hostkeys_clear");

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
/** 볼트 생성 → 1회성 복구 키를 반환한다(반드시 사용자에게 보여줄 것). */
export const vaultInit = (master: string): Promise<string> =>
  invoke<string>("vault_init", { master });
/** unlock 결과. v1→v2 이관이 일어나면 새 복구 키가 함께 온다(반드시 보여줄 것). */
export interface UnlockOutcome {
  ok: boolean;
  migratedRecovery: string | null;
}
export const vaultUnlock = (master: string): Promise<UnlockOutcome> =>
  invoke<UnlockOutcome>("vault_unlock", { master });
export const vaultUnlockRecovery = (recovery: string): Promise<boolean> =>
  invoke<boolean>("vault_unlock_recovery", { recovery });
/** 마스터 변경 → 새 복구 키 반환(기존 키 무효). */
export const vaultChangeMaster = (newMaster: string): Promise<string> =>
  invoke<string>("vault_change_master", { newMaster });
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

export const sftpDownload = (
  id: string,
  remotePath: string,
  localPath: string,
  transferId: string,
): Promise<void> => invoke("sftp_download", { id, remotePath, localPath, transferId });

export const sftpUpload = (
  id: string,
  localPath: string,
  remotePath: string,
  transferId: string,
): Promise<void> => invoke("sftp_upload", { id, localPath, remotePath, transferId });

export const sftpCancel = (transferId: string): Promise<void> =>
  invoke("sftp_cancel", { transferId });

/** 원격 경로를 절대경로로 정규화("." → 홈). */
export const sftpCanonicalize = (id: string, path: string): Promise<string> =>
  invoke<string>("sftp_canonicalize", { id, path });

/** 전송 진행률 이벤트. */
export interface ProgressEvent {
  transferId: string;
  name: string;
  done: number;
  total: number;
}

export const onSftpProgress = (cb: (e: ProgressEvent) => void): Promise<UnlistenFn> =>
  listen<ProgressEvent>("sftp://progress", (e) => cb(e.payload));

// ── 로컬 파일시스템(SFTP 좌측 패널) ───────────────────────────────────────────

export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export const localDefaultDir = (): Promise<string> => invoke<string>("local_default_dir");
export const localList = (path: string): Promise<LocalEntry[]> =>
  invoke<LocalEntry[]>("local_list", { path });
export const localParent = (path: string): Promise<string> =>
  invoke<string>("local_parent", { path });
export const localMkdir = (path: string): Promise<void> => invoke("local_mkdir", { path });
export const localRemove = (path: string, isDir: boolean): Promise<void> =>
  invoke("local_remove", { path, isDir });
export const localRename = (from: string, to: string): Promise<void> =>
  invoke("local_rename", { from, to });
export const localExists = (path: string): Promise<boolean> =>
  invoke<boolean>("local_exists", { path });

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
