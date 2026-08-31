// SFTP 공통부 — 항목 타입·경로/표기 헬퍼·살아있는 연결 레지스트리·전송 상태.
// sftpui.ts(창 본체)에서 분리(0.63.0 정지작업). 로직 변경 없음.

import { sftpDisconnect, sftpCancel, onSftpProgress } from "./ipc";
import { applyIcon } from "./icons";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  /** 심볼릭 링크(원격 전용). 로컬 목록에는 없다. */
  isSymlink?: boolean;
}

export type Side = "local" | "remote";

export const joinPath = (dir: string, name: string): string =>
  dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;

/** 드래그 내용에 OS 파일(탐색기 등)이 들어 있는가. 앱 내부 드래그는 자체 타입만 쓴다. */
export const hasOsFiles = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * 경로의 상위 폴더. 로컬·원격 모두 목록이 '/' 로 정규화된 경로를 준다.
 * 상위가 없으면(루트·이름뿐) 빈 문자열 — 호출부는 '모르는 값' 으로 다루면 된다.
 */
export const parentOf = (p: string): string => {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? (i === 0 ? "/" : "") : t.slice(0, i);
};

export function remoteParent(path: string): string {
  const p = path.replace(/\/+$/, "");
  if (p === "") return "/"; // 루트("/")에서 상위 = 루트 유지(홈으로 튀지 않게)
  const cut = p.lastIndexOf("/");
  if (cut < 0) return ".";
  if (cut === 0) return "/";
  return p.slice(0, cut);
}

