import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const hostEl = $<HTMLInputElement>("host");
const portEl = $<HTMLInputElement>("port");
const userEl = $<HTMLInputElement>("user");
const passEl = $<HTMLInputElement>("pass");
const connectBtn = $<HTMLButtonElement>("connect");
const statusEl = $<HTMLSpanElement>("status");

// ── Terminal ──────────────────────────────────────────────────────────────
const term = new Terminal({
  fontFamily: "Consolas, monospace",
  fontSize: 14,
  cursorBlink: true,
  theme: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($("term"));
fit.fit();

// ── Session state ─────────────────────────────────────────────────────────
let id: string | null = null;

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", error);
}

async function connect(): Promise<void> {
  if (id) return; // already connected
  const host = hostEl.value.trim();
  const port = Number(portEl.value) || 22;
  const user = userEl.value.trim();
  const password = passEl.value;

  if (!host || !user) {
    setStatus("호스트와 사용자를 입력하세요.", true);
    return;
  }

  setStatus("접속 중…");
  connectBtn.disabled = true;
  fit.fit();
  try {
    id = await invoke<string>("ssh_connect", {
      host,
      port,
      user,
      password,
      cols: term.cols,
      rows: term.rows,
    });
    setStatus(`접속됨 (${host})`);
    term.focus();
  } catch (e) {
    id = null;
    setStatus(`접속 실패: ${String(e)}`, true);
    connectBtn.disabled = false;
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────
connectBtn.addEventListener("click", () => void connect());
for (const el of [hostEl, portEl, userEl, passEl]) {
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void connect();
  });
}

term.onData((d) => {
  if (id === null) return;
  void invoke("ssh_write", {
    id,
    data: Array.from(new TextEncoder().encode(d)),
  });
});

term.onResize(({ cols, rows }) => {
  if (id === null) return;
  void invoke("ssh_resize", { id, cols, rows });
});

void listen<{ id: string; data: number[] }>("ssh://data", (e) => {
  if (e.payload.id === id) {
    term.write(new Uint8Array(e.payload.data));
  }
});

void listen<{ id: string; message: string }>("ssh://closed", (e) => {
  if (e.payload.id !== id) return;
  term.writeln(`\r\n\x1b[33m[세션 종료] ${e.payload.message}\x1b[0m`);
  id = null;
  connectBtn.disabled = false;
  setStatus("연결 끊김", true);
});

// ── Resize handling ───────────────────────────────────────────────────────
window.addEventListener("resize", () => {
  fit.fit();
  if (id !== null) void invoke("ssh_resize", { id, cols: term.cols, rows: term.rows });
});

// ── Auto update (best-effort, silent on failure) ──────────────────────────
async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    const ok = confirm(
      `새 버전 ${update.version} 이(가) 있습니다. 지금 설치할까요?`,
    );
    if (!ok) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch {
    // 무업데이트/오프라인/플러그인 미구성 등은 조용히 무시
  }
}

void checkForUpdates();
