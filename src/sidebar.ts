// 좌측 세션 사이드바. 폴더 경로로 트리를 구성하고, 세션 열기/편집/삭제/새로만들기를 제공.

import type { SessionInfo, ServiceLink } from "./types";
import type { FolderSort } from "./settings";
import { showContextMenu, type MenuItem } from "./contextmenu";
import { applyIcon } from "./icons";
import { renderRecent, sessionRow, type RowCtx } from "./sidebarrows";

export interface SidebarCallbacks {
  onOpen: (s: SessionInfo) => void;
  onEdit: (s: SessionInfo) => void;
  onDelete: (s: SessionInfo) => void;
  onSftp: (s: SessionInfo) => void;
  /** 폴더를 접거나 펼쳤을 때 — 설정에 저장해 재시작 후에도 유지한다. */
  onCollapsedChange?: (paths: string[]) => void;
  /** 살아있는 SFTP 연결 상태(없으면 null). 칩 색·진행률 표시에 쓴다. */
  sftpLive?: (s: SessionInfo) => { transferring: boolean; percent: number } | null;
  /** SFTP 칩 우클릭 → 연결 끊기. */
  onSftpDisconnect?: (s: SessionInfo) => void;
  onNew: () => void;
  onQuick: () => void;
  onDuplicate: (s: SessionInfo) => void;
  onMove: (s: SessionInfo) => void;
  onRename: (s: SessionInfo) => void;
  onReorder: (s: SessionInfo, dir: -1 | 1) => void;
  onBulkDelete: () => void;
  /** 최근 접속 목록에서 한 세션 제거(세션 자체는 유지, 접속 이력만 삭제). */
  onRemoveRecent: (s: SessionInfo) => void;
  /** 최근 접속 기록 전체 삭제. */
  onClearRecent: () => void;
  onNewFolder: (parent: string) => void;
  onImport: () => void;
  onRenameFolder: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  /** 드래그로 세션을 다른 세션 위/아래(순서) 또는 폴더 안으로 옮길 때. */
  onDropSession: (sourceId: string, target: DropTarget) => void;
  /** 폴더를 다른 폴더 안(또는 루트)으로 이동 — 하위 폴더·세션까지 함께 옮긴다. */
  onMoveFolder: (sourcePath: string, destParent: string) => void;
  /** 이 폴더(하위 폴더 포함)의 세션을 모두 연다. */
  onOpenFolder?: (path: string, sessions: SessionInfo[]) => void;
  /** 폴더별 정렬 방식 변경("" = 루트). */
  onFolderSort?: (path: string, mode: FolderSort) => void;
  /** 세션 호스트의 웹 서비스를 브라우저로 연다. */
  onOpenService?: (s: SessionInfo, svc: ServiceLink) => void;
}

/** 드롭 위치 — 세션 앞/뒤에 끼우기, 또는 폴더로 이동. */
export type DropTarget =
  | { kind: "session"; id: string; before: boolean }
  | { kind: "folder"; path: string };

export const DRAG_TYPE = "application/x-sshtool-session";
const DRAG_FOLDER = "application/x-sshtool-folder";

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  sessions: SessionInfo[];
}

const newFolder = (name: string, path: string): FolderNode => ({
  name,
  path,
  folders: new Map(),
  sessions: [],
});

/** 키보드 탐색 대상이 되는 행 — DOM 순서가 곧 위/아래 이동 순서다. */
const NAV_ROWS = ".recent-row, .tree-folder, .tree-session";
/** 최근 접속 행처럼 트리 깊이가 없는 항목의 깊이값(부모 탐색에서 걸리지 않는다). */
const NO_DEPTH = -1;

export const navDepth = (row: HTMLElement): number => Number(row.dataset.navDepth ?? NO_DEPTH);

/** 세션 종류별 아이콘 — 목록만 훑어도 SSH·로컬 셸·원격 데스크톱이 구분되게. */
export const kindIcon = (s: SessionInfo): string =>
  s.kind === "local" ? "local" : s.kind === "rdp" ? "rdp" : "remote";

/** 세션 상세(계정@호스트:포트 또는 로컬 셸) — 세션 행·최근 접속 공용. */
export const detailText = (s: SessionInfo): string =>
  s.kind === "local"
    ? `로컬 셸${s.shellExe ? ` · ${s.shellExe}` : ""}`
    : s.kind === "rdp"
      ? `원격 데스크톱 · ${s.user ? `${s.user}@` : ""}${s.host}:${s.port}`
      : s.user
      ? `${s.user}@${s.host}:${s.port}`
      : `${s.host}:${s.port}`;

