// SFTP 파일 목록 패널(로컬/원격 공용) — 목록·선택·정렬·열 너비·타입어헤드·드래그·우클릭.
// sftpui.ts 에서 분리(0.67.0). 로직 변경 없음. 창이 쥔 상태(sftpId·전송 상태)와 동작
// (전송·업로드)은 PaneCtx 로 받는다.

import {
  sftpList,
  sftpRemove,
  sftpRename,
  sftpMkdir,
  localList,
  localParent,
  localRemove,
  localRename,
  localMkdir,
  openPath,
  localTempDir,
  sftpDownload,
} from "./ipc";
import { confirmDialog, textPrompt } from "./dialogs";
import { applyIcon, fileIcon } from "./icons";
import { showContextMenu, type MenuItem } from "./contextmenu";
import { span, mkBtn } from "./sftpcommon";
import { DirTree } from "./sftptree";
import {
  joinPath,
  parentOf,
  baseName,
  remoteParent,
  fmtSize,
  fmtTime,
  entryType,
  isExecutable,
  hasOsFiles,
  colWidths,
  TYPEAHEAD_RESET_MS,
  type Entry,
  type Side,
  type TransferState,
} from "./sftpcommon";

/** 패널이 창에서 필요로 하는 것들. 창이 만들어 넘긴다. */
export interface PaneCtx {
  getSftpId: () => string;
  setStatus: (m: string) => void;
  xfer: TransferState;
  transferInto: (dest: Pane, paths: string[]) => Promise<void>;
  transferItems: (dest: Pane, items: Entry[], destDirOverride?: string) => Promise<void>;
  downloadToPicked: (items: Entry[]) => Promise<void>;
  onOsFilesDropped: (dt: DataTransfer, destDir?: string) => Promise<void>;
  setTransfer: (id: string | null) => void;
  /** 원격 파일을 임시본으로 연 뒤, 그 파일이 바뀌면 서버로 되올린다(0.67.0). */
  watchEdit: (localPath: string, remotePath: string, name: string) => void;
  showProgress: (name: string, done: number, total: number) => void;
  hideProgress: () => void;
}

// ── 파일 목록 패널 ──
export class Pane {
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

