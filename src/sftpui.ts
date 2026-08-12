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
  localStat,
  stageWrite,
  stageSweep,
} from "./ipc";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { attachResizeHandles } from "./sftpwindow";
import { DirTree } from "./sftptree";
import { createProgressStrip } from "./sftpprogress";
import { Pane, type PaneCtx } from "./sftppane";
import {
  xTransferInto,
  xTransferItems,
  xDownloadToPicked,
  xOnOsFilesDropped,
  xTransferPlan,
  type TransferCtx,
} from "./sftptransfer";
import { openSyncDialog } from "./sftpsync";
import { confirmDialog, textPrompt, attentionPulse } from "./dialogs";
import { applyIcon, fileIcon } from "./icons";
import { showContextMenu, type MenuItem } from "./contextmenu";
import {
  conflictDialog,
  uniqueName,
  type ConflictChoice,
  type ConflictResult,
} from "./conflict";

import {
  type Entry,
  type Side,
  type LiveSftp,
  joinPath,
  hasOsFiles,
  baseName,
  remoteParent,
  pathUnder,
  dirChain,
  fmtSize,
  fmtTime,
  isExecutable,
  entryType,
  colWidths,
  TYPEAHEAD_RESET_MS,
  liveSftp,
  transferStates,
  transferStateOf,
  notifyLive,
  hookProgressOnce,
} from "./sftpcommon";
// 기존 소비자(main.ts·sidebar.ts)가 "./sftpui" 에서 가져가던 공개 API 는 그대로 통한다.
export { liveSftpOf, onLiveSftpChanged, disconnectLiveSftp } from "./sftpcommon";

/** 창 크기·위치 기억(세션 간 공유) — 닫았다 다시 열 때 직전 자리·크기로.
 *  left/top 이 null 이면 가운데 정렬(기본) 상태다. */
let savedPanelSize: { w: number; h: number; left: number | null; top: number | null } | null = null;

/** 창이 화면 밖으로 나가지 않게 좌표를 다듬는다. 머리말은 항상 잡을 수 있어야 한다. */
const clampLeft = (left: number, w: number): number =>
  Math.max(-(w - 120), Math.min(window.innerWidth - 120, left));