/** 마지막 접속 시각 표기(툴팁용). 오늘이면 시각만, 아니면 날짜까지. */
function lastConnectedText(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? hm : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
}

/**
 * 행 툴팁 — 세부정보 표시를 꺼 두어도 마우스만 올리면 확인할 수 있게 한다.
 * 목록을 좁게 쓰는 사람이 세부정보를 끄는데, 그러면 어느 서버인지 알 길이 없어진다.
 */
export function rowTooltip(s: SessionInfo): string {
  const lines = [s.name || s.host, detailText(s)];
  if (s.folder) lines.push(`폴더: ${s.folder}`);
  if (s.lastConnectedUtc > 0) lines.push(`마지막 접속: ${lastConnectedText(s.lastConnectedUtc)}`);
  lines.push("더블클릭하여 접속");
  return lines.join("\n");
}

export class Sidebar {
  /** 지금 화면에 있는 SFTP 칩들 — 진행률만 바뀔 때 여기만 다시 칠한다. */
  private liveChips: { chip: HTMLElement; s: SessionInfo }[] = [];
  private repainting = false;
  private sessions: SessionInfo[] = [];
  private folders: string[] = [];
  private collapsed = new Set<string>();
  /** 접기 연출이 도는 중(두 단계 접기의 대기 구간) — 연타로 상태가 꼬이지 않게 막는다. */
  private foldAnimating = false;
  /** 마지막 render 가 실제로 그린 모든 폴더 경로(중첩 포함) — 전체 접기/펼치기용. */
  private allFolderPaths: string[] = [];
  private filter = "";
  /** 표시 옵션(설정에서 주입). */
  private sortByRecent = false;
  /** 폴더별 정렬 방식("" = 루트). 없으면 전역 규칙. */
  private folderSort: Record<string, FolderSort> = {};
  private showDetail = true;
  private recentLimit = 10;
  /** 타입어헤드 버퍼 — 잠시 쉬면 처음부터 다시 친 것으로 본다(탐색기 방식, SFTP 목록과 동일). */
  private typeBuf = "";
  private typeAt = 0;
  /** 키보드 포커스가 놓인 행의 식별자. 다시 그려도 같은 행으로 돌아가기 위해 값으로 들고 있다. */
  private focusKey: string | null = null;
  /** 행 → Enter 로 실행할 동작(폴더는 펼침 토글, 세션·최근 접속은 연결). */
  private readonly activateFns = new WeakMap<HTMLElement, () => void>();

