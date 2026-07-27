// 다중 탭 터미널 관리. 각 탭 = xterm 인스턴스 하나 + 하나의 live SSH 세션.
// 설정(테마·폰트·크기·커서·스크롤백) 적용, 선택→자동복사+토스트, 우클릭 복사/붙여넣기,
// 검색(Ctrl+Shift+F), Ctrl+휠 zoom, Ctrl+Enter=LF, 탭 상태색, 탭 단축키, 상태바 연동.

import { Terminal } from "@xterm/xterm";
import { applyIcon } from "./icons";
import { showContextMenu } from "./contextmenu";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import type { SessionInfo } from "./types";
import type { Settings } from "./settings";
import { fontStack } from "./settings";
import { themeById } from "./themes";
import {
  sshConnect,
  sshWrite,
  sshResize,
  sshClose,
  localOpen,
  localWrite,
  localResize,
  localClose,
  onSshData,
  onSshClosed,
  imeSetEnglish,
} from "./ipc";

/** 세션 종류에 따라 전송 경로를 고른다(로컬 셸도 이벤트는 SSH 와 동일). */
const isLocal = (s: SessionInfo): boolean => s.kind === "local";
const writeTo = (s: SessionInfo, id: string, bytes: Uint8Array): Promise<void> =>
  isLocal(s) ? localWrite(id, bytes) : sshWrite(id, bytes);
const resizeTo = (s: SessionInfo, id: string, cols: number, rows: number): Promise<void> =>
  isLocal(s) ? localResize(id, cols, rows) : sshResize(id, cols, rows);
const closeOf = (s: SessionInfo, id: string): Promise<void> =>
  isLocal(s) ? localClose(id) : sshClose(id);

/** 접속에 쓸 자격증명 + 사용자가 직접 입력했는지 여부(저장 제안용). */
export interface ResolvedCreds {
  user: string;
  password: string;
  /** true 면 이번에 프롬프트로 입력받은 것(저장 여부를 물어볼 대상). */
  prompted: boolean;
}

/** 자격증명 해결·저장 정책. 볼트 연동은 main.ts 가 구현(탭은 UI-비종속). */
export interface CredentialProvider {
  resolve(session: SessionInfo): Promise<ResolvedCreds | null>;
  onConnected(session: SessionInfo, creds: ResolvedCreds): Promise<void>;
  onError(session: SessionInfo, error: string): Promise<void>;
}

const LOCAL_CREDS: ResolvedCreds = { user: "", password: "", prompted: false };

export interface StatusInfo {
  label: string;
  state: "none" | "connecting" | "connected" | "disconnected";
  size: string;
  cursor: string;
  encoding: string; // 문자셋(charset)
  cipher: string; // 암호화 방식(원격 SSH 세션에만)
  /** 접속 유지시간(MM:SS 또는 HH:MM:SS). 접속 전이면 빈 문자열. */
  uptime: string;
}

/** 세션 화면 배치: 탭 / 세로 분할 / 가로 분할(WPF 0.20.0). */
export type ViewMode = "tabs" | "vertical" | "horizontal";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const LF = new Uint8Array([0x0a]);

/**
 * 트리거 발동 허용 창(ms). 접속 직후에만 발동시켜, 한참 뒤에 나타난 패턴 출력에는
 * 반응하지 않게 한다. 로그인·sudo 프롬프트는 접속 직후에 나오므로 정상 용도는 이 안에 든다.
 */
const TRIGGER_WINDOW_MS = 10_000;

