// 좌측 세션 사이드바. 폴더 경로로 트리를 구성하고, 세션 열기/편집/삭제/새로만들기를 제공.

import type { SessionInfo } from "./types";
import { showContextMenu } from "./contextmenu";
import { applyIcon } from "./icons";

interface SidebarCallbacks {
  onOpen: (s: SessionInfo) => void;
  onEdit: (s: SessionInfo) => void;
  onDelete: (s: SessionInfo) => void;
  onSftp: (s: SessionInfo) => void;
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
}

/** 드롭 위치 — 세션 앞/뒤에 끼우기, 또는 폴더로 이동. */
export type DropTarget =
  | { kind: "session"; id: string; before: boolean }
  | { kind: "folder"; path: string };

const DRAG_TYPE = "application/x-sshtool-session";
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

const navDepth = (row: HTMLElement): number => Number(row.dataset.navDepth ?? NO_DEPTH);

/** 세션 상세(계정@호스트:포트 또는 로컬 셸) — 세션 행·최근 접속 공용. */
const detailText = (s: SessionInfo): string =>
  s.kind === "local"
    ? `로컬 셸${s.shellExe ? ` · ${s.shellExe}` : ""}`
    : s.user
      ? `${s.user}@${s.host}:${s.port}`
      : `${s.host}:${s.port}`;

