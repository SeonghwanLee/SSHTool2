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
/**
 * 자격증명 해결 결과 — null 은 사용자가 스스로 취소한 것, { failed } 는 서버 확인(probe)
 * 실패다. 실패를 팝업이 아니라 탭 오버레이에 보여 주려면 둘을 구분해야 한다(0.59.0).
 */
export type CredResolution = ResolvedCreds | null | { failed: string };

export interface CredentialProvider {
  resolve(session: SessionInfo): Promise<CredResolution>;
  onConnected(session: SessionInfo, creds: ResolvedCreds): Promise<void>;
  onError(session: SessionInfo, error: string): Promise<void>;
}

const LOCAL_CREDS: ResolvedCreds = { user: "", password: "", prompted: false };

/**
 * 세션 탭 우클릭 메뉴가 앱 쪽(main.ts)에 위임하는 동작 묶음.
 *
 * 인자를 하나씩 늘리는 대신 객체로 받는다 — 생성자 인자가 이미 여덟 개라 순서로 구분하기
 * 어렵고, 항목이 늘 때마다 호출부가 위치로 어긋날 위험이 크다.
 * 주입되지 않은 동작은 메뉴에 항목 자체를 넣지 않는다(눌러도 아무 일 없는 항목 금지).
 */
export interface TabActions {
  /** SFTP 파일 전송 창 열기. */
  sftp?: (session: SessionInfo) => void;
  /** 저장 세션 이름 변경. 바뀐 이름을 돌려주면 탭 라벨을 즉시 갱신한다(취소는 null). */
  rename?: (session: SessionInfo) => Promise<string | null>;
  /** 저장 세션 편집. 편집 결과를 돌려주면 탭이 들고 있는 세션도 함께 갱신한다(취소는 null). */
  edit?: (session: SessionInfo) => Promise<SessionInfo | null>;
  /**
   * 이 세션이 저장 목록에 있는지. 빠른 접속 같은 임시 세션은 저장 목록에 없어
   * 이름 변경·편집이 아무것도 바꾸지 못하므로, false 면 두 항목을 메뉴에서 숨긴다.
   */
  isSaved?: (session: SessionInfo) => boolean;
}

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
 * 잠긴 세션에서 입력이 막혔을 때 띄우는 안내.
 * 아무 반응이 없으면 고장으로 오해하므로 왜 안 나가는지 매번 알려 준다.
 */
const LOCKED_HINT = "세션 잠김 — 탭 우클릭 → 세션 잠금 해제";

/**
 * 트리거 발동 허용 창(ms). 접속 직후에만 발동시켜, 한참 뒤에 나타난 패턴 출력에는
 * 반응하지 않게 한다. 로그인·sudo 프롬프트는 접속 직후에 나오므로 정상 용도는 이 안에 든다.
 */
/** 확대/축소 배율 표시가 떠 있는 시간(ms). */
const ZOOM_BADGE_MS = 900;

const TRIGGER_WINDOW_MS = 10_000;

/** "#RRGGBB" 를 [r,g,b] 로. 형식이 아니면 null. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 두 색을 t 비율로 섞는다(0 = a, 1 = b). 검색 강조색을 테마에 맞춰 만드는 데 쓴다 —
 * 색을 고정하면 밝은 테마에서 글자가 안 보이거나 어두운 테마에서 튄다.
 */
function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const mix = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return "#" + mix.map((v) => v.toString(16).padStart(2, "0")).join("");
}

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

/**
 * 세션이 끊긴 뒤 터미널에 남는 입력 모드를 원상복구하는 시퀀스.
 *
 * 원격 앱(Claude CLI·vim·tmux 등)이 켜 둔 모드는 **터미널 쪽 상태**라 세션이 죽어도
 * 그대로 남는다. 특히 마우스 추적이 켜진 채 재접속하면 마우스를 움직이는 것만으로
 * `ESC[<35;82;12M` 같은 시퀀스가 새 셸로 날아가, 프롬프트에 `35;82;12M…` 이 찍힌다.
 * 끊긴 시점에 꺼 두면 다음 세션이 깨끗한 상태에서 시작한다.
 *
 * term.reset() 은 쓰지 않는다 — 화면과 스크롤백까지 지워서, 끊긴 세션의 마지막 출력을
 * 남겨 두는 '세션 종료' 동작과 어긋난다. 모드만 골라서 끈다.
 */
