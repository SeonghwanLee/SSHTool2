// 터미널 탭 하나 — xterm 뷰 + 세션 상태 + 수신 펌프/게이트/역압.
// tabs.ts(TabManager)에서 분리(0.63.0 정지작업, 800줄 규칙). 로직 변경 없음.
// 다중 탭 터미널 관리. 각 탭 = xterm 인스턴스 하나 + 하나의 live SSH 세션.
// 설정(테마·폰트·크기·커서·스크롤백) 적용, 선택→자동복사+토스트, 우클릭 복사/붙여넣기,
// 검색(Ctrl+Shift+F), Ctrl+휠 zoom, Ctrl+Enter=LF, 탭 상태색, 탭 단축키, 상태바 연동.

import { Terminal } from "@xterm/xterm";
import { applyIcon, iconSpan } from "./icons";
import { showContextMenu, type MenuItem } from "./contextmenu";
import { logBytes, logLine } from "./debuglog";
import { confirmDialog, alertDialog } from "./dialogs";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchDecorationOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { loadUnicode } from "./unicodewidth";
import "@xterm/xterm/css/xterm.css";
import type { SessionInfo } from "./types";
import type { Settings } from "./settings";
import { fontStack } from "./settings";
import { themeById } from "./themes";
import { Utf8Gate } from "./utf8stream";
import { pinCompositionOverlay } from "./imeoverlay";
import { TermSearch } from "./termsearch";
import {
  clamp,
  LF,
  LOCKED_HINT,
  ZOOM_BADGE_MS,
  TRIGGER_WINDOW_MS,
  stripAnsi,
  formatUptime,
  mixHex,
  RESET_INPUT_MODES,
  LOCAL_CREDS,
  type ResolvedCreds,
  type CredResolution,
  type CredentialProvider,
  type TabActions,
  type StatusInfo,
  type ViewMode,
} from "./termtypes";
// 기존 소비자(tabs.ts → main.ts)가 termtab 에서 가져가던 이름들을 그대로 통하게 한다.
export {
  LOCAL_CREDS,
  RESET_INPUT_MODES,
  clamp,
  stripAnsi,
  formatUptime,
} from "./termtypes";
export type {
  ResolvedCreds,
  CredResolution,
  CredentialProvider,
  TabActions,
  StatusInfo,
  ViewMode,
} from "./termtypes";
import {
  sshConnect,
  sshWrite,
  sshPause,
  b64ToBytes,
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
export const isLocal = (s: SessionInfo): boolean => s.kind === "local";
export const writeTo = (s: SessionInfo, id: string, bytes: Uint8Array): Promise<void> =>
  isLocal(s) ? localWrite(id, bytes) : sshWrite(id, bytes);
export const resizeTo = (s: SessionInfo, id: string, cols: number, rows: number): Promise<void> =>
  isLocal(s) ? localResize(id, cols, rows) : sshResize(id, cols, rows);
export const closeOf = (s: SessionInfo, id: string): Promise<void> =>
  isLocal(s) ? localClose(id) : sshClose(id);

/** 탭 하나 = 터미널 뷰 + 상태. 접속/재접속 로직은 TabManager 가 구동한다. */
export class TerminalTab {
  readonly key = crypto.randomUUID();
  session: SessionInfo;
  liveId: string | null = null;
  status: "connecting" | "connected" | "disconnected" = "connecting";
  activity = false; // 비활성 탭에 출력이 도착하면 true(호박색)
  /**
   * 이 탭만의 잠금. 켜지면 셸로 나가는 입력이 모두 막히고 종료·닫기도 거부된다.
   * 앱 전체 볼트 잠금(vault)과는 아무 상관이 없다 — 저장된 비밀번호는 그대로 쓸 수 있고,
   * 볼트를 잠가도 이 값은 바뀌지 않는다. 실수로 명령을 치거나 창을 닫는 것만 막는 장치다.
   */
  locked = false;
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
  /** 잠긴 동안 늘 떠 있는 표시 — 입력이 안 먹는 이유를 화면에서 바로 알 수 있게 한다. */
  private readonly lockBadge: HTMLDivElement;
  /** 확대/축소 배율 표시와 그 자동 숨김 타이머. */
  private readonly zoomBadge: HTMLDivElement;
  private zoomTimer: number | null = null;
  /** 끊긴 뒤 떠 있는 재접속 버튼 — 엔터로도 누를 수 있게 포커스 대상이 된다. */
  private reconnectBtn: HTMLButtonElement | null = null;
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
  private readonly searchCtl: TermSearch;
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
    this.lockBadge = el("div", "term-lock-badge");
    this.lockBadge.append(iconSpan("lock"), document.createTextNode("잠김"));
    this.lockBadge.style.display = "none";
    // 확대/축소 배율 — 바꾼 직후 화면 가운데에 잠깐 떴다 사라진다.
    this.zoomBadge = el("div", "term-zoom-badge");
    this.zoomBadge.style.display = "none";
    this.searchBar = el("div", "term-search");
    this.searchBar.style.display = "none";
    this.searchInput = document.createElement("input");
    this.searchInput.placeholder = "검색 (Enter/F3, Shift+F3 역방향, Esc 닫기)";
    this.searchBar.appendChild(this.searchInput);
    // 검색창을 떠나면(터미널 클릭 등) 자동으로 닫는다 — 열어 두고 잊으면 계속 화면을
    // 가리고, 강조 표시도 남아 있어 거슬린다(사용자 보고). 강조까지 함께 걷힌다.
    // focusout 은 검색창 안에서의 이동(input↔버튼)에도 발생하므로, 포커스가 정말
    // 바깥으로 나갔는지 relatedTarget 으로 확인한다. relatedTarget 이 null 인 경우
    // (창 자체가 비활성화 등)는 닫지 않는다 — 앱을 오갔다고 검색이 사라지면 그것대로 성가시다.
    this.searchBar.addEventListener("focusout", (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !this.searchBar.contains(to)) this.closeSearch();
    });
    // 끊긴 화면(오버레이)의 빈 곳을 눌러도 포커스를 재접속 버튼으로 되돌린다. 남은 출력을
    // 복사하려고 클릭하면 포커스가 떠나 엔터가 다시 죽는다 — 그 자리에서 곧장 복구한다.
    // setTimeout 0: 브라우저의 기본 포커스 이동이 끝난 뒤에 되돌려야 이긴다.
    this.overlay.addEventListener("mousedown", () => {
      if (this.status === "disconnected") setTimeout(() => this.reconnectBtn?.focus(), 0);
    });
    this.root.append(
      this.header,
      this.termHost,
      this.overlay,
      this.toast,
      this.lockBadge,
      this.zoomBadge,
      this.searchBar,
    );
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
    this.searchCtl = new TermSearch(
      this.term,
      this.search,
      this.searchBar,
      this.searchInput,
      () => this.settings,
      () => this.closeSearch(),
    );
    this.term.loadAddon(new WebLinksAddon());
    // Unicode 11 + VS16(이모지 표현) 폭 보정 — unicodewidth.ts 참고.
    loadUnicode(this.term);
    this.term.open(this.termHost);
    // 행 높이가 컨테이너에 딱 안 떨어질 때 하단에 남는 잔여 영역이 검게 비치는 걸 막는다
    // — 컨테이너 배경을 터미널 배경색과 같게 칠해 눈에 띄지 않게 한다(글자 크기 무관).
    this.termHost.style.background = theme.term.background ?? "";

    this.term.onData((d) => this.send(new TextEncoder().encode(d)));
    this.term.onResize(() => onResize());

    this.wireInput();
    pinCompositionOverlay(this.term);
  }

  /**
   * 셸로 나가는 유일한 출구. 키 입력·붙여넣기·트리거·시작 명령이 모두 여기를 지나므로,
   * 잠금은 이 한 곳에서 막으면 새어 나갈 경로가 남지 않는다.
   */
  private send(bytes: Uint8Array): void {
    if (this.locked) {
      this.showToast(LOCKED_HINT);
      return;
    }
    this.onInput(bytes);
  }

  // ── 입력/복사/붙여넣기/줌 ──
  private wireInput(): void {
    // Ctrl+Enter 의 LF 를 항상 '지연' 전송한다. 한글 조합이 확정될 때 xterm 은 확정 문자를
    // setTimeout(0) 으로 보내므로, LF 도 setTimeout(0) 으로 미뤄야 "문자 → 개행" 순서가 지켜진다.
    // (동기로 보내면 IME 가 229 keydown→compositionend→실제 Enter keydown 순서를 낼 때
    //  실제 Enter keydown 이 문자보다 먼저 LF 를 쏴 마지막 글자가 다음 줄로 밀린다.)
    // 여러 keydown 이 겹치는 IME 모델에서 LF 가 두 번 나가지 않도록 짧은 시간 창으로 1회만 보낸다.
    const sendCtrlEnterLf = () => {
      const now = performance.now();
      if (now - this.lastCtrlEnterLf < 50) return;
      this.lastCtrlEnterLf = now;
      setTimeout(() => this.send(LF), 0);
    };

    this.term.attachCustomKeyEventHandler((e) => {
      // 잠금 중에는 keydown 이 아닌 키 이벤트(keypress 등)도 xterm 에 넘기지 않는다.
      // xterm 은 keypress 로도 문자를 만들어 내므로 keydown 만 봐서는 막을 수 없다.
      if (this.locked && e.type !== "keydown") return false;
      if (e.type !== "keydown") return true;
      const ctrl = e.ctrlKey;
      const stop = () => {
        e.preventDefault(); // false 반환만으론 webview 확대 등 기본동작이 남음
        return false;
      };

      // ── 앱 예약 단축키 — xterm 에 넘기지 않고 흘려보내 문서 핸들러가 받게 한다 ──
      //
      // xterm 은 자기가 아는 키를 이스케이프 시퀀스로 바꿔 보내며 stopPropagation 까지
      // 하므로, 여기서 빼 주지 않은 앱 단축키는 터미널에 포커스가 있는 동안(= 사실상 항상)
      // 전부 죽는다. Ctrl+3~7(제어문자), Ctrl+F4, Ctrl+Tab 이 차례로 그렇게 죽어 있었다 —
      // 하나씩 뚫는 대신 목록 한 곳에 모은다. 새 단축키를 만들면 여기에도 넣을 것.
      //
      // false 반환 = xterm 이 손을 떼고 preventDefault 도 하지 않아 이벤트가 그대로
      // 문서까지 올라간다. 대가: 그 조합을 원격 앱에 보내는 길이 막힌다
      // (Ctrl+3~7 의 제어문자 ESC·FS·GS·RS·US, Ctrl+Tab, Ctrl+F4 시퀀스 — 실사용 희박).
      if (ctrl && !e.altKey && !e.metaKey) {
        const reserved =
          (!e.shiftKey && e.key >= "1" && e.key <= "9") || // 탭 번호 전환
          (!e.shiftKey && e.key === "F4") || // 세션 닫기
          e.key === "Tab"; // 탭 순환(Shift 는 역방향이므로 함께)
        if (reserved) return false;
      }

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
      // 여기까지 온 키는 셸로 전달될 입력이다 — 잠금 중이면 막는다.
      // 복사·검색·스크롤·확대는 위에서 이미 처리돼 잠겨 있어도 그대로 쓸 수 있다.
      if (this.locked) {
        this.showToast(LOCKED_HINT);
        return stop();
      }
      return true;
    });

    // 조합 중 눌린 Ctrl+Enter 는 여기(확정 시점)에서 LF 를 지연 전송한다.
    this.term.textarea?.addEventListener("compositionend", () => {
      this.termHost.classList.remove("composing");
      if (this.pendingCompositionLf) {
        this.pendingCompositionLf = false;
        sendCtrlEnterLf();
      }
    });
    // 조합이 새로 시작되면 예약을 무효화 — 이전 Ctrl+Enter 가 조합을 끝내지 못한 경우
    // 다음 조합의 compositionend 에서 엉뚱한 LF 가 나가는 것을 막는다.
    // 조합 중에는 터미널 커서를 감춘다. 조합 글자는 오버레이로 그려지는데, 그 옆에 커서
    // 사각형이 같이 보이면 "지금 치는 글자가 커서 밖에 나온다"처럼 읽혀 거슬린다.
    // 조합이 끝나면 곧바로 되돌린다(compositionend).
    this.term.textarea?.addEventListener("compositionstart", () => {
      this.termHost.classList.add("composing");
      this.pendingCompositionLf = false;
    });

    // 선택 후 놓으면 자동 복사(설정 시), xterm/PuTTY 방식.
    this.termHost.addEventListener("mouseup", (e) => {
      if (e.button === 0 && this.settings.copyOnSelect && this.term.hasSelection()) {
        void this.copySelection();
      }
    });
    // 우클릭 = 붙여넣기. 단, '선택 시 자동 복사' 가 꺼져 있을 때만 선택분을 먼저 복사한다.
    //
    // 자동 복사가 켜진 상태에서 선택이 남아 있다고 또 복사하면, 드래그 직후 우클릭이
    // 붙여넣기로 동작하지 않는다. 이미 클립보드에 들어간 것을 다시 복사할 뿐이라
    // 화면상 아무 일도 안 일어난 것처럼 보이고, 선택이 풀릴 때까지 붙여넣기가 안 된다.
    this.termHost.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.settings.copyOnSelect && this.term.hasSelection()) void this.copySelection();
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
    // 잠긴 세션에서는 클립보드를 읽지도 않는다 — 어차피 보내지 못한다.
    if (this.locked) {
      this.showToast(LOCKED_HINT);
      return;
    }
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
    this.flashZoom();
    this.onFontSize(this.sessionFontSize); // 세션에 저장
  }
  private setZoom(v: number): void {
    // Ctrl+0 = 세션 지정 해제(전역 설정으로 복귀).
    this.sessionFontSize = v > 0 ? v : 0;
    this.applyFont();
    this.flashZoom();
    this.onFontSize(this.sessionFontSize);
  }
  private applyFont(): void {
    this.term.options.fontFamily = fontStack(this.settings.fontFamily);
    this.term.options.fontSize = this.effectiveFontSize();
    this.invalidateFit(); // 글자 크기가 바뀌면 셀 크기가 달라진다
    this.fitNow();
    this.onActive();
  }

  /**
   * 지금 배율을 화면 가운데에 잠깐 띄운다. 기준은 설정의 전역 글자 크기 —
   * Ctrl+0 으로 돌아오는 지점이 100% 여야 "원래대로" 가 눈에 보인다.
   */
  private flashZoom(): void {
    const base = this.settings.fontSize;
    if (base <= 0) return;
    const pct = Math.round((this.effectiveFontSize() / base) * 100);
    this.zoomBadge.textContent = `${pct}%`;
    this.zoomBadge.style.display = "block";
    // 다시 그리기 전에 클래스를 떼야 연속으로 돌릴 때 애니메이션이 처음부터 다시 돈다.
    this.zoomBadge.classList.remove("fading");
    void this.zoomBadge.offsetWidth;
    this.zoomBadge.classList.add("fading");
    if (this.zoomTimer !== null) clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => {
      this.zoomBadge.style.display = "none";
      this.zoomTimer = null;
    }, ZOOM_BADGE_MS);
  }

  // 검색 동작은 termsearch.ts 로 분리(0.67.0) — 이 클래스는 열기·닫기만 위임한다.
  openSearch(): void {
    this.searchOpen = true;
    this.searchCtl.open();
  }
  private closeSearch(): void {
    this.searchOpen = false;
    this.searchCtl.close();
  }
  private searchNext(): void {
    this.searchCtl.next();
  }
  private searchPrev(): void {
    this.searchCtl.prev();
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
    this.invalidateFit(); // 글꼴·크기가 바뀌었을 수 있다
    this.fitNow();
  }

  /** 이 탭의 잠금을 켜고 끈다. 표시(배지·탭 라벨)까지 함께 맞춘다. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.root.classList.toggle("locked", locked);
    this.lockBadge.style.display = locked ? "flex" : "none";
  }

  /** 탭에 붙은 세션 정보 교체 — 편집·이름 변경 결과를 라벨에 즉시 반영한다. */
  setSession(next: SessionInfo): void {
    this.session = next;
    this.headerLabel.textContent = next.name || `${next.user}@${next.host}`;
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

  /** 마지막으로 맞춘 크기(px) — 같은 크기면 다시 재지 않는다. */
  private fittedAt: { w: number; h: number } | null = null;

  /**
   * 터미널을 컨테이너 크기에 맞춘다.
   *
   * 크기가 그대로면 건너뛴다(0.72.0). fit() 은 셀 크기를 재느라 강제 레이아웃을
   * 일으키고, 전체화면처럼 큰 격자(200×60 이상)에서는 그 비용이 눈에 띈다 —
   * 탭을 오갈 때마다 같은 크기로 다시 재면 마우스가 끊기는 느낌을 준다.
   * 글꼴·글자 크기가 바뀌면 셀 크기가 달라지므로 그때는 캐시를 버린다(invalidateFit).
   */
  fitNow(): void {
    const w = this.termHost.clientWidth;
    const h = this.termHost.clientHeight;
    if (w === 0 || h === 0) return; // 아직 안 보이는 탭 — 보일 때 다시 맞춘다
    if (this.fittedAt && this.fittedAt.w === w && this.fittedAt.h === h) return;
    try {
      this.fit.fit();
      this.fittedAt = { w, h };
    } catch {
      /* 아직 레이아웃 전 */
    }
  }

  /** 셀 크기가 달라졌을 때(글꼴·글자 크기·테마 변경) 다음 fit 을 강제한다. */
  invalidateFit(): void {
    this.fittedAt = null;
  }
  focus(): void {
    if (this.status === "disconnected" && this.reconnectBtn) {
      this.reconnectBtn.focus();
      return;
    }
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
  /** 수신 스트림의 UTF-8 문자 경계 정렬 — xterm 6.0.0 조각 디코더 버그 우회(utf8stream.ts). */
  private readonly utf8Gate = new Utf8Gate();
  // ── 수신 쓰기 펌프(0.61.0) — 대량 출력에 앱이 굳던 문제의 보수적 해법 ──
  // term.write 를 fire-and-forget 으로 쌓으면 유입이 소화보다 빠를 때 xterm 내부
  // 버퍼가 무한정 자라 UI 가 잠식된다(cat 대용량 등). 소화 완료 콜백을 받아 다음
  // 조각을 보내는 펌프로 바꾼다 — 내용·순서는 그대로고 밀어넣는 속도만 조절된다.
  private writeQ: Uint8Array[] = [];
  private draining = false;
  /** 쓰기 큐에 쌓인 바이트 — 역압 워터마크 판단용. */
  private queuedBytes = 0;
  private rxPaused = false;
  /**
   * 역압(0.63.0): 큐가 4MB 를 넘으면 백엔드에 수신 일시정지를 걸어 SSH 흐름제어로
   * 서버 송신까지 멈추고, 512KB 아래로 빠지면 재개한다. 로컬 셸은 PTY 버퍼가
   * 자체 역압을 갖고 있어 제외. 극단 출력(수백 MB)에서도 메모리가 안 자란다.
   */
  private updateFlow(): void {
    if (!this.liveId || isLocal(this.session)) return;
    if (!this.rxPaused && this.queuedBytes > 4 * 1024 * 1024) {
      this.rxPaused = true;
      void sshPause(this.liveId, true);
    } else if (this.rxPaused && this.queuedBytes < 512 * 1024) {
      this.rxPaused = false;
      void sshPause(this.liveId, false);
    }
  }
  private pump(): void {
    if (this.draining) return;
    this.draining = true;
    const next = (): void => {
      if (this.disposed) {
        this.draining = false;
        this.writeQ = [];
        this.queuedBytes = 0;
        return;
      }
      let chunk = this.writeQ.shift();
      if (!chunk) {
        this.draining = false;
        return;
      }
      // 작은 조각이 몰려 있으면 64KB 까지 합쳐 호출 횟수를 줄인다(순서 유지).
      if (chunk.length < 65536 && this.writeQ.length > 0) {
        let size = chunk.length;
        let k = 0;
        while (k < this.writeQ.length && size + this.writeQ[k].length <= 65536)
          size += this.writeQ[k++].length;
        if (k > 0) {
          const merged = new Uint8Array(size);
          merged.set(chunk, 0);
          let off = chunk.length;
          for (let j = 0; j < k; j++) {
            merged.set(this.writeQ[j], off);
            off += this.writeQ[j].length;
          }
          this.writeQ.splice(0, k);
          chunk = merged;
        }
      }
      const written = chunk.length;
      this.term.write(chunk, () => {
        this.queuedBytes -= written;
        this.updateFlow(); // 큐가 빠졌으면 수신 재개
        next();
      });
    };
    next();
  }
  writeBytes(bytes: Uint8Array): void {
    // 서버가 실제로 무엇을 보냈는지 — 화면에 그려진 결과만 보고는 알 수 없는 것들
    // (커서 이동, 마우스 추적 켜기, 색상 코드)이 여기에 드러난다. 진단 로그와 트리거는
    // 게이트 이전의 원본을 본다(각자 자체 스트리밍 디코더로 조각을 올바르게 잇는다).
    logBytes(`RX ${this.session.name || this.session.host}`, bytes);
    const complete = this.utf8Gate.feed(bytes);
    if (complete.length) {
      this.writeQ.push(complete);
      this.queuedBytes += complete.length;
      this.updateFlow(); // 큐가 넘치면 수신 일시정지
      this.pump();
    }
    if (this.session.triggers.length) this.checkTriggers(bytes);
  }

  /** 접속 직후 자동 실행 명령(줄 단위)을 순서대로 전송. */
  sendStartupCommands(): void {
    const lines = this.session.startupCommands
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // 실행 키는 CR — 키보드 Enter 가 보내는 그 바이트다. LF 를 보냈더니 원격 셸은
    // 줄 규율이 받아줘 우연히 실행됐지만, 로컬 PowerShell(ConPTY)은 텍스트만 붙고
    // 실행되지 않았다("엔터가 안 먹힌다"). 양쪽 다 CR 이 맞다.
    for (const line of lines) this.sendText(`${line}\r`);
  }

  private sendText(text: string): void {
    this.send(new TextEncoder().encode(text));
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
      // 사용자가 적은 \n 은 'Enter' 라는 뜻 — 실행되려면 CR 이어야 한다(위 시작 명령과 동일).
      this.sendText(rule.send.replace(/\\n/g, "\r"));
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

  /** 끊김 오버레이에 자동 재접속 안내를 덧붙인다(없으면 만들고, 있으면 문구만 바꾼다). */
  showRetryNote(text: string): void {
    if (this.status !== "disconnected") return;
    let note = this.overlay.querySelector<HTMLElement>(".overlay-retry");
    if (!note) {
      note = el("div", "overlay-retry");
      // 보통은 재접속 버튼이 든 상자 안에 붙인다. 상자가 없으면(이례적) 오버레이에
      // 직접 붙여 안내가 사라지지 않게 한다.
      (this.overlay.querySelector(".overlay-box") ?? this.overlay).appendChild(note);
    }
    note.textContent = text;
  }

  setConnecting(): void {
    this.status = "connecting";
    this.reconnectBtn = null;
    this.utf8Gate.clear(); // 새 스트림 — 이전 접속의 반쪽 문자 꼬리와 잇지 않는다
    this.writeQ = []; // 이전 스트림의 미출력 잔여도 버린다(새 화면에 섞이지 않게)
    this.queuedBytes = 0;
    this.rxPaused = false; // 이전 연결의 일시정지 상태는 세션과 함께 사라졌다
    this.overlay.style.display = "flex";
    this.overlay.innerHTML = `<div class="overlay-msg">접속 중…</div>`;
  }
  setConnected(liveId: string): void {
    logLine("접속됨", `${this.session.user}@${this.session.host}:${this.session.port} (${liveId})`);
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
    logLine("끊김", `${this.session.name || this.session.host} — ${message}`);
    this.status = "disconnected";
    this.liveId = null;
    // 끊긴 시각을 박아 두면 이후 유지시간이 최종값에서 멈춘다.
    if (this.connectedAt !== null && this.disconnectedAt === null) {
      this.disconnectedAt = Date.now();
    }
    // 원격 앱이 켜 둔 마우스 추적 등이 남아 있으면 재접속 후 마우스 이동이 그대로
    // 입력된다. 화면은 남기고 모드만 되돌린다.
    // 잘린 UTF-8 로 끝난 출력의 마지막 바이트를 내보낸다 — 게이트가 물고 있던
    // 꼬리는 다음 데이터가 없으면 영영 안 나온다(진단 0.62.0).
    const tail = this.utf8Gate.flush();
    if (tail.length) this.term.write(tail);
    this.term.write(RESET_INPUT_MODES);
    this.term.writeln(`\r\n\x1b[33m[세션 종료] ${message}\x1b[0m`);
    this.overlay.style.display = "flex";
    this.overlay.innerHTML = "";
    const box = el("div", "overlay-box");
    const msg = el("div", "overlay-msg");
    msg.textContent = message;
    const btn = document.createElement("button");
    btn.className = "btn-accent";
    btn.textContent = "재접속 (Enter)";
    btn.addEventListener("click", onReconnect);
    box.append(msg, btn);
    this.overlay.appendChild(box);
    // 버튼에 포커스를 준다 — 엔터·스페이스로 바로 재접속된다. 끊긴 터미널에 대고
    // 엔터를 쳐도 아무 일이 없어(liveId 가 없어 입력이 버려진다) 멈춘 것처럼 보였다.
    this.reconnectBtn = btn;
    btn.focus();
  }

  /** 닫힌 뒤 뒤늦게 도착한 접속 결과를 무시하기 위한 표시. */
  disposed = false;

  dispose(): void {
    this.disposed = true;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.zoomTimer) clearTimeout(this.zoomTimer); // 배율 표시 타이머도 함께 정리
    this.term.dispose();
    this.root.remove();
  }
}

/** 탭 모음 + 탭바 DOM + 활성 탭 + 전역 SSH 이벤트 디스패치 + 상태바 연동. */

export function el(tag: string, className: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = className;
  return e;
}
