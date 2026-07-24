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
  localList,
  localParent,
  localMkdir,
  localRemove,
  localRename,
  localExists,
} from "./ipc";
import { confirmDialog, textPrompt } from "./dialogs";
import { showContextMenu } from "./contextmenu";
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
  const cut = p.lastIndexOf("/");
  if (cut < 0) return ".";
  if (cut === 0) return "/";
  return p.slice(0, cut);
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

/** 확장자에 따른 색(터미널 ls 색상 관례 + 확장자 구분). */
function entryColor(e: Entry): string {
  if (e.isDir) return "#7db8ff";
  const ext = e.name.toLowerCase().split(".").pop() ?? "";
  if (["sh", "bash", "exe", "bat", "cmd", "run", "bin"].includes(ext)) return "#8ec07c";
  if (["zip", "gz", "tar", "7z", "rar", "xz", "bz2"].includes(ext)) return "#e0c060";
  if (["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp"].includes(ext)) return "#c08ee0";
  if (["log", "txt", "md", "conf", "cfg", "ini", "yaml", "yml", "json", "xml"].includes(ext))
    return "#cfcfcf";
  if (["c", "h", "cpp", "rs", "ts", "js", "py", "java", "go"].includes(ext)) return "#79d0c8";
  return "";
}

export async function openSftpBrowser(session: SessionInfo, password: string): Promise<void> {
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
  closeBtn.textContent = "×";
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
  cancelBtn.textContent = "✕";
  cancelBtn.title = "전송 취소";
  cancelBtn.addEventListener("click", () => {
    cancelled = true;
    if (currentTransfer) void sftpCancel(currentTransfer);
  });
  strip.append(pName, bar, pInfo, cancelBtn);

  const showProgress = (name: string, done: number, total: number) => {
    strip.classList.remove("hidden");
    pName.textContent = name;
    const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    fill.style.width = `${ratio}%`;
    pct.textContent = `${ratio}%`;
    pInfo.textContent = total > 0 ? `${fmtSize(done)} / ${fmtSize(total)}` : fmtSize(done);
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

  // ── 파일 목록 패널 ──
  class Pane {
    path = "";
    entries: Entry[] = [];
    readonly selected = new Set<string>();
    readonly root = document.createElement("div");
    private readonly listEl = document.createElement("div");
    private readonly pathInput = document.createElement("input");
    other!: Pane;

    constructor(readonly side: Side) {
      this.root.className = "sftp-pane";

      const head = document.createElement("div");
      head.className = "sftp-pane-head";
      const label = document.createElement("span");
      label.className = "pane-label";
      label.textContent = side === "local" ? "로컬" : "원격";
      head.appendChild(label);

      const up = mkBtn("↑", "상위 폴더");
      up.addEventListener("click", () => void this.up());
      const refresh = mkBtn("⟳", "새로고침(F5)");
      refresh.addEventListener("click", () => void this.reload());
      const mkdirBtn = mkBtn("＋", "새 폴더");
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

      this.root.append(head, this.listEl);
    }

    async go(path: string): Promise<void> {
      try {
        const entries =
          this.side === "local" ? await localList(path) : await sftpList(sftpId!, path || ".");
        this.path = path;
        this.pathInput.value = path;
        this.entries = entries as Entry[];
        this.selected.clear();
        this.draw();
      } catch (e) {
        setStatus(`목록 실패: ${String(e)}`);
      }
    }

    reload(): Promise<void> {
      return this.go(this.path);
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

    draw(): void {
      this.listEl.innerHTML = "";
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

      const icon = document.createElement("span");
      icon.className = "sftp-icon";
      icon.textContent = entry.isDir ? "📁" : "📄";

      const name = document.createElement("span");
      name.className = "sftp-name";
      name.textContent = entry.name;
      const color = entryColor(entry);
      if (color) name.style.color = color;

      const size = document.createElement("span");
      size.className = "sftp-size";
      size.textContent = entry.isDir ? "" : fmtSize(entry.size);

      const time = document.createElement("span");
      time.className = "sftp-time";
      time.textContent = fmtTime(entry.modified);

      el.append(icon, name, size, time);

      el.addEventListener("click", (e) => {
        if (!e.ctrlKey && !e.metaKey) this.selected.clear();
        if (this.selected.has(entry.path)) this.selected.delete(entry.path);
        else this.selected.add(entry.path);
        this.markSelection();
        this.listEl.focus();
      });
      el.addEventListener("dblclick", () => {
        if (entry.isDir) void this.go(entry.path);
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
        showContextMenu(e.clientX, e.clientY, [
          {
            label: this.side === "local" ? "업로드 →" : "← 다운로드",
            accel: "t",
            action: () => void transferInto(this.other, [...this.selected]),
          },
          { separator: true },
          { label: "이름 변경 (F2)", accel: "r", action: () => void this.rename(entry) },
          { label: "새로고침 (F5)", accel: "f", action: () => void this.reload() },
          { separator: true },
          {
            label: "삭제 (Del)",
            accel: "d",
            danger: true,
            action: () => void this.removeSelected(),
          },
        ]);
      });
      return el;
    }
  }

  const local = new Pane("local");
  const remote = new Pane("remote");
  local.other = remote;
  remote.other = local;
  body.append(local.root, remote.root);
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
    const start = await localDefaultDir();
    await local.go(start);
  } catch {
    await local.go("");
  }
  try {
    sftpId = await sftpConnect(session.host, session.port, session.user, password);
    // "." 로 두면 상위 이동이 불가능하므로 절대경로(홈)로 정규화한다.
    let start = ".";
    try {
      start = await sftpCanonicalize(sftpId, ".");
    } catch {
      start = ".";
    }
    await remote.go(start);
    setStatus("연결됨");
  } catch (e) {
    setStatus(`SFTP 접속 실패: ${String(e)}`);
  }

  // F5/F2/Delete 가 첫 클릭 전에도 동작하도록(그리고 F5 가 앱 새로고침이 되지 않도록) 포커스.
  local.focusList();

  // 로컬 존재 검사는 목록 기반이지만, 방금 만든 파일 등 최신 상태 확인이 필요할 때 사용.
  void localExists;
}

function mkBtn(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "sftp-btn";
  b.textContent = label;
  b.title = title;
  return b;
}