const RESET_INPUT_MODES =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l" + // 마우스 추적(클릭·버튼이동·전체이동)
  "\x1b[?1005l\x1b[?1006l\x1b[?1015l" + // 마우스 좌표 확장 인코딩
  "\x1b[?2004l" + // 괄호 붙여넣기
  "\x1b[?1l\x1b>"; // 커서키·키패드를 일반 모드로

/** 탭 하나 = 터미널 뷰 + 상태. 접속/재접속 로직은 TabManager 가 구동한다. */
class TerminalTab {
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
    this.term.loadAddon(new WebLinksAddon());
    const uni = new Unicode11Addon();
    this.term.loadAddon(uni);
    this.term.unicode.activeVersion = "11";
    this.term.open(this.termHost);
    // 행 높이가 컨테이너에 딱 안 떨어질 때 하단에 남는 잔여 영역이 검게 비치는 걸 막는다
    // — 컨테이너 배경을 터미널 배경색과 같게 칠해 눈에 띄지 않게 한다(글자 크기 무관).
    this.termHost.style.background = theme.term.background ?? "";

    this.term.onData((d) => this.send(new TextEncoder().encode(d)));
    this.term.onResize(() => onResize());

    this.wireInput();
    this.pinCompositionOverlay();
    this.wireSearch();
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

  // ── 검색 ──
  /**
   * 검색어 강조 색. 예전에는 clearDecorations() 만 부르고 decorations 를 넘기지 않아
   * 강조가 아예 켜지지 않았다 — 현재 위치로 이동만 하고 나머지 일치는 표시되지 않았다.
   *
   * 활성 일치는 accent 그대로, 나머지는 accent 를 터미널 배경 쪽으로 섞어 한 단계 죽인다.
   * 둘을 같은 색으로 두면 지금 어디에 있는지 알 수 없다.
   */
  private searchDecorations(): ISearchDecorationOptions {
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a7c080";
    const bg = themeById(this.settings.theme).term.background ?? "#000000";
    return {
      matchBackground: mixHex(accent, bg, 0.5),
      matchOverviewRuler: accent,
      activeMatchBackground: accent,
      activeMatchColorOverviewRuler: accent,
    };
  }

