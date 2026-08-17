// 탭 관리자 — 탭 수명·전환·분할 배치·동시 명령. TerminalTab 은 termtab.ts.
// 다중 탭 터미널 관리. 각 탭 = xterm 인스턴스 하나 + 하나의 live SSH 세션.
// 설정(테마·폰트·크기·커서·스크롤백) 적용, 선택→자동복사+토스트, 우클릭 복사/붙여넣기,
// 검색(Ctrl+Shift+F), Ctrl+휠 zoom, Ctrl+Enter=LF, 탭 상태색, 탭 단축키, 상태바 연동.

import { applyIcon, iconSpan } from "./icons";
import { showContextMenu } from "./contextmenu";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { confirmDialog, alertDialog, appToast } from "./dialogs";
import type { SessionInfo } from "./types";
import { sessionColorCss } from "./types";
import type { Settings } from "./settings";
import { sshConnect, b64ToBytes, localOpen, onSshData, onSshClosed, localWriteText } from "./ipc";

import {
  TerminalTab,
  isLocal,
  writeTo,
  resizeTo,
  closeOf,
  LOCAL_CREDS,
  el,
  type CredentialProvider,
  type ResolvedCreds,
  type ViewMode,
  type TabActions,
  type StatusInfo,
} from "./termtab";
import { beginTabDrag } from "./tabdrag";
import { tabMenu } from "./tabmenu";
import { blockedByDisabled } from "./sessionflow";
import { broadcastTargets, broadcastTo, pruneKeys } from "./tabbroadcast";
import {
  scheduleAutoReconnect,
  cancelAutoReconnect,
  type AutoState,
} from "./tabreconnect";
// 기존 소비자(main.ts 등)가 "./tabs" 에서 가져가던 공개 타입·상수는 그대로 통한다.
export type { CredentialProvider, ResolvedCreds, CredResolution, StatusInfo, TabActions, ViewMode } from "./termtab";

/**
 * 저장본(파일에 남는 것)으로 탭의 세션을 갱신하되, 볼트에서 메모리로만 채워 둔 비밀 값은
 * 지금 들고 있는 것을 남긴다. 저장본에서는 그 값이 비워져 있어(extractSecrets) 그대로
 * 덮으면 접속 중인 탭의 비밀 트리거·시작 명령이 빈 값이 된다.
 *
 * 비밀 트리거의 짝은 '비밀 표시된 규칙의 순서' 로 맞춘다 — hydrateSecrets 가 볼트에서
 * 되채울 때 쓰는 규칙과 같아야 어긋나지 않는다.
 */
function keepSecrets(cur: SessionInfo, saved: SessionInfo): SessionInfo {
  const prevSends = cur.triggers.filter((t) => t.secret).map((t) => t.send);
  let n = 0;
  return {
    ...saved,
    startupCommands:
      saved.startupCommandsSecret && !saved.startupCommands
        ? cur.startupCommands
        : saved.startupCommands,
    triggers: saved.triggers.map((t) => {
      if (!t.secret) return t;
      const prev = prevSends[n++];
      return t.send ? t : { ...t, send: prev ?? "" };
    }),
  };
}