/** path 가 root 아래(또는 root 자신)인가 — 트리 루트 판별용. */
export function pathUnder(path: string, root: string): boolean {
  if (root === "/") return path.startsWith("/");
  const r = root.replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`);
}

/** root 부터 path 까지의 조상 경로 체인 [root, …, path](트리 펼침용). */
export function dirChain(root: string, path: string): string[] {
  const chain = [root];
  if (!pathUnder(path, root)) return chain;
  const rest = path.slice(root.length).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!rest) return chain;
  let cur = root === "/" ? "" : root.replace(/\/+$/, "");
  for (const seg of rest.split("/")) {
    cur = `${cur}/${seg}`;
    chain.push(cur);
  }
  return chain;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fmtTime(unixSec: number): string {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 실행 파일로 볼 확장자. 원격 목록에는 권한 정보가 없어(Entry 에 mode 가 없다) 이름으로
 * 판단한다 — 색으로 눈에 띄게 하는 용도라 오탐이 있어도 손해가 없다.
 */
export const EXEC_EXT = new Set(["exe", "bat", "cmd", "com", "msi", "ps1", "sh", "bash", "zsh", "py", "pl", "rb"]);

export function isExecutable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && EXEC_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** 파일유형 열 텍스트. */
export function entryType(e: Entry): string {
  // 색은 놓칠 수 있다(색약·고대비 테마) — 글자로도 남긴다.
  if (e.isSymlink) return "링크";
  if (e.isDir) return "폴더";
  const dot = e.name.lastIndexOf(".");
  const x = dot > 0 ? e.name.slice(dot + 1).toUpperCase() : "";
  return x ? `${x} 파일` : "파일";
}

// ── 살아있는 SFTP 연결 레지스트리 ─────────────────────────────────────────────
//
// 모달을 닫아도 연결과 진행 중인 전송을 유지한다. 큰 파일을 받는 동안 터미널로 돌아갈 수
// 있어야 하기 때문이다. 연결은 백엔드(SftpMap)가 id 로 들고 있어 UI 와 무관하게 살아 있으므로,
// 프론트는 그 id 와 마지막 화면 상태만 기억하면 된다.
//
// 닫아도 끊기지 않으므로 **끊는 수단이 따로 있어야 한다** — 모달의 '연결 끊기' 버튼과
// 사이드바 SFTP 칩 우클릭이 그 역할을 한다.

export interface LiveSftp {
  sftpId: string;
  /** 다시 열 때 돌아갈 위치. */
  localDir: string;
  remoteDir: string;
  /** 진행 중 전송(없으면 null) — 모달이 닫혀 있어도 사이드바에 진행률을 보여 주기 위해 둔다. */
  transferId: string | null;
  name: string;
  /**
   * 전송 묶음 전체 기준의 진행량/총량. 파일 하나가 아니라 이번에 옮기기로 한 것 전부다 —
   * 열 개를 보내는데 파일마다 0%→100% 를 반복하면 얼마나 남았는지 알 수 없다.
   */
  done: number;
  total: number;
  /** 지금 파일이 시작되기 전까지 끝난 바이트. 진행 이벤트에 더해 전체 진행량을 만든다. */
  baseDone: number;
  /** 묶음 전체 바이트. 0 이면 미리 재지 못한 경우로, 파일 단위 진행률로 되돌아간다. */
  grandTotal: number;
}

/** 열 너비(px) — 모달을 닫았다 열어도 유지한다. 앱을 껐다 켜면 기본값으로 돌아간다. */
export const colWidths: Record<string, number> = {};


/** 타입어헤드 입력이 이어진 것으로 볼 시간(ms). 넘으면 처음부터 다시 친 것으로 본다. */
export const TYPEAHEAD_RESET_MS = 900;

export const liveSftp = new Map<string, LiveSftp>();

/**
 * 전송 상태 — 모달 인스턴스가 아니라 **연결(세션)** 소속(0.62.0). 모달을 접었다 다시
 * 열면 새 인스턴스가 생기는데, 상태가 인스턴스 지역이면 같은 연결에 이중 전송이
 * 시작되고 취소 버튼이 옛 전송에 닿지 않는다. 연결이 끊길 때 함께 지운다.
 */
export interface TransferState {
  transferring: boolean;
  cancelled: boolean;
  current: string | null;
}
export const transferStates = new Map<string, TransferState>();
export const transferStateOf = (id: string): TransferState => {
  let t = transferStates.get(id);
  if (!t) {
    t = { transferring: false, cancelled: false, current: null };
    transferStates.set(id, t);
  }
  return t;
};
export const liveWatchers = new Set<() => void>();
let progressHooked = false;

export const notifyLive = (): void => {
  for (const fn of liveWatchers) fn();
};

/** 세션에 살아있는 SFTP 연결이 있는가(사이드바 표시용). */
export const liveSftpOf = (sessionId: string): LiveSftp | undefined => liveSftp.get(sessionId);

/**
 * 지금 이 세션이 전송 중인가.
 *
 * 전송 id 로 판단하면 안 된다 — 끌어다 놓은 업로드는 조각마다 전송이 끝나 id 가 없다.
 * 그래서 사이드바 칩이 진행률 대신 계속 "SFTP" 로만 보였다(0.76.7).
 * 없는 세션에 상태를 만들지 않도록 get 으로만 본다.
 */
export const sftpTransferring = (sessionId: string): boolean =>
  transferStates.get(sessionId)?.transferring === true;

/** 살아있는 연결 목록이 바뀌거나 진행률이 갱신될 때 호출된다. */
export function onLiveSftpChanged(fn: () => void): () => void {
  liveWatchers.add(fn);
  return () => liveWatchers.delete(fn);
}

/** 사이드바 등에서 명시적으로 끊을 때. 진행 중 전송도 함께 취소한다. */
export async function disconnectLiveSftp(sessionId: string): Promise<void> {
  const live = liveSftp.get(sessionId);
  if (!live) return;
  liveSftp.delete(sessionId);
  transferStates.delete(sessionId);
  notifyLive();
  if (live.transferId) await sftpCancel(live.transferId).catch(() => {});
  await sftpDisconnect(live.sftpId).catch(() => {});
}

/**
 * 진행률 구독은 모달과 별개로 한 번만 건다 — 모달이 닫혀 있어도 배경 전송의 진행을
 * 따라가야 사이드바에 퍼센트를 띄울 수 있다.
 */
export function hookProgressOnce(): void {
  if (progressHooked) return;
  progressHooked = true;
  void onSftpProgress((e) => {
    for (const live of liveSftp.values()) {
      if (live.transferId !== e.transferId) continue;
      live.name = e.name;
      // 총량을 미리 잰 경우에만 묶음 기준으로 환산한다. 못 잰 경우(폴더 목록 조회 실패 등)
      // 억지로 합치면 100% 를 넘거나 뒤로 가는 수가 있어 파일 단위로 둔다.
      if (live.grandTotal > 0) {
        live.done = Math.min(live.grandTotal, live.baseDone + e.done);
        live.total = live.grandTotal;
      } else {
        live.done = e.done;
        live.total = e.total;
      }
      notifyLive();
      return;
    }
  });
}


export function span(): HTMLElement {
  return document.createElement("span");
}

export function mkBtn(iconName: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "sftp-btn";
  applyIcon(b, iconName);
  b.title = title;
  return b;
}
