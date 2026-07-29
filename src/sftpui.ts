// SFTP 파일 매니저 — 로컬 | 원격 이중 패널(FileZilla 방식).
// 양방향 드래그앤드롭 전송(폴더 재귀), 다중 선택, 진행률 + 취소, 이름 충돌 처리,
// 우클릭 메뉴, F5 새로고침 / F2 이름변경 / Delete 삭제.

import type { SessionInfo } from "./types";
import {
  sftpConnect,
  sftpList,
  sftpDownload,
  sftpUpload,
  sftpCancel,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpDisconnect,
  sftpCanonicalize,
  onSftpProgress,
  localDefaultDir,
  localRoots,
  localList,
  localParent,
  localMkdir,
  localRemove,
  localRename,
  localExists,
  openPath,
  localTempDir,
} from "./ipc";
import { confirmDialog, textPrompt } from "./dialogs";
import { applyIcon, fileIcon } from "./icons";
import { showContextMenu, type MenuItem } from "./contextmenu";
import {
  conflictDialog,
  uniqueName,
  type ConflictChoice,
  type ConflictResult,
} from "./conflict";

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  /** 심볼릭 링크(원격 전용). 로컬 목록에는 없다. */
  isSymlink?: boolean;
}

type Side = "local" | "remote";

const joinPath = (dir: string, name: string): string =>
  dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function remoteParent(path: string): string {
  const p = path.replace(/\/+$/, "");
  if (p === "") return "/"; // 루트("/")에서 상위 = 루트 유지(홈으로 튀지 않게)
  const cut = p.lastIndexOf("/");
  if (cut < 0) return ".";
  if (cut === 0) return "/";
  return p.slice(0, cut);
}

