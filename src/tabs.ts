// 다중 탭 터미널 관리. 각 탭 = xterm 인스턴스 하나 + 하나의 live SSH 세션.
// 백엔드는 이미 세션을 id 로 다중 관리하므로(SessionMap), 프론트는 tab↔liveId 를 잇는다.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SessionInfo } from "./types";
import {
  sshConnect,
  sshWrite,
  sshResize,
  sshClose,
  onSshData,
  onSshClosed,
} from "./ipc";

type PromptPassword = (s: SessionInfo) => Promise<string | null>;

const TERM_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
};

/** 탭 하나 = 터미널 뷰 + 상태. 접속/재접속 로직은 TabManager 가 구동한다. */
class TerminalTab {
  readonly key = crypto.randomUUID();
  session: SessionInfo;
  liveId: string | null = null;
  status: "connecting" | "connected" | "disconnected" = "connecting";

  readonly root: HTMLDivElement;
  private readonly termHost: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit: FitAddon;

  constructor(session: SessionInfo, onInput: (bytes: Uint8Array) => void, onResize: () => void) {
    this.session = session;

    this.root = document.createElement("div");
    this.root.className = "term-pane";

    this.termHost = document.createElement("div");
    this.termHost.className = "term-host";
    this.root.appendChild(this.termHost);

    this.overlay = document.createElement("div");
    this.overlay.className = "term-overlay";
    this.root.appendChild(this.overlay);

    this.term = new Terminal({
      fontFamily: "Consolas, D2Coding, monospace",
      fontSize: 14,
      cursorBlink: true,
      theme: TERM_THEME,
      scrollback: 5000,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.termHost);

    this.term.onData((d) => onInput(new TextEncoder().encode(d)));
    this.term.onResize(() => onResize());
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }

  fitNow(): void {
    // 숨겨진(display:none) 탭은 크기가 0 이라 fit 이 어긋난다 — 활성 탭만 호출.
    try {
      this.fit.fit();
    } catch {
      /* 아직 레이아웃 전 */
    }
  }

  focus(): void {
    this.term.focus();
  }

  writeBytes(data: number[]): void {
    this.term.write(new Uint8Array(data));
  }

  setConnecting(): void {
    this.status = "connecting";
    this.overlay.style.display = "flex";
    this.overlay.innerHTML = `<div class="overlay-msg">접속 중…</div>`;
  }

  setConnected(liveId: string): void {
    this.status = "connected";
    this.liveId = liveId;
    this.overlay.style.display = "none";
    this.overlay.innerHTML = "";
  }

  setDisconnected(message: string, onReconnect: () => void): void {
    this.status = "disconnected";
    this.liveId = null;
    this.term.writeln(`\r\n\x1b[33m[세션 종료] ${message}\x1b[0m`);
    this.overlay.style.display = "flex";
    this.overlay.innerHTML = "";
    const box = document.createElement("div");
    box.className = "overlay-box";
    const msg = document.createElement("div");
    msg.className = "overlay-msg";
    msg.textContent = message;
    const btn = document.createElement("button");
    btn.className = "btn-accent";
    btn.textContent = "재접속";
    btn.addEventListener("click", onReconnect);
    box.append(msg, btn);
    this.overlay.appendChild(box);
  }

  dispose(): void {
    this.term.dispose();
    this.root.remove();
  }
}

/** 탭 모음 + 탭바 DOM + 활성 탭 + 전역 SSH 이벤트 디스패치. */
export class TabManager {
  private readonly tabs: TerminalTab[] = [];
  private readonly byLiveId = new Map<string, TerminalTab>();
  private active: TerminalTab | null = null;

  constructor(
    private readonly tabbar: HTMLElement,
    private readonly panes: HTMLElement,
    private readonly emptyState: HTMLElement,
    private readonly promptPassword: PromptPassword,
    private readonly confirmClose: (name: string) => Promise<boolean>,
  ) {
    void onSshData((e) => this.byLiveId.get(e.id)?.writeBytes(e.data));
    void onSshClosed((e) => {
      const tab = this.byLiveId.get(e.id);
      if (!tab) return;
      this.byLiveId.delete(e.id);
      tab.setDisconnected(e.message, () => void this.reconnect(tab));
      this.renderTabbar();
    });

    window.addEventListener("resize", () => this.fitActive());
  }