  private wireSearch(): void {
    this.searchInput.addEventListener("input", () => {
      if (this.searchInput.value)
        this.search.findNext(this.searchInput.value, {
          incremental: true,
          decorations: this.searchDecorations(),
        });
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
  openSearch(): void {
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
    if (this.searchInput.value)
      this.search.findNext(this.searchInput.value, { decorations: this.searchDecorations() });
  }
  private searchPrev(): void {
    if (this.searchInput.value)
      this.search.findPrevious(this.searchInput.value, { decorations: this.searchDecorations() });
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

  fitNow(): void {
    try {
      this.fit.fit();
    } catch {
      /* 아직 레이아웃 전 */
    }
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
  writeBytes(data: number[]): void {
    const bytes = new Uint8Array(data);
    // 서버가 실제로 무엇을 보냈는지 — 화면에 그려진 결과만 보고는 알 수 없는 것들
    // (커서 이동, 마우스 추적 켜기, 색상 코드)이 여기에 드러난다.
    logBytes(`RX ${this.session.name || this.session.host}`, bytes);
    this.term.write(bytes);
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

  /**
   * 조합(IME) 오버레이를 조합이 시작된 셀에 고정한다.
   *
   * xterm 은 조합 중인 글자를 '지금 커서 셀'에 띄우고 렌더마다 다시 놓는다. claude CLI 처럼
   * 입력 중에도 화면을 계속 다시 그리는 앱에서는, 스피너 출력이 커서를 다른 곳에 두고
   * 끝나는 순간 조합 중이던 한글이 그 자리로 점프해 보인다(시뮬레이션으로 재현·확인).
   * 조합 중에는 아무것도 서버로 전송되지 않아 실제 입력 지점은 움직이지 않으므로,
   * 시작 셀에 붙여 두는 것이 맞다.
   *
   * 안정성 원칙: xterm 의 상태(버퍼 등)는 일절 만지지 않는다. 원본 함수를 먼저 그대로
   * 실행한 뒤 오버레이·textarea 의 left/top 스타일만 되돌려 놓는다. 비공개 API 라
   * 구조가 다르면(업그레이드 등) 고정만 조용히 꺼지고 기본 동작으로 남는다.
   */
  private pinCompositionOverlay(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const core = (this.term as any)._core;
      const helper = core?._compositionHelper;
      const ta = this.term.textarea;
      if (!helper || !ta || typeof helper.updateCompositionElements !== "function") return;

      /** 고정 기준 셀. null 이면 고정하지 않는다(기본 동작). */
      let pinned: { col: number; row: number } | null = null;

      ta.addEventListener("compositionstart", () => {
        try {
          const buf = core._bufferService?.buffer;
          pinned = buf ? { col: buf.x, row: buf.y } : null;
        } catch {
          pinned = null;
        }
      });
      ta.addEventListener("compositionend", () => {
        pinned = null;
      });

      const original = helper.updateCompositionElements.bind(helper);
      helper.updateCompositionElements = (dontRecurse?: unknown) => {
        original(dontRecurse);
        if (pinned === null || !helper._isComposing) return;
        try {
          const buf = core._bufferService?.buffer;
          const cols = core._bufferService?.cols ?? 0;
          const cell = core._renderService?.dimensions?.css?.cell;
          if (!buf || !cell || !(cell.width > 0)) return;

          // 커서의 '정당한 전진'은 따라간다. SSH 에서는 음절이 확정되면 서버 에코가
          // 돌아와야 커서가 움직이는데, 다음 음절의 조합은 그보다 먼저 시작된다 —
          // 시작 셀에 못 박아 두면 조합 글자가 앞 글자 위에 겹쳐 보인다(0.52.3 회귀).
          // 같은 줄에서 앞으로 몇 칸 이내의 이동만 에코로 보고 기준을 옮긴다.
          // 먼 점프·다른 줄(스피너·상태줄 재그리기)은 무시한다 — 그게 원래 고치려던 증상이다.
          if (buf.y === pinned.row && buf.x >= pinned.col && buf.x - pinned.col <= 8) {
            pinned = { col: buf.x, row: buf.y };
          }

          const left = Math.min(pinned.col, Math.max(0, cols - 1)) * cell.width;
          const top = pinned.row * cell.height;
          const view = helper._compositionView as HTMLElement | undefined;
          if (view) {
            view.style.left = `${left}px`;
            view.style.top = `${top}px`;
          }
          // IME 후보창(한자 변환 목록 등)은 textarea 위치를 따라간다 — 같이 붙인다.
          const t = helper._textarea as HTMLElement | undefined;
          if (t) {
            t.style.left = `${left}px`;
            t.style.top = `${top}px`;
          }
        } catch {
          /* 계측 실패 시 이번 렌더는 기본 위치(원본이 이미 놓았다)로 둔다 */
        }
      };
    } catch {
      // 내부 구조가 예상과 다르면 고정 없이 기본 동작 — 기능 하나가 앱을 위협하지 않는다.
    }
  }

  /** 상태바용 접속 유지시간. 접속 전이면 빈 문자열, 끊긴 뒤엔 최종값에서 멈춘다. */
  uptimeText(): string {
    if (this.connectedAt === null) return "";
    return formatUptime((this.disconnectedAt ?? Date.now()) - this.connectedAt);
  }

  setConnecting(): void {
    this.status = "connecting";
    this.reconnectBtn = null;
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
  /** 탭을 끄는 중이었는지 — 놓은 직후의 click 을 걸러내기 위해 잠깐 남긴다. */
  private dragMoved = false;
  /** 동시 명령이 겨눈 탭 키(null = 표시 안 함). 탭바 강조에만 쓴다. */
  private bcastKeys: ReadonlySet<string> | null = null;
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
    /** 세션 탭 우클릭 메뉴가 앱에 위임하는 동작들. 미주입 항목은 메뉴에 넣지 않는다. */
    private readonly actions: TabActions = {},
  ) {
    this.settings = settings;

    // 회귀 검사(check:ui)가 활성 탭 터미널에 접근하기 위한 훅 — 개발 서버에서만 존재하고
    // 프로덕션 빌드에서는 이 가지째 제거된다(DEV 가 false 상수로 치환).
    if (import.meta.env.DEV) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__tm = this;
    }

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
      // 4개까지는 한 줄로 나열한다(세로 분할이면 ⅠⅠⅠⅠ, 가로 분할이면 4단) — 로그 넉 대를
      // 나란히 두고 보는 용도(사용자 요청). 5개부터는 접는다: 한 줄에 다섯을 세우면
      // 폭이 좁아져 어차피 읽을 수 없다. 세로는 정사각에 가깝게, 가로는 3단 기준.
      const cols =
        this.viewMode === "vertical"
          ? n <= 4
            ? n
            : Math.ceil(Math.sqrt(n))
          : n <= 4
            ? 1
            : Math.ceil(n / 3);
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
    // 탭부터 무조건 만든다(0.59.0) — 예전엔 probe·비밀번호를 다 통과해야 탭이 생겨서,
    // 죽은 호스트는 한참 뒤 팝업 하나가 전부였다. 이제 여는 즉시 탭이 뜨고,
    // probe 가 도는 동안 '접속 중…', 실패하면 끊김과 똑같은 재접속 오버레이가 보인다.
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
    tab.setConnecting(); // probe·비밀번호 입력 동안에도 탭 안에 상태가 보이게
    this.renderTabbar();

    const creds = isLocal(session) ? LOCAL_CREDS : await this.credentials.resolve(session);
    if (!this.tabs.includes(tab)) return; // 묻는 사이 탭을 닫았으면 유령 접속 금지
    if (creds === null || "failed" in creds) {
      this.markUnconnected(tab, creds);
      return;
    }
    await this.doConnect(tab, creds);
  }

  /** 자격증명 단계에서 멈춘 탭을 끊김과 같은 재접속 오버레이로 바꾼다. */
  private markUnconnected(tab: TerminalTab, creds: null | { failed: string }): void {
    tab.setDisconnected(
      creds === null ? "접속을 취소했습니다." : `접속 실패: ${creds.failed}`,
      () => void this.reconnect(tab),
    );
    this.renderTabbar();
    this.emitStatus();
  }

  /**
   * 동시 명령 대상 후보 — 접속 중인 탭만. 잠긴 탭도 목록에는 넣되 잠겼다고 알린다
   * (숨기면 "왜 저 세션엔 안 갔지"를 알 길이 없다).
   */
  broadcastTargets(): { key: string; label: string; locked: boolean }[] {
    return this.tabs
      .filter((t) => t.liveId)
      .map((t) => ({
        key: t.key,
        label: t.session.name || `${t.session.user}@${t.session.host}`,
        locked: t.locked,
      }));
  }

  /**
   * 여러 세션에 같은 입력을 보낸다. `keys` 를 주면 그 탭들만, 없으면 접속된 전부.
   *
   * 잠긴 탭은 건너뛴다. 잠금은 '실수로 명령이 들어가는 것'을 막는 장치인데, 동시 명령은
   * 그 사고가 가장 크게 번지는 경로다(운영 서버 10개에 한 줄). 몇 개를 건너뛰었는지
   * 돌려줘 호출부가 조용히 넘기지 않게 한다.
   */
  broadcast(data: Uint8Array, keys?: ReadonlySet<string>): { sent: number; locked: number } {
    let sent = 0;
    let locked = 0;
    for (const t of this.tabs) {
      if (!t.liveId) continue;
      if (keys && !keys.has(t.key)) continue;
      if (t.locked) {
        locked++;
        continue;
      }
      void writeTo(t.session, t.liveId, data);
      sent++;
    }
    return { sent, locked };
  }

  sendActive(data: Uint8Array): "sent" | "none" | "locked" {
    if (!this.active?.liveId) return "none";
    if (this.active.locked) return "locked";
    void writeTo(this.active.session, this.active.liveId, data);
    return "sent";
  }

  /**
   * 동시 명령이 겨눈 탭을 탭바에 표시한다(null = 표시 없음). 열 개가 열려 있으면 어디로
   * 나가는지가 목록 안에서만 보여선 안 된다 — 보내기 직전에 탭바에서 확인되어야 한다.
   */
  markBroadcast(keys: ReadonlySet<string> | null): void {
    this.bcastKeys = keys;
    // renderTabbar() 를 쓰면 안 된다 — 그 끝에서 tabsChanged 를 알리는데, 구독자(동시 명령
    // 창)가 다시 markBroadcast 를 불러 무한 재귀에 빠진다. 클래스만 제자리에서 갈아 끼운다.
    const items = this.tabbar.children;
    this.tabs.forEach((t, i) => items[i]?.classList.toggle("bcast", keys?.has(t.key) === true));
  }

  /** 닫힌 탭의 키를 걸러낸다 — 대상 집합이 유령 키를 들고 있지 않게. */
  pruneKeys(keys: ReadonlySet<string>): Set<string> {
    const live = new Set<string>(this.tabs.filter((t) => t.liveId).map((t) => t.key));
    return new Set([...keys].filter((k) => live.has(k)));
  }
  /** 활성 탭의 찾기 창을 연다(타이틀바 버튼용). 열린 탭이 없으면 아무 일도 하지 않는다. */
  openSearch(): void {
    this.active?.openSearch();
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
    this.activate(tab);
    tab.setConnecting(); // probe 동안 '접속 중…' — 재시도 반응이 즉시 보이게
    const creds = isLocal(tab.session) ? LOCAL_CREDS : await this.credentials.resolve(tab.session);
    if (!this.tabs.includes(tab)) return;
    if (creds === null || "failed" in creds) {
      this.markUnconnected(tab, creds);
      return;
    }
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

  /**
   * SSH 연결만 끊고 탭은 그대로 남긴다('닫기' 와 다르다).
   * 끊긴 뒤에는 평소 연결이 죽었을 때와 똑같이 '재접속' 오버레이가 뜬다.
   */
  private disconnectTab(tab: TerminalTab): void {
    const id = tab.liveId;
    if (!id) return; // 이미 끊긴 탭
    // 먼저 매핑을 지운다 — 백엔드가 뒤이어 보내는 종료 이벤트가 오버레이를 덧그리지 않게.
    this.byLiveId.delete(id);
    void closeOf(tab.session, id);
    tab.setDisconnected("세션을 종료했습니다.", () => void this.reconnect(tab));
    this.renderTabbar();
    if (tab === this.active) this.emitStatus();
  }

  /** 탭 잠금 토글 — 탭바 표시(자물쇠)를 함께 갱신한다. */
  private setTabLocked(tab: TerminalTab, locked: boolean): void {
    tab.setLocked(locked);
    this.renderTabbar();
  }

  /**
   * 잠긴 탭이면 이유를 알리고 true 를 돌려준다. 종료·닫기 계열 앞에 공통으로 쓴다
   * — 조용히 무시하면 버튼이 고장 난 것처럼 보인다.
   */
  private async refuseIfLocked(tab: TerminalTab): Promise<boolean> {
    if (!tab.locked) return false;
    await alertDialog(
      `'${tabName(tab)}' 세션은 잠겨 있습니다.\n` +
        "탭을 우클릭해 '세션 잠금 해제' 를 먼저 하세요.",
      "잠긴 세션",
    );
    return true;
  }

  /** 메뉴에서 고른 '세션 종료' — 잠긴 탭은 거부한다(잠금의 목적이 오조작 방지다). */
  private async runDisconnect(tab: TerminalTab): Promise<void> {
    if (await this.refuseIfLocked(tab)) return;
    this.disconnectTab(tab);
  }

  /** 메뉴에서 고른 재접속 — 살아 있는 연결을 끊고 다시 붙으므로 한 번 확인받는다. */
  private async reconnectFromMenu(tab: TerminalTab): Promise<void> {
    if (tab.status === "connected") {
      // 살아 있는 연결을 끊게 되므로 '종료' 와 같은 기준으로 잠금이 걸린다.
      if (await this.refuseIfLocked(tab)) return;
      const ok = await confirmDialog(
        `'${tabName(tab)}' 세션의 연결을 끊고 다시 접속할까요? 실행 중인 작업이 중단됩니다.`,
      );
      if (!ok) return;
      this.disconnectTab(tab);
    }
    await this.reconnect(tab);
  }

  /** 접속 중인 모든 세션을 '종료'(연결만 끊기)한다. 탭은 하나도 닫지 않는다. */
  /**
   * 열린 탭을 모두 닫는다. '접속된 모든 세션 종료'(연결만 끊고 탭 유지)와 짝이 되는 동작으로,
   * 이쪽은 탭 자체를 없앤다. 잠긴 탭은 하나씩 닫을 때와 같은 기준으로 건너뛴다 —
   * 그래야 잠금을 믿을 수 있다.
   */
  private async closeAll(): Promise<void> {
    const targets = this.tabs.filter((t) => !t.locked);
    const lockedCount = this.tabs.length - targets.length;
    if (targets.length === 0) {
      await alertDialog("열린 세션이 모두 잠겨 있어 닫을 세션이 없습니다.", "잠긴 세션");
      return;
    }
    const connected = targets.filter((t) => t.liveId).length;
    const ok = await confirmDialog(
      `열린 ${targets.length}개 세션을 모두 닫을까요?` +
        (connected > 0 ? `\n접속 중인 ${connected}개는 연결이 끊깁니다.` : "") +
        (lockedCount > 0 ? `\n잠긴 세션 ${lockedCount}개는 그대로 둡니다.` : ""),
    );
    if (!ok) return;
    // 닫으면서 배열이 줄어드므로 사본을 돌린다. 확인은 위에서 한 번만 받았으므로
    // 탭마다 다시 묻지 않도록 closeTab 대신 강제 닫기를 쓴다.
    for (const t of [...targets]) this.forceCloseTab(t);
  }

  private async disconnectAll(): Promise<void> {
    const connected = this.tabs.filter((t) => t.liveId);
    // 잠긴 탭은 건드리지 않는다 — 하나씩 끊을 때와 같은 기준이어야 잠금을 믿을 수 있다.
    const targets = connected.filter((t) => !t.locked);
    const lockedCount = connected.length - targets.length;
    if (targets.length === 0) {
      await alertDialog("접속 중인 세션이 모두 잠겨 있어 종료할 세션이 없습니다.", "잠긴 세션");
      return;
    }
    const ok = await confirmDialog(
      `접속 중인 ${targets.length}개 세션을 모두 종료할까요? 탭은 닫지 않고 연결만 끊습니다.` +
        (lockedCount > 0 ? `\n잠긴 세션 ${lockedCount}개는 그대로 둡니다.` : ""),
    );
    if (!ok) return;
    for (const t of targets) this.disconnectTab(t);
  }

  /** 편집·이름 변경 결과를 같은 세션을 쓰는 모든 탭에 반영한다(하나 더 열어 둔 경우 포함). */
  private applySessionUpdate(next: SessionInfo): void {
    for (const t of this.tabs) {
      if (t.session.id === next.id) t.setSession({ ...next });
    }
    this.renderTabbar();
    this.emitStatus();
  }

  private async runRename(tab: TerminalTab): Promise<void> {
    const name = await this.actions.rename?.(tab.session);
    if (!name) return;
    this.applySessionUpdate({ ...tab.session, name });
  }

  private async runEdit(tab: TerminalTab): Promise<void> {
    const edited = await this.actions.edit?.(tab.session);
    if (!edited) return;
    this.applySessionUpdate(edited);
  }

  private async closeTab(tab: TerminalTab): Promise<void> {
    // 탭바 ×·가운데 클릭·Ctrl+F4·타일 헤더 × 가 모두 여기로 모이므로 잠금 검사는 여기 하나면 된다.
    if (await this.refuseIfLocked(tab)) return;
    if (tab.status === "connected") {
      const ok = await this.confirmClose(tab.session.name || tab.session.host);
      if (!ok) return;
    }
    this.forceCloseTab(tab);
  }

  /**
   * 확인 없이 탭을 닫는다. 잠금·연결 확인은 호출자가 이미 했다고 본다 —
   * '모두 닫기' 처럼 한 번만 묻고 여러 개를 닫는 경우에 탭마다 다시 묻지 않기 위해 나눴다.
   */
  private forceCloseTab(tab: TerminalTab): void {
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

  /**
   * 세션 탭 우클릭 메뉴 구성. 성격별로 묶어 구분선을 넣는다 —
   * 세션 정의(편집·이름 변경) → 열기 계열 → 접속 계열 → 닫기·전체 종료.
   * 상황에 맞지 않는 항목은 아예 넣지 않는다(임시 세션의 편집, 로컬 셸의 SFTP 등).
   */
  private tabMenu(tab: TerminalTab): MenuItem[] {
    const s = tab.session;
    // 빠른 접속처럼 저장 목록에 없는 세션은 편집·이름 변경이 아무것도 남기지 못한다.
    const saved = this.actions.isSaved?.(s) ?? false;
    const items: MenuItem[] = [];

    if (saved && this.actions.edit) {
      items.push({ label: "세션 편집", accel: "e", action: () => void this.runEdit(tab) });
    }
    if (saved && this.actions.rename) {
      items.push({ label: "세션 이름 변경", accel: "n", action: () => void this.runRename(tab) });
    }
    if (items.length) items.push({ separator: true });

    // 같은 세션으로 접속을 하나 더 연다. tab.session 을 그대로 쓰므로 볼트에서 꺼낸
    // 비밀 값(트리거·시작 명령)이 이미 채워져 있어 다시 묻지 않는다.
    items.push({ label: "세션 하나 더 열기", accel: "d", action: () => void this.openSession(s) });
    // 로컬 셸과 SFTP 를 끈 세션에는 전송 항목을 넣지 않는다(사이드바와 같은 기준).
    if (this.actions.sftp && s.kind === "ssh" && s.enableSftp) {
      items.push({ label: "SFTP 파일 전송", accel: "f", action: () => this.actions.sftp?.(s) });
    }

    items.push({ separator: true });
    items.push({ label: "재접속", accel: "r", action: () => void this.reconnectFromMenu(tab) });
    if (tab.status === "connected") {
      // '닫기' 와 다르다 — 연결만 끊고 탭은 남겨 재접속 화면이 되게 한다.
      items.push({ label: "세션 종료", accel: "t", action: () => void this.runDisconnect(tab) });
    }

    // 이 탭만의 잠금이다. 앱 전체 볼트 잠금과 헷갈리지 않도록 '세션' 을 붙여 부른다.
    items.push({ separator: true });
    items.push(
      tab.locked
        ? { label: "세션 잠금 해제", accel: "l", action: () => this.setTabLocked(tab, false) }
        : { label: "세션 잠금", accel: "l", action: () => this.setTabLocked(tab, true) },
    );

    items.push({ separator: true });
    items.push({
      label: "세션 닫기",
      accel: "c",
      danger: true,
      action: () => void this.closeTab(tab),
    });
    // 접속이 하나뿐이면 위의 '세션 종료' 와 결과가 같아 굳이 내놓지 않는다.
    if (this.connectedCount() >= 2) {
      items.push({
        label: "접속된 모든 세션 종료",
        accel: "a",
        danger: true,
        action: () => void this.disconnectAll(),
      });
    }
    // 탭이 둘 이상일 때만 — 하나뿐이면 '세션 닫기' 와 같은 동작이라 메뉴만 늘어난다.
    if (this.tabs.length > 1) {
      items.push({
        label: "모든 세션 닫기",
        accel: "w",
        danger: true,
        action: () => void this.closeAll(),
      });
    }
    return items;
  }

  /**
   * 탭을 끌어 순서를 바꾼다.
   *
   * HTML5 드래그앤드롭 대신 마우스 이벤트로 처리한다. 탭바는 폭이 좁고 항목이 촘촘해
   * 놓을 자리를 픽셀 단위로 보여 줘야 하는데, dragover 는 자식 요소를 지날 때마다
   * 들락거려 표시가 깜빡인다. 좌표를 직접 보면 그 문제가 없다.
   *
   * 5px 을 넘겨야 드래그로 친다 — 그 전에는 그냥 클릭(탭 전환)이다.
   */
  private beginTabDrag(tab: TerminalTab, item: HTMLElement, down: MouseEvent): void {
    if (this.tabs.length < 2) return;
    const startX = down.clientX;
    this.dragMoved = false;
    let dropAt = -1; // 삽입될 위치(this.tabs 기준 인덱스)

    const clearMarks = () => {
      for (const el of this.tabbar.children) el.classList.remove("drop-before", "drop-after");
    };

    const onMove = (m: MouseEvent) => {
      if (!this.dragMoved) {
        if (Math.abs(m.clientX - startX) < 5) return;
        this.dragMoved = true;
        item.classList.add("dragging");
        document.body.classList.add("dragging-tab");
      }
      clearMarks();
      // 커서가 어느 탭의 어느 쪽에 있는지로 삽입 위치를 정한다.
      const items = [...this.tabbar.children] as HTMLElement[];
      dropAt = items.length; // 기본값 = 맨 끝
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (m.clientX < r.left + r.width / 2) {
          dropAt = i;
          break;
        }
      }
      const from = this.tabs.indexOf(tab);
      // 제자리(자기 앞/뒤)면 표시하지 않는다 — 옮겨지지 않는데 선이 보이면 헷갈린다.
      if (dropAt === from || dropAt === from + 1) {
        dropAt = -1;
        return;
      }
      if (dropAt < items.length) items[dropAt].classList.add("drop-before");
      else items[items.length - 1].classList.add("drop-after");
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dragging-tab");
      item.classList.remove("dragging");
      clearMarks();
      if (this.dragMoved && dropAt >= 0) {
        const from = this.tabs.indexOf(tab);
        this.tabs.splice(from, 1);
        // 앞쪽에서 빼냈으면 목표 인덱스가 하나 당겨진다.
        this.tabs.splice(dropAt > from ? dropAt - 1 : dropAt, 0, tab);
        this.renderTabbar();
        // 타일 모드에서는 탭 순서가 곧 화면 배치 순서라 다시 깔아야 한다.
        if (this.viewMode !== "tabs") this.layout(false);
      }
      // click 은 mouseup 뒤에 온다 — 다음 프레임에 풀어야 그 클릭을 걸러낼 수 있다.
      setTimeout(() => {
        this.dragMoved = false;
      }, 0);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private renderTabbar(): void {
    this.tabbar.innerHTML = "";
    for (const tab of this.tabs) {
      const cls =
        "tab" +
        (tab === this.active ? " active" : "") +
        (tab.locked ? " locked" : "") +
        (tab.status === "disconnected" ? " dead" : tab.activity ? " activity" : "") +
        (this.bcastKeys?.has(tab.key) ? " bcast" : "");
      const item = el("div", cls);

      const dot = el("span", "tab-dot " + tab.status);
      const label = el("span", "tab-label");
      label.textContent = tab.session.name || `${tab.session.user}@${tab.session.host}`;
      label.title = tab.session.name || tab.session.host;

      const close = document.createElement("button");
      close.className = "tab-close";
      applyIcon(close, "cancel");
      close.title = "세션 닫기";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void this.closeTab(tab);
      });

      item.append(dot);
      // 잠긴 탭은 자물쇠로 눈에 띄게 — 입력이 안 먹는 이유를 탭에서도 알 수 있어야 한다.
      if (tab.locked) {
        const lock = iconSpan("lock", "tab-lock");
        lock.title = "잠긴 세션 — 입력·종료·닫기가 막혀 있습니다";
        item.append(lock);
      }
      item.append(label, close);
      item.addEventListener("click", () => {
        // 방금 끌어서 옮긴 것이면 활성화하지 않는다 — 놓는 순간 탭이 바뀌면
        // 옮기려던 것인지 고르려던 것인지 알 수 없게 된다.
        if (this.dragMoved) return;
        this.activate(tab);
      });
      item.addEventListener("mousedown", (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          void this.closeTab(tab);
          return;
        }
        if (ev.button === 0) this.beginTabDrag(tab, item, ev);
      });
      item.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.activate(tab); // 어느 탭에 대한 메뉴인지 눈으로 분명히
        showContextMenu(ev.clientX, ev.clientY, this.tabMenu(tab));
      });
      this.tabbar.appendChild(item);
    }
    // 탭바를 다시 그리는 시점 = 탭 추가/삭제·접속 상태 변화가 확정된 시점.
    for (const fn of this.tabsChanged) fn();
  }
}

/** 확인 문구에 쓸 탭 표시 이름 — 이름이 없으면 호스트로 대신한다. */
function tabName(tab: TerminalTab): string {
  return tab.session.name || tab.session.host || "세션";
}

function el(tag: string, className: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = className;
  return e;
}
