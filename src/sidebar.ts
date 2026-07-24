// 좌측 세션 사이드바. 폴더 경로로 트리를 구성하고, 세션 열기/편집/삭제/새로만들기를 제공.

import type { SessionInfo } from "./types";
import { showContextMenu } from "./contextmenu";

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
  onNewFolder: (parent: string) => void;
  onImport: () => void;
  onRenameFolder: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  /** 드래그로 세션을 다른 세션 위/아래(순서) 또는 폴더 안으로 옮길 때. */
  onDropSession: (sourceId: string, target: DropTarget) => void;
}

/** 드롭 위치 — 세션 앞/뒤에 끼우기, 또는 폴더로 이동. */
export type DropTarget =
  | { kind: "session"; id: string; before: boolean }
  | { kind: "folder"; path: string };

const DRAG_TYPE = "application/x-sshtool-session";

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

export class Sidebar {
  private sessions: SessionInfo[] = [];
  private folders: string[] = [];
  private collapsed = new Set<string>();
  private filter = "";
  /** 표시 옵션(설정에서 주입). */
  private sortByRecent = false;
  private showDetail = true;

  constructor(
    private readonly tree: HTMLElement,
    private readonly cb: SidebarCallbacks,
    newBtn: HTMLElement,
    quickBtn: HTMLElement,
  ) {
    newBtn.addEventListener("click", () => this.cb.onNew());
    quickBtn.addEventListener("click", () => this.cb.onQuick());

    // 빈 영역에 드롭 = 루트로 꺼내기(모든 세션이 폴더 안이면 다른 방법이 없다).
    this.tree.addEventListener("dragover", (e) => {
      if (e.target !== this.tree || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
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
      if (id) this.cb.onDropSession(id, { kind: "folder", path: "" });
    });

    // 빈 영역 우클릭 = 트리 전체 대상 메뉴.
    this.tree.addEventListener("contextmenu", (e) => {
      if (e.target !== this.tree) return; // 행에서 올라온 이벤트는 각 행이 처리
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

  private select(row: HTMLElement): void {
    for (const el of this.tree.querySelectorAll(".tree-session.selected"))
      el.classList.remove("selected");
    row.classList.add("selected");
  }

  /** 설정 변경 시 표시 옵션을 반영한다. */
  setDisplayOptions(sortByRecent: boolean, showDetail: boolean): void {
    this.sortByRecent = sortByRecent;
    this.showDetail = showDetail;
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
    // 빈 폴더만 있어도 그려야 하므로 폴더 유무까지 본다.
    const visible = [...rootNode.folders.values()].length > 0 || rootNode.sessions.length > 0;
    if (!visible) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = this.filter
        ? "검색 결과가 없습니다."
        : "저장된 세션이 없습니다.\n＋ 로 추가하거나, 빈 곳을 우클릭해\n다른 클라이언트에서 가져오세요.";
      this.tree.appendChild(empty);
      return;
    }
    this.renderNode(rootNode, this.tree, 0);
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
      arrow.textContent = isCollapsed ? "▶" : "▼";
      const label = document.createElement("span");
      label.className = "tree-folder-label";
      label.textContent = f.name;
      row.append(arrow, label);
      row.addEventListener("click", () => {
        if (isCollapsed) this.collapsed.delete(f.path);
        else this.collapsed.add(f.path);
        this.render(this.sessions);
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
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
        if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
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
        const id = e.dataTransfer?.getData(DRAG_TYPE);
        if (id) {
          // 접혀 있으면 펼쳐 준다 — 안 그러면 옮긴 세션이 사라진 것처럼 보인다.
          this.collapsed.delete(f.path);
          this.cb.onDropSession(id, { kind: "folder", path: f.path });
        }
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
    icon.textContent = s.kind === "local" ? "▣" : "»";

    const main = document.createElement("div");
    main.className = "tree-session-main";
    const name = document.createElement("div");
    name.className = "tree-session-name";
    name.textContent = s.name || s.host;
    const detail = document.createElement("div");
    detail.className = "tree-session-detail";
    detail.textContent =
      s.kind === "local"
        ? `로컬 셸${s.shellExe ? ` · ${s.shellExe}` : ""}`
        : s.user
          ? `${s.user}@${s.host}:${s.port}`
          : `${s.host}:${s.port}`;
    main.append(name);
    if (this.showDetail) main.append(detail);

    const actions = document.createElement("div");
    actions.className = "tree-actions";
    actions.draggable = false; // 버튼 위에서 행 드래그가 시작되지 않게
    // 로컬 셸 세션에는 SFTP 가 없다(로컬 파일은 탐색기로 접근).
    const sftp = document.createElement("button");
    sftp.className = "tree-act";
    sftp.style.display = s.kind === "local" ? "none" : "";
    sftp.title = "SFTP 파일 전송";
    sftp.textContent = "📁";
    sftp.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onSftp(s);
    });
    const edit = document.createElement("button");
    edit.className = "tree-act";
    edit.title = "편집";
    edit.textContent = "✎";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onEdit(s);
    });
    const del = document.createElement("button");
    del.className = "tree-act";
    del.title = "삭제";
    del.textContent = "🗑";
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
    // 더블클릭 = 접속(단일 클릭 중복·오접속 방지). 선택 하이라이트만 단일 클릭.
    row.addEventListener("dblclick", () => this.cb.onOpen(s));
    row.addEventListener("click", () => this.select(row));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.select(row);
      showContextMenu(e.clientX, e.clientY, [
        { label: "연결", accel: "c", action: () => this.cb.onOpen(s) },
        ...(s.kind === "local"
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