  /** 저장 세션(또는 임시 세션)으로 새 탭을 열고 접속한다. */
  async openSession(session: SessionInfo): Promise<void> {
    const pw = await this.promptPassword(session);
    if (pw === null) return; // 취소

    const tab = new TerminalTab(
      session,
      (bytes) => {
        if (tab.liveId) void sshWrite(tab.liveId, bytes);
      },
      () => {
        if (tab.liveId) void sshResize(tab.liveId, tab.cols, tab.rows);
      },
    );
    this.tabs.push(tab);
    this.panes.appendChild(tab.root);
    this.activate(tab);
    this.renderTabbar();
    await this.doConnect(tab, pw);
  }

  private async reconnect(tab: TerminalTab): Promise<void> {
    const pw = await this.promptPassword(tab.session);
    if (pw === null) return;
    this.activate(tab);
    await this.doConnect(tab, pw);
  }

  private async doConnect(tab: TerminalTab, password: string): Promise<void> {
    tab.setConnecting();
    this.renderTabbar();
    tab.fitNow();
    try {
      const liveId = await sshConnect({
        host: tab.session.host,
        port: tab.session.port,
        user: tab.session.user,
        password,
        cols: tab.cols,
        rows: tab.rows,
      });
      tab.setConnected(liveId);
      this.byLiveId.set(liveId, tab);
      tab.focus();
    } catch (e) {
      tab.setDisconnected(`접속 실패: ${String(e)}`, () => void this.reconnect(tab));
    }
    this.renderTabbar();
  }

  private activate(tab: TerminalTab): void {
    this.active = tab;
    for (const t of this.tabs) t.root.classList.toggle("active", t === tab);
    this.emptyState.style.display = this.tabs.length ? "none" : "flex";
    this.renderTabbar();
    // 활성화 직후 레이아웃 확정 → fit + 리사이즈 통지.
    requestAnimationFrame(() => {
      tab.fitNow();
      if (tab.liveId) void sshResize(tab.liveId, tab.cols, tab.rows);
      tab.focus();
    });
  }

  private fitActive(): void {
    const tab = this.active;
    if (!tab) return;
    tab.fitNow();
    if (tab.liveId) void sshResize(tab.liveId, tab.cols, tab.rows);
  }

  private async closeTab(tab: TerminalTab): Promise<void> {
    // 연결이 살아있을 때만 확인을 묻는다(이미 끊긴 탭은 그냥 닫음).
    if (tab.status === "connected") {
      const ok = await this.confirmClose(tab.session.name || tab.session.host);
      if (!ok) return;
    }
    if (tab.liveId) {
      void sshClose(tab.liveId);
      this.byLiveId.delete(tab.liveId);
    }
    const idx = this.tabs.indexOf(tab);
    if (idx >= 0) this.tabs.splice(idx, 1);
    tab.dispose();

    if (this.active === tab) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      if (next) this.activate(next);
      else {
        this.active = null;
        this.emptyState.style.display = "flex";
      }
    }
    this.renderTabbar();
  }

  private renderTabbar(): void {
    this.tabbar.innerHTML = "";
    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab === this.active ? " active" : "");

      const dot = document.createElement("span");
      dot.className = "tab-dot " + tab.status;

      const label = document.createElement("span");
      label.className = "tab-label";
      // 탭 이름은 좌측 세션 이름으로 고정(WPF 피드백) — 셸이 바꾸지 않음.
      label.textContent = tab.session.name || `${tab.session.user}@${tab.session.host}`;

      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "닫기";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void this.closeTab(tab);
      });

      el.append(dot, label, close);
      el.addEventListener("click", () => this.activate(tab));
      el.addEventListener("mousedown", (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          void this.closeTab(tab); // 휠 클릭 = 닫기
        }
      });
      this.tabbar.appendChild(el);
    }
  }
}
