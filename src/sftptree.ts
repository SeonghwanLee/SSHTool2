// SFTP 창의 디렉터리 트리(지연 로딩). sftpui.ts 에서 분리(0.67.0). 로직 변경 없음.

import { sftpList, localList } from "./ipc";
import { applyIcon } from "./icons";
import { baseName, pathUnder, dirChain, hasOsFiles, type Entry, type Side } from "./sftpcommon";

// ── 디렉터리 트리(지연 로딩) ──
// 각 패널 상단의 폴더 트리. 확장 시에만 하위 폴더를 조회하고, 목록 이동 시
// 해당 경로까지 자동으로 펼쳐 강조한다. 클릭하면 아래 목록이 그 폴더로 이동.
export class DirTree {
  readonly el = document.createElement("div");
  private roots: string[] = [];
  private readonly expanded = new Set<string>();
  private readonly children = new Map<string, string[]>(); // 경로 → 하위 폴더 경로들
  private current = "";

  constructor(
    /** 살아있는 SFTP 연결 id — 재접속으로 바뀌므로 값이 아니라 게터로 받는다. */
    private readonly getSftpId: () => string,
    private readonly side: Side,
    private readonly onPick: (path: string) => void,
    /** 트리 폴더 우클릭 — 그 폴더를 대상으로 한 메뉴를 띄운다. */
    private readonly onMenu?: (path: string, x: number, y: number) => void,
    /** 탐색기에서 트리 폴더 위로 파일을 떨어뜨렸을 때(원격 트리에만 연결). */
    private readonly onDropFiles?: (path: string, dt: DataTransfer) => void,
    /** 같은 패널 목록에서 끌어온 항목을 이 폴더로 옮긴다(0.87.0). */
    private readonly onDropMove?: (path: string, paths: string[]) => void,
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
        this.side === "local" ? await localList(path) : await sftpList(this.getSftpId(), path || ".");
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
    // 탐색기 파일을 특정 폴더에 조준해 떨어뜨리는 경로 — 목록(현재 폴더) 드롭과 달리
    // 이동하지 않고 그 폴더로 바로 올린다.
    if (this.onDropFiles || this.onDropMove) {
      row.addEventListener("dragover", (e) => {
        const os = hasOsFiles(e);
        const mine = (e.dataTransfer?.types ?? []).includes("application/x-sshtool");
        if (!(os && this.onDropFiles) && !(mine && this.onDropMove)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer && mine) e.dataTransfer.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (e) => {
        row.classList.remove("drop-target");
        if (!e.dataTransfer) return;
        if (hasOsFiles(e)) {
          if (!this.onDropFiles) return;
          e.preventDefault();
          e.stopPropagation();
          this.onDropFiles(path, e.dataTransfer);
          return;
        }
        const raw = e.dataTransfer.getData("application/x-sshtool");
        if (!raw || !this.onDropMove) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          // 이 트리는 자기 패널의 것이므로, 넘어온 것이 그 패널의 항목일 때만 옮긴다.
          const payload = JSON.parse(raw) as { side: Side; paths: string[] };
          if (payload.side !== this.side) return;
          this.onDropMove(path, payload.paths);
        } catch {
          /* 무시 */
        }
      });
    }
    this.el.appendChild(row);

    if (isOpen && kids) {
      for (const k of kids) this.renderNode(k, depth + 1);
    }
  }
}