/** 접속 유지시간 표기 — 1시간을 넘기면 HH:MM:SS, 그 전까지는 MM:SS. */
const formatUptime = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const mins = Math.floor(total / 60) % 60;
  const secs = total % 60;
  return hours > 0 ? `${pad(hours)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
};

/**
 * 트리거 매칭용으로 ANSI 제어 시퀀스를 제거한다. 컬러 프롬프트
 * (예: "\x1b[32mpassword:\x1b[0m")에서도 사용자가 눈으로 본 문자열로 매칭되게 한다.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[\]()#;?]*[0-9;]*[A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/** 탭 하나 = 터미널 뷰 + 상태. 접속/재접속 로직은 TabManager 가 구동한다. */
class TerminalTab {
  readonly key = crypto.randomUUID();
  session: SessionInfo;
  liveId: string | null = null;
  status: "connecting" | "connected" | "disconnected" = "connecting";
  activity = false; // 비활성 탭에 출력이 도착하면 true(호박색)
  /** 셸이 열린 시각(ms). null = 아직 접속된 적 없음. 접속 유지시간의 기준점. */
  connectedAt: number | null = null;
  /** 끊긴 시각(ms). null = 접속 유지 중. 값이 있으면 유지시간이 여기서 멈춘다. */
  disconnectedAt: number | null = null;
  /** 발동 창을 벗어나 규칙을 건너뛴 사실을 이미 알렸는지(세션당 1회만 안내). */
  private triggerWindowNotified = false;

  readonly root: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly headerLabel: HTMLDivElement;
  readonly headerClose: HTMLButtonElement;
  private readonly termHost: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private readonly searchBar: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly search: SearchAddon;
  private settings: Settings;
  /** 이 세션의 글자 크기(0 = 전역 설정 따름). Ctrl+휠/±로 조절, 세션에 저장된다. */
  private sessionFontSize = 0;
  private toastTimer = 0;
  private searchOpen = false;
  private triggerBuf = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly lastFired = new Map<string, number>();

  constructor(
    session: SessionInfo,
    settings: Settings,
    private readonly onInput: (bytes: Uint8Array) => void,
    onResize: () => void,
    private readonly onActive: () => void,
    private readonly onFontSize: (size: number) => void = () => {},
  ) {
    this.session = session;
    this.settings = settings;
    this.sessionFontSize = session.fontSize > 0 ? session.fontSize : 0;

    this.root = el("div", "term-pane");
    // 타일(분할) 모드에서만 보이는 헤더 — 세션명 + 닫기(WPF 0.45.3).
    this.header = el("div", "pane-header");
    this.headerLabel = el("span", "pane-header-label");
    this.headerClose = document.createElement("button");
    this.headerClose.className = "pane-header-close";
    this.headerClose.textContent = "×";
    this.headerClose.title = "닫기";
    this.header.append(this.headerLabel, this.headerClose);
    this.termHost = el("div", "term-host");
    this.overlay = el("div", "term-overlay");
    this.toast = el("div", "term-toast");
    this.toast.style.display = "none";
    this.searchBar = el("div", "term-search");
    this.searchBar.style.display = "none";
    this.searchInput = document.createElement("input");
    this.searchInput.placeholder = "검색 (Enter/F3, Shift+F3 역방향, Esc 닫기)";
    this.searchBar.appendChild(this.searchInput);
    this.root.append(this.header, this.termHost, this.overlay, this.toast, this.searchBar);
    this.headerLabel.textContent = session.name || `${session.user}@${session.host}`;

    const theme = themeById(settings.theme);
    this.term = new Terminal({
      fontFamily: fontStack(settings.fontFamily),
      fontSize: session.fontSize > 0 ? session.fontSize : settings.fontSize,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      theme: theme.term,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon());
    const uni = new Unicode11Addon();
    this.term.loadAddon(uni);
    this.term.unicode.activeVersion = "11";
    this.term.open(this.termHost);
    // 행 높이가 컨테이너에 딱 안 떨어질 때 하단에 남는 잔여 영역이 검게 비치는 걸 막는다
    // — 컨테이너 배경을 터미널 배경색과 같게 칠해 눈에 띄지 않게 한다(글자 크기 무관).
    this.termHost.style.background = theme.term.background ?? "";

    this.term.onData((d) => onInput(new TextEncoder().encode(d)));
    this.term.onResize(() => onResize());

    this.wireInput(onInput);
    this.wireSearch();
  }

  // ── 입력/복사/붙여넣기/줌 ──
  private wireInput(onInput: (bytes: Uint8Array) => void): void {
    // Ctrl+Enter 의 LF 를 항상 '지연' 전송한다. 한글 조합이 확정될 때 xterm 은 확정 문자를
    // setTimeout(0) 으로 보내므로, LF 도 setTimeout(0) 으로 미뤄야 "문자 → 개행" 순서가 지켜진다.
    // (동기로 보내면 IME 가 229 keydown→compositionend→실제 Enter keydown 순서를 낼 때
    //  실제 Enter keydown 이 문자보다 먼저 LF 를 쏴 마지막 글자가 다음 줄로 밀린다.)
    // 여러 keydown 이 겹치는 IME 모델에서 LF 가 두 번 나가지 않도록 짧은 시간 창으로 1회만 보낸다.
    const sendCtrlEnterLf = () => {
      const now = performance.now();
      if (now - this.lastCtrlEnterLf < 50) return;
      this.lastCtrlEnterLf = now;
      setTimeout(() => onInput(LF), 0);
    };

    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const ctrl = e.ctrlKey;
      const stop = () => {
        e.preventDefault(); // false 반환만으론 webview 확대 등 기본동작이 남음
        return false;
      };

      // Ctrl+Enter = 줄바꿈(제출 없이 다중행 입력, claude CLI 등).
      if (ctrl && e.key === "Enter") {
        if (e.isComposing || e.keyCode === 229) {
          // 조합 중: IME 확정 흐름을 방해하지 않고 compositionend 에서 LF 를 지연 전송.
          this.pendingCompositionLf = true;
          return true; // preventDefault 안 함(CR 은 xterm 이 조합 중 억제)
        }
        // 비조합(영문 또는 229-모델의 실제 Enter keydown): LF 를 지연 전송해 확정 문자 뒤에 오게.
        sendCtrlEnterLf();
        return stop();
      }

      // 그 밖의 키는 IME(한글 등) 조합 중에는 가로채지 않는다.
      if (e.isComposing || e.keyCode === 229) return true;
      if (ctrl && e.shiftKey && (e.key === "F" || e.key === "f")) {
        this.openSearch();
        return stop();
      }
      if (this.searchOpen && e.key === "F3") {
        e.shiftKey ? this.searchPrev() : this.searchNext();
        return stop();
      }
      if (ctrl && !e.shiftKey && (e.key === "c" || e.key === "C") && this.term.hasSelection()) {
        void this.copySelection();
        return stop();
      }
      if (ctrl && e.key === "Insert") {
        if (this.term.hasSelection()) void this.copySelection();
        return stop();
      }
      if (e.shiftKey && e.key === "Insert") {
        void this.pasteClipboard();
        return stop();
      }
      if (e.shiftKey && !ctrl && (e.key === "PageUp" || e.key === "PageDown")) {
        // 스크롤백 페이지 이동(전체화면 앱에 전달하지 않고 로컬 처리).
        if (e.key === "PageUp") this.term.scrollPages(-1);
        else this.term.scrollPages(1);
        return stop();
      }
      if (ctrl && e.key === "0") {
        this.setZoom(0);
        return stop();
      }
      if (ctrl && (e.key === "=" || e.key === "+")) {
        this.bumpZoom(1);
        return stop();
      }
      if (ctrl && (e.key === "-" || e.key === "_")) {
        this.bumpZoom(-1);
        return stop();
      }
      return true;
    });

    // 조합 중 눌린 Ctrl+Enter 는 여기(확정 시점)에서 LF 를 지연 전송한다.
    this.term.textarea?.addEventListener("compositionend", () => {
      if (this.pendingCompositionLf) {
        this.pendingCompositionLf = false;
        sendCtrlEnterLf();
      }
    });
    // 조합이 새로 시작되면 예약을 무효화 — 이전 Ctrl+Enter 가 조합을 끝내지 못한 경우
    // 다음 조합의 compositionend 에서 엉뚱한 LF 가 나가는 것을 막는다.
    this.term.textarea?.addEventListener("compositionstart", () => {
      this.pendingCompositionLf = false;
    });

    // 선택 후 놓으면 자동 복사(설정 시), xterm/PuTTY 방식.
    this.termHost.addEventListener("mouseup", (e) => {
      if (e.button === 0 && this.settings.copyOnSelect && this.term.hasSelection()) {
        void this.copySelection();
      }
    });
    // 우클릭 = 선택 있으면 복사, 없으면 붙여넣기(PuTTY 관례).
    this.termHost.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.term.hasSelection()) void this.copySelection();
      else void this.pasteClipboard();
    });
    // Ctrl+휠 zoom.
    this.termHost.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.bumpZoom(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  }

  private async copySelection(): Promise<void> {
    const text = this.term.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(`${text.length}자 복사됨`);
    } catch {
      /* 클립보드 접근 실패 무시 */
    }
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const t = await navigator.clipboard.readText();
      if (t) this.term.paste(t);
    } catch {
      /* 무시 */
    }
  }

  private showToast(msg: string): void {
    this.toast.textContent = msg;
    this.toast.style.display = "block";
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.style.display = "none";
    }, 1200);
  }

  /** 현재 적용 글자 크기 — 세션 지정값이 있으면 그것, 없으면 전역 설정. */
  private effectiveFontSize(): number {
    return this.sessionFontSize > 0 ? this.sessionFontSize : this.settings.fontSize;
  }
  private bumpZoom(d: number): void {
    this.sessionFontSize = clamp(this.effectiveFontSize() + d, 6, 40);
    this.applyFont();
    this.onFontSize(this.sessionFontSize); // 세션에 저장
  }
  private setZoom(v: number): void {
    // Ctrl+0 = 세션 지정 해제(전역 설정으로 복귀).
    this.sessionFontSize = v > 0 ? v : 0;
    this.applyFont();
    this.onFontSize(this.sessionFontSize);
  }
  private applyFont(): void {
    this.term.options.fontFamily = fontStack(this.settings.fontFamily);
    this.term.options.fontSize = this.effectiveFontSize();
    this.fitNow();
    this.onActive();
  }

  // ── 검색 ──
  private wireSearch(): void {
    this.searchInput.addEventListener("input", () => {
      if (this.searchInput.value) this.search.findNext(this.searchInput.value, { incremental: true });
      else this.search.clearDecorations();
    });
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "F3") {
        e.preventDefault();
        e.shiftKey ? this.searchPrev() : this.searchNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeSearch();
      }
    });
  }
  private openSearch(): void {
    this.searchOpen = true;
    this.searchBar.style.display = "flex";
    this.searchInput.focus();
    this.searchInput.select();
  }
  private closeSearch(): void {
    this.searchOpen = false;
    this.searchBar.style.display = "none";
    this.search.clearDecorations();
    this.term.focus();
  }
  private searchNext(): void {
    if (this.searchInput.value) this.search.findNext(this.searchInput.value);
  }
  private searchPrev(): void {
    if (this.searchInput.value) this.search.findPrevious(this.searchInput.value);
  }

  // ── 설정 적용 ──
  applySettings(s: Settings): void {
    this.settings = s;
    const t = this.term;
    t.options.fontFamily = fontStack(s.fontFamily);
    t.options.fontSize = this.effectiveFontSize();
    t.options.cursorBlink = s.cursorBlink;
    t.options.cursorStyle = s.cursorStyle;
    t.options.scrollback = s.scrollback;
    const term = themeById(s.theme).term;
    t.options.theme = term;
    this.termHost.style.background = term.background ?? ""; // 하단 잔여 영역 색 동기화
    this.fitNow();
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }
  cursorPos(): string {
    const b = this.term.buffer.active;
    return `${b.cursorY + 1},${b.cursorX + 1}`;
  }

  fitNow(): void {
    try {
      this.fit.fit();
    } catch {
      /* 아직 레이아웃 전 */
    }
  }
  focus(): void {
    this.term.focus();
    // 세션 첫 시작(첫 포커스) 시 1회만 IME 를 영문으로 전환한다(사용자 요청).
    // 이후 사용자가 한글로 바꾸면 그대로 존중 — 매 포커스마다 강제하지 않는다.
    if (!this.imeInitDone) {
      this.imeInitDone = true;
      setTimeout(() => void imeSetEnglish(), 80); // 포커스/IMC 안정 후
    }
  }
  private imeInitDone = false;
  private pendingCompositionLf = false; // Ctrl+Enter(조합 중) → compositionend 에서 LF 전송 예약
  private lastCtrlEnterLf = 0; // Ctrl+Enter LF 중복(이중 keydown) 방지용 타임스탬프
  writeBytes(data: number[]): void {
    const bytes = new Uint8Array(data);
    this.term.write(bytes);
    if (this.session.triggers.length) this.checkTriggers(bytes);
  }

  /** 접속 직후 자동 실행 명령(줄 단위)을 순서대로 전송. */
  sendStartupCommands(): void {
    const lines = this.session.startupCommands
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) this.sendText(`${line}\n`);
  }

  private sendText(text: string): void {
    this.onInput(new TextEncoder().encode(text));
  }

  /**
   * 수신 텍스트에서 패턴을 감지하면 지정 값을 자동 입력.
   * 최근 2000자만 보고, 규칙마다 1초 쿨다운을 둬 반복 폭주를 막는다.
   */
  private checkTriggers(bytes: Uint8Array): void {
    const text = stripAnsi(this.decoder.decode(bytes, { stream: true }));
    this.triggerBuf = (this.triggerBuf + text).slice(-2000);

    const now = Date.now();
    let fired = false;
    this.session.triggers.forEach((rule, i) => {
      if (!rule.pattern) return;
      // 쿨다운 키는 인덱스 — 패턴이 같은 두 규칙이 서로의 쿨다운을 먹지 않게 한다.
      const cooldownKey = `${i}:${rule.pattern}`;
      if (now - (this.lastFired.get(cooldownKey) ?? 0) < 1000) return;
      let hit = false;
      try {
        hit = rule.regex
          ? new RegExp(rule.pattern).test(this.triggerBuf)
          : this.triggerBuf.includes(rule.pattern);
      } catch {
        hit = false; // 잘못된 정규식은 무시
      }
      if (!hit) return;
      this.lastFired.set(cooldownKey, now);

      // 접속 직후 창을 벗어난 매칭은 전송하지 않는다. 조용히 무시하면 "왜 트리거가
      // 안 되지" 하고 원인을 찾기 어려우므로, 세션당 한 번은 이유를 알려 준다.
      if (this.connectedAt === null || now - this.connectedAt > TRIGGER_WINDOW_MS) {
        if (!this.triggerWindowNotified) {
          this.triggerWindowNotified = true;
          this.term.writeln(
            `\r\n\x1b[33m[트리거] 접속 후 ${TRIGGER_WINDOW_MS / 1000}초가 지나 규칙을 실행하지 않았습니다.\x1b[0m`,
          );
        }
        return;
      }

      fired = true;
      this.sendText(rule.send.replace(/\\n/g, "\n"));
    });

    // 버퍼 비우기는 루프가 끝난 뒤 한 번 — 루프 안에서 지우면 같은 출력에 걸린
    // 나머지 규칙들이 빈 버퍼를 보게 되어 영영 매칭되지 않는다.
    if (fired) this.triggerBuf = "";
  }

  /** 상태바용 접속 유지시간. 접속 전이면 빈 문자열, 끊긴 뒤엔 최종값에서 멈춘다. */
  uptimeText(): string {
    if (this.connectedAt === null) return "";
    return formatUptime((this.disconnectedAt ?? Date.now()) - this.connectedAt);
  }

  setConnecting(): void {
    this.status = "connecting";
    this.overlay.style.display = "flex";
    this.overlay.innerHTML = `<div class="overlay-msg">접속 중…</div>`;
  }
  setConnected(liveId: string): void {
    this.status = "connected";
    this.liveId = liveId;
    // 유지시간 기준은 셸이 열린 이 시점. 재접속이면 여기서 다시 0 부터 센다.
    this.connectedAt = Date.now();
    this.disconnectedAt = null;
    // 트리거 발동 창도 접속 시점 기준이므로 재접속 때 함께 초기화한다.
    this.triggerWindowNotified = false;
    this.overlay.style.display = "none";
    this.overlay.innerHTML = "";
  }
  setDisconnected(message: string, onReconnect: () => void): void {
    this.status = "disconnected";
    this.liveId = null;
    // 끊긴 시각을 박아 두면 이후 유지시간이 최종값에서 멈춘다.
    if (this.connectedAt !== null && this.disconnectedAt === null) {
      this.disconnectedAt = Date.now();
    }
    this.term.writeln(`\r\n\x1b[33m[세션 종료] ${message}\x1b[0m`);
    this.overlay.style.display = "flex";
    this.overlay.innerHTML = "";
    const box = el("div", "overlay-box");
    const msg = el("div", "overlay-msg");
    msg.textContent = message;
    const btn = document.createElement("button");
    btn.className = "btn-accent";
    btn.textContent = "재접속";
    btn.addEventListener("click", onReconnect);
    box.append(msg, btn);
    this.overlay.appendChild(box);
  }

  /** 닫힌 뒤 뒤늦게 도착한 접속 결과를 무시하기 위한 표시. */
  disposed = false;

  dispose(): void {
    this.disposed = true;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.term.dispose();
    this.root.remove();
  }
}

/** 탭 모음 + 탭바 DOM + 활성 탭 + 전역 SSH 이벤트 디스패치 + 상태바 연동. */
export class TabManager {
  private readonly tabs: TerminalTab[] = [];
  private readonly byLiveId = new Map<string, TerminalTab>();
  /** 아직 탭에 연결되기 전에 도착한 종료 이벤트(liveId → 사유). */
  private readonly pendingClosed = new Map<string, string>();
  /** 접속 응답보다 먼저 도착한 출력(포워딩 상태 배너 등)을 잠시 보관한다. */
  private readonly pendingData = new Map<string, number[][]>();
  private active: TerminalTab | null = null;
  private settings: Settings;
  private viewMode: ViewMode = "tabs";
  private refitPending = false;
  /** 탭 구성·접속 상태가 바뀔 때 알림받을 구독자(동시 명령 창 세션 수 등). */
  private readonly tabsChanged: Array<() => void> = [];

  constructor(
    private readonly tabbar: HTMLElement,
    private readonly panes: HTMLElement,
    private readonly emptyState: HTMLElement,
    private readonly credentials: CredentialProvider,
    private readonly confirmClose: (name: string) => Promise<boolean>,
    settings: Settings,
    private readonly onStatus: (info: StatusInfo) => void,
    private readonly onSessionFontSize: (session: SessionInfo, size: number) => void = () => {},
    /** 세션 탭 우클릭 → SFTP 파일 전송. 미주입 시 메뉴에 항목을 넣지 않는다. */
    private readonly onSftp?: (session: SessionInfo) => void,
  ) {
    this.settings = settings;

    // 접속 유지시간은 1초마다 값이 바뀌므로 상태바를 주기적으로 다시 내보낸다.
    // 실제로 흘러가는 경우(활성 탭이 접속 유지 중)에만 emit 해 불필요한 갱신을 막는다.
    window.setInterval(() => {
      const t = this.active;
      if (t && t.connectedAt !== null && t.disconnectedAt === null) this.emitStatus();
    }, 1000);

    void onSshData((e) => {
      const tab = this.byLiveId.get(e.id);
      if (!tab) {
        // 아직 이 id 가 탭에 연결되기 전 — 버려지지 않게 보관해 두었다가 연결 시 반영.
        const buf = this.pendingData.get(e.id) ?? [];
        buf.push(e.data);
        if (buf.length <= 200) this.pendingData.set(e.id, buf); // 폭주 방지 상한
        window.setTimeout(() => this.pendingData.delete(e.id), 10_000);
        return;
      }
      tab.writeBytes(e.data);
      if (tab !== this.active && !tab.activity) {
        tab.activity = true;
        this.renderTabbar();
      }
      if (tab === this.active) this.emitStatus();
    });
    void onSshClosed((e) => {
      const tab = this.byLiveId.get(e.id);
      if (!tab) {
        // 접속 응답(invoke)이 프론트에 도달하기 전에 세션이 죽은 경우 — 로컬 셸은
        // 즉시 종료될 수 있다. 나중에 등록될 때 처리하도록 잠시 보관한다.
        this.pendingClosed.set(e.id, e.message);
        window.setTimeout(() => this.pendingClosed.delete(e.id), 10_000);
        return;
      }
      this.byLiveId.delete(e.id);
      tab.setDisconnected(e.message, () => void this.reconnect(tab));
      this.renderTabbar();
      if (tab === this.active) this.emitStatus();
    });

    // 패널 영역 크기가 바뀌면 항상 터미널을 다시 맞춘다 — 창 리사이즈뿐 아니라
    // 동시명령 창 토글·사이드바 폭 조절처럼 window resize 가 안 뜨는 경우까지 커버.
    // (안 하면 줄어들었던 영역이 터미널 배경(검은색)으로 남는다.) rAF 로 합쳐 과호출 방지.
    const scheduleRefit = () => {
      if (this.refitPending) return;
      this.refitPending = true;
      requestAnimationFrame(() => {
        this.refitPending = false;
        this.fitActive();
      });
    };
    window.addEventListener("resize", scheduleRefit);
    new ResizeObserver(scheduleRefit).observe(this.panes);

    // 듀얼모니터에서 배율이 다른 화면으로 창을 옮기면 devicePixelRatio 가 바뀐다.
    // CSS 픽셀 크기가 그대로여도(→ ResizeObserver 안 뜸) 셀 계측이 어긋날 수 있으니
    // DPR 변화를 직접 감지해 refit. 미디어쿼리는 특정 배율에 고정돼 한 번 쓰고 재등록한다.
    const watchDpr = () => {
      window
        .matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        .addEventListener(
          "change",
          () => {
            scheduleRefit();
            watchDpr();
          },
          { once: true },
        );
    };
    watchDpr();

    document.addEventListener("keydown", (e) => {
      if (!e.ctrlKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        this.cycle(e.shiftKey ? -1 : 1);
      } else if (e.key === "F4") {
        e.preventDefault();
        if (this.active) void this.closeTab(this.active);
      } else if (e.key >= "1" && e.key <= "9") {
        const i = Number(e.key) - 1;
        if (this.tabs[i]) {
          e.preventDefault();
          this.activate(this.tabs[i]);
        }
      }
    });
  }

  /** 탭 / 세로 분할 / 가로 분할 전환. 세션·연결 상태는 그대로 유지된다. */
  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.layout();
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  /** 현재 뷰 모드에 맞춰 패널 배치를 갱신하고 모든 보이는 터미널을 다시 맞춘다. */
  private layout(focusActive = true): void {
    const tiled = this.viewMode !== "tabs";
    this.panes.classList.toggle("tile", tiled);
    this.panes.style.gridTemplateColumns = "";
    this.panes.style.gridTemplateRows = "";

    if (tiled) {
      const n = Math.max(1, this.tabs.length);
      // 3개까지는 한 줄, 그 이상은 2열로 접어 2×2 형태가 되게 한다.
      // 세로 분할: 3개까지는 한 줄, 4개부터는 정사각에 가깝게 접어 2×2 형태가 되게 한다.
      const cols =
        this.viewMode === "vertical"
          ? n <= 3
            ? n
            : Math.ceil(Math.sqrt(n))
          : Math.ceil(n / Math.min(n, 3));
      const rows = Math.ceil(n / cols);
      this.panes.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      this.panes.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    }

    for (const t of this.tabs) {
      // 타일 모드에서는 전부 보이고, 탭 모드에서는 활성 탭만 보인다.
      t.root.classList.toggle("visible", tiled || t === this.active);
      t.root.classList.toggle("focused", tiled && t === this.active);
    }
    this.emptyState.style.display = this.tabs.length ? "none" : "flex";

    requestAnimationFrame(() => {
      for (const t of this.tabs) {
        if (!tiled && t !== this.active) continue;
        t.fitNow();
        if (t.liveId) void resizeTo(t.session, t.liveId, t.cols, t.rows);
      }
      // 리사이즈로 인한 재배치에서는 포커스를 뺏지 않는다(검색창·명령창 입력 중 튐 방지).
      if (focusActive) this.active?.focus();
      this.emitStatus();
    });
  }

  /** 설정 변경 → 모든 터미널 + 상태바에 즉시 반영. */
  applySettings(s: Settings): void {
    this.settings = s;
    for (const t of this.tabs) t.applySettings(s);
    this.emitStatus();
  }

  async openSession(session: SessionInfo): Promise<void> {
    // 로컬 셸은 인증이 없다.
    const creds = isLocal(session) ? LOCAL_CREDS : await this.credentials.resolve(session);
    if (creds === null) return;

    const tab = new TerminalTab(
      session,
      this.settings,
      (bytes) => {
        if (tab.liveId) void writeTo(tab.session, tab.liveId, bytes);
      },
      () => {
        if (tab.liveId) void resizeTo(tab.session, tab.liveId, tab.cols, tab.rows);
        if (tab === this.active) this.emitStatus();
      },
      () => {
        if (tab === this.active) this.emitStatus();
      },
      (size) => this.onSessionFontSize(tab.session, size),
    );
    tab.headerClose.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.closeTab(tab);
    });
    // 타일 모드: 타일을 클릭하면 그 타일로 포커스 이동(WPF 0.45.3).
    tab.root.addEventListener("mousedown", () => {
      if (this.viewMode !== "tabs" && this.active !== tab) this.activate(tab);
    });
    this.tabs.push(tab);
    this.panes.appendChild(tab.root);
    this.activate(tab);
    this.renderTabbar();
    await this.doConnect(tab, creds);
  }

  broadcast(data: Uint8Array): number {
    let n = 0;
    for (const t of this.tabs) {
      if (t.liveId) {
        void writeTo(t.session, t.liveId, data);
        n++;
      }
    }
    return n;
  }
  sendActive(data: Uint8Array): boolean {
    if (this.active?.liveId) {
      void writeTo(this.active.session, this.active.liveId, data);
      return true;
    }
    return false;
  }
  connectedCount(): number {
    return this.tabs.filter((t) => t.liveId).length;
  }

  /**
   * 탭이 열리거나 닫힐 때, 접속 상태가 바뀔 때 호출된다.
   * 동시 명령 창처럼 connectedCount() 를 화면에 띄워 두는 쪽이 갱신 시점을 알기 위해 쓴다.
   */
  onTabsChanged(fn: () => void): void {
    this.tabsChanged.push(fn);
  }

  private cycle(dir: number): void {
    if (this.tabs.length < 2 || !this.active) return;
    const i = this.tabs.indexOf(this.active);
    const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length];
    this.activate(next);
  }

  private async reconnect(tab: TerminalTab): Promise<void> {
    const creds = isLocal(tab.session) ? LOCAL_CREDS : await this.credentials.resolve(tab.session);
    if (creds === null) return;
    this.activate(tab);
    await this.doConnect(tab, creds);
  }

  private async doConnect(tab: TerminalTab, creds: ResolvedCreds): Promise<void> {
    tab.setConnecting();
    this.renderTabbar();
    this.emitStatus();
    tab.fitNow();
    try {
      const liveId = isLocal(tab.session)
        ? await localOpen(
            tab.session.shellExe,
            tab.session.workingDir,
            tab.cols,
            tab.rows,
            tab.session.enableLog ? tab.session.name || "local" : null,
          )
        : await sshConnect({
        host: tab.session.host,
        port: tab.session.port,
        user: creds.user,
        password: creds.password,
        cols: tab.cols,
        rows: tab.rows,
        charset: tab.session.charset,
        logName: tab.session.enableLog ? tab.session.name || tab.session.host : null,
            portForwards: tab.session.portForwards,
            authType: tab.session.authType,
            privateKeyPath: tab.session.privateKeyPath,
            allowLegacyAlgorithms: tab.session.allowLegacyAlgorithms,
          });
      if (tab.disposed) {
        // 접속이 완료되기 전에 탭을 닫은 경우 — 세션이 새지 않도록 즉시 정리.
        void closeOf(tab.session, liveId);
        return;
      }
      tab.setConnected(liveId);
      this.byLiveId.set(liveId, tab);
      // 접속 응답보다 먼저 도착했던 출력(포워딩 배너 등)을 이제 반영한다.
      const earlyData = this.pendingData.get(liveId);
      if (earlyData) {
        this.pendingData.delete(liveId);
        for (const chunk of earlyData) tab.writeBytes(chunk);
      }
      // 접속 응답보다 먼저 도착했던 종료 이벤트가 있으면 지금 반영한다.
      const early = this.pendingClosed.get(liveId);
      if (early !== undefined) {
        this.pendingClosed.delete(liveId);
        this.byLiveId.delete(liveId);
        tab.setDisconnected(early, () => void this.reconnect(tab));
        this.renderTabbar();
        if (tab === this.active) this.emitStatus();
        return;
      }
      tab.focus();
      if (!isLocal(tab.session)) void this.credentials.onConnected(tab.session, creds);
      // 셸 프롬프트가 나온 뒤 자동 실행 명령 전송.
      if (tab.session.startupCommands.trim()) {
        window.setTimeout(() => tab.sendStartupCommands(), 500);
      }
    } catch (e) {
      if (!isLocal(tab.session)) void this.credentials.onError(tab.session, String(e));
      tab.setDisconnected(`접속 실패: ${String(e)}`, () => void this.reconnect(tab));
    }
    this.renderTabbar();
    if (tab === this.active) this.emitStatus();
  }

  private activate(tab: TerminalTab): void {
    this.active = tab;
    tab.activity = false;
    this.renderTabbar();
    this.layout();
  }

  private fitActive(): void {
    // 타일 모드에서는 보이는 모든 터미널을 다시 맞춰야 한다(포커스는 유지).
    this.layout(false);
  }

  private async closeTab(tab: TerminalTab): Promise<void> {
    if (tab.status === "connected") {
      const ok = await this.confirmClose(tab.session.name || tab.session.host);
      if (!ok) return;
    }
    if (tab.liveId) {
      void closeOf(tab.session, tab.liveId);
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
        this.emitStatus();
      }
    }
    this.renderTabbar();
    this.layout();
  }

  private emitStatus(): void {
    const tab = this.active;
    if (!tab) {
      this.onStatus({
        label: "",
        state: "none",
        size: "",
        cursor: "",
        encoding: "",
        cipher: "",
        uptime: "",
      });
      return;
    }
    const s = tab.session;
    const local = isLocal(s);
    const who = local
      ? `로컬 셸${s.shellExe ? ` · ${s.shellExe}` : ""}`
      : s.user
        ? `${s.user}@${s.host}:${s.port}`
        : `${s.host}:${s.port}`;
    this.onStatus({
      label: `${s.name || s.host} · ${who}`,
      state: tab.status,
      size: `${tab.cols}×${tab.rows}`,
      cursor: tab.cursorPos(),
      encoding: local ? "" : tab.session.charset || "UTF-8",
      // 원격 세션은 SSH-2 로 암호화됨(정확한 협상 cipher 표기는 후속 과제).
      cipher: local || tab.status !== "connected" ? "" : "SSH-2",
      uptime: tab.uptimeText(),
    });
  }

  private renderTabbar(): void {
    this.tabbar.innerHTML = "";
    for (const tab of this.tabs) {
      const cls =
        "tab" +
        (tab === this.active ? " active" : "") +
        (tab.status === "disconnected" ? " dead" : tab.activity ? " activity" : "");
      const item = el("div", cls);

      const dot = el("span", "tab-dot " + tab.status);
      const label = el("span", "tab-label");
      label.textContent = tab.session.name || `${tab.session.user}@${tab.session.host}`;
      label.title = tab.session.name || tab.session.host;

      const close = document.createElement("button");
      close.className = "tab-close";
      applyIcon(close, "cancel");
      close.title = "닫기";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void this.closeTab(tab);
      });

      item.append(dot, label, close);
      item.addEventListener("click", () => this.activate(tab));
      item.addEventListener("mousedown", (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          void this.closeTab(tab);
        }
      });
      item.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.activate(tab); // 어느 탭에 대한 메뉴인지 눈으로 분명히
        const s = tab.session;
        // 로컬 셸과 SFTP 를 끈 세션에는 전송 항목을 넣지 않는다(사이드바와 같은 기준).
        const sftpItem =
          this.onSftp && s.kind !== "local" && s.enableSftp
            ? [{ label: "SFTP 파일 전송", accel: "f", action: () => this.onSftp?.(s) } as const]
            : [];
        showContextMenu(ev.clientX, ev.clientY, [
          ...sftpItem,
          ...(sftpItem.length ? [{ separator: true } as const] : []),
          { label: "닫기", accel: "c", danger: true, action: () => void this.closeTab(tab) },
        ]);
      });
      this.tabbar.appendChild(item);
    }
    // 탭바를 다시 그리는 시점 = 탭 추가/삭제·접속 상태 변화가 확정된 시점.
    for (const fn of this.tabsChanged) fn();
  }
}

function el(tag: string, className: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = className;
  return e;
}
