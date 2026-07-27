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

/** 파일유형 열 텍스트. */
function entryType(e: Entry): string {
  if (e.isDir) return "폴더";
  const dot = e.name.lastIndexOf(".");
  const x = dot > 0 ? e.name.slice(dot + 1).toUpperCase() : "";
  return x ? `${x} 파일` : "파일";
}

export async function openSftpBrowser(
  session: SessionInfo,
  password: string,
  /** SFTP 인증이 실제로 성공한 뒤에만 호출(자격증명 저장 제안 등). */
  onAuthenticated?: () => void | Promise<void>,
): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "sftp-overlay";
  const panel = document.createElement("div");
  panel.className = "sftp-panel sftp-dual";
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let sftpId: string | null = null;
  let unlisten: (() => void) | null = null;
  let currentTransfer: string | null = null;
  let cancelled = false;
  let transferring = false; // 동시 전송 방지(진행바·취소 대상이 뒤섞이지 않게)
  let disposed = false;     // 창이 닫힌 뒤의 후속 작업 차단

  // ── 헤더 ──
  const header = document.createElement("div");
  header.className = "sftp-header";
  const title = document.createElement("div");
  title.className = "sftp-title";
  title.textContent = `SFTP · ${session.name || session.host}`;
  const status = document.createElement("div");
  status.className = "sftp-status";
  const closeBtn = document.createElement("button");
  closeBtn.className = "sftp-close";
  applyIcon(closeBtn, "close");
  header.append(title, status, closeBtn);

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
    if (!disposed && e.transferId === currentTransfer) showProgress(e.name, e.done, e.total);
  }).then((fn) => {
    // listen() 이 해결되기 전에 창이 닫혔으면 즉시 해제(리스너 누수 방지).
    if (disposed) fn();
    else unlisten = fn;
  });

  // ── 패널 ──
  const body = document.createElement("div");
  body.className = "sftp-body";

  const cleanup = () => {
    disposed = true;
    cancelled = true;
    // 진행 중 전송을 반드시 중단한다 — 안 그러면 창이 없는데 백그라운드로 계속 전송된다.
    if (currentTransfer) void sftpCancel(currentTransfer);
    unlisten?.();
    if (sftpId) void sftpDisconnect(sftpId);
    overlay.remove();
  };
  closeBtn.addEventListener("click", cleanup);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) cleanup();
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
    other!: Pane;

    constructor(readonly side: Side) {
      this.root.className = "sftp-pane";
      this.tree = new DirTree(side, (p) => void this.go(p));

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

    /** 컬럼 헤더(파일명/유형/크기/수정일자) + 구분선 드래그로 너비 조절(탐색기 방식). */
    private buildColHead(): HTMLElement {
      const head = document.createElement("div");
      head.className = "sftp-colhead";
      const spacer = document.createElement("span"); // 아이콘 칸 자리
      head.append(spacer, this.colCell("파일명"), this.colCell("유형", "--c-type"),
        this.colCell("크기", "--c-size"), this.colCell("수정일자", "--c-time"));
      return head;
    }

    private colCell(label: string, cssVar?: string): HTMLElement {
      const cell = document.createElement("span");
      cell.className = "sftp-colcell";
      cell.textContent = label;
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
      }
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
      return this.entries.filter((x) => x.name !== "." && x.name !== "..");
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
        currentTransfer = transferId;
        showProgress(entry.name, 0, entry.size);
        await sftpDownload(sftpId, entry.path, localPath, transferId);
        currentTransfer = null;
        hideProgress();
        await openPath(localPath);
        setStatus("연결됨");
      } catch (e) {
        currentTransfer = null;
        hideProgress();
        setStatus(`열기 실패: ${String(e)}`);
      } finally {
        transferring = false;
      }
    }

    draw(): void {
      this.listEl.innerHTML = "";
      if (this.path) this.listEl.appendChild(this.upRow()); // '..' 상위 이동
      for (const entry of this.entries) {
        if (entry.name === "." || entry.name === "..") continue;
        this.listEl.appendChild(this.row(entry));
      }
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
      el.className = "sftp-row" + (this.selected.has(entry.path) ? " selected" : "");
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
    const src = dest.other;
    const items = src.entries.filter((e) => paths.includes(e.path));
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
    currentTransfer = null;
    transferring = false;
    setStatus(
      cancelled
        ? "전송 취소됨"
        : failed > 0
          ? `전송 완료 (${failed}개 실패/건너뜀)`
          : "전송 완료",
    );
    if (!disposed) await dest.reload();
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
      currentTransfer = transferId;
      showProgress(entry.name, 0, entry.size);
      if (from === "local") await sftpUpload(sftpId!, entry.path, destPath, transferId);
      else await sftpDownload(sftpId!, entry.path, destPath, transferId);
      currentTransfer = null;
      return;
    }

    // 폴더: 대상에 만들고 자식들을 재귀 전송.
    if (from === "local") await sftpMkdir(sftpId!, destPath).catch(() => undefined);
    else await localMkdir(destPath).catch(() => undefined);

    const children = (
      from === "local" ? await localList(entry.path) : await sftpList(sftpId!, entry.path)
    ) as Entry[];
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
  try {
    const start = await localDefaultDir();
    await local.go(start);
  } catch {
    await local.go("");
  }
  try {
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
