// SFTP 파일 브라우저 오버레이. 원격 디렉터리 탐색 + 다운로드/업로드/새폴더/이름변경/삭제.
// 로컬 경로 선택은 tauri-plugin-dialog(open/save)로, 실제 파일 I/O 는 백엔드가 수행.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { SessionInfo } from "./types";
import {
  sftpConnect,
  sftpList,
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpDisconnect,
  type SftpEntry,
} from "./ipc";
import { confirmDialog, textPrompt } from "./dialogs";

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;

function parentOf(path: string): string {
  const p = path.replace(/\/+$/, "");
  const cut = p.lastIndexOf("/");
  if (cut < 0) return "."; // 상대 홈에서 더 위로는 가지 않음(절대경로는 직접 입력)
  if (cut === 0) return "/"; // "/etc" → "/"
  return p.slice(0, cut);
}

const joinPath = (dir: string, name: string): string =>
  dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;

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

/** 세션 하나에 대한 SFTP 브라우저 오버레이를 띄운다. password 는 SFTP 전용 연결 인증에 사용. */
export async function openSftpBrowser(session: SessionInfo, password: string): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "sftp-overlay";

  const panel = document.createElement("div");
  panel.className = "sftp-panel";
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const setBusy = (msg: string) => {
    status.textContent = msg;
  };

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

  // ── 툴바 ──
  const toolbar = document.createElement("div");
  toolbar.className = "sftp-toolbar";
  const upBtn = mkBtn("↑ 상위");
  const refreshBtn = mkBtn("⟳ 새로고침");
  const mkdirBtn = mkBtn("＋ 새 폴더");
  const uploadBtn = mkBtn("⬆ 업로드");
  const pathInput = document.createElement("input");
  pathInput.className = "sftp-path";
  toolbar.append(upBtn, refreshBtn, mkdirBtn, uploadBtn, pathInput);

  // ── 목록 ──
  const listEl = document.createElement("div");
  listEl.className = "sftp-list";

  panel.append(header, toolbar, listEl);

  let id: string | null = null;
  let cwd = ".";

  const cleanup = () => {
    if (id) void sftpDisconnect(id);
    overlay.remove();
  };
  closeBtn.addEventListener("click", cleanup);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) cleanup();
  });

  async function navigate(path: string): Promise<void> {
    if (!id) return;
    setBusy("불러오는 중…");
    try {
      const entries = await sftpList(id, path);
      cwd = path;
      pathInput.value = path;
      renderList(entries);
      setBusy(`${entries.length}개 항목`);
    } catch (e) {
      setBusy(`오류: ${String(e)}`);
    }
  }

  function renderList(entries: SftpEntry[]): void {
    listEl.innerHTML = "";
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      listEl.appendChild(row(entry));
    }
  }

  function row(entry: SftpEntry): HTMLElement {
    const el = document.createElement("div");
    el.className = "sftp-row";

    const icon = document.createElement("span");
    icon.className = "sftp-icon";
    icon.textContent = entry.isDir ? "📁" : "📄";

    const name = document.createElement("span");
    name.className = "sftp-name";
    name.textContent = entry.name;

    const size = document.createElement("span");
    size.className = "sftp-size";
    size.textContent = entry.isDir ? "" : fmtSize(entry.size);

    const time = document.createElement("span");
    time.className = "sftp-time";
    time.textContent = fmtTime(entry.modified);

    const actions = document.createElement("span");
    actions.className = "sftp-actions";
    if (!entry.isDir) {
      const dl = mkAct("⬇", "다운로드");
      dl.addEventListener("click", (e) => {
        e.stopPropagation();
        void download(entry);
      });
      actions.appendChild(dl);
    }
    const ren = mkAct("✎", "이름 변경");
    ren.addEventListener("click", (e) => {
      e.stopPropagation();
      void rename(entry);
    });
    const del = mkAct("🗑", "삭제");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void remove(entry);
    });
    actions.append(ren, del);

    el.append(icon, name, size, time, actions);
    if (entry.isDir) {
      el.classList.add("is-dir");
      el.addEventListener("dblclick", () => void navigate(entry.path));
    }
    return el;
  }

  async function download(entry: SftpEntry): Promise<void> {
    const local = await saveDialog({ defaultPath: entry.name });
    if (!local) return;
    setBusy(`다운로드 중: ${entry.name}`);
    try {
      await sftpDownload(id!, entry.path, local);
      setBusy(`다운로드 완료: ${entry.name}`);
    } catch (e) {
      setBusy(`다운로드 실패: ${String(e)}`);
    }
  }

  async function upload(): Promise<void> {
    const picked = await openDialog({ multiple: false });
    if (!picked || Array.isArray(picked)) {
      if (Array.isArray(picked) && picked.length === 0) return;
      if (!picked) return;
    }
    const local = Array.isArray(picked) ? picked[0] : picked;
    const remote = joinPath(cwd, basename(local));
    setBusy(`업로드 중: ${basename(local)}`);
    try {
      await sftpUpload(id!, local, remote);
      await navigate(cwd);
      setBusy(`업로드 완료: ${basename(local)}`);
    } catch (e) {
      setBusy(`업로드 실패: ${String(e)}`);
    }
  }

  async function mkdir(): Promise<void> {
    const name = await textPrompt("새 폴더 이름", "", "만들기");
    if (!name) return;
    try {
      await sftpMkdir(id!, joinPath(cwd, name));
      await navigate(cwd);
    } catch (e) {
      setBusy(`폴더 생성 실패: ${String(e)}`);
    }
  }

  async function rename(entry: SftpEntry): Promise<void> {
    const next = await textPrompt("이름 변경", entry.name, "변경");
    if (!next || next === entry.name) return;
    try {
      await sftpRename(id!, entry.path, joinPath(parentOf(entry.path), next));
      await navigate(cwd);
    } catch (e) {
      setBusy(`이름 변경 실패: ${String(e)}`);
    }
  }

  async function remove(entry: SftpEntry): Promise<void> {
    const ok = await confirmDialog(`'${entry.name}'${entry.isDir ? " 폴더" : ""}를 삭제할까요?`);
    if (!ok) return;
    try {
      await sftpRemove(id!, entry.path, entry.isDir);
      await navigate(cwd);
    } catch (e) {
      setBusy(`삭제 실패: ${String(e)}`);
    }
  }

  upBtn.addEventListener("click", () => void navigate(parentOf(cwd)));
  refreshBtn.addEventListener("click", () => void navigate(cwd));
  mkdirBtn.addEventListener("click", () => void mkdir());
  uploadBtn.addEventListener("click", () => void upload());
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void navigate(pathInput.value.trim() || ".");
  });

  // ── 연결 ──
  setBusy("접속 중…");
  try {
    id = await sftpConnect(session.host, session.port, session.user, password);
    await navigate(".");
  } catch (e) {
    setBusy(`SFTP 접속 실패: ${String(e)}`);
  }
}

function mkBtn(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "sftp-btn";
  b.textContent = label;
  return b;
}

function mkAct(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "sftp-act";
  b.textContent = label;
  b.title = title;
  return b;
}
