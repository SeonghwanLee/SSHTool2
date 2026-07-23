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