export class Sidebar {
  private sessions: SessionInfo[] = [];
  private folders: string[] = [];
  private collapsed = new Set<string>();
  private filter = "";
  /** 표시 옵션(설정에서 주입). */
  private sortByRecent = false;
  private showDetail = true;
  private recentLimit = 10;
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
        { label: "다른 클라이언트에서 가져오기…", accel: "i", action: () => this.cb.onImport() },
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
        return;
    }
  }

  /** → 접혀 있으면 펼치고, 이미 펼쳐져 있으면 첫 자식으로. 세션·최근 접속은 자식이 없다. */
  private navRight(row: HTMLElement, rows: HTMLElement[], index: number): void {
    if (row.dataset.navKind !== "folder") return;
    const path = row.dataset.navPath ?? "";
    if (this.collapsed.has(path) && !this.filter) {
      this.collapsed.delete(path);
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
        this.render(this.sessions);
        return;
      }
    }
    this.focusRow(this.parentRow(rows, index));
  }

  /** 설정 변경 시 표시 옵션을 반영한다. */
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
    return (
      s.name.toLowerCase().includes(q) ||
      s.host.toLowerCase().includes(q) ||
      s.user.toLowerCase().includes(q) ||
      s.shellExe.toLowerCase().includes(q)
    );
  }

  /** 세션 + 명시적으로 만든(비어 있을 수 있는) 폴더 목록으로 트리를 그린다. */
  render(sessions: SessionInfo[], folders: string[] = this.folders): void {
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

    this.tree.innerHTML = "";
    // 검색 중이 아니면 상단에 최근 접속 10개(바로 접속 가능).
    if (!this.filter) this.renderRecent();
    // 빈 폴더만 있어도 그려야 하므로 폴더 유무까지 본다.
    const visible = [...rootNode.folders.values()].length > 0 || rootNode.sessions.length > 0;
    if (!visible) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = this.filter
        ? "검색 결과가 없습니다."
        : "저장된 세션이 없습니다.\n＋ 로 추가하거나, 빈 곳을 우클릭해\n다른 클라이언트에서 가져오세요.";
      this.tree.appendChild(empty);
      this.restoreNavFocus(hadFocus);
      return;
    }
    this.renderNode(rootNode, this.tree, 0);
    this.restoreNavFocus(hadFocus);
  }

  /** 폴더와 그 하위 모든 폴더를 접는다(우클릭 '폴더 접기'). */
  private collapseTree(node: FolderNode): void {
    this.collapsed.add(node.path);
    for (const child of node.folders.values()) this.collapseTree(child);
  }

  /** 상단 '최근 접속' 섹션 — 접속 이력이 있는 세션 최근 10개, 클릭 시 바로 접속. */
  private renderRecent(): void {
    if (this.recentLimit <= 0) return; // 0 = 최근 접속 섹션 숨김
    const recent = this.sessions
      .filter((s) => s.lastConnectedUtc > 0)
      .sort((a, b) => b.lastConnectedUtc - a.lastConnectedUtc)
      .slice(0, this.recentLimit);
    if (recent.length === 0) return;

    const head = document.createElement("div");
    head.className = "recent-head";
    const headLabel = document.createElement("span");
    headLabel.textContent = "최근 접속";
    const clearAll = document.createElement("button");
    clearAll.className = "recent-clear tree-act";
    applyIcon(clearAll, "delete");
    clearAll.title = "최근 기록 전체 삭제";
    clearAll.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onClearRecent();
    });
    head.append(headLabel, clearAll);
    this.tree.appendChild(head);

    for (const s of recent) {
      const row = document.createElement("div");
      row.className = "recent-row";
      row.title = `${detailText(s)} · 더블클릭하여 접속`;

      const icon = document.createElement("span");
      icon.className = "tree-icon";
      applyIcon(icon, s.kind === "local" ? "local" : "remote");

      const name = document.createElement("span");
      name.className = "recent-name";
      name.textContent = s.name || s.host;

      const detail = document.createElement("span");
      detail.className = "recent-detail";
      detail.textContent = detailText(s);

      // 마우스 오버 시 나타나는 개별 삭제(휴지통) 버튼.
      const del = document.createElement("button");
      del.className = "recent-del tree-act";
      applyIcon(del, "delete");
      del.title = "최근 목록에서 삭제";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onRemoveRecent(s);
      });

      // 세션 행과 같은 기준 — 로컬 셸이거나 SFTP 를 끈 세션에는 노출하지 않는다.
      const sftpAvailable = s.kind !== "local" && s.enableSftp;
      const sftp = document.createElement("button");
      sftp.className = "recent-sftp tree-act sftp-chip";
      sftp.textContent = "SFTP";
      sftp.title = "SFTP 파일 전송";
      sftp.style.display = sftpAvailable ? "" : "none";
      sftp.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onSftp(s);
      });

      row.append(icon, name, detail, sftp, del);
      row.dataset.navKind = "recent";
      this.registerNav(row, `r:${s.id}`, () => this.cb.onOpen(s));
      // 세션 행과 같은 규칙 — 단일 클릭은 선택만, 접속은 더블클릭.
      // 한 번 클릭에 바로 붙으면 목록을 훑다가 실수로 접속하게 된다.
      row.addEventListener("click", () => this.select(row));
      row.addEventListener("dblclick", () => this.cb.onOpen(s));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.select(row);
        showContextMenu(e.clientX, e.clientY, [
          { label: "연결", accel: "c", action: () => this.cb.onOpen(s) },
          ...(sftpAvailable
            ? [{ label: "SFTP 파일 전송", accel: "f", action: () => this.cb.onSftp(s) } as const]
            : []),
          { separator: true },
          {
            label: "최근 목록에서 삭제",
            accel: "d",
            danger: true,
            action: () => this.cb.onRemoveRecent(s),
          },
          { label: "최근 기록 전체 삭제", accel: "a", action: () => this.cb.onClearRecent() },
        ]);
      });
      this.tree.appendChild(row);
    }

    const divider = document.createElement("div");
    divider.className = "recent-divider";
    this.tree.appendChild(divider);
  }

  private renderNode(node: FolderNode, parent: HTMLElement, depth: number): void {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    for (const f of folders) {
      const isCollapsed = !this.filter && this.collapsed.has(f.path);
      const row = document.createElement("div");
      row.className = "tree-folder";
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const arrow = document.createElement("span");
      arrow.className = "tree-arrow";
      applyIcon(arrow, isCollapsed ? "folder" : "folderOpen");
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
        if (isCollapsed) this.collapsed.delete(f.path);
        else this.collapsed.add(f.path);
        this.render(this.sessions);
      };
      row.dataset.navKind = "folder";
      row.dataset.navPath = f.path;
      row.dataset.navDepth = String(depth);
      this.registerNav(row, `f:${f.path}`, toggle);
      row.addEventListener("click", toggle);
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          {
            label: "폴더 접기 (하위 폴더까지)",
            accel: "c",
            action: () => {
              this.collapseTree(f);
              this.render(this.sessions);
            },
          },
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

    // 최근 접속순이 켜져 있으면 그 기준, 아니면 수동 정렬(sortOrder) → 이름순.
    const sessions = [...node.sessions].sort((a, b) =>
      this.sortByRecent
        ? b.lastConnectedUtc - a.lastConnectedUtc || a.name.localeCompare(b.name, "ko")
        : a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"),
    );
    for (const s of sessions) {
      parent.appendChild(this.sessionRow(s, depth));
    }
  }

  private sessionRow(s: SessionInfo, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-session";
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    applyIcon(icon, s.kind === "local" ? "local" : "remote");

    const main = document.createElement("div");
    main.className = "tree-session-main";
    const name = document.createElement("div");
    name.className = "tree-session-name";
    name.textContent = s.name || s.host;
    const detail = document.createElement("div");
    detail.className = "tree-session-detail";
    detail.textContent = detailText(s);
    main.append(name);
    if (this.showDetail) main.append(detail);

    const actions = document.createElement("div");
    actions.className = "tree-actions";
    actions.draggable = false; // 버튼 위에서 행 드래그가 시작되지 않게
    // 로컬 셸 세션에는 SFTP 가 없다(로컬 파일은 탐색기로 접근).
    const sftp = document.createElement("button");
    sftp.className = "tree-act";
    sftp.style.display = s.kind === "local" || !s.enableSftp ? "none" : "";
    sftp.title = "SFTP 파일 전송";
    sftp.classList.add("sftp-chip");
    sftp.textContent = "SFTP";
    sftp.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onSftp(s);
    });
    const edit = document.createElement("button");
    edit.className = "tree-act";
    edit.title = "편집";
    applyIcon(edit, "edit");
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onEdit(s);
    });
    const del = document.createElement("button");
    del.className = "tree-act";
    del.title = "삭제";
    applyIcon(del, "delete");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onDelete(s);
    });
    actions.append(sftp, edit, del);

    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(DRAG_TYPE, s.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      // 행의 위/아래 절반에 따라 삽입 위치를 표시(WPF 0.6.2 삽입선).
      const r = row.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      row.classList.toggle("drop-before", before);
      row.classList.toggle("drop-after", !before);
    });
    row.addEventListener("dragleave", (e) => {
      const to = e.relatedTarget as Node | null;
      if (!to || !row.contains(to)) row.classList.remove("drop-before", "drop-after");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      // 클래스는 dragleave 로 지워질 수 있으므로 좌표에서 다시 계산한다.
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      row.classList.remove("drop-before", "drop-after");
      const id = e.dataTransfer?.getData(DRAG_TYPE);
      if (id && id !== s.id) {
        this.cb.onDropSession(id, { kind: "session", id: s.id, before });
      }
    });

    row.append(icon, main, actions);
    row.dataset.navKind = "session";
    row.dataset.navDepth = String(depth);
    this.registerNav(row, `s:${s.id}`, () => this.cb.onOpen(s));
    // 키보드로 옮겨 다닐 때도 마우스 클릭과 같은 선택 하이라이트를 남긴다.
    row.addEventListener("focus", () => this.select(row));
    // 더블클릭 = 접속(단일 클릭 중복·오접속 방지). 선택 하이라이트만 단일 클릭.
    row.addEventListener("dblclick", () => this.cb.onOpen(s));
    row.addEventListener("click", () => this.select(row));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.select(row);
      showContextMenu(e.clientX, e.clientY, [
        { label: "연결", accel: "c", action: () => this.cb.onOpen(s) },
        ...(s.kind === "local" || !s.enableSftp
          ? []
          : [
              { label: "SFTP 파일 전송", accel: "f", action: () => this.cb.onSftp(s) } as const,
            ]),
        { separator: true },
        { label: "편집", accel: "e", action: () => this.cb.onEdit(s) },
        { label: "복제", accel: "u", action: () => this.cb.onDuplicate(s) },
        { label: "폴더 이동", accel: "m", action: () => this.cb.onMove(s) },
        { label: "이름 변경", accel: "r", action: () => this.cb.onRename(s) },
        { separator: true },
        { label: "위로", accel: "k", action: () => this.cb.onReorder(s, -1) },
        { label: "아래로", accel: "j", action: () => this.cb.onReorder(s, 1) },
        { separator: true },
        { label: "새 폴더", accel: "n", action: () => this.cb.onNewFolder(s.folder) },
        { label: "삭제", accel: "d", danger: true, action: () => this.cb.onDelete(s) },
        { label: "세션 일괄 삭제…", accel: "b", danger: true, action: () => this.cb.onBulkDelete() },
      ]);
    });
    return row;
  }
}
