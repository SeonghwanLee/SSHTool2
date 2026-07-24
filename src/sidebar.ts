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
}

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

  constructor(
    private readonly tree: HTMLElement,
    private readonly cb: SidebarCallbacks,
    newBtn: HTMLElement,
    quickBtn: HTMLElement,
  ) {
    newBtn.addEventListener("click", () => this.cb.onNew());
    quickBtn.addEventListener("click", () => this.cb.onQuick());

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
      s.user.toLowerCase().includes(q)
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
      parent.appendChild(row);
      if (!isCollapsed) this.renderNode(f, parent, depth + 1);
    }

    // 수동 정렬(sortOrder) 우선, 같으면 이름순.
    const sessions = [...node.sessions].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"),
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
    icon.textContent = "»";

    const main = document.createElement("div");
    main.className = "tree-session-main";
    const name = document.createElement("div");
    name.className = "tree-session-name";
    name.textContent = s.name || s.host;
    const detail = document.createElement("div");
    detail.className = "tree-session-detail";
    detail.textContent = s.user ? `${s.user}@${s.host}:${s.port}` : `${s.host}:${s.port}`;
    main.append(name, detail);

    const actions = document.createElement("div");
    actions.className = "tree-actions";
    const sftp = document.createElement("button");
    sftp.className = "tree-act";
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

    row.append(icon, main, actions);
    // 더블클릭 = 접속(단일 클릭 중복·오접속 방지). 선택 하이라이트만 단일 클릭.
    row.addEventListener("dblclick", () => this.cb.onOpen(s));
    row.addEventListener("click", () => this.select(row));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.select(row);
      showContextMenu(e.clientX, e.clientY, [
        { label: "연결", accel: "c", action: () => this.cb.onOpen(s) },
        { label: "SFTP 파일 전송", accel: "f", action: () => this.cb.onSftp(s) },
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