  constructor(
    private readonly ctx: PaneCtx,
    readonly side: Side,
  ) {
    this.root.className = "sftp-pane";
    // 트리에서 고른 폴더를 반대편으로 통째로 옮긴다. 목록으로 내려가 그 폴더를 찾아
    // 우클릭할 필요 없이, 트리에서 바로 보내려는 것이 이 메뉴의 목적이다.
    this.tree = new DirTree(
      () => this.ctx.getSftpId(),
      side,
      (p) => void this.go(p),
      (path, x, y) => {
        // 트리에 보이는 폴더가 반대편 목록에 떠 있다는 보장이 없어 항목을 직접 만든다.
        const folder: Entry = { name: baseName(path), path, isDir: true, size: 0, modified: 0 };
        const items: MenuItem[] = [
          { label: "이 폴더 열기", accel: "o", action: () => void this.go(path) },
          // 목록으로 내려가지 않고 트리에서 바로 만든다(0.69.0) — 대상은 '이 폴더 안'.
          { label: "하위 새 폴더", accel: "n", action: () => void this.makeDirIn(path) },
          { separator: true },
          {
            label: side === "local" ? "업로드 →" : "← 다운로드",
            accel: "t",
            action: () => void this.ctx.transferItems(this.other, [folder]),
          },
        ];
        if (side === "remote") {
          items.push({
            label: "폴더 지정해 다운로드…",
            accel: "g",
            action: () => void this.ctx.downloadToPicked([folder]),
          });
        }
        items.push(
          { separator: true },
          { label: "새로고침", accel: "f", action: () => void this.tree.reveal(path, true) },
        );
        showContextMenu(x, y, items);
      },
      // 원격 트리 폴더에 탐색기 파일을 떨어뜨리면 그 폴더로 업로드.
      side === "remote" ? (path, dt) => void this.ctx.onOsFilesDropped(dt, path) : undefined,
      // 목록에서 끌어온 것을 트리의 폴더에 떨어뜨리면 그 폴더로 옮긴다(0.87.0).
      (path, paths) => void this.moveInto(path, paths),
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
        { label: "새로고침", accel: "f", hint: "F5", action: () => void this.reload() },
      ];
      // 빈 폴더에서는 고를 것이 없다.
      if (this.visible().length > 0) {
        items.push(
          { separator: true },
          {
            label: "전체 선택",
            accel: "a",
            hint: "Ctrl+A",
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

    // 반대 패널에서 끌어온 항목, 그리고 탐색기에서 끌어온 OS 파일(원격만) 받기.
    this.listEl.addEventListener("dragover", (e) => {
      if (!e.dataTransfer) return;
      // OS 파일은 원격 패널만 받는다 — 로컬 패널에 받아 봐야 탐색기 복사와 같다.
      if (hasOsFiles(e) && this.side === "local") return;
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
      if (!e.dataTransfer) return;
      if (hasOsFiles(e)) {
        // 탐색기 드롭 = 현재 원격 폴더로 업로드.
        if (this.side === "remote") void this.ctx.onOsFilesDropped(e.dataTransfer);
        return;
      }
      const raw = e.dataTransfer.getData("application/x-sshtool");
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as { side: Side; paths: string[] };
        // 같은 패널 안에서 빈 곳에 떨어뜨린 것은 '지금 폴더로 옮기기' 다 — 하위 폴더에서
        // 끌어 올린 경우에만 뜻이 있고, 이미 이 폴더에 있는 것은 moveInto 가 걸러 낸다.
        if (payload.side === this.side) {
          void this.moveInto(this.path, payload.paths);
          return;
        }
        void this.ctx.transferInto(this, payload.paths);
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
        this.side === "local" ? await localList(path) : await sftpList(this.ctx.getSftpId(), path || ".");
      this.path = path;
      this.pathInput.value = path;
      this.entries = entries as Entry[];
      this.selected.clear();
      this.anchor = -1; // 폴더 이동 시 Shift 범위 선택 기준 초기화(엉뚱한 범위 방지)
      this.draw();
      void this.tree.reveal(path, force); // 트리 강조·펼침 동기화(reload 는 캐시 갱신)
    } catch (e) {
      this.ctx.setStatus(`목록 실패: ${String(e)}`);
    }
  }

  reload(): Promise<void> {
    return this.go(this.path, true); // 폴더 생성/삭제/이름변경 후 트리도 갱신
  }

  /**
   * 같은 패널 안에서 폴더로 옮긴다(0.87.0) — 목록의 폴더 행에, 또는 트리의 폴더에
   * 떨어뜨렸을 때. 로컬·원격 모두 이름 바꾸기(rename)로 처리한다: 같은 장치 안이라
   * 내용을 복사하지 않고 즉시 끝난다.
   *
   * 안전 장치가 필요한 자리다. 드래그는 손이 미끄러지기 쉽고, 옮기기는 원본을 그대로
   * 들어 옮기므로 잘못 떨어뜨리면 파일이 사라진 것처럼 보인다:
   *  - 자기 자신, 이미 그 폴더에 있는 것, 폴더를 자기 하위로 넣는 것은 조용히 뺀다.
   *  - **같은 이름이 이미 있으면 건너뛴다.** 로컬 rename 은 Windows 에서 기존 파일을
   *    말없이 덮어쓴다(std::fs::rename → MOVEFILE_REPLACE_EXISTING). 덮어쓰면 되돌릴
   *    길이 없으므로, 목적지 목록을 미리 읽어 이름이 겹치는 것은 손대지 않는다.
   *  - 무엇이 옮겨졌고 무엇이 남았는지 상태줄에 그대로 밝힌다.
   */
  async moveInto(destDir: string, paths: string[]): Promise<void> {
    const targets = [...new Set(paths)].filter((p) => {
      if (!p || p === destDir) return false;
      if (destDir === parentOf(p)) return false; // 이미 그 안에 있다
      if (destDir.startsWith(`${p}/`)) return false; // 폴더를 자기 하위로
      return true;
    });
    if (targets.length === 0) return;

    try {
      this.ctx.setStatus("옮기는 중…");
      const existing = new Set(
        (this.side === "local"
          ? await localList(destDir)
          : await sftpList(this.ctx.getSftpId(), destDir || ".")
        ).map((e) => e.name),
      );
      let moved = 0;
      const skipped: string[] = [];
      const failed: string[] = [];
      for (const from of targets) {
        const name = baseName(from);
        if (existing.has(name)) {
          skipped.push(name);
          continue;
        }
        const to = joinPath(destDir, name);
        try {
          if (this.side === "local") await localRename(from, to);
          else await sftpRename(this.ctx.getSftpId(), from, to);
          moved++;
        } catch (e) {
          failed.push(`${name}(${String(e).slice(0, 40)})`);
        }
      }
      await this.reload();
      const where = baseName(destDir) || destDir;
      this.ctx.setStatus(
        moved === 0 && skipped.length === 0 && failed.length === 0
          ? "옮길 항목이 없습니다"
          : `${moved}개를 '${where}' 로 옮겼습니다` +
              (skipped.length ? ` · 같은 이름이 있어 ${skipped.length}개 건너뜀(${skipped.join(", ")})` : "") +
              (failed.length ? ` · 실패 ${failed.length}개(${failed.join(", ")})` : ""),
      );
    } catch (e) {
      this.ctx.setStatus(`옮기기 실패: ${String(e)}`);
    }
  }

  focusList(): void {
    this.listEl.focus();
  }

  async up(): Promise<void> {
    const parent =
      this.side === "local" ? await localParent(this.path) : remoteParent(this.path);
    if (parent && parent !== this.path) await this.go(parent);
  }

  /** 지금 보고 있는 폴더 안에 새 폴더(머리말 버튼·목록 우클릭). */
  private async makeDir(): Promise<void> {
    await this.makeDirIn(this.path);
  }

  /**
   * 지정한 폴더 **안에** 새 폴더를 만든다. 트리 우클릭은 보고 있는 폴더가 아니라
   * 오른쪽 클릭한 폴더가 대상이라 경로를 받는다(0.69.0).
   */
  private async makeDirIn(parent: string): Promise<void> {
    const name = await textPrompt(`새 폴더 이름 (${baseName(parent) || parent} 안)`, "", "만들기");
    if (!name) return;
    try {
      const target = joinPath(parent, name);
      if (this.side === "local") await localMkdir(target);
      else await sftpMkdir(this.ctx.getSftpId(), target);
      // 만든 자리가 화면에 보이도록: 보고 있는 폴더면 목록을, 아니면 트리를 갱신한다.
      if (parent === this.path) await this.reload();
      else await this.tree.reveal(parent, true);
    } catch (e) {
      this.ctx.setStatus(`폴더 생성 실패: ${String(e)}`);
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
      else await sftpRename(this.ctx.getSftpId(), entry.path, target);
      await this.reload();
    } catch (e) {
      this.ctx.setStatus(`이름 변경 실패: ${String(e)}`);
    }
  }

  private async removeSelected(): Promise<void> {
    const targets = this.entries.filter((x) => this.selected.has(x.path));
    if (targets.length === 0) return;
    // 폴더는 **안에 든 것까지** 지운다 — 되돌릴 수 없으므로 무엇이 걸려 있는지 밝힌다.
    // 예전에는 원격 폴더가 아예 지워지지 않아(빈 폴더만 지우는 규격) 이 경고가 필요
    // 없었지만, 0.89.1 부터 실제로 지워진다.
    const dirs = targets.filter((t) => t.isDir);
    const detail = dirs.length
      ? `폴더 ${dirs.length}개는 안에 든 파일까지 함께 지워집니다: ${dirs
          .map((d) => d.name)
          .slice(0, 5)
          .join(", ")}${dirs.length > 5 ? " 외" : ""}`
      : "";
    const ok = await confirmDialog(`${targets.length}개 항목을 삭제할까요?`, {
      ok: "삭제",
      cancel: "취소",
      detail,
      defaultCancel: dirs.length > 0, // 폴더가 섞이면 Enter 가 삭제를 고르지 않게
    });
    if (!ok) return;

    let done = 0;
    const failed: string[] = [];
    for (const t of targets) {
      try {
        if (this.side === "local") await localRemove(t.path, t.isDir);
        else await sftpRemove(this.ctx.getSftpId(), t.path, t.isDir);
        done++;
      } catch (e) {
        // 하나가 막혀도 나머지는 계속 지운다. 결과는 마지막에 한 번만 알린다 —
        // 예전에는 항목마다 상태줄을 덮어써서 무엇이 실패했는지 남지 않았다.
        failed.push(`${t.name}(${String(e).slice(0, 60)})`);
      }
    }
    await this.reload();
    this.ctx.setStatus(
      failed.length === 0
        ? `${done}개 삭제`
        : `${done}개 삭제 · 실패 ${failed.length}개 — ${failed.join(", ")}`,
    );
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
  /** 회귀 검사용 — '열기' 를 밖에서 부른다(창 안 클로저라 이 통로가 없으면 검증 불가). */
  openForTest(entry: Entry): Promise<void> {
    return this.open(entry);
  }

  private async open(entry: Entry): Promise<void> {
    if (entry.isDir) {
      await this.go(entry.path);
      return;
    }
    if (this.side === "local") {
      try {
        await openPath(entry.path);
      } catch (e) {
        this.ctx.setStatus(`열기 실패: ${String(e)}`);
      }
      return;
    }
    if (!this.ctx.getSftpId()) {
      this.ctx.setStatus("원격에 접속되지 않았습니다.");
      return;
    }
    if (this.ctx.xfer.transferring) {
      this.ctx.setStatus("전송 중입니다. 끝난 뒤 다시 시도하세요.");
      return;
    }
    // 원격 파일명은 서버가 준 값 — 경로 구분자/상위(..)를 걸러 임시폴더 밖으로 새지 않게 한다.
    const rawName = baseName(entry.name).replace(/[\\/]/g, "_");
    const safeName = rawName === "" || rawName === "." || rawName === ".." ? "download" : rawName;
    this.ctx.xfer.transferring = true; // 동시 전송/열기 방지 — this.ctx.xfer.current 가 뒤섞이지 않게
    this.ctx.xfer.cancelled = false;
    try {
      this.ctx.setStatus(`여는 중… ${entry.name}`);
      const dir = await localTempDir();
      const localPath = joinPath(dir.replace(/\\+$/, ""), safeName);
      const transferId = crypto.randomUUID();
      this.ctx.setTransfer(transferId);
      this.ctx.showProgress(entry.name, 0, entry.size);
      await sftpDownload(this.ctx.getSftpId(), entry.path, localPath, transferId);
      this.ctx.setTransfer(null);
      this.ctx.hideProgress();
      await openPath(localPath);
      // 편집 감시 시작(0.67.0) — 이 임시본을 고쳐 저장하면 서버로 되올린다.
      this.ctx.watchEdit(localPath, entry.path, entry.name);
      this.ctx.setStatus(`열었습니다 — 저장하면 서버에 반영됩니다: ${entry.name}`);
    } catch (e) {
      this.ctx.setTransfer(null);
      this.ctx.hideProgress();
      this.ctx.setStatus(`열기 실패: ${String(e)}`);
    } finally {
      this.ctx.xfer.transferring = false;
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
      void this.ctx.transferInto(this.other, paths);
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
      // 같은 패널 안 이동도 되므로 복사·이동 둘 다 허용으로 알린다.
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
    });

    // 폴더 행은 드롭을 받는다(0.87.0) — 같은 패널 안에서 그 폴더로 옮긴다.
    // 파일 행은 받지 않는다(파일 안으로 넣을 자리가 없다).
    if (entry.isDir) {
      const sameSide = (e: DragEvent): boolean => {
        const raw = e.dataTransfer?.getData("application/x-sshtool");
        // dragover 에서는 getData 가 빈 문자열이라 타입 존재만으로 판단한다.
        if (!raw) return (e.dataTransfer?.types ?? []).includes("application/x-sshtool");
        try {
          return (JSON.parse(raw) as { side: Side }).side === this.side;
        } catch {
          return false;
        }
      };
      el.addEventListener("dragover", (e) => {
        if (hasOsFiles(e) || !sameSide(e)) return; // 탐색기 드롭은 목록 전체가 받는다
        e.preventDefault();
        e.stopPropagation(); // 목록(현재 폴더) 드롭이 대신 처리하지 않게
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        el.classList.add("drop-target");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
      el.addEventListener("drop", (e) => {
        el.classList.remove("drop-target");
        if (hasOsFiles(e)) return;
        const raw = e.dataTransfer?.getData("application/x-sshtool");
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          const payload = JSON.parse(raw) as { side: Side; paths: string[] };
          if (payload.side !== this.side) return; // 반대 패널에서 온 것은 전송이 맡는다
          void this.moveInto(entry.path, payload.paths);
        } catch {
          /* 무시 */
        }
      });
    }
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
      items.push({
        label:
          (this.side === "local" ? "업로드 →" : "← 다운로드") +
          (count > 1 ? ` (${count}개)` : ""),
        accel: "t",
        action: () => void this.ctx.transferInto(this.other, [...this.selected]),
      });
      // 좌측(로컬) 패널을 옮겨 다닐 필요 없이 바탕화면 등 원하는 곳으로 바로 받는다.
      if (this.side === "remote") {
        items.push({
          label: "폴더 지정해 다운로드…" + (count > 1 ? ` (${count}개)` : ""),
          accel: "g",
          action: () =>
            void this.ctx.downloadToPicked(this.entries.filter((en) => this.selected.has(en.path))),
        });
      }
      items.push(
        { separator: true },
        { label: "이름 변경", accel: "r", hint: "F2", action: () => void this.rename(entry) },
        { label: "새 폴더", accel: "n", action: () => void this.makeDir() },
        { label: "새로고침", accel: "f", hint: "F5", action: () => void this.reload() },
        { separator: true },
        {
          label: "삭제" + (count > 1 ? ` (${count}개)` : ""),
          accel: "d",
          hint: "Del",
          danger: true,
          action: () => void this.removeSelected(),
        },
      );
      showContextMenu(e.clientX, e.clientY, items);
    });
    return el;
  }
}