  constructor(
    private readonly tree: HTMLElement,
    private readonly cb: SidebarCallbacks,
    newBtn: HTMLElement,
    quickBtn: HTMLElement,
  ) {
    newBtn.addEventListener("click", () => this.cb.onNew());
    quickBtn.addEventListener("click", () => this.cb.onQuick());

    this.tree.addEventListener("keydown", (e) => this.onKeyDown(e));

    // 빈 영역에 드롭 = 루트로 꺼내기(모든 세션이 폴더 안이면 다른 방법이 없다).
    this.tree.addEventListener("dragover", (e) => {
      const ty = e.dataTransfer?.types;
      if (e.target !== this.tree || !ty || (!ty.includes(DRAG_TYPE) && !ty.includes(DRAG_FOLDER)))
        return;
      e.preventDefault();
      this.tree.classList.add("drop-root");
    });
    this.tree.addEventListener("dragleave", (e) => {
      const to = e.relatedTarget as Node | null;
      if (!to || !this.tree.contains(to)) this.tree.classList.remove("drop-root");
    });
    this.tree.addEventListener("drop", (e) => {
      this.tree.classList.remove("drop-root");
      if (e.target !== this.tree) return;
      e.preventDefault();
      const id = e.dataTransfer?.getData(DRAG_TYPE);
      if (id) {
        this.cb.onDropSession(id, { kind: "folder", path: "" });
        return;
      }
      const src = e.dataTransfer?.getData(DRAG_FOLDER);
      if (src) this.cb.onMoveFolder(src, ""); // 폴더를 루트로 이동
    });

    // 빈 영역 우클릭 = 트리 전체 대상 메뉴.
    this.tree.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement;
      // 세션/폴더 행에서 올라온 이벤트는 각 행이 처리 — 빈 영역·안내문에서만 연다.
      if (target.closest(".tree-session, .tree-folder")) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "새 세션", accel: "s", action: () => this.cb.onNew() },
        { label: "새 폴더", accel: "n", action: () => this.cb.onNewFolder("") },
        { separator: true },
        // 루트에 바로 놓인 세션들의 정렬. 폴더 안은 각 폴더 메뉴에서 따로 정한다.
        ...this.sortItems(""),
        { separator: true },
        { label: "외부 프로그램 세션 가져오기…", accel: "i", action: () => this.cb.onImport() },
        { separator: true },
        { label: "세션 일괄 삭제…", accel: "b", danger: true, action: () => this.cb.onBulkDelete() },
      ]);
    });
  }

  /** "a/b" 경로의 폴더 노드를 만들며 내려가 마지막 노드를 반환. 빈 경로면 루트. */
  private ensurePath(root: FolderNode, path: string): FolderNode {
    let node = root;
    const p = (path ?? "").trim();
    if (!p) return node;
    let acc = "";
    for (const seg of p.split(/[\\/]/).filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!node.folders.has(seg)) node.folders.set(seg, newFolder(seg, acc));
      node = node.folders.get(seg)!;
    }
    return node;
  }

  /**
   * SFTP 칩에 연결 상태를 입힌다. 모달을 닫아도 연결이 살아 있으므로, 그 사실이 어딘가
   * 보여야 사용자가 끊을 수 있다. 깜빡임은 쓰지 않는다 — 몇 분씩 지속되는 상태라
   * 계속 깜빡이면 시선만 뺏기고 정작 중요한 알림을 무시하게 된다.
   */
  private paintSftpChip(chip: HTMLElement, s: SessionInfo): boolean {
    // 그리는 중에 만난 칩은 기억해 둔다 — 진행률만 바뀔 때 목록을 새로 만들지 않고
    // 이 칩들만 다시 칠하기 위해서다(paintLive).
    if (!this.repainting) this.liveChips.push({ chip, s });
    const live = this.cb.sftpLive?.(s) ?? null;
    chip.classList.toggle("live", live !== null);
    chip.classList.toggle("busy", live?.transferring === true);
    if (live?.transferring) {
      // 전송 중에는 퍼센트만 — "SFTP 37%" 는 사이드바를 좁히면 줄바꿈으로 깨진다
      // (사용자 보고 0.62.1). busy 색상과 %가 있어 SFTP 문구 없이도 의미가 통한다.
      chip.textContent = `${live.percent}%`;
      chip.title = `SFTP 전송 중 ${live.percent}% · 우클릭하여 연결 끊기`;
    } else {
      chip.textContent = "SFTP";
      chip.title = live ? "연결됨 · 우클릭하여 연결 끊기" : "SFTP 파일 전송";
    }
    if (!live) return false;
    chip.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "SFTP 연결 끊기",
          accel: "d",
          danger: true,
          action: () => this.cb.onSftpDisconnect?.(s),
        },
      ]);
    };
    return true;
  }

  /** 세션 행·최근 접속 행 공용 선택 표시(트리 전체에서 하나만 선택된다). */
  private select(row: HTMLElement): void {
    for (const el of this.tree.querySelectorAll(".tree-session.selected, .recent-row.selected"))
      el.classList.remove("selected");
    row.classList.add("selected");
  }

  /**
   * 행을 키보드 탐색 대상으로 등록한다. roving tabindex — 트리 전체에서 Tab 으로 들어올 수
   * 있는 행은 항상 하나뿐이고, 나머지는 방향키로만 옮겨 다닌다(트리뷰 관례).
   */
  private registerNav(row: HTMLElement, key: string, activate: () => void): void {
    row.tabIndex = -1;
    row.dataset.navKey = key;
    this.activateFns.set(row, activate);
    row.addEventListener("focus", () => {
      this.focusKey = key;
      for (const r of this.navRows()) r.tabIndex = r === row ? 0 : -1;
    });
  }

  private navRows(): HTMLElement[] {
    return [...this.tree.querySelectorAll<HTMLElement>(NAV_ROWS)];
  }

  private focusRow(row: HTMLElement | undefined): void {
    row?.focus();
  }

  /**
   * 다시 그린 뒤 키보드 포커스를 같은 행으로 되돌린다. 트리 밖에 포커스가 있었다면
   * 뺏지 않고 진입 지점(tabIndex=0)만 잡아 둔다.
   */
  private restoreNavFocus(hadFocus: boolean): void {
    const rows = this.navRows();
    if (rows.length === 0) return;
    const row = rows.find((r) => r.dataset.navKey === this.focusKey) ?? rows[0];
    this.focusKey = row.dataset.navKey ?? null;
    for (const r of rows) r.tabIndex = r === row ? 0 : -1;
    if (hadFocus) row.focus();
  }

  /** 현재 행의 부모 폴더 행 — 자기보다 얕은 깊이의 폴더 중 위쪽에서 가장 가까운 것. */
  private parentRow(rows: HTMLElement[], index: number): HTMLElement | undefined {
    const depth = navDepth(rows[index]);
    for (let i = index - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.dataset.navKind === "folder" && navDepth(r) < depth) return r;
    }
    return undefined;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const row = e.target as HTMLElement | null;
    // 행 안의 버튼(삭제·편집 등)에 포커스가 있을 때는 그쪽 기본 동작을 방해하지 않는다.
    if (!row?.dataset.navKey) return;
    const rows = this.navRows();
    const i = rows.indexOf(row);
    if (i < 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.focusRow(rows[i + 1]);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.focusRow(rows[i - 1]);
        return;
      case "Home":
        e.preventDefault();
        this.focusRow(rows[0]);
        return;
      case "End":
        e.preventDefault();
        this.focusRow(rows[rows.length - 1]);
        return;
      case "ArrowRight":
        e.preventDefault();
        this.navRight(row, rows, i);
        return;
      case "ArrowLeft":
        e.preventDefault();
        this.navLeft(row, rows, i);
        return;
      case "Enter":
        e.preventDefault();
        this.activateFns.get(row)?.();
        return;
      default:
        this.typeAhead(e, rows, i);
        return;
    }
  }

  /**
   * 타입어헤드 — 글자를 치면 그 글자로 시작하는 행으로 이동한다(탐색기 방식).
   * 연달아 치면 이어 붙여 좁히고("웹서" → 웹서버1), 잠시 쉬면 새로 시작한다.
   * 현재 행 다음부터 찾아 한 바퀴 돈다 — 같은 글자를 다시 치면 다음 일치 항목으로 간다.
   */
  private typeAhead(e: KeyboardEvent, rows: HTMLElement[], from: number): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key.length !== 1 || e.key === " ") return; // 스페이스는 스크롤 등 기본 동작에 둔다
    e.preventDefault();

    const now = Date.now();
    // 이어치기 창을 넘겼으면 새 검색. 같은 글자 반복은 '다음 일치로 이동'으로 취급한다
    // (탐색기와 같다 — "ss" 를 빠르게 치면 s 로 시작하는 두 번째 항목).
    const cont = now - this.typeAt <= 900;
    const key = e.key.toLowerCase();
    if (cont && !(this.typeBuf.length === 1 && this.typeBuf === key)) this.typeBuf += key;
    else this.typeBuf = key;
    this.typeAt = now;

    const label = (r: HTMLElement) =>
      (
        r.querySelector(".tree-session-name, .tree-folder-label")?.textContent ?? ""
      ).toLowerCase();
    // 현재 행 '다음'부터 한 바퀴 — 검색어가 한 글자면 현재 행 자신은 건너뛰어야
    // 같은 글자 연타로 다음 항목에 갈 수 있다.
    for (let k = 1; k <= rows.length; k++) {
      const r = rows[(from + k) % rows.length];
      if (label(r).startsWith(this.typeBuf)) {
        this.focusRow(r);
        return;
      }
    }
  }

  /** → 접혀 있으면 펼치고, 이미 펼쳐져 있으면 첫 자식으로. 세션·최근 접속은 자식이 없다. */
  private navRight(row: HTMLElement, rows: HTMLElement[], index: number): void {
    if (row.dataset.navKind !== "folder") return;
    const path = row.dataset.navPath ?? "";
    if (this.collapsed.has(path) && !this.filter) {
      this.collapsed.delete(path);
      this.collapsedChanged();
      this.render(this.sessions);
      return;
    }
    const next = rows[index + 1];
    if (next && navDepth(next) > navDepth(row)) this.focusRow(next);
  }

  /** ← 펼쳐진 폴더면 접고, 그 외에는 부모 폴더로 올라간다. */
  private navLeft(row: HTMLElement, rows: HTMLElement[], index: number): void {
    if (row.dataset.navKind === "folder") {
      const path = row.dataset.navPath ?? "";
      if (!this.collapsed.has(path) && !this.filter) {
        this.collapsed.add(path);
        this.collapsedChanged();
        this.render(this.sessions);
        return;
      }
    }
    this.focusRow(this.parentRow(rows, index));
  }

  /** 저장돼 있던 접힘 상태를 되살린다(시작 시 1회). */
  setCollapsed(paths: string[]): void {
    this.collapsed = new Set(paths);
    this.render(this.sessions);
  }

  /**
   * 전체 접기 ↔ 전체 펼치기(사이드바 상단 버튼). 하나라도 펼쳐져 있으면 모두 접는다.
   * 개별 폴더와 같은 두 단계 연출을 쓴다 — 깊이 0(최상위 폴더·루트 세션)만 남으므로
   * 사라질 행은 정확히 "깊이 > 0"인 행들이다.
   * 반환값 = 실행 후(연출이 끝나면) 전부 접힌 상태가 되는가 — 버튼 아이콘은 이 값으로
   * 즉시 갱신한다. 연출 중 재호출은 상태를 바꾸지 않고 현 상태를 되돌려 준다.
   */
  toggleFoldAll(): boolean {
    if (this.foldAnimating) return this.isAllFolded();
    const anyExpanded = this.allFolderPaths.some((p) => !this.collapsed.has(p));

    if (!anyExpanded) {
      // 전체 펼치기 — 다시 그린 직후 깊이 > 0 행들이 미끄러져 들어온다.
      this.collapsed.clear();
      this.collapsedChanged();
      this.render(this.sessions);
      if (!this.filter) {
        for (const r of this.tree.querySelectorAll<HTMLElement>("[data-nav-kind]")) {
          if (Number(r.dataset.navDepth ?? "-1") <= 0) continue;
          r.classList.add("kid-enter");
          r.addEventListener("animationend", () => r.classList.remove("kid-enter"), {
            once: true,
          });
        }
      }
      return false;
    }

    // 전체 접기 — 검색 중에는 접힘이 표시에 반영되지 않으므로 연출 없이 상태만 바꾼다.
    if (this.filter) {
      for (const p of this.allFolderPaths) this.collapsed.add(p);
      this.collapsedChanged();
      this.render(this.sessions);
      return true;
    }
    for (const r of this.tree.querySelectorAll<HTMLElement>("[data-nav-kind]")) {
      if (Number(r.dataset.navDepth ?? "-1") > 0) r.classList.add("kid-exit");
      else if (r.dataset.navKind === "folder") r.classList.add("collapsed"); // 셰브론 회전
    }
    this.foldAnimating = true;
    window.setTimeout(() => {
      this.foldAnimating = false;
      for (const p of this.allFolderPaths) this.collapsed.add(p);
      this.collapsedChanged();
      this.render(this.sessions);
    }, 130);
    return true;
  }

  /** 폴더가 있고 전부 접혀 있는가 — 전체 접기 버튼의 아이콘 결정용. */
  isAllFolded(): boolean {
    return (
      this.allFolderPaths.length > 0 &&
      this.allFolderPaths.every((p) => this.collapsed.has(p))
    );
  }

  /** 방금 펼친 폴더의 자식 행들이 살짝 미끄러져 들어오게 한다(다시 그린 직후 호출). */
  private animateKidsIn(path: string, depth: number): void {
    const rows = [...this.tree.querySelectorAll<HTMLElement>("[data-nav-kind]")];
    const i = rows.findIndex(
      (r) => r.dataset.navKind === "folder" && r.dataset.navPath === path,
    );
    if (i < 0) return;
    for (let k = i + 1; k < rows.length; k++) {
      const r = rows[k];
      if (Number(r.dataset.navDepth ?? "-1") <= depth) break;
      r.classList.add("kid-enter");
      r.addEventListener("animationend", () => r.classList.remove("kid-enter"), { once: true });
    }
  }

  /** 접힘이 바뀔 때마다 저장을 요청한다 — 폴더를 정리해 쓰면 매번 다시 접는 건 번거롭다. */
  private collapsedChanged(): void {
    this.cb.onCollapsedChange?.([...this.collapsed]);
  }

  /** 설정 변경 시 표시 옵션을 반영한다. */
  /** 폴더별 정렬 방식을 갈아 끼운다(설정에서 읽어 넘긴다). */
  setFolderSort(map: Record<string, FolderSort>): void {
    this.folderSort = { ...map };
  }

  setDisplayOptions(sortByRecent: boolean, showDetail: boolean, recentLimit = 10): void {
    this.sortByRecent = sortByRecent;
    this.showDetail = showDetail;
    this.recentLimit = recentLimit;
    this.render(this.sessions);
  }

  /** 외부 검색창에서 호출. 필터 중에는 매칭이 보이도록 폴더 접힘을 무시한다. */
  setFilter(query: string): void {
    this.filter = query.trim().toLowerCase();
    this.render(this.sessions);
  }

  private matches(s: SessionInfo): boolean {
    if (!this.filter) return true;
    const q = this.filter;
    // 행에 보이는 세부정보 표기(계정@호스트:포트) 그대로 검색되게 한다 — 개별 필드만
    // 보면 "root@10.0.0.1" 처럼 붙여 친 검색이 안 걸린다(0.59.2). 개별 host·user 검색은
    // 합성 문자열 검색에 포함되므로 따로 두지 않고, 폴더명도 검색 범위에 넣는다.
    return (
      s.name.toLowerCase().includes(q) ||
      detailText(s).toLowerCase().includes(q) ||
      s.folder.toLowerCase().includes(q)
    );
  }

  /** 행 렌더(sidebarrows.ts)에 넘길 통로 — 비공개 멤버를 밖에서 볼 수 없어 매번 만든다. */
  private rowCtx(): RowCtx {
    return {
      cb: this.cb,
      tree: this.tree,
      sessions: this.sessions,
      recentLimit: this.recentLimit,
      showDetail: this.showDetail,
      select: (row) => this.select(row),
      serviceItems: (s) => this.serviceItems(s),
      registerNav: (row, key, activate) => this.registerNav(row, key, activate),
      paintSftpChip: (chip, s) => this.paintSftpChip(chip, s),
    };
  }

  /**
   * 살아있는 SFTP 표시(연결·전송 진행률)만 제자리에서 다시 칠한다.
   *
   * 전송 중에는 진행 알림이 초당 여러 번 온다. 그때마다 render() 로 목록을 새로 만들면
   * 누르려던 버튼이 손가락 밑에서 사라져 클릭이 먹지 않고, 세션영역 고정을 해제한
   * 상태에서는 바뀐 노드가 '바깥'으로 판정돼 임시 노출까지 닫혔다(사용자 보고 0.76.7).
   */
  paintLive(): void {
    this.repainting = true;
    try {
      for (const { chip, s } of this.liveChips) {
        if (chip.isConnected) this.paintSftpChip(chip, s);
      }
    } finally {
      this.repainting = false;
    }
  }

  /** 세션 + 명시적으로 만든(비어 있을 수 있는) 폴더 목록으로 트리를 그린다. */
  render(sessions: SessionInfo[], folders: string[] = this.folders): void {
    this.liveChips = [];
    // 폴더를 접었다 펴면 트리를 통째로 다시 만들므로, 그 전에 포커스가 트리 안에 있었는지 본다.
    const hadFocus = this.tree.contains(document.activeElement);
    this.sessions = sessions;
    this.folders = folders;
    const rootNode = newFolder("", "");

    // 빈 폴더도 트리에 나타나도록 먼저 경로를 만들어 둔다(검색 중에는 생략).
    if (!this.filter) {
      for (const path of folders) this.ensurePath(rootNode, path);
    }

    for (const s of sessions) {
      if (!this.matches(s)) continue;
      this.ensurePath(rootNode, s.folder).sessions.push(s);
    }

    // 전체 접기/펼치기가 다룰 폴더 목록(중첩 포함, 루트 제외)을 이번 트리에서 뽑아 둔다.
    this.allFolderPaths = [];
    const walkFolders = (n: FolderNode): void => {
      for (const c of n.folders.values()) {
        this.allFolderPaths.push(c.path);
        walkFolders(c);
      }
    };
    walkFolders(rootNode);

    this.tree.innerHTML = "";
    // 검색 중이 아니면 상단에 최근 접속 10개(바로 접속 가능).
    if (!this.filter) renderRecent(this.rowCtx());
    // 빈 폴더만 있어도 그려야 하므로 폴더 유무까지 본다.
    const visible = [...rootNode.folders.values()].length > 0 || rootNode.sessions.length > 0;
    if (!visible) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = this.filter
        ? "검색 결과가 없습니다."
        : "저장된 세션이 없습니다.\n＋ 로 추가하거나, 빈 곳을 우클릭해\n외부 프로그램에서 가져오세요.";
      this.tree.appendChild(empty);
      this.restoreNavFocus(hadFocus);
      return;
    }
    this.renderNode(rootNode, this.tree, 0);
    this.restoreNavFocus(hadFocus);
  }

  /** 이 폴더와 하위 폴더에 든 세션 — 목록 정렬 순서 그대로(보이는 순서대로 열린다). */
  private sessionsUnder(path: string): SessionInfo[] {
    const inPath = (f: string): boolean => f === path || f.startsWith(`${path}/`);
    return this.sessions.filter((s) => inPath(s.folder)).sort(this.comparator(path));
  }

  /** 폴더와 그 하위 모든 폴더를 접는다(우클릭 '폴더 접기'). */
  private collapseTree(node: FolderNode): void {
    this.collapsed.add(node.path);
    for (const child of node.folders.values()) this.collapseTree(child);
  }


  private renderNode(node: FolderNode, parent: HTMLElement, depth: number): void {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    for (const f of folders) {
      const isCollapsed = !this.filter && this.collapsed.has(f.path);
      const row = document.createElement("div");
      // Grafana Row 헤더 방식(0.58.0) — 밴드형 헤더 + 셰브론. 회전은 CSS(.collapsed)가
      // 담당해 접을 때 부드럽게 돈다(폴더 아이콘 교체 방식은 애니메이션이 불가능했다).
      row.className = "tree-folder" + (isCollapsed ? " collapsed" : "");
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const arrow = document.createElement("span");
      arrow.className = "tree-arrow";
      applyIcon(arrow, "chevronDown");
      const label = document.createElement("span");
      label.className = "tree-folder-label";
      label.textContent = f.name;
      row.append(arrow, label);
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        e.dataTransfer?.setData(DRAG_FOLDER, f.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      const toggle = () => {
        if (this.foldAnimating) return; // 접히는 중 연타 방지
        // 검색 중에는 접힘이 표시에 반영되지 않으므로 연출 없이 상태만 바꾼다(기존 동작).
        if (this.filter) {
          if (isCollapsed) this.collapsed.delete(f.path);
          else this.collapsed.add(f.path);
          this.collapsedChanged();
          this.render(this.sessions);
          return;
        }
        if (isCollapsed) {
          this.collapsed.delete(f.path);
          this.collapsedChanged();
          this.render(this.sessions);
          this.animateKidsIn(f.path, depth);
          return;
        }
        // 접기는 두 단계 — 자식이 미끄러져 사라진 뒤 다시 그린다. 셰브론 회전(CSS 전환)도
        // 이 지연 덕에 눈에 보인다. 즉시 다시 그리면 애니메이션이 전혀 보이지 않는다.
        row.classList.add("collapsed");
        let el = row.nextElementSibling as HTMLElement | null;
        while (el && Number(el.dataset.navDepth ?? "-1") > depth) {
          el.classList.add("kid-exit");
          el = el.nextElementSibling as HTMLElement | null;
        }
        this.foldAnimating = true;
        window.setTimeout(() => {
          this.foldAnimating = false;
          this.collapsed.add(f.path);
          this.collapsedChanged();
          this.render(this.sessions);
        }, 130);
      };
      row.dataset.navKind = "folder";
      row.dataset.navPath = f.path;
      row.dataset.navDepth = String(depth);
      this.registerNav(row, `f:${f.path}`, toggle);
      row.addEventListener("click", toggle);
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          ...(this.cb.onOpenFolder
            ? [
                {
                  label: "이 폴더 세션 모두 열기",
                  accel: "o",
                  action: () => this.cb.onOpenFolder?.(f.path, this.sessionsUnder(f.path)),
                } as const,
                { separator: true } as const,
              ]
            : []),
          {
            label: "폴더 접기 (하위 폴더까지)",
            accel: "c",
            action: () => {
              this.collapseTree(f);
              this.collapsedChanged();
              this.render(this.sessions);
            },
          },
          { separator: true },
          ...this.sortItems(f.path),
          { separator: true },
          { label: "하위 새 폴더", accel: "n", action: () => this.cb.onNewFolder(f.path) },
          { label: "폴더 이름 변경", accel: "r", action: () => this.cb.onRenameFolder(f.path) },
          { separator: true },
          {
            label: "폴더 삭제(세션은 루트로)",
            accel: "d",
            danger: true,
            action: () => this.cb.onDeleteFolder(f.path),
          },
        ]);
      });
      row.addEventListener("dragover", (e) => {
        const ty = e.dataTransfer?.types;
        if (!ty || (!ty.includes(DRAG_TYPE) && !ty.includes(DRAG_FOLDER))) return;
        e.preventDefault();
        row.classList.add("drop-into");
      });
      row.addEventListener("dragleave", (e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !row.contains(to)) row.classList.remove("drop-into");
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("drop-into");
        // 접혀 있으면 펼쳐 준다 — 안 그러면 옮긴 항목이 사라진 것처럼 보인다.
        this.collapsed.delete(f.path);
        const id = e.dataTransfer?.getData(DRAG_TYPE);
        if (id) {
          this.cb.onDropSession(id, { kind: "folder", path: f.path });
          return;
        }
        const src = e.dataTransfer?.getData(DRAG_FOLDER);
        if (src) this.cb.onMoveFolder(src, f.path); // 이 폴더 안으로 이동
      });

      parent.appendChild(row);
      if (!isCollapsed) this.renderNode(f, parent, depth + 1);
    }

    const sessions = [...node.sessions].sort(this.comparator(node.path));
    for (const s of sessions) {
      parent.appendChild(sessionRow(this.rowCtx(), s, depth));
    }
  }

  /**
   * 이 폴더의 세션 비교기. 폴더에 지정된 방식이 있으면 그것을, 없으면 전역 규칙을 쓴다
   * (최근 접속순 설정 → 그 기준, 아니면 끌어서 정한 순서).
   *
   * 어느 방식이든 마지막에는 이름으로 한 번 더 가른다 — 값이 같을 때 순서가 매번 달라지면
   * 목록이 이유 없이 흔들린다.
   */
  private comparator(path: string): (a: SessionInfo, b: SessionInfo) => number {
    const name = (a: SessionInfo, b: SessionInfo) =>
      (a.name || a.host).localeCompare(b.name || b.host, "ko");
    const mode = this.folderSort[path] ?? (this.sortByRecent ? "recent" : "manual");
    switch (mode) {
      case "name-asc":
        return name;
      case "name-desc":
        return (a, b) => -name(a, b);
      case "recent":
        return (a, b) => b.lastConnectedUtc - a.lastConnectedUtc || name(a, b);
      default:
        return (a, b) => a.sortOrder - b.sortOrder || name(a, b);
    }
  }

  /**
   * '서비스 연결' 하위메뉴("서비스목록"). 서비스가 없거나 호스트 없는 세션(로컬 셸)이면
   * 빈 배열 — 죽은 항목을 두느니 아예 안 보이는 쪽이 낫다(빠른 접속 세션의 편집 항목과
   * 같은 결정).
   */
  private serviceItems(s: SessionInfo): MenuItem[] {
    const services = s.services ?? [];
    if (s.kind === "local" || services.length === 0 || !this.cb.onOpenService) return [];
    return [
      {
        label: "서비스 연결",
        children: services.map((svc) => ({
          label: `${svc.name}  ·  :${svc.port}`,
          action: () => this.cb.onOpenService!(s, svc),
        })),
      },
    ];
  }

  /** 폴더 우클릭 메뉴의 정렬 항목("" = 루트). */
  private sortItems(path: string): MenuItem[] {
    const cur = this.folderSort[path] ?? (this.sortByRecent ? "recent" : "manual");
    const pick = (label: string, mode: FolderSort, accel: string): MenuItem => ({
      // 지금 무엇이 걸려 있는지 표시가 없으면 눌러 보기 전에는 알 수 없다.
      label: (cur === mode ? "● " : "○ ") + label,
      accel,
      action: () => this.cb.onFolderSort?.(path, mode),
    });
    return [
      pick("정렬: 이름 오름차순", "name-asc", "a"),
      pick("정렬: 이름 내림차순", "name-desc", "z"),
      pick("정렬: 최근 접속순", "recent", "t"),
      pick("정렬: 수동(끌어서 배치)", "manual", "m"),
    ];
  }

}