const clampTop = (top: number, _h: number): number =>
  Math.max(0, Math.min(window.innerHeight - 40, top));

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
    const w = Math.min(savedPanelSize.w, window.innerWidth - 8);
    const h = Math.min(savedPanelSize.h, window.innerHeight - 8);
    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
    // 옮겨 둔 자리도 되살린다. 앱 창이 작아졌으면 화면 안으로 끌어들인다 —
    // 밖에 복원되면 창을 잡을 수 없다.
    if (savedPanelSize.left !== null && savedPanelSize.top !== null) {
      panel.style.position = "fixed";
      panel.style.margin = "0";
      panel.style.left = `${clampLeft(savedPanelSize.left, w)}px`;
      panel.style.top = `${clampTop(savedPanelSize.top, h)}px`;
    }
  }
  overlay.appendChild(panel);
  document.body.appendChild(overlay);


  let sftpId: string | null = null;
  let unlisten: (() => void) | null = null;
  // 전송 상태(진행·취소·현재 전송 id)는 연결 소속 공유 객체 — 위 TransferState 참조.
  const xfer = transferStateOf(session.id);
  /** 이번 묶음의 측정 단계에서 읽어 둔 폴더 목록(경로 → 자식). 전송이 재사용한다. */
  let listedCache = new Map<string, Entry[]>();
  // 이번 전송 묶음 전체의 바이트. 0 이면 미리 재지 못한 경우로 파일 단위 진행률로 돌아간다.
  // 이번 전송 묶음 전체의 바이트. 진행 스트립·전송 로직이 같은 객체를 본다.
  const bundle = { total: 0, done: 0 };
  let disposed = false;     // 창이 닫힌 뒤의 후속 작업 차단

  // ── 헤더 ──
  const header = document.createElement("div");
  header.className = "sftp-header";
  const title = document.createElement("div");
  title.className = "sftp-title";
  title.textContent = `SFTP · ${session.name || session.host}`;
  header.title = "끌어서 창 이동 · 더블클릭으로 최대화";
  const status = document.createElement("div");
  status.className = "sftp-status";
  // 우측 상단 창 버튼 — 일반 창과 같은 [–][□][X] 표준 매핑(0.57.0).
  // 접기(–)가 예전 X 의 역할(창만 닫고 연결 유지, 세션 목록의 SFTP 칩으로 복원)이고,
  // X 는 이제 실제로 끊는다 — 예전엔 X 가 창만 닫아 일반 창과 의미가 달랐다.
  // 폴더 비교·동기화(0.74.0) — 지금 양쪽에 열려 있는 폴더가 대상이라 창 버튼 옆에 둔다.
  const syncBtn = document.createElement("button");
  syncBtn.className = "sftp-winbtn sftp-sync";
  syncBtn.title = "폴더 비교·동기화 — 지금 보고 있는 로컬·원격 폴더를 견줍니다";
  applyIcon(syncBtn, "sync");
  const minBtn = document.createElement("button");
  minBtn.className = "sftp-winbtn sftp-min";
  minBtn.title = "접기 — 연결은 유지됩니다. 세션 목록의 SFTP 칩으로 다시 엽니다";
  applyIcon(minBtn, "minimize");
  const maxBtn = document.createElement("button");
  maxBtn.className = "sftp-winbtn sftp-maximize";
  maxBtn.title = "창 크기에 맞게 최대화 (되돌리려면 다시 누르세요)";
  applyIcon(maxBtn, "maximize");
  const closeBtn = document.createElement("button");
  closeBtn.className = "sftp-winbtn sftp-close";
  closeBtn.title = "연결을 끊고 닫습니다(진행 중 전송도 취소)";
  applyIcon(closeBtn, "close");
  header.append(title, status, syncBtn, minBtn, maxBtn, closeBtn);

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
    applyIcon(maxBtn, on ? "restore" : "maximize");
    maxBtn.title = on ? "최대화 전 크기로 되돌립니다" : "창 크기에 맞게 최대화 (되돌리려면 다시 누르세요)";
  };
  /** 최대화 상태만 푼다(크기는 그대로) — 손잡이로 크기를 바꿨을 때 버튼이 거짓말하지 않게. */
  const clearMaximized = (): void => {
    beforeMax = null;
    applyIcon(maxBtn, "maximize");
    maxBtn.title = "창 크기에 맞게 최대화 (되돌리려면 다시 누르세요)";
  };
  // 크기 조절 손잡이(8방향)는 sftpwindow.ts 로 분리(0.67.0).
  attachResizeHandles(panel, () => beforeMax !== null, clearMaximized);
  maxBtn.addEventListener("click", () => setMaximized(beforeMax === null));
  // 머리말을 끌어 창을 옮긴다(0.65.0). 크기 조절과 같은 방식으로, 끄는 동안에는
  // 가운데 정렬을 끊고 지금 자리에 못 박은 뒤 좌표만 움직인다.
  header.addEventListener("mousedown", (down) => {
    if (down.button !== 0) return;
    if ((down.target as HTMLElement).closest("button")) return; // 창 버튼은 제 일을 한다
    if (beforeMax !== null) return; // 최대화 중에는 이동하지 않는다(되돌린 뒤에)
    down.preventDefault();
    const r = panel.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.margin = "0";
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.width = `${r.width}px`;
    panel.style.height = `${r.height}px`;
    const dx = down.clientX - r.left;
    const dy = down.clientY - r.top;
    const onMove = (m: MouseEvent) => {
      if (m.buttons === 0) {
        onUp(); // 창 밖에서 버튼을 놓아 mouseup 을 놓친 경우 정리
        return;
      }
      panel.style.left = `${clampLeft(m.clientX - dx, r.width)}px`;
      panel.style.top = `${clampTop(m.clientY - dy, r.height)}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("sftp-resizing");
      document.body.style.cursor = "";
    };
    document.body.classList.add("sftp-resizing"); // 끄는 동안 내부 선택 방지
    document.body.style.cursor = "move";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
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

  // 진행 스트립(막대·속도·취소)은 sftpprogress.ts 로 분리(0.67.0).
  const { strip, showProgress, setOverall, hideProgress } = createProgressStrip(xfer);
  onSftpProgress((e) => {
    if (disposed || e.transferId !== xfer.current) return;
    // 파일 하나가 아니라 묶음 전체 기준으로 보여 준다 — 열 개를 보내는데 파일마다
    // 0%→100% 를 반복하면 얼마나 남았는지 알 수 없다.
    if (bundle.total > 0) showProgress(e.name, Math.min(bundle.total, bundle.done + e.done), bundle.total);
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
    xfer.current = id;
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
      const l = /left:\s*([\d.-]+)px/.exec(beforeMax);
      const t = /top:\s*([\d.-]+)px/.exec(beforeMax);
      savedPanelSize =
        w && h
          ? {
              w: parseFloat(w[1]),
              h: parseFloat(h[1]),
              left: l ? parseFloat(l[1]) : null,
              top: t ? parseFloat(t[1]) : null,
            }
          : null;
      return;
    }
    const r = panel.getBoundingClientRect();
    // position:fixed 면 사용자가 옮긴 자리다 — 그 좌표까지 기억한다.
    const moved = panel.style.position === "fixed";
    savedPanelSize = {
      w: Math.round(r.width),
      h: Math.round(r.height),
      left: moved ? Math.round(r.left) : null,
      top: moved ? Math.round(r.top) : null,
    };
  };

  /** 마지막 화면 위치를 레지스트리에 남긴다(다시 열 때 그 자리로 돌아가기 위해). */
  const rememberState = () => {
    if (!sftpId) return;
    const live = liveSftp.get(session.id);
    if (!live) return;
    live.localDir = local.path;
    live.remoteDir = remote.path;
    live.transferId = xfer.current;
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
    if (watchTimer) window.clearInterval(watchTimer); // 편집 감시 종료
    window.removeEventListener("resize", onWinResize);
    overlay.remove();
    notifyLive();
  };

  /** 실제로 끊는다 — 진행 중 전송도 취소된다. */
  const disconnectNow = () => {
    disposed = true;
    rememberSize();
    xfer.cancelled = true;
    if (watchTimer) window.clearInterval(watchTimer); // 편집 감시 종료
    if (xfer.current) void sftpCancel(xfer.current);
    unlisten?.();
    window.removeEventListener("resize", onWinResize);
    liveSftp.delete(session.id);
    transferStates.delete(session.id);
    if (sftpId) void sftpDisconnect(sftpId);
    overlay.remove();
    notifyLive();
  };
  // 접기는 연결을 유지하므로 전송 중이어도 그냥 접어도 된다(배경 전송은 칩이 보여 준다).
  minBtn.addEventListener("click", closeKeepAlive);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) attentionPulse(panel); // 바깥 클릭으로는 닫지 않는다(버튼으로만)
  });

  // X = 끊고 닫기. 끊기는 되돌릴 수 없다 — 전송 중이면 한 번 확인한다.
  closeBtn.addEventListener("click", () => {
    void (async () => {
      if (xfer.current) {
        const ok = await confirmDialog("파일을 전송 중입니다. 전송을 취소하고 연결을 끊을까요?");
        if (!ok || disposed) return;
      }
      disconnectNow();
    })();
  });

  // 디렉터리 트리는 sftptree.ts 로 분리(0.67.0) — 살아있는 sftpId 를 게터로 받는다.

  // ── 원격 파일 즉시 편집(0.67.0) ──
  // 원격 파일을 열면 임시본이 로컬에 생긴다. 그 파일을 편집기로 고쳐 저장하면
  // 서버로 되올린다 — vi 없이 메모장·VS Code 로 서버 설정을 고칠 수 있다.
  //
  // 감시는 2초 폴링이다(파일 감시 API 를 새로 들이지 않는다). 저장 도중(쓰는 중)에
  // 올리면 반쪽 파일이 서버에 남으므로, **한 번 더 같은 크기·시각이 관측될 때**만 올린다.
  interface EditWatch {
    localPath: string;
    remotePath: string;
    name: string;
    /** 마지막으로 서버에 반영한 상태(크기·수정시각). */
    synced: [number, number];
    /** 직전 관측값 — 이것과 같아야 '쓰기가 끝났다'고 본다. */
    seen: [number, number] | null;
  }
  const watches = new Map<string, EditWatch>();
  let watchTimer = 0;

  const watchEdit = (localPath: string, remotePath: string, name: string): void => {
    void localStat(localPath).then((st) => {
      if (disposed || !st) return;
      watches.set(localPath, { localPath, remotePath, name, synced: st, seen: null });
      if (watchTimer === 0) watchTimer = window.setInterval(() => void pollEdits(), 2000);
    });
  };

  const pollEdits = async (): Promise<void> => {
    if (disposed || watches.size === 0) return;
    if (xfer.transferring) return; // 전송 중에는 건드리지 않는다(진행률·취소가 뒤섞인다)
    for (const w of [...watches.values()]) {
      const st = await localStat(w.localPath);
      if (!st) {
        watches.delete(w.localPath); // 임시본이 지워졌다 — 감시 종료
        continue;
      }
      const changed = st[0] !== w.synced[0] || st[1] !== w.synced[1];
      if (!changed) {
        w.seen = null;
        continue;
      }
      // 저장이 끝났는지 — 같은 값이 두 번 관측돼야 올린다(쓰는 중 업로드 방지).
      if (!w.seen || w.seen[0] !== st[0] || w.seen[1] !== st[1]) {
        w.seen = st;
        continue;
      }
      if (!sftpId) continue;
      try {
        xfer.transferring = true;
        setStatus(`서버로 저장 중… ${w.name}`);
        await sftpUpload(sftpId, w.localPath, w.remotePath, crypto.randomUUID());
        w.synced = st;
        w.seen = null;
        setStatus(`서버에 저장됨 — ${w.name}`);
        if (!disposed) await remote.reload();
      } catch (e) {
        setStatus(`서버 저장 실패(${w.name}): ${String(e)}`);
      } finally {
        xfer.transferring = false;
      }
    }
  };

  // 회귀 검사용 훅 — 편집 감시는 파일시스템 시각에 의존해 실기 없이 검증하기 어렵다.
  // 프로덕션 빌드에서는 이 가지째 제거된다(DEV 가 false 상수로 치환).
  if (import.meta.env.DEV) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__sftpTest = { watchEdit, pollEdits };
  }

  // 파일 목록 패널(Pane)은 sftppane.ts 로 분리(0.67.0) — 창이 쥔 상태·동작은 PaneCtx 로 넘긴다.

  const pctx: PaneCtx = {
    getSftpId: () => sftpId!,
    setStatus,
    xfer,
    transferInto: (dest, paths) => transferInto(dest, paths),
    transferItems: (dest, items, override) => transferItems(dest, items, override),
    downloadToPicked: (items) => downloadToPicked(items),
    onOsFilesDropped: (dt, destDir) => onOsFilesDropped(dt, destDir),
    setTransfer,
    showProgress,
    hideProgress,
    watchEdit,
  };
  const local = new Pane(pctx, "local");
  const remote = new Pane(pctx, "remote");
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

  // 전송·탐색기 연계는 sftptransfer.ts 로 분리(0.67.0). 창이 쥐고 있던 상태·표시
  // 함수는 컨텍스트(TransferCtx)로 넘긴다 — 클로저를 그대로 옮길 수 없기 때문이다.
  const xctx: TransferCtx = {
    session,
    xfer,
    getSftpId: () => sftpId,
    isDisposed: () => disposed,
    setStatus,
    showProgress,
    hideProgress,
    setOverall,
    setTransfer,
    bundle,
    listed: listedCache,
    resumeAll: null,
    panes: { local: () => local, remote: () => remote },
  };
  const transferInto = (dest: Pane, paths: string[]): Promise<void> => xTransferInto(xctx, dest, paths);
  const transferItems = (dest: Pane, items: Entry[], destDirOverride?: string): Promise<void> =>
    xTransferItems(xctx, dest, items, destDirOverride);
  const downloadToPicked = (items: Entry[]): Promise<void> => xDownloadToPicked(xctx, items);
  const onOsFilesDropped = (dt: DataTransfer, destDir?: string): Promise<void> =>
    xOnOsFilesDropped(xctx, dt, destDir);

  syncBtn.addEventListener("click", () => {
    openSyncDialog({
      getSftpId: () => sftpId,
      localDir: () => local.path,
      remoteDir: () => remote.path,
      setStatus,
      run: (from, plan, makeDirs) => xTransferPlan(xctx, from, plan, makeDirs),
      refresh: async () => {
        if (disposed) return;
        await local.reload();
        await remote.reload();
      },
    });
  });

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
      xfer.current = existing.transferId;
      remote.tree.init(["/"]);
      await remote.go(existing.remoteDir || ".");
      setStatus(xfer.current ? "연결됨 · 전송 중" : "연결됨");
      // 닫혀 있는 동안 진행된 전송이 있으면 진행바를 이어서 보여 준다.
      if (xfer.current && existing.total > 0) {
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
        session.charset,
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
      // 인증이 확인된 뒤에만 저장 제안 등을 수행한다(틀린 비번을 볼트에 넣지 않도록).
      // **새로 접속해 성공한 이 분기에서만** 부른다 — 살아있는 연결 재사용 분기에서
      // 부르면 방금 입력한(검증 안 된) 비밀번호가 볼트에 저장된다(진단 0.62.0).
      void onAuthenticated?.();
    }
  } catch (e) {
    setStatus(`SFTP 접속 실패: ${String(e)}`);
  }

  // F5/F2/Delete 가 첫 클릭 전에도 동작하도록(그리고 F5 가 앱 새로고침이 되지 않도록) 포커스.
  local.focusList();

  // 로컬 존재 검사는 목록 기반이지만, 방금 만든 파일 등 최신 상태 확인이 필요할 때 사용.
  void localExists;
}