export class TabManager {
  private readonly tabs: TerminalTab[] = [];
  private readonly byLiveId = new Map<string, TerminalTab>();
  /** 아직 탭에 연결되기 전에 도착한 종료 이벤트(liveId → 사유). */
  private readonly pendingClosed = new Map<string, string>();
  /** 접속 응답보다 먼저 도착한 출력(포워딩 상태 배너 등)을 잠시 보관한다. */
  private readonly pendingData = new Map<string, Uint8Array[]>();
  private active: TerminalTab | null = null;
  private settings: Settings;
  private viewMode: ViewMode = "tabs";
  /**
   * 분할 보기에 올린 탭들(0.80.0). 예전에는 열린 세션을 전부 나눠 보여 줬는데, 탭이
   * 대여섯 개면 한 칸이 너무 좁아 읽을 수 없었다 — 볼 것만 골라 담는다.
   * 탭 객체를 그대로 담는다: 같은 세션을 두 번 열 수 있어 세션 id 로는 구분되지 않는다.
   */
  private splitTabs = new Set<TerminalTab>();
  /**
   * 일반창으로 돌아갈 때 남겨 두는 직전 선택 — **세로·가로가 따로** 기억한다(0.80.1).
   * 넉 대씩 나란히 보는 묶음과 여섯 대를 층으로 보는 묶음이 서로 다르기 때문이다
   * (사용자 보고). 하나로 합쳐 두면 방향을 바꿀 때마다 다시 골라야 했다.
   */
  private savedSplit: Record<"vertical" | "horizontal", TerminalTab[]> = {
    vertical: [],
    horizontal: [],
  };
  private refitPending = false;
  /** 탭을 끄는 중이었는지 — 놓은 직후의 click 을 걸러내기 위해 잠깐 남긴다. */
  private dragMoved = false;
  /** 동시 명령이 겨눈 탭 키(null = 표시 안 함). 탭바 강조에만 쓴다. */
  private bcastKeys: ReadonlySet<string> | null = null;
  /** 자동 재접속 예약 상태(타이머·시도 횟수). 규칙은 tabreconnect.ts. */
  private readonly autoState: AutoState = { timers: new Map(), tries: new Map() };
  /** 수신 이벤트발 상태바 갱신의 마지막 시각 — 폭주 출력에서 DOM 갱신을 초당 4회로 제한. */
  private lastRxStatusAt = 0;
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
      const bytes = b64ToBytes(e.data);
      const tab = this.byLiveId.get(e.id);
      if (!tab) {
        // 아직 이 id 가 탭에 연결되기 전 — 버려지지 않게 보관해 두었다가 연결 시 반영.
        // 상한은 push **전에** 검사해야 한다 — get() 이 준 배열을 밀어 넣고 set 만
        // 생략하는 방식은 Map 안의 같은 배열이라 아무것도 못 막았다(진단 0.62.0).
        // 상한 초과 시 새 조각을 버린다(가장 오래된 것을 버리면 이스케이프 시퀀스가
        // 중간부터 재생돼 화면이 깨진다 — 늦은 출력이 잘리는 쪽이 안전하다).
        const buf = this.pendingData.get(e.id);
        if (!buf) {
          this.pendingData.set(e.id, [bytes]);
          window.setTimeout(() => this.pendingData.delete(e.id), 10_000);
        } else if (buf.length < 200) {
          buf.push(bytes);
        }
        return;
      }
      tab.writeBytes(bytes);
      // '아직 안 본 출력' 표시. 분할 보기에서는 모든 터미널이 눈앞에 있으므로 켜지 않는다
      // — 보고 있는 화면에 "안 봤다" 표시가 뜨면 표시 자체를 못 믿게 된다.
      if (tab !== this.active && this.viewMode === "tabs" && !tab.activity) {
        tab.activity = true;
        this.renderTabbar();
      }
      // 수신 조각마다 상태바 DOM 을 갱신하면 폭주 출력에서 그 비용만으로도 상당하다
      // — 사람 눈에는 초당 4회면 충분하다(0.61.0).
      if (tab === this.active) {
        const now = Date.now();
        if (now - this.lastRxStatusAt > 250) {
          this.lastRxStatusAt = now;
          this.emitStatus();
        }
      }
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
      // 예기치 않게 끊긴 경우에만 자동 재접속을 건다 — 사용자가 끊었거나 탭을 닫은
      // 경로(disconnectTab·closeTab)는 여기를 지나지 않는다(매핑을 먼저 지우므로).
      this.scheduleAutoReconnect(tab);
    });

    // 패널 영역 크기가 바뀌면 항상 터미널을 다시 맞춘다 — 창 리사이즈뿐 아니라
    // 동시명령 창 토글·사이드바 폭 조절처럼 window resize 가 안 뜨는 경우까지 커버.
    // (안 하면 줄어들었던 영역이 터미널 배경(검은색)으로 남는다.) rAF 로 합쳐 과호출 방지.
    //
    // 크기가 멎은 뒤 한 번 더 맞추는 이유(0.78.2):
    // 전체화면으로 키우면 커서가 글자와 어긋나 밀려 보이는 일이 가끔 있었다. 창 크기를
    // 줄였다 되돌리면 사라졌다 — 즉 **다시 재면 낫는다**. 전환이 진행되는 동안 잰 크기가
    // 캐시(fittedAt)에 박히면 그 뒤로는 같은 크기로 보여 다시 재지 않기 때문이다.
    // 변화가 멎고 나서 캐시를 버리고 한 번 더 맞춘다 — 사용자가 손으로 하던 일을 대신한다.
    let settleTimer = 0;
    const scheduleRefit = (remeasure = false) => {
      // 배율이 바뀌면 CSS 크기는 그대로라 캐시에 걸려 다시 재지 못한다 — 캐시를 버린다.
      if (remeasure) for (const t of this.tabs) t.invalidateFit();
      if (!this.refitPending) {
        this.refitPending = true;
        requestAnimationFrame(() => {
          this.refitPending = false;
          this.fitActive();
        });
      }
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        for (const t of this.tabs) t.invalidateFit();
        this.fitActive();
      }, 250);
    };
    window.addEventListener("resize", () => scheduleRefit());
    new ResizeObserver(() => scheduleRefit()).observe(this.panes);

    // 듀얼모니터에서 배율이 다른 화면으로 창을 옮기면 devicePixelRatio 가 바뀐다.
    // CSS 픽셀 크기가 그대로여도(→ ResizeObserver 안 뜸) 셀 계측이 어긋날 수 있으니
    // DPR 변화를 직접 감지해 refit. 미디어쿼리는 특정 배율에 고정돼 한 번 쓰고 재등록한다.
    const watchDpr = () => {
      window
        .matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        .addEventListener(
          "change",
          () => {
            scheduleRefit(true); // 배율 변화 — 셀 계측부터 다시
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

  /**
   * 탭 / 세로 분할 / 가로 분할 전환. 세션·연결 상태는 그대로 유지된다.
   *
   * 분할로 들어갈 때 대상이 정해져 있지 않으면 열린 탭 전부를 담는다 — 설정 복원처럼
   * 사람이 고를 기회가 없는 경로가 그렇다. 사람이 고르는 길은 startSplit 이다.
   */
  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (mode === "tabs") this.stashSplit();
    else if (this.splitTabs.size === 0) this.splitTabs = new Set(this.tabs);
    this.renderTabbar();
    this.layout();
  }

  /** 분할 보기에 올릴 탭 후보 — 지금 열려 있는 탭 전부(선택 창이 목록으로 쓴다). */
  splitCandidates(): TerminalTab[] {
    return [...this.tabs];
  }

  /**
   * 그 방향의 분할 구성. 지금 그 방향으로 분할 중이면 화면에 올라 있는 것, 아니면
   * 저장해 둔 것 — 고르는 창이 무엇을 미리 체크할지 여기서 정한다.
   */
  splitOf(mode: Exclude<ViewMode, "tabs">): TerminalTab[] {
    if (this.viewMode === mode && this.splitTabs.size > 0) {
      return this.tabs.filter((t) => this.splitTabs.has(t));
    }
    return this.savedSplit[mode].filter((t) => this.tabs.includes(t));
  }

  /** 그 방향에 되살릴 구성이 남아 있는가 — 분할 버튼 표시를 방향별로 켠다. */
  hasSavedSplit(mode: Exclude<ViewMode, "tabs">): boolean {
    return this.savedSplit[mode].filter((t) => this.tabs.includes(t)).length > 0;
  }

  /**
   * 고른 탭들로 분할을 시작한다.
   * 하나도 고르지 않았으면 분할을 푼다 — 고르는 창에서 전부 해제하는 것이 곧
   * "이 방향은 이제 안 쓴다"는 뜻이라, 그 방향의 구성도 함께 비운다(사용자 요청).
   */
  startSplit(mode: Exclude<ViewMode, "tabs">, picked: TerminalTab[]): boolean {
    const keep = picked.filter((t) => this.tabs.includes(t));
    if (keep.length === 0) {
      this.savedSplit[mode] = [];
      this.splitTabs.clear();
      this.viewMode = "tabs";
      this.renderTabbar();
      this.layout();
      return true;
    }
    this.savedSplit[mode] = keep;
    this.splitTabs = new Set(keep);
    this.viewMode = mode;
    // 보고 있던 탭이 분할에서 빠졌으면 분할 안의 첫 탭으로 옮긴다 — 활성 탭이 화면에
    // 없으면 키보드 입력이 보이지 않는 곳으로 들어간다.
    if (!this.active || !this.splitTabs.has(this.active)) this.active = keep[0];
    this.renderTabbar();
    this.layout();
    return true;
  }

  /** 그 방향의 직전 구성으로 되살린다. 남은 것이 없으면 false(고르는 창을 띄울 차례다). */
  restoreSplit(mode: Exclude<ViewMode, "tabs">): boolean {
    const keep = this.savedSplit[mode].filter((t) => this.tabs.includes(t));
    if (keep.length === 0) return false;
    return this.startSplit(mode, keep);
  }

  /** 일반창으로 — 지금 선택을 남겨 두고 분할을 푼다. */
  exitSplit(): void {
    this.viewMode = "tabs";
    this.stashSplit();
    this.renderTabbar();
    this.layout();
  }

  /** 지금 분할 선택을 그 방향의 '직전 구성' 으로 옮긴다(일반창 전환 직전에 부른다). */
  private stashSplit(): void {
    if (this.splitTabs.size === 0) return;
    const mode = this.viewMode;
    if (mode === "vertical" || mode === "horizontal") {
      this.savedSplit[mode] = this.tabs.filter((t) => this.splitTabs.has(t));
    }
    this.splitTabs.clear();
  }

  /** 이 탭이 지금 분할 화면에 올라 있는가(탭바 흐림 표시·클릭 경고 판단). */
  isInSplit(tab: TerminalTab): boolean {
    return this.viewMode !== "tabs" && this.splitTabs.has(tab);
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  /** 현재 뷰 모드에 맞춰 패널 배치를 갱신하고 모든 보이는 터미널을 다시 맞춘다. */
  /** 활성 탭의 터미널로 포커스를 보낸다 — 화면을 덮는 창을 닫은 뒤 돌아갈 자리. */
  focusActive(): void {
    this.active?.focus();
  }

  private layout(focusActive = true): void {
    const tiled = this.viewMode !== "tabs";
    this.panes.classList.toggle("tile", tiled);
    this.panes.style.gridTemplateColumns = "";
    this.panes.style.gridTemplateRows = "";

    // 분할에 올린 탭만 화면에 세운다(0.80.0) — 예전에는 열린 탭 전부였다.
    const shown = tiled ? this.tabs.filter((t) => this.splitTabs.has(t)) : [];
    if (tiled) {
      const n = Math.max(1, shown.length);
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

    // 타일 배치는 DOM 순서를 따른다 — 탭 순서를 바꿔도(드래그) 화면에 반영되지 않아
    // 분할 보기에서는 '연 순서' 가 그대로 남았다(0.70.0 수정). 순서가 어긋날 때만
    // 다시 붙인다: appendChild 는 이미 붙어 있는 노드를 옮기므로, 같은 순서면 건드리지
    // 않아 터미널이 흔들리지 않는다.
    const domOrder = [...this.panes.children];
    const sameOrder =
      domOrder.length === this.tabs.length && this.tabs.every((t, i) => domOrder[i] === t.root);
    if (!sameOrder) {
      for (const t of this.tabs) this.panes.appendChild(t.root);
    }

    for (const t of this.tabs) {
      // 타일 모드에서는 분할에 올린 것만, 탭 모드에서는 활성 탭만 보인다.
      t.root.classList.toggle("visible", tiled ? this.splitTabs.has(t) : t === this.active);
      t.root.classList.toggle("focused", tiled && t === this.active);
    }
    this.emptyState.style.display = this.tabs.length ? "none" : "flex";

    requestAnimationFrame(() => {
      for (const t of this.tabs) {
        if (tiled ? !this.splitTabs.has(t) : t !== this.active) continue;
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
    // 분할 중이면 새 탭을 분할에 넣지 않고, 화면도 넘기지 않는다(0.80.0) — 골라 둔 배치를
    // 세션 하나 연다고 무너뜨리지 않기 위해서다. 탭바에 흐리게 서 있다가, 눌러서
    // 옮겨 갈 때 분할을 닫을지 묻는다. 무엇이 일어났는지 모르지 않도록 알린다.
    if (this.viewMode !== "tabs" && this.splitTabs.size > 0) {
      appToast(`'${session.name || session.host}' 은(는) 분할 밖에 열렸습니다 — 탭을 누르면 옮겨 갑니다`);
    } else {
      this.activate(tab);
    }
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
    return broadcastTargets(this.tabs);
  }

  /**
   * 여러 세션에 같은 입력을 보낸다. `keys` 를 주면 그 탭들만, 없으면 접속된 전부.
   * 규칙(잠긴 탭 건너뛰기·실패 집계)은 tabbroadcast.ts 에 있다.
   */
  broadcast(
    data: Uint8Array,
    keys?: ReadonlySet<string>,
  ): Promise<{ sent: number; locked: number; failed: string[] }> {
    return broadcastTo(this.tabs, data, keys);
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
    return pruneKeys(this.tabs, keys);
  }

  /** 활성 탭의 찾기 창을 연다(타이틀바 버튼용). 열린 탭이 없으면 아무 일도 하지 않는다. */
  openSearch(): void {
    this.active?.openSearch();
  }

  /** 이 세션의 탭이 이미 있으면 그 탭으로 이동하고 true(빠른 찾기용). */
  focusSession(sessionId: string): boolean {
    const tab = this.tabs.find((t) => t.session.id === sessionId);
    if (!tab) return false;
    this.activate(tab);
    tab.focus();
    return true;
  }

  /** 지금 열려 있는 탭들의 세션 id(중복 가능) — 빠른 찾기의 '열림' 배지에 쓴다. */
  /** 지금 보고 있는 탭의 세션(없으면 null) — 단축키가 '현재 세션' 에 명령할 때 쓴다. */
  activeSession(): SessionInfo | null {
    return this.active?.session ?? null;
  }

  openSessionIds(): string[] {
    return this.tabs.map((t) => t.session.id);
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
    // 분할 중에는 화면에 올라 있는 탭 사이에서만 돈다 — 안 보이는 탭으로 넘어가면
    // 분할이 통째로 풀려 버려서, 탭을 훑어보는 동작으로는 지나치다.
    const ring =
      this.viewMode !== "tabs" && this.splitTabs.size > 0
        ? this.tabs.filter((t) => this.splitTabs.has(t))
        : this.tabs;
    if (ring.length < 2 || !this.active) return;
    const i = ring.indexOf(this.active);
    if (i < 0) return;
    const next = ring[(i + dir + ring.length) % ring.length];
    this.activate(next);
  }

  /**
   * 자동 재접속 예약(0.67.0). 세션 옵션이 켜져 있고 시도 횟수가 남았을 때만.
   *
   * 사람이 끊은 경우에는 부르지 않는다 — 끊자마자 스스로 다시 붙으면 '끊기'가 고장 난
   * 것처럼 보인다. 시도 횟수를 넘기면 멈추고 안내만 남긴다(무한 재시도 금지 — 잠긴
   * 계정을 만들거나 서버 로그를 채운다).
   */
  private scheduleAutoReconnect(tab: TerminalTab): void {
    scheduleAutoReconnect(this.autoState, tab, () => void this.reconnect(tab));
  }

  private cancelAutoReconnect(tab: TerminalTab): void {
    cancelAutoReconnect(this.autoState, tab);
  }

  private async reconnect(tab: TerminalTab): Promise<void> {
    this.cancelAutoReconnect(tab); // 손으로 눌렀으면 예약분은 버린다
    // 접속을 막아 둔 세션이면 다시 붙지 않는다 — 자동 재접속도 여기를 지난다.
    if (blockedByDisabled(tab.session)) return;
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
      this.autoState.tries.delete(tab); // 붙었으니 자동 재접속 시도 횟수를 초기화한다
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

  /**
   * 탭을 눌렀을 때. 분할 화면에 없는 탭이면 분할이 닫힌다는 것을 먼저 알린다 —
   * 눌러 보고 나서야 배치가 무너진 것을 아는 일이 없도록.
   */
  private async pickTab(tab: TerminalTab): Promise<void> {
    if (this.viewMode !== "tabs" && !this.splitTabs.has(tab)) {
      const ok = await confirmDialog(
        `'${tabName(tab)}' 은(는) 지금 분할 화면에 없습니다.\n` +
          "분할 보기를 닫고 이 세션으로 전환할까요?\n" +
          "(분할 구성은 남아 있어 분할 버튼으로 되살릴 수 있습니다)",
      );
      if (!ok) return;
    }
    this.activate(tab);
  }

  private activate(tab: TerminalTab): void {
    // 분할 화면에 없는 탭으로 옮기면 분할을 푼다 — 보이지 않는 터미널에 키보드가
    // 들어가면 어디에 치고 있는지 알 수 없다. 마우스로 누른 경우에는 그 전에
    // pickTab 이 한 번 묻는다(0.80.0).
    if (this.viewMode !== "tabs" && !this.splitTabs.has(tab)) {
      this.viewMode = "tabs";
      this.stashSplit();
    }
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
    this.cancelAutoReconnect(tab); // 사람이 끊었다 — 스스로 다시 붙지 않는다
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

  /**
   * 스크롤백을 텍스트 파일로 내보낸다.
   *
   * 세션 로그(enableLog)와 다르다 — 그쪽은 미리 켜 둔 세션만, 접속하는 동안 계속
   * 쌓는다. 이건 "지금 화면에 남아 있는 것"을 필요할 때 한 번 뽑는 것이라, 문제를
   * 만난 뒤에도 늦지 않다.
   */
  private async exportScrollback(tab: TerminalTab): Promise<void> {
    const text = tab.scrollbackText();
    if (!text.trim()) {
      appToast("저장할 내용이 없습니다.");
      return;
    }
    const stamp = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const safe = (tabName(tab) || "session").replace(/[\\/:*?"<>|]/g, "_");
    const target = await saveDialog({
      defaultPath:
        `${safe}-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}` +
        `-${p2(stamp.getHours())}${p2(stamp.getMinutes())}.txt`,
      filters: [{ name: "텍스트 파일", extensions: ["txt", "log"] }],
    });
    if (!target) return;
    try {
      await localWriteText(target, text);
      appToast(`스크롤백을 저장했습니다 — ${text.split("\r\n").length}줄`);
    } catch (e) {
      await alertDialog(`저장하지 못했습니다: ${String(e)}`);
    }
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

  /**
   * 저장 목록이 바뀔 때마다(사이드바 편집·이름 변경·폴더 이동·드래그 등) 열려 있는 탭이
   * 들고 있는 세션 정보를 최신으로 맞춘다.
   *
   * 왜 필요한가: 탭은 열릴 때 받은 세션을 계속 들고 있었다. 그래서 접속한 뒤 사이드바에서
   * 고치면 그 내용이 탭에 닿지 않아, 탭 우클릭 '세션 편집' 이 옛 내용으로 열렸다(사용자
   * 보고). 라벨·색 같은 표시도 함께 뒤처졌다.
   */
  syncFromSaved(list: SessionInfo[]): void {
    const saved = new Map(list.map((s) => [s.id, s]));
    let changed = false;
    for (const t of this.tabs) {
      const next = saved.get(t.session.id);
      if (!next) continue; // 빠른 접속(저장 안 함)·삭제된 세션은 들고 있던 것을 그대로 둔다
      const merged = keepSecrets(t.session, next);
      if (JSON.stringify(merged) === JSON.stringify(t.session)) continue;
      t.setSession(merged);
      changed = true;
    }
    if (!changed) return;
    this.renderTabbar();
    this.emitStatus();
  }

  /** 편집·이름 변경 결과를 같은 세션을 쓰는 모든 탭에 반영한다(하나 더 열어 둔 경우 포함). */
  applySessionUpdate(next: SessionInfo): void {
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
    this.cancelAutoReconnect(tab); // 닫는 탭에 예약이 남아 유령 접속이 생기지 않게
    this.autoState.tries.delete(tab);
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
    this.splitTabs.delete(tab);
    this.savedSplit.vertical = this.savedSplit.vertical.filter((t) => t !== tab);
    this.savedSplit.horizontal = this.savedSplit.horizontal.filter((t) => t !== tab);
    // 분할에 올린 것이 하나도 남지 않으면 일반창으로 — 빈 격자만 남으면 갇힌다.
    if (this.viewMode !== "tabs" && this.splitTabs.size === 0) this.viewMode = "tabs";
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
        (tab.locked ? " locked" : "") +
        (tab.status === "disconnected" ? " dead" : tab.activity ? " activity" : "") +
        (this.bcastKeys?.has(tab.key) ? " bcast" : "") +
        // 분할 중인데 화면에 올라 있지 않은 탭 — 흐리게 둔다(눌러 보기 전에 알 수 있게).
        (this.viewMode !== "tabs" && !this.splitTabs.has(tab) ? " off-split" : "");
      const item = el("div", cls);
      // 세션 색 태그 — 목록과 같은 색을 탭에도 둔다(운영 탭을 한눈에).
      const tabColor = sessionColorCss(tab.session.color);
      if (tabColor) {
        item.classList.add("has-color");
        item.style.setProperty("--session-color", tabColor);
      }

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
        void this.pickTab(tab);
      });
      item.addEventListener("mousedown", (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          void this.closeTab(tab);
          return;
        }
        if (ev.button === 0)
          beginTabDrag(
            {
              tabbar: this.tabbar,
              tabs: this.tabs,
              viewMode: this.viewMode,
              getDragMoved: () => this.dragMoved,
              setDragMoved: (v) => {
                this.dragMoved = v;
              },
              layout: (f) => this.layout(f),
              renderTabbar: () => this.renderTabbar(),
            },
            tab,
            item,
            ev,
          );
      });
      item.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.activate(tab); // 어느 탭에 대한 메뉴인지 눈으로 분명히
        showContextMenu(ev.clientX, ev.clientY, tabMenu(
            {
              tabs: this.tabs,
              actions: this.actions,
              connectedCount: () => this.connectedCount(),
              openSession: (x) => this.openSession(x),
              closeTab: (t) => this.closeTab(t),
              closeAll: () => this.closeAll(),
              disconnectAll: () => this.disconnectAll(),
              runDisconnect: (t) => this.runDisconnect(t),
              reconnectFromMenu: (t) => this.reconnectFromMenu(t),
              runRename: (t) => this.runRename(t),
              runEdit: (t) => this.runEdit(t),
              setTabLocked: (t, v) => this.setTabLocked(t, v),
              exportScrollback: (t) => void this.exportScrollback(t),
            },
            tab,
          ));
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
