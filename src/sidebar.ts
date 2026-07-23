// 좌측 세션 사이드바. 폴더 경로로 트리를 구성하고, 세션 열기/편집/삭제/새로만들기를 제공.

import type { SessionInfo } from "./types";

interface SidebarCallbacks {
  onOpen: (s: SessionInfo) => void;
  onEdit: (s: SessionInfo) => void;
  onDelete: (s: SessionInfo) => void;
  onSftp: (s: SessionInfo) => void;
  onNew: () => void;
  onQuick: () => void;
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

  render(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    const rootNode = newFolder("", "");

    for (const s of sessions) {
      if (!this.matches(s)) continue;
      let node = rootNode;
      const path = s.folder.trim();
      if (path) {
        let acc = "";
        for (const seg of path.split(/[\\/]/).filter(Boolean)) {
          acc = acc ? `${acc}/${seg}` : seg;
          if (!node.folders.has(seg)) node.folders.set(seg, newFolder(seg, acc));
          node = node.folders.get(seg)!;
        }
      }
      node.sessions.push(s);
    }

    this.tree.innerHTML = "";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "저장된 세션이 없습니다.\n＋ 로 추가하세요.";
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
      parent.appendChild(row);
      if (!isCollapsed) this.renderNode(f, parent, depth + 1);
    }

    const sessions = [...node.sessions].sort((a, b) => a.name.localeCompare(b.name, "ko"));
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
    row.addEventListener("click", () => {
      for (const el of this.tree.querySelectorAll(".tree-session.selected"))
        el.classList.remove("selected");
      row.classList.add("selected");
    });
    return row;
  }
}