/** path 가 root 아래(또는 root 자신)인가 — 트리 루트 판별용. */
function pathUnder(path: string, root: string): boolean {
  if (root === "/") return path.startsWith("/");
  const r = root.replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`);
}

/** root 부터 path 까지의 조상 경로 체인 [root, …, path](트리 펼침용). */
function dirChain(root: string, path: string): string[] {
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

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtTime(unixSec: number): string {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 실행 파일로 볼 확장자. 원격 목록에는 권한 정보가 없어(Entry 에 mode 가 없다) 이름으로
 * 판단한다 — 색으로 눈에 띄게 하는 용도라 오탐이 있어도 손해가 없다.
 */
const EXEC_EXT = new Set(["exe", "bat", "cmd", "com", "msi", "ps1", "sh", "bash", "zsh", "py", "pl", "rb"]);

function isExecutable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && EXEC_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** 파일유형 열 텍스트. */
function entryType(e: Entry): string {
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

interface LiveSftp {
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
const colWidths: Record<string, number> = {};

/**
 * 창 크기(px) — 열 너비와 같은 수명. 위치는 기억하지 않는다 — 크기만 인라인으로 주면
 * 오버레이의 flex 가 늘 가운데에 놓아 주므로, 앱 창이 줄었을 때 화면 밖에 뜨는 문제가
 * 아예 생기지 않는다.
 */
let savedPanelSize: { w: number; h: number } | null = null;

/** 타입어헤드 입력이 이어진 것으로 볼 시간(ms). 넘으면 처음부터 다시 친 것으로 본다. */
const TYPEAHEAD_RESET_MS = 900;

const liveSftp = new Map<string, LiveSftp>();
const liveWatchers = new Set<() => void>();
let progressHooked = false;

const notifyLive = (): void => {
  for (const fn of liveWatchers) fn();
};

/** 세션에 살아있는 SFTP 연결이 있는가(사이드바 표시용). */
export const liveSftpOf = (sessionId: string): LiveSftp | undefined => liveSftp.get(sessionId);

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
  notifyLive();
  if (live.transferId) await sftpCancel(live.transferId).catch(() => {});
  await sftpDisconnect(live.sftpId).catch(() => {});
}

/**
 * 진행률 구독은 모달과 별개로 한 번만 건다 — 모달이 닫혀 있어도 배경 전송의 진행을
 * 따라가야 사이드바에 퍼센트를 띄울 수 있다.
 */
function hookProgressOnce(): void {
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

export async function openSftpBrowser(
  session: SessionInfo,
  password: string,
  /** SFTP 인증이 실제로 성공한 뒤에만 호출(자격증명 저장 제안 등). */
  onAuthenticated?: () => void | Promise<void>,
  /** 설정의 'SFTP 기본 로컬 폴더'. 빈 값이면 OS 기본을 쓴다. */
  defaultLocalDir?: string,
): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "sftp-overlay";
  const panel = document.createElement("div");
  panel.className = "sftp-panel sftp-dual";
  if (savedPanelSize) {
    // 지난번 크기를 이어받는다. 앱 창보다 크면 그만큼 줄인다(최소치는 CSS min-* 가 지킨다).
    panel.style.width = `${Math.min(savedPanelSize.w, window.innerWidth - 8)}px`;
    panel.style.height = `${Math.min(savedPanelSize.h, window.innerHeight - 8)}px`;
  }
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // ── 크기 조절 손잡이 ──
  //
  // 창처럼 네 변과 네 모서리에서 모두 잡을 수 있게 한다. 우하단 한 곳뿐이면 창을 키우려고
  // 매번 그 구석까지 커서를 옮겨야 한다.
  //
  // CSS `resize: both` 는 쓸 수 없다. 이 패널은 오버레이의 flex 로 가운데 정렬돼 있어,
  // 끄는 동안 커지는 만큼 다시 가운데로 밀린다 — 잡고 있던 모서리가 커서에서 도망간다.
  // 드래그를 시작할 때 패널을 지금 자리에 고정(position: fixed)한 뒤 변을 움직인다.
  // 기준점이 움직이지 않으므로 잡은 자리가 커서를 그대로 따라온다.
  const EDGES: { dir: string; cursor: string }[] = [
    { dir: "n", cursor: "ns-resize" },
    { dir: "s", cursor: "ns-resize" },
    { dir: "e", cursor: "ew-resize" },
    { dir: "w", cursor: "ew-resize" },
    { dir: "ne", cursor: "nesw-resize" },
    { dir: "nw", cursor: "nwse-resize" },
    { dir: "se", cursor: "nwse-resize" },
    { dir: "sw", cursor: "nesw-resize" },
  ];

  for (const { dir, cursor } of EDGES) {
    const handle = document.createElement("div");
    handle.className = `sftp-rs sftp-rs-${dir}`;
    if (dir === "se") handle.title = "끌어서 창 크기 조절";
    panel.appendChild(handle);

    handle.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const r = panel.getBoundingClientRect();
      // 재정렬을 끊기 위해 현재 위치·크기에 못 박는다.
      panel.style.position = "fixed";
      panel.style.margin = "0";
      panel.style.left = `${r.left}px`;
      panel.style.top = `${r.top}px`;
      panel.style.width = `${r.width}px`;
      panel.style.height = `${r.height}px`;

      const cs = getComputedStyle(panel);
      const minW = parseFloat(cs.minWidth) || 400;
      const minH = parseFloat(cs.minHeight) || 300;
      const startX = down.clientX;
      const startY = down.clientY;
      const right = r.right;
      const bottom = r.bottom;

      const onMove = (m: MouseEvent) => {
        const dx = m.clientX - startX;
        const dy = m.clientY - startY;
        // 각 변을 따로 움직인다. 화면 밖으로는 못 나가게 막는다 — 넘기면 헤더의 닫기
        // 버튼에 닿지 못하는 창이 된다.
        if (dir.includes("e")) {
          const w = Math.min(window.innerWidth - r.left - 4, Math.max(minW, r.width + dx));
          panel.style.width = `${w}px`;
        }
        if (dir.includes("w")) {
          const left = Math.max(4, Math.min(right - minW, r.left + dx));
          panel.style.left = `${left}px`;
          panel.style.width = `${right - left}px`;
        }
        if (dir.includes("s")) {
          const h = Math.min(window.innerHeight - r.top - 4, Math.max(minH, r.height + dy));
          panel.style.height = `${h}px`;
        }
        if (dir.includes("n")) {
          const top = Math.max(4, Math.min(bottom - minH, r.top + dy));
          panel.style.top = `${top}px`;
          panel.style.height = `${bottom - top}px`;
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.classList.remove("sftp-resizing");
      };
      // 손잡이로 크기를 바꾸면 최대화 상태를 푼다 — '이전 크기'라고 적힌 채 크기가
      // 최대화가 아니면 버튼이 거짓말을 하게 된다.
      if (beforeMax !== null) {
        beforeMax = null;
        maxBtn.textContent = "최대화";
      }
      // 드래그 중에는 커서를 고정한다. 손잡이를 잠깐 벗어나도 모양이 바뀌지 않게.
      document.body.style.cursor = cursor;
      document.body.classList.add("sftp-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  let sftpId: string | null = null;
  let unlisten: (() => void) | null = null;
  let currentTransfer: string | null = null;
  let cancelled = false;
  let transferring = false; // 동시 전송 방지(진행바·취소 대상이 뒤섞이지 않게)
  /** 이번 묶음의 측정 단계에서 읽어 둔 폴더 목록(경로 → 자식). 전송이 재사용한다. */
  let listedCache = new Map<string, Entry[]>();
  // 이번 전송 묶음 전체의 바이트. 0 이면 미리 재지 못한 경우로 파일 단위 진행률로 돌아간다.
  let bundleTotal = 0;
  let bundleDone = 0;
  let disposed = false;     // 창이 닫힌 뒤의 후속 작업 차단

  // ── 헤더 ──
  const header = document.createElement("div");
  header.className = "sftp-header";
  const title = document.createElement("div");
  title.className = "sftp-title";
  title.textContent = `SFTP · ${session.name || session.host}`;
  const status = document.createElement("div");
  status.className = "sftp-status";
  // 닫기는 연결을 유지한 채 창만 감춘다 — 끊으려면 이 버튼을 눌러야 한다.
  const dcBtn = document.createElement("button");
  dcBtn.className = "sftp-btn sftp-disconnect";
  dcBtn.textContent = "연결 끊기";
  dcBtn.title = "SFTP 연결을 끊습니다(진행 중 전송도 취소).";
  // 최대화 — 창 안을 꽉 채운다. 파일이 많은 폴더를 훑을 때 매번 모서리를 끌지 않아도 된다.
  const maxBtn = document.createElement("button");
  maxBtn.className = "sftp-btn sftp-maximize";
  maxBtn.textContent = "최대화";
  maxBtn.title = "창 크기에 맞게 최대화 (되돌리려면 다시 누르세요)";
  const closeBtn = document.createElement("button");
  closeBtn.className = "sftp-close";
  closeBtn.title = "닫기(연결은 유지됩니다)";
  applyIcon(closeBtn, "close");
  header.append(title, status, dcBtn, maxBtn, closeBtn);

  // 최대화 직전의 인라인 스타일을 통째로 기억했다가 되돌린다. 값만 따로 담으면
  // '한 번도 크기를 안 바꾼 상태'(인라인 스타일 없음)를 되살릴 수 없다.
  let beforeMax: string | null = null;
  const applyMaximized = () => {
    panel.style.position = "fixed";
    panel.style.margin = "0";
    // CSS 의 max-width/height(99vw·98vh)가 걸려 있어 그대로 두면 최대화가 창을 다 못 채운다.
    // 스타일 속성을 통째로 되돌리므로 여기서 풀어도 복원에는 영향이 없다.
    panel.style.maxWidth = "none";
    panel.style.maxHeight = "none";
    panel.style.left = "4px";
    panel.style.top = "4px";
    panel.style.width = `${window.innerWidth - 8}px`;
    panel.style.height = `${window.innerHeight - 8}px`;
  };
  const setMaximized = (on: boolean) => {
    if (on) {
      beforeMax = panel.getAttribute("style") ?? "";
      applyMaximized();
    } else {
      if (beforeMax === null) return;
      panel.setAttribute("style", beforeMax);
      beforeMax = null;
    }
    maxBtn.textContent = on ? "이전 크기" : "최대화";
    maxBtn.title = on ? "최대화 전 크기로 되돌립니다" : "창 크기에 맞게 최대화 (되돌리려면 다시 누르세요)";
  };
  maxBtn.addEventListener("click", () => setMaximized(beforeMax === null));
  // 헤더를 더블클릭해도 토글된다 — 창에서 흔히 쓰는 방식이라 눌러 보게 된다.
  header.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    setMaximized(beforeMax === null);
  });
  // 최대화 상태에서 앱 창 크기가 바뀌면 따라간다. 안 그러면 화면 밖으로 삐져나간다.
  const onWinResize = () => {
    if (beforeMax !== null) applyMaximized();
  };
  window.addEventListener("resize", onWinResize);

  const setStatus = (m: string) => {
    status.textContent = m;
  };

  // ── 전송 진행 스트립 ──
  const strip = document.createElement("div");
  strip.className = "sftp-progress hidden";
  const pName = document.createElement("span");
  pName.className = "prog-name";
  const bar = document.createElement("div");
  bar.className = "prog-bar";
  const fill = document.createElement("div");
  fill.className = "prog-fill";
  const pct = document.createElement("span");
  pct.className = "prog-pct";
  bar.append(fill, pct);
  const pInfo = document.createElement("span");
  pInfo.className = "prog-info";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "tree-act";
  applyIcon(cancelBtn, "cancel");
  cancelBtn.title = "전송 취소";
  cancelBtn.addEventListener("click", () => {
    cancelled = true;
    if (currentTransfer) void sftpCancel(currentTransfer);
  });
  strip.append(pName, bar, pInfo, cancelBtn);

  // 전송 속도 계산용(이전 진행 시점).
  let speedName = "";
  let lastDone = 0;
  let lastAt = 0;
  let overall = ""; // "3/10" 같은 전체 진행

  const showProgress = (name: string, done: number, total: number) => {
    strip.classList.remove("hidden");
    pName.textContent = overall ? `${name}  (${overall})` : name;
    const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    fill.style.width = `${ratio}%`;
    pct.textContent = `${ratio}%`;

    // 같은 파일이 진행 중일 때만 속도(MB/s)를 낸다.
    let speed = "";
    const now = performance.now();
    if (name === speedName && now > lastAt) {
      const bps = ((done - lastDone) / (now - lastAt)) * 1000;
      if (bps > 0) speed = ` · ${fmtSize(bps)}/s`;
    }
    // 파일이 바뀌면 현재 진행량을 기준점으로 삼는다(0 으로 두면 첫 샘플 속도가 부풀려짐).
    speedName = name;
    lastDone = done;
    lastAt = now;
    pInfo.textContent = (total > 0 ? `${fmtSize(done)} / ${fmtSize(total)}` : fmtSize(done)) + speed;
  };
  const setOverall = (o: string) => {
    overall = o;
  };
  const hideProgress = () => strip.classList.add("hidden");

  onSftpProgress((e) => {
    if (disposed || e.transferId !== currentTransfer) return;
    // 파일 하나가 아니라 묶음 전체 기준으로 보여 준다 — 열 개를 보내는데 파일마다
    // 0%→100% 를 반복하면 얼마나 남았는지 알 수 없다.
    if (bundleTotal > 0) showProgress(e.name, Math.min(bundleTotal, bundleDone + e.done), bundleTotal);
    else showProgress(e.name, e.done, e.total);
  }).then((fn) => {
    // listen() 이 해결되기 전에 창이 닫혔으면 즉시 해제(리스너 누수 방지).
    if (disposed) fn();
    else unlisten = fn;
  });

  // ── 패널 ──
  const body = document.createElement("div");
  body.className = "sftp-body";

  /** 진행 중 전송을 레지스트리에도 반영한다(모달이 닫혀도 사이드바가 상태를 안다). */
  const setTransfer = (id: string | null) => {
    currentTransfer = id;
    const live = liveSftp.get(session.id);
    if (live) {
      live.transferId = id;
      if (!id) {
        live.done = 0;
        live.total = 0;
      }
    }
    notifyLive();
  };

  /** 창 크기를 기억한다(다음에 열 때 이어받도록). 최대화 상태면 그 직전 크기를 남긴다. */
  const rememberSize = () => {
    if (beforeMax !== null) {
      // 최대화 중 — 되돌릴 크기(인라인 width/height)를 파싱해 남긴다. 없으면 기본 크기였다.
      const w = /width:\s*([\d.]+)px/.exec(beforeMax);
      const h = /height:\s*([\d.]+)px/.exec(beforeMax);
      savedPanelSize = w && h ? { w: parseFloat(w[1]), h: parseFloat(h[1]) } : null;
      return;
    }
    const r = panel.getBoundingClientRect();
    savedPanelSize = { w: Math.round(r.width), h: Math.round(r.height) };
  };

  /** 마지막 화면 위치를 레지스트리에 남긴다(다시 열 때 그 자리로 돌아가기 위해). */
  const rememberState = () => {
    if (!sftpId) return;
    const live = liveSftp.get(session.id);
    if (!live) return;
    live.localDir = local.path;
    live.remoteDir = remote.path;
    live.transferId = currentTransfer;
  };

  /**
   * 창만 닫고 연결·전송은 살려 둔다. 큰 파일을 받는 동안 터미널로 돌아갈 수 있어야 해서
   * 기본 닫기를 이 동작으로 둔다. 전송이 계속되므로 닫기 전 확인도 필요 없다.
   */
  const closeKeepAlive = () => {
    disposed = true;
    rememberSize();
    rememberState();
    unlisten?.(); // 모달 진행바 구독만 해제 — 배경 진행률은 모듈 구독이 계속 받는다
    window.removeEventListener("resize", onWinResize);
    overlay.remove();
    notifyLive();
  };

  /** 실제로 끊는다 — 진행 중 전송도 취소된다. */
  const disconnectNow = () => {
    disposed = true;
    rememberSize();
    cancelled = true;
    if (currentTransfer) void sftpCancel(currentTransfer);
    unlisten?.();
    window.removeEventListener("resize", onWinResize);
    liveSftp.delete(session.id);
    if (sftpId) void sftpDisconnect(sftpId);
    overlay.remove();
    notifyLive();
  };
  // 닫기는 연결을 유지하므로 전송 중이어도 그냥 닫아도 된다(예전엔 확인을 물었다).
  closeBtn.addEventListener("click", closeKeepAlive);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeKeepAlive();
  });

  // 끊기는 되돌릴 수 없다 — 전송 중이면 한 번 확인한다.
  dcBtn.addEventListener("click", () => {
    void (async () => {
      if (currentTransfer) {
        const ok = await confirmDialog("파일을 전송 중입니다. 전송을 취소하고 연결을 끊을까요?");
        if (!ok || disposed) return;
      }
      disconnectNow();
    })();
  });

  // ── 디렉터리 트리(지연 로딩) ──
  // 각 패널 상단의 폴더 트리. 확장 시에만 하위 폴더를 조회하고, 목록 이동 시
  // 해당 경로까지 자동으로 펼쳐 강조한다. 클릭하면 아래 목록이 그 폴더로 이동.
  class DirTree {
    readonly el = document.createElement("div");
    private roots: string[] = [];
    private readonly expanded = new Set<string>();
    private readonly children = new Map<string, string[]>(); // 경로 → 하위 폴더 경로들
    private current = "";

    constructor(
      private readonly side: Side,
      private readonly onPick: (path: string) => void,
      /** 트리 폴더 우클릭 — 그 폴더를 대상으로 한 메뉴를 띄운다. */
      private readonly onMenu?: (path: string, x: number, y: number) => void,
    ) {
      this.el.className = "sftp-tree";
    }

    init(roots: string[]): void {
      this.roots = roots;
      this.render();
    }

    /** 하위 폴더 목록을 조회(캐시). 실패해도 빈 배열로 안전 처리. */
    private async load(path: string): Promise<string[]> {
      const cached = this.children.get(path);
      if (cached) return cached;
      try {
        const entries =
          this.side === "local" ? await localList(path) : await sftpList(sftpId!, path || ".");
        const dirs = (entries as Entry[])
          .filter((e) => e.isDir && e.name !== "." && e.name !== "..")
          .map((e) => e.path)
          .sort((a, b) => baseName(a).localeCompare(baseName(b), "ko"));
        this.children.set(path, dirs);
        return dirs;
      } catch {
        this.children.set(path, []);
        return [];
      }
    }

    /**
     * 주어진 경로까지 조상들을 펼치고 강조(목록 이동과 동기화).
     * force=true 면 그 폴더의 하위 캐시를 버려 다시 조회(생성/삭제/이름변경 반영).
     */
    async reveal(path: string, force = false): Promise<void> {
      this.current = path;
      if (force) this.children.delete(path);
      const root = this.roots.find((r) => pathUnder(path, r));
      if (root) {
        for (const seg of dirChain(root, path)) {
          this.expanded.add(seg);
          await this.load(seg);
        }
      }
      this.render();
    }

    private render(): void {
      this.el.innerHTML = "";
      for (const r of this.roots) this.renderNode(r, 0);
      if (this.roots.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tree-empty";
        empty.textContent = "…";
        this.el.appendChild(empty);
      }
      // 현재 폴더가 트리 최상단에 보이도록 스크롤한다.
      const cur = this.el.querySelector(".tree-current") as HTMLElement | null;
      if (cur) this.el.scrollTop = Math.max(0, cur.offsetTop - this.el.offsetTop);
    }

    private renderNode(path: string, depth: number): void {
      const kids = this.children.get(path);
      const isOpen = this.expanded.has(path);
      const expandable = kids === undefined || kids.length > 0; // 미조회는 일단 펼침 가능으로

      const row = document.createElement("div");
      row.className = "tree-node" + (path === this.current ? " tree-current" : "");
      row.style.paddingLeft = `${4 + depth * 14}px`;

      const arrow = document.createElement("span");
      arrow.className = "tree-arrow";
      arrow.textContent = expandable ? (isOpen ? "▾" : "▸") : "";
      arrow.addEventListener("click", async (e) => {
        e.stopPropagation(); // 화살표는 펼침만, 이동은 안 함
        if (this.expanded.has(path)) this.expanded.delete(path);
        else {
          this.expanded.add(path);
          await this.load(path);
        }
        this.render();
      });

      const icon = document.createElement("span");
      icon.className = "tree-folder-icon";
      applyIcon(icon, isOpen ? "folderOpen" : "folder");

      const label = document.createElement("span");
      label.className = "tree-node-label";
      label.textContent = this.roots.includes(path) ? path : baseName(path);

      row.append(arrow, icon, label);
      row.addEventListener("click", () => this.onPick(path));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onMenu?.(path, e.clientX, e.clientY);
      });
      this.el.appendChild(row);

      if (isOpen && kids) {
        for (const k of kids) this.renderNode(k, depth + 1);
      }
    }
  }

  // ── 파일 목록 패널 ──
  class Pane {
    path = "";
    entries: Entry[] = [];
    readonly selected = new Set<string>();
    readonly root = document.createElement("div");
    readonly tree: DirTree;
    private readonly listEl = document.createElement("div");
    private readonly pathInput = document.createElement("input");
    private anchor = -1; // Shift 범위 선택 기준 인덱스(visible 기준)
    /** 타입어헤드 누적 버퍼와 마지막 입력 시각 — 잠시 쉬면 초기화된다. */
    private typeBuf = "";
    private typeAt = 0;
    /** 열 헤더 클릭 정렬. 기본은 이름 오름차순(기존 동작과 같다). */
    private sortKey: "name" | "type" | "size" | "time" = "name";
    private sortAsc = true;
    other!: Pane;

    constructor(readonly side: Side) {
      this.root.className = "sftp-pane";
      // 트리에서 고른 폴더를 반대편으로 통째로 옮긴다. 목록으로 내려가 그 폴더를 찾아
      // 우클릭할 필요 없이, 트리에서 바로 보내려는 것이 이 메뉴의 목적이다.
      this.tree = new DirTree(
        side,
        (p) => void this.go(p),
        (path, x, y) => {
          // 트리에 보이는 폴더가 반대편 목록에 떠 있다는 보장이 없어 항목을 직접 만든다.
          const folder: Entry = { name: baseName(path), path, isDir: true, size: 0, modified: 0 };
          showContextMenu(x, y, [
            { label: "이 폴더 열기", accel: "o", action: () => void this.go(path) },
            { separator: true },
            {
              label: side === "local" ? "업로드 →" : "← 다운로드",
              accel: "t",
              action: () => void transferItems(this.other, [folder]),
            },
            { separator: true },
            { label: "새로고침", accel: "f", action: () => void this.tree.reveal(path, true) },
          ]);
        },
      );

      const head = document.createElement("div");
      head.className = "sftp-pane-head";
      const labelIcon = document.createElement("span");
      labelIcon.className = "pane-label-icon";
      applyIcon(labelIcon, side === "local" ? "local" : "globe");
      const label = document.createElement("span");
      label.className = "pane-label";
      label.textContent = side === "local" ? "로컬" : "원격";
      head.append(labelIcon, label);

      const up = mkBtn("up", "상위 폴더");
      up.addEventListener("click", () => void this.up());
      const refresh = mkBtn("refresh", "새로고침(F5)");
      refresh.addEventListener("click", () => void this.reload());
      const mkdirBtn = mkBtn("newFolder", "새 폴더");
      mkdirBtn.addEventListener("click", () => void this.makeDir());
      head.append(up, refresh, mkdirBtn);

      this.pathInput.className = "sftp-path";
      this.pathInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void this.go(this.pathInput.value.trim());
      });
      head.appendChild(this.pathInput);

      this.listEl.className = "sftp-list";
      this.listEl.tabIndex = 0;
      this.listEl.addEventListener("keydown", (e) => this.onKey(e));

      // 목록 빈 곳 우클릭 — 폴더가 비어 있으면 우클릭할 행 자체가 없어 '새 폴더'로 가는
      // 길이 머리말 버튼뿐이었다. 행 위에서 뜬 메뉴는 행 핸들러가 이미 처리하므로 건너뛴다.
      this.listEl.addEventListener("contextmenu", (e) => {
        // '..' 행은 제 메뉴가 없으므로 여기서 받는다 — 제외하면 우클릭이 죽은 자리가 된다.
        if ((e.target as HTMLElement).closest(".sftp-row:not(.sftp-updir)")) return;
        e.preventDefault();
        // 탐색기와 같게 빈 곳을 누르면 선택을 푼다 — 안 그러면 이 메뉴가 무엇을 대상으로
        // 하는지 모호해진다(선택은 남아 있는데 메뉴에는 그 항목 명령이 없다).
        if (this.selected.size > 0) {
          this.selected.clear();
          this.markSelection();
        }
        const items: MenuItem[] = [
          { label: "새 폴더", accel: "n", action: () => void this.makeDir() },
          { separator: true },
          { label: "상위 폴더", accel: "u", action: () => void this.up() },
          { label: "새로고침 (F5)", accel: "f", action: () => void this.reload() },
        ];
        // 빈 폴더에서는 고를 것이 없다.
        if (this.visible().length > 0) {
          items.push(
            { separator: true },
            {
              label: "전체 선택 (Ctrl+A)",
              accel: "a",
              action: () => {
                for (const v of this.visible()) this.selected.add(v.path);
                this.markSelection();
                this.listEl.focus();
              },
            },
          );
        }
        showContextMenu(e.clientX, e.clientY, items);
      });

      // 반대 패널에서 끌어온 항목 받기.
      this.listEl.addEventListener("dragover", (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        this.listEl.classList.add("drop-target");
      });
      this.listEl.addEventListener("dragleave", (e) => {
        // 자식 행 사이를 지날 때도 발생하므로, 목록 바깥으로 나갔을 때만 해제한다.
        const to = e.relatedTarget as Node | null;
        if (!to || !this.listEl.contains(to)) this.listEl.classList.remove("drop-target");
      });
      this.listEl.addEventListener("drop", (e) => {
        e.preventDefault();
        this.listEl.classList.remove("drop-target");
        const raw = e.dataTransfer?.getData("application/x-sshtool");
        if (!raw) return;
        try {
          const payload = JSON.parse(raw) as { side: Side; paths: string[] };
          if (payload.side === this.side) return; // 같은 패널 내 이동은 미지원
          void transferInto(this, payload.paths);
        } catch {
          /* 무시 */
        }
      });

      // 트리(상단) ↔ 목록(하단) 세로 크기 조절 스플리터.
      const hsplit = document.createElement("div");
      hsplit.className = "sftp-hsplitter";
      hsplit.addEventListener("mousedown", (down) => {
        down.preventDefault();
        const startY = down.clientY;
        const startH = this.tree.el.getBoundingClientRect().height;
        const paneH = this.root.getBoundingClientRect().height;
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        const onMove = (m: MouseEvent) => {
          if (m.buttons === 0) {
            onUp();
            return;
          }
          const h = Math.max(48, Math.min(paneH - 120, startH + (m.clientY - startY)));
          this.tree.el.style.flex = `0 0 ${h}px`;
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });

      this.root.append(head, this.tree.el, hsplit, this.buildColHead(), this.listEl);
    }

    /** 정렬이 바뀌면 헤더만 다시 그려 방향 표시를 갱신한다. */
    private rebuildHead(): void {
      const old = this.root.querySelector(".sftp-colhead");
      if (old) old.replaceWith(this.buildColHead());
    }

    /** 컬럼 헤더(파일명/유형/크기/수정일자) + 구분선 드래그로 너비 조절(탐색기 방식). */
    private buildColHead(): HTMLElement {
      // 이전에 조절해 둔 폭이 있으면 그대로 되살린다.
      for (const [v, w] of Object.entries(colWidths)) this.root.style.setProperty(v, `${w}px`);
      const head = document.createElement("div");
      head.className = "sftp-colhead";
      const spacer = document.createElement("span"); // 아이콘 칸 자리
      head.append(
        spacer,
        this.colCell("파일명", undefined, "name"),
        this.colCell("유형", "--c-type", "type"),
        this.colCell("크기", "--c-size", "size"),
        this.colCell("수정일자", "--c-time", "time"),
      );
      return head;
    }

    private colCell(
      label: string,
      cssVar?: string,
      sortKey?: "name" | "type" | "size" | "time",
    ): HTMLElement {
      const cell = document.createElement("span");
      cell.className = "sftp-colcell";
      const text = document.createElement("span");
      text.className = "sftp-collabel";
      // 정렬 중인 열에는 방향 표시를 붙인다(탐색기 관례).
      const arrow = sortKey && this.sortKey === sortKey ? (this.sortAsc ? " ▲" : " ▼") : "";
      text.textContent = label + arrow;
      cell.appendChild(text);

      if (sortKey) {
        cell.classList.add("sortable");
        cell.title = "클릭하여 정렬";
        cell.addEventListener("click", () => {
          // 같은 열을 다시 누르면 방향만 뒤집는다.
          if (this.sortKey === sortKey) this.sortAsc = !this.sortAsc;
          else {
            this.sortKey = sortKey;
            // 크기·날짜는 큰 값/최신이 먼저 보이는 편이 쓸모 있다.
            this.sortAsc = sortKey === "name" || sortKey === "type";
          }
          this.rebuildHead();
          this.draw();
        });
      }
      if (cssVar) {
        const handle = document.createElement("span");
        handle.className = "sftp-colhandle";
        handle.title = "드래그하여 너비 조절";
        handle.addEventListener("mousedown", (down) => {
          down.preventDefault();
          down.stopPropagation();
          const startX = down.clientX;
          const cur = parseFloat(getComputedStyle(this.root).getPropertyValue(cssVar)) || 84;
          const onMove = (m: MouseEvent) => {
            if (m.buttons === 0) {
              onUp();
              return;
            }
            // 왼쪽 경계를 끌어 이 컬럼 너비를 조절(파일명 컬럼이 남는 폭을 흡수).
            const w = Math.max(48, Math.min(360, cur - (m.clientX - startX)));
            this.root.style.setProperty(cssVar, `${w}px`);
            colWidths[cssVar] = w; // 모달을 닫았다 열어도 폭이 유지되게 기억한다
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        });
        cell.appendChild(handle);
      }
      return cell;
    }

    /** '..' 상위 폴더 이동 행(탐색기/FTP 방식) — 루트가 아니면 목록 맨 위에 표시. */
    private upRow(): HTMLElement {
      const el = document.createElement("div");
      el.className = "sftp-row sftp-updir";
      const icon = document.createElement("span");
      icon.className = "sftp-icon mdl2";
      applyIcon(icon, "up");
      const name = document.createElement("span");
      name.className = "sftp-name";
      name.textContent = "..";
      el.append(icon, name, span(), span(), span());
      el.addEventListener("dblclick", () => void this.up());
      return el;
    }

    async go(path: string, force = false): Promise<void> {
      try {
        const entries =
          this.side === "local" ? await localList(path) : await sftpList(sftpId!, path || ".");
        this.path = path;
        this.pathInput.value = path;
        this.entries = entries as Entry[];
        this.selected.clear();
        this.anchor = -1; // 폴더 이동 시 Shift 범위 선택 기준 초기화(엉뚱한 범위 방지)
        this.draw();
        void this.tree.reveal(path, force); // 트리 강조·펼침 동기화(reload 는 캐시 갱신)
      } catch (e) {
        setStatus(`목록 실패: ${String(e)}`);
      }
    }

    reload(): Promise<void> {
      return this.go(this.path, true); // 폴더 생성/삭제/이름변경 후 트리도 갱신
    }

    focusList(): void {
      this.listEl.focus();
    }

    async up(): Promise<void> {
      const parent =
        this.side === "local" ? await localParent(this.path) : remoteParent(this.path);
      if (parent && parent !== this.path) await this.go(parent);
    }

    private async makeDir(): Promise<void> {
      const name = await textPrompt("새 폴더 이름", "", "만들기");
      if (!name) return;
      try {
        const target = joinPath(this.path, name);
        if (this.side === "local") await localMkdir(target);
        else await sftpMkdir(sftpId!, target);
        await this.reload();
      } catch (e) {
        setStatus(`폴더 생성 실패: ${String(e)}`);
      }
    }

    private onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        this.selected.clear();
        for (const v of this.visible()) this.selected.add(v.path);
        this.markSelection();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        void this.reload();
      } else if (e.key === "Delete") {
        e.preventDefault();
        void this.removeSelected();
      } else if (e.key === "F2") {
        e.preventDefault();
        const first = [...this.selected][0];
        const entry = this.entries.find((x) => x.path === first);
        if (entry) void this.rename(entry);
      } else {
        this.typeAhead(e);
      }
    }

    /**
     * 타입어헤드 — 글자를 치면 그 글자로 시작하는 항목으로 이동한다(탐색기 관례).
     *
     * 빠르게 이어 치면 누적해서 좁히고(`2`,`0`,`2` → "202…"), 잠시 쉬면 처음부터 다시
     * 시작한다. 같은 글자만 반복해서 누르면 그 글자로 시작하는 항목들을 순환한다 —
     * 파일명을 정확히 모를 때 훑어보는 용도라 이쪽이 누적보다 쓸모 있다.
     */
    private typeAhead(e: KeyboardEvent): void {
      // 조합 중인 한글(229)·조합키·기능키는 건드리지 않는다.
      if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      if ([...e.key].length !== 1) return; // 문자 한 글자만(Enter·Arrow 등 제외)

      e.preventDefault();
      const now = Date.now();
      const sameKey = this.typeBuf.length === 1 && this.typeBuf === e.key.toLowerCase();
      if (now - this.typeAt > TYPEAHEAD_RESET_MS) this.typeBuf = "";
      this.typeAt = now;

      const rows = this.visible();
      if (rows.length === 0) return;
      const cur = rows.findIndex((v) => this.selected.has(v.path));

      let from = 0;
      if (sameKey) {
        // 같은 글자 반복 = 다음 후보로 순환(버퍼는 그 글자 하나로 유지).
        from = cur + 1;
      } else {
        this.typeBuf += e.key.toLowerCase();
        from = cur < 0 ? 0 : cur; // 누적 중에는 현재 항목부터 다시 본다
      }

      const hit = this.findByPrefix(rows, this.typeBuf, from);
      if (hit < 0) return;
      const target = rows[hit];
      this.selected.clear();
      this.selected.add(target.path);
      this.anchor = hit;
      this.markSelection();
      this.listEl
        .querySelector<HTMLElement>(`[data-path="${CSS.escape(target.path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }

    /** from 부터 한 바퀴 돌며 prefix 로 시작하는 첫 항목의 인덱스(없으면 -1). */
    private findByPrefix(rows: Entry[], prefix: string, from: number): number {
      for (let i = 0; i < rows.length; i++) {
        const idx = (from + i) % rows.length;
        if (rows[idx].name.toLowerCase().startsWith(prefix)) return idx;
      }
      return -1;
    }

    private async rename(entry: Entry): Promise<void> {
      const next = await textPrompt("이름 변경", entry.name, "변경");
      if (!next || next === entry.name) return;
      const target = joinPath(this.side === "local" ? await localParent(entry.path) : remoteParent(entry.path), next);
      try {
        if (this.side === "local") await localRename(entry.path, target);
        else await sftpRename(sftpId!, entry.path, target);
        await this.reload();
      } catch (e) {
        setStatus(`이름 변경 실패: ${String(e)}`);
      }
    }

    private async removeSelected(): Promise<void> {
      const targets = this.entries.filter((x) => this.selected.has(x.path));
      if (targets.length === 0) return;
      const ok = await confirmDialog(`${targets.length}개 항목을 삭제할까요?`);
      if (!ok) return;
      for (const t of targets) {
        try {
          if (this.side === "local") await localRemove(t.path, t.isDir);
          else await sftpRemove(sftpId!, t.path, t.isDir);
        } catch (e) {
          setStatus(`삭제 실패: ${String(e)}`);
        }
      }
      await this.reload();
    }

    selectedEntries(): Entry[] {
      return this.entries.filter((x) => this.selected.has(x.path));
    }

    hasName(name: string): boolean {
      return this.entries.some((x) => x.name === name);
    }

    /** 화면에 보이는 항목만("."/".." 제외) — 범위 선택·전체 선택 기준. */
    private visible(): Entry[] {
      return this.sorted(this.entries.filter((x) => x.name !== "." && x.name !== ".."));
    }

    /**
     * 정렬 결과. **폴더를 항상 먼저** 둔다 — 정렬 기준이 무엇이든 폴더가 위에 모이는 것이
     * 파일 관리자의 공통 관례이고, 크기·날짜로 정렬했을 때 폴더가 파일 사이에 흩어지면
     * 탐색이 어려워진다.
     */
    private sorted(list: Entry[]): Entry[] {
      const dir = this.sortAsc ? 1 : -1;
      const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, "ko");
      return [...list].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        switch (this.sortKey) {
          case "size":
            return (a.size - b.size) * dir || byName(a, b);
          case "time":
            return (a.modified - b.modified) * dir || byName(a, b);
          case "type":
            return entryType(a).localeCompare(entryType(b), "ko") * dir || byName(a, b);
          default:
            return byName(a, b) * dir;
        }
      });
    }

    /** 파일을 기본 연결 프로그램으로 연다(원격은 임시폴더로 내려받아 사본을 연다). */
    private async open(entry: Entry): Promise<void> {
      if (entry.isDir) {
        await this.go(entry.path);
        return;
      }
      if (this.side === "local") {
        try {
          await openPath(entry.path);
        } catch (e) {
          setStatus(`열기 실패: ${String(e)}`);
        }
        return;
      }
      if (!sftpId) {
        setStatus("원격에 접속되지 않았습니다.");
        return;
      }
      if (transferring) {
        setStatus("전송 중입니다. 끝난 뒤 다시 시도하세요.");
        return;
      }
      // 원격 파일명은 서버가 준 값 — 경로 구분자/상위(..)를 걸러 임시폴더 밖으로 새지 않게 한다.
      const rawName = baseName(entry.name).replace(/[\\/]/g, "_");
      const safeName = rawName === "" || rawName === "." || rawName === ".." ? "download" : rawName;
      transferring = true; // 동시 전송/열기 방지 — currentTransfer 가 뒤섞이지 않게
      cancelled = false;
      try {
        setStatus(`여는 중… ${entry.name}`);
        const dir = await localTempDir();
        const localPath = joinPath(dir.replace(/\\+$/, ""), safeName);
        const transferId = crypto.randomUUID();
        setTransfer(transferId);
        showProgress(entry.name, 0, entry.size);
        await sftpDownload(sftpId, entry.path, localPath, transferId);
        setTransfer(null);
        hideProgress();
        await openPath(localPath);
        setStatus("연결됨");
      } catch (e) {
        setTransfer(null);
        hideProgress();
        setStatus(`열기 실패: ${String(e)}`);
      } finally {
        transferring = false;
      }
    }

    draw(): void {
      this.listEl.innerHTML = "";
      if (this.path) this.listEl.appendChild(this.upRow()); // '..' 상위 이동
      for (const entry of this.visible()) this.listEl.appendChild(this.row(entry));
    }

    /** 선택 표시만 갱신 — draw() 로 재생성하면 드래그 소스가 사라져 드래그가 취소된다. */
    markSelection(): void {
      for (const child of Array.from(this.listEl.children)) {
        const el = child as HTMLElement;
        const p = el.dataset.path;
        el.classList.toggle("selected", !!p && this.selected.has(p));
      }
    }

    private row(entry: Entry): HTMLElement {
      const el = document.createElement("div");
      el.className =
        "sftp-row" +
        (this.selected.has(entry.path) ? " selected" : "") +
        // 링크는 폴더·실행파일보다 앞선다 — 링크라는 사실이 확장자보다 중요한 정보다.
        (entry.isSymlink
          ? " is-link"
          : entry.isDir
            ? " is-dir"
            : isExecutable(entry.name)
              ? " is-exec"
              : "");
      el.dataset.path = entry.path;
      el.draggable = true;

      const fi = fileIcon(entry.name, entry.isDir);
      const icon = document.createElement("span");
      icon.className = "sftp-icon mdl2";
      icon.textContent = fi.glyph;
      icon.style.color = fi.color;

      const name = document.createElement("span");
      name.className = "sftp-name";
      name.textContent = entry.name;

      const type = document.createElement("span");
      type.className = "sftp-type";
      type.textContent = entryType(entry);

      const size = document.createElement("span");
      size.className = "sftp-size";
      size.textContent = entry.isDir ? "" : fmtSize(entry.size);

      const time = document.createElement("span");
      time.className = "sftp-time";
      time.textContent = fmtTime(entry.modified);

      el.append(icon, name, type, size, time);

      el.addEventListener("click", (e) => {
        const vis = this.visible();
        const idx = vis.findIndex((x) => x.path === entry.path);
        if (e.shiftKey && this.anchor >= 0 && this.anchor < vis.length) {
          // Shift: 기준 항목부터 현재 항목까지 범위 선택(Ctrl 동반 시 기존 선택 유지).
          if (!e.ctrlKey && !e.metaKey) this.selected.clear();
          const [a, b] = this.anchor <= idx ? [this.anchor, idx] : [idx, this.anchor];
          for (let k = a; k <= b; k++) this.selected.add(vis[k].path);
        } else if (e.ctrlKey || e.metaKey) {
          if (this.selected.has(entry.path)) this.selected.delete(entry.path);
          else this.selected.add(entry.path);
          this.anchor = idx;
        } else {
          this.selected.clear();
          this.selected.add(entry.path);
          this.anchor = idx;
        }
        this.markSelection();
        this.listEl.focus();
      });
      el.addEventListener("dblclick", () => {
        // 폴더는 진입, 파일은 반대편으로 전송(선택에 포함돼 있으면 선택 전체를 전송).
        if (entry.isDir) {
          void this.go(entry.path);
          return;
        }
        const paths =
          this.selected.has(entry.path) && this.selected.size > 1
            ? [...this.selected]
            : [entry.path];
        void transferInto(this.other, paths);
      });
      el.addEventListener("dragstart", (e) => {
        // 드래그 시작 시 현재 선택에 포함돼 있지 않으면 이 항목만 선택.
        if (!this.selected.has(entry.path)) {
          this.selected.clear();
          this.selected.add(entry.path);
          this.markSelection(); // draw() 금지 — 드래그 중인 노드가 제거되면 드래그가 죽는다
        }
        const paths = [...this.selected];
        e.dataTransfer?.setData(
          "application/x-sshtool",
          JSON.stringify({ side: this.side, paths }),
        );
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!this.selected.has(entry.path)) {
          this.selected.clear();
          this.selected.add(entry.path);
          this.markSelection();
        }
        const count = this.selected.size;
        const items: MenuItem[] = [];
        // 단일 파일 선택 시 "열기"(기본 연결 프로그램) — xls→엑셀 등 탐색기와 동일.
        if (count === 1 && !entry.isDir) {
          items.push({
            label: "열기",
            accel: "o",
            action: () => void this.open(entry),
          });
        }
        items.push(
          {
            label:
              (this.side === "local" ? "업로드 →" : "← 다운로드") +
              (count > 1 ? ` (${count}개)` : ""),
            accel: "t",
            action: () => void transferInto(this.other, [...this.selected]),
          },
          { separator: true },
          { label: "이름 변경 (F2)", accel: "r", action: () => void this.rename(entry) },
          { label: "새 폴더", accel: "n", action: () => void this.makeDir() },
          { label: "새로고침 (F5)", accel: "f", action: () => void this.reload() },
          { separator: true },
          {
            label: "삭제 (Del)" + (count > 1 ? ` (${count}개)` : ""),
            accel: "d",
            danger: true,
            action: () => void this.removeSelected(),
          },
        );
        showContextMenu(e.clientX, e.clientY, items);
      });
      return el;
    }
  }

  const local = new Pane("local");
  const remote = new Pane("remote");
  local.other = remote;
  remote.other = local;

  // 로컬|원격 폭 조절 스플리터.
  const splitter = document.createElement("div");
  splitter.className = "sftp-splitter";
  body.append(local.root, splitter, remote.root);
  splitter.addEventListener("mousedown", (down) => {
    down.preventDefault();
    const startX = down.clientX;
    const rect = body.getBoundingClientRect();
    const startLeft = local.root.getBoundingClientRect().width;
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMove = (m: MouseEvent) => {
      if (m.buttons === 0) {
        onUp(); // 창 밖에서 버튼을 놓아 mouseup 을 놓친 경우 정리
        return;
      }
      const w = Math.max(160, Math.min(rect.width - 160, startLeft + (m.clientX - startX)));
      body.style.gridTemplateColumns = `${w}px 6px 1fr`;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  panel.append(header, body, strip);

  // ── 전송 ──

  /** dest 패널로 소스 경로들을 전송(폴더는 재귀). */
  async function transferInto(dest: Pane, paths: string[]): Promise<void> {
    // 목록에 보이는 항목을 옮기는 경로 — 경로를 현재 목록에서 실제 항목으로 바꿔 넘긴다.
    await transferItems(dest, dest.other.entries.filter((e) => paths.includes(e.path)));
  }

  /**
   * 항목을 실제로 옮긴다. 목록(`entries`)에 없는 것도 옮길 수 있어야 해서 경로가 아니라
   * 항목을 받는다 — 트리에서 고른 폴더는 반대편 목록에 떠 있지 않을 수 있다.
   */
  async function transferItems(dest: Pane, items: Entry[]): Promise<void> {
    const src = dest.other;
    if (items.length === 0) return;
    if (!sftpId) {
      setStatus("원격에 접속되지 않았습니다.");
      return;
    }
    if (transferring) {
      setStatus("이미 전송 중입니다. 끝난 뒤 다시 시도하세요.");
      return;
    }

    transferring = true;
    cancelled = false;

    // 총량을 먼저 잰다. 폴더는 목록을 훑어야 알 수 있어 잠깐 걸린다 — 그 사이 상태를 밝힌다.
    // 실패하면 0 으로 두고 파일 단위 진행률로 돌아간다(멈추지는 않는다).
    setStatus("전송할 크기 계산 중…");
    // 수천 파일 폴더에서 측정(전체 목록 순회)이 공짜가 아니다 — 읽은 목록을 담아 두었다가
    // 전송에서 그대로 쓴다. 측정이 실패해 비면 전송이 직접 조회한다(기존 경로).
    listedCache = new Map();
    bundleTotal = await measureTotal(src.side, items, listedCache).catch(() => 0);
    bundleDone = 0;
    setBundle();
    setStatus(bundleTotal > 0 ? `전송 시작 (${fmtSize(bundleTotal)})` : "전송 시작");

    let applied: ConflictChoice | null = null;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      if (cancelled) break;
      if (items.length > 1) setOverall(`${i + 1}/${items.length}`);
      const item = items[i];
      let targetName = item.name;

      if (dest.hasName(targetName)) {
        const decision: ConflictResult = applied
          ? { choice: applied, applyToRest: true }
          : await conflictDialog(targetName, items.length - i - 1);
        if (decision.applyToRest) applied = decision.choice;
        if (decision.choice === "cancel") break;
        if (decision.choice === "skip") continue;
        if (decision.choice === "rename") {
          targetName = uniqueName(targetName, (c) => dest.hasName(c));
        }
      }

      try {
        await transferOne(src.side, item, dest.path, targetName);
      } catch (e) {
        // 심볼릭 링크·권한 오류 등 한 항목의 실패로 나머지를 중단하지 않는다.
        failed++;
        console.error("전송 실패", item.path, e);
      }
    }

    hideProgress();
    setOverall("");
    setTransfer(null);
    transferring = false;
    bundleTotal = 0;
    bundleDone = 0;
    listedCache = new Map();
    setBundle();
    setStatus(
      cancelled
        ? "전송 취소됨"
        : failed > 0
          ? `전송 완료 (${failed}개 실패/건너뜀)`
          : "전송 완료",
    );
    if (!disposed) await dest.reload();
  }

  /**
   * 옮길 것의 총 바이트를 미리 잰다. 폴더는 목록을 훑어 합산한다.
   * 한 곳이라도 조회에 실패하면 전체를 포기하고 0 을 돌려준다 — 반쪽 총량으로 계산하면
   * 진행률이 100% 를 넘거나 뒤로 가서, 아예 파일 단위로 보여 주는 편이 낫다.
   */
  async function measureTotal(
    from: Side,
    items: Entry[],
    /** 측정하며 읽은 폴더 목록. 전송이 재사용해 같은 폴더를 두 번 조회하지 않는다. */
    listed?: Map<string, Entry[]>,
  ): Promise<number> {
    let sum = 0;
    for (const item of items) {
      if (cancelled) return 0;
      if (!item.isDir) {
        sum += item.size;
        continue;
      }
      const kids = ((await (from === "local"
        ? localList(item.path)
        : sftpList(sftpId!, item.path))) as Entry[]).filter(
        (k) => k.name !== "." && k.name !== "..",
      );
      listed?.set(item.path, kids);
      sum += await measureTotal(from, kids, listed);
    }
    return sum;
  }

  /** 묶음 진행 상태를 레지스트리에 반영한다(모달을 닫아도 칩이 전체 진행률을 보여 주도록). */
  function setBundle(): void {
    const live = liveSftp.get(session.id);
    if (!live) return;
    live.baseDone = bundleDone;
    live.grandTotal = bundleTotal;
    if (bundleTotal > 0) {
      live.done = Math.min(bundleTotal, bundleDone);
      live.total = bundleTotal;
    }
    notifyLive();
  }

  /** 파일 하나 또는 폴더 하나(재귀)를 옮긴다. */
  async function transferOne(
    from: Side,
    entry: Entry,
    destDir: string,
    destName: string,
  ): Promise<void> {
    if (cancelled) return;
    const destPath = joinPath(destDir, destName);

    if (!entry.isDir) {
      const transferId = crypto.randomUUID();
      setTransfer(transferId);
      if (bundleTotal > 0) showProgress(entry.name, bundleDone, bundleTotal);
      else showProgress(entry.name, 0, entry.size);
      if (from === "local") await sftpUpload(sftpId!, entry.path, destPath, transferId);
      else await sftpDownload(sftpId!, entry.path, destPath, transferId);
      setTransfer(null);
      // 이 파일 몫을 누적한다. 다음 파일의 진행 이벤트는 여기에 더해져 전체 진행이 된다.
      bundleDone = Math.min(bundleTotal || Number.MAX_SAFE_INTEGER, bundleDone + entry.size);
      setBundle();
      return;
    }

    // 폴더: 대상에 만들고 자식들을 재귀 전송.
    if (from === "local") await sftpMkdir(sftpId!, destPath).catch(() => undefined);
    else await localMkdir(destPath).catch(() => undefined);

    // 측정 단계에서 이미 읽은 폴더면 다시 조회하지 않는다.
    const children =
      listedCache.get(entry.path) ??
      ((from === "local"
        ? await localList(entry.path)
        : await sftpList(sftpId!, entry.path)) as Entry[]);
    for (const child of children) {
      if (cancelled) return;
      if (child.name === "." || child.name === "..") continue;
      try {
        await transferOne(from, child, destPath, child.name);
      } catch (e) {
        console.error("하위 항목 전송 실패", child.path, e); // 링크·권한 문제는 건너뜀
      }
    }
  }

  // ── 시작: 로컬 기본 폴더 + 원격 접속 ──
  setStatus("접속 중…");
  try {
    local.tree.init(await localRoots());
  } catch {
    local.tree.init(["/"]);
  }
  // 이미 살아있는 연결이 있으면 그대로 재사용한다 — 다시 붙지 않으므로 자격증명도 묻지 않고,
  // 마지막에 보던 폴더로 곧장 돌아간다.
  const existing = liveSftp.get(session.id);
  // 우선순위: 직전에 보던 폴더 > 설정의 기본 폴더 > OS 기본.
  // 살아 있는 연결을 다시 열 때 설정값으로 되돌리면 하던 일을 끊는다.
  try {
    const start = existing?.localDir || defaultLocalDir?.trim() || (await localDefaultDir());
    await local.go(start);
  } catch {
    // 설정한 폴더가 사라졌거나 권한이 없을 수 있다 — OS 기본으로 한 번 더 시도한다.
    try {
      await local.go(await localDefaultDir());
    } catch {
      await local.go("");
    }
  }
  try {
    if (existing) {
      sftpId = existing.sftpId;
      currentTransfer = existing.transferId;
      remote.tree.init(["/"]);
      await remote.go(existing.remoteDir || ".");
      setStatus(currentTransfer ? "연결됨 · 전송 중" : "연결됨");
      // 닫혀 있는 동안 진행된 전송이 있으면 진행바를 이어서 보여 준다.
      if (currentTransfer && existing.total > 0) {
        showProgress(existing.name, existing.done, existing.total);
      }
    } else {
      sftpId = await sftpConnect(
        session.host,
        session.port,
        session.user,
        password,
        session.authType,
        session.privateKeyPath,
        session.allowLegacyAlgorithms,
      );
      // "." 로 두면 상위 이동이 불가능하므로 절대경로(홈)로 정규화한다.
      let start = ".";
      try {
        start = await sftpCanonicalize(sftpId, ".");
      } catch {
        start = ".";
      }
      remote.tree.init(["/"]); // 원격 트리 루트
      await remote.go(start);
      setStatus("연결됨");
      hookProgressOnce();
      liveSftp.set(session.id, {
        sftpId,
        localDir: local.path,
        remoteDir: remote.path,
        transferId: null,
        name: "",
        done: 0,
        total: 0,
        baseDone: 0,
        grandTotal: 0,
      });
      notifyLive();
    }
    // 인증이 확인된 뒤에만 저장 제안 등을 수행한다(틀린 비번을 볼트에 넣지 않도록).
    void onAuthenticated?.();
  } catch (e) {
    setStatus(`SFTP 접속 실패: ${String(e)}`);
  }

  // F5/F2/Delete 가 첫 클릭 전에도 동작하도록(그리고 F5 가 앱 새로고침이 되지 않도록) 포커스.
  local.focusList();

  // 로컬 존재 검사는 목록 기반이지만, 방금 만든 파일 등 최신 상태 확인이 필요할 때 사용.
  void localExists;
}

function span(): HTMLElement {
  return document.createElement("span");
}

function mkBtn(iconName: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "sftp-btn";
  applyIcon(b, iconName);
  b.title = title;
  return b;
}
