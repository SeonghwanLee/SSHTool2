// 화면 배선 — 설정창·분할보기·호스트키 프롬프트·사이드바 폭·자동잠금·화면보호기·
// 창버튼·잠금 단축키·상태바. main.ts 에서 분리(0.67.0 정지작업). 로직 변경 없음.

import type { TabManager, StatusInfo } from "./tabs";
import type { Sidebar } from "./sidebar";
import { settings, setSettings, applyDisplayOptions, tabManager, sessions, connectSession } from "./appstate";
import { saveSettings, type Settings, type ViewModeSetting } from "./settings";
import { settingsDialog } from "./settingsdialog";
import { SIDEBAR_MIN_W, SIDEBAR_MAX_W } from "./settings";
import { applyAppTheme, themeById } from "./themes";
import { setDebugLogging } from "./debuglog";
import { onHostKeyPrompt, hostKeyAnswer, vaultLock, windowFitToScreen } from "./ipc";
import { hostKeyPrompt, confirmDialog, appToast } from "./dialogs";
import { applyIcon } from "./icons";
import { pickSplitTargets } from "./splitpicker";
import { openGroupMenu } from "./splitgroups";
import { openSftpFor } from "./sessionflow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showScreensaver, hideScreensaver, isScreensaverOn } from "./screensaver";
import { reflectLock, changeMasterFlow, toggleAutoUnlock } from "./vaultflow";
import { initPalette, togglePalette } from "./palette";
import { hydrateSecrets } from "./sessionflow";
import { keystoreHas } from "./ipc";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

export function wireSettings(tabs: TabManager): void {
  const applyLive = (live: Settings) => {
    setSettings(live);
    applyAppTheme(themeById(live.theme));
    tabs.applySettings(live);
    applyDisplayOptions(live);
    restartAutoLock();
    restartScreensaver();
  };
  $("open-settings").addEventListener("click", async () => {
    const { saved, settings: result } = await settingsDialog(
      settings,
      applyLive,
      () => void changeMasterFlow(),
      {
        initial: await keystoreHas().catch(() => false),
        toggle: (enable) => toggleAutoUnlock(enable),
      },
    );
    if (saved) {
      // '저장'을 누른 경우에만 디스크에 기록한다.
      applyLive(result);
      // 켜면 파일을 새로 시작하고, 끄면 남은 줄을 흘려보낸다.
      void setDebugLogging(settings.verboseLog);
      try {
        await saveSettings(settings);
      } catch (e) {
        console.error("설정 저장 실패", e);
      }
    }
    // 취소면 settingsDialog 가 이미 onLive(original) 로 되돌렸으므로 아무것도 하지 않는다.
  });
}

/** 뷰 모드(탭/세로 분할/가로 분할) 버튼. 선택은 설정에 저장된다. */
export function wireViewModes(tabs: TabManager): void {
  const buttons: [string, ViewModeSetting][] = [
    ["view-tabs", "tabs"],
    ["view-vertical", "vertical"],
    ["view-horizontal", "horizontal"],
  ];
  /**
   * 버튼 상태 갱신. 지금 보기 모드에 'active', 되살릴 분할 구성이 남아 있으면
   * 분할 버튼에 'has-split' 을 얹어 색으로 알린다 — 한 번 누르면 그대로 돌아온다는 표시다.
   */
  const mark = () => {
    const mode = tabs.getViewMode();
    for (const [id, m] of buttons) $(id).classList.toggle("active", m === mode);
    // 표시는 방향별로 — 세로와 가로가 각자 구성을 기억한다(0.80.1).
    for (const id of ["view-vertical", "view-horizontal"] as const) {
      const dir = id === "view-vertical" ? "vertical" : "horizontal";
      const saved = mode !== dir && tabs.hasSavedSplit(dir);
      $(id).classList.toggle("has-split", saved);
      $(id).title = saved
        ? `${dir === "vertical" ? "세로" : "가로"} 분할 — 직전에 고른 세션으로 되살립니다(다시 누르면 세션을 고릅니다)`
        : `${dir === "vertical" ? "세로" : "가로"} 분할 — 나눠서 볼 세션을 고릅니다`;
    }
  };
  const remember = async (mode: ViewModeSetting) => {
    setSettings({ ...settings, viewMode: mode });
    try {
      await saveSettings(settings);
    } catch (e) {
      console.error("뷰 모드 저장 실패", e);
    }
  };

  $("view-tabs").addEventListener("click", () => {
    tabs.exitSplit();
    mark();
    void remember("tabs");
  });

  for (const id of ["view-vertical", "view-horizontal"] as const) {
    const mode = id === "view-vertical" ? "vertical" : "horizontal";
    $(id).addEventListener("click", async () => {
      const already = tabs.getViewMode() === mode;
      // 이미 그 분할 중이면 '고르기', 아니면 직전 선택으로 되살리기. 되살릴 것이
      // 없을 때만 고르는 창을 띄운다 — 늘 물으면 빠르게 오가는 데 방해가 된다.
      if (!already && tabs.restoreSplit(mode)) {
        mark();
        void remember(mode);
        return;
      }
      const open = tabs.splitCandidates();
      if (open.length === 0) {
        appToast("열려 있는 세션이 없습니다 — 먼저 세션에 접속하세요");
        return;
      }
      const now = new Set(tabs.splitOf(mode));
      const picked = await pickSplitTargets(
        $(id),
        open.map((t) => ({
          item: t,
          label: t.session.name || t.session.host,
          detail: t.session.kind === "local" ? "로컬 셸" : `${t.session.user}@${t.session.host}`,
          // 고른 적이 없으면 전부 켜 둔다 — 예전 동작(전부 분할)이 기본값이 된다.
          checked: now.size === 0 ? true : now.has(t),
        })),
        mode === "vertical" ? "세로로 나눠 볼 세션" : "가로로 나눠 볼 세션",
      );
      if (!picked) return;
      tabs.startSplit(mode, picked); // 빈 목록이면 분할이 풀린다(그 방향 구성도 비운다)
      mark();
      void remember(picked.length > 0 ? mode : "tabs");
    });
  }

  // ── 분할 그룹(0.81.0) ──
  $("split-groups").addEventListener("click", () => {
    openGroupMenu($("split-groups"), {
      groups: () => settings.splitGroups ?? [],
      sessions: () => sessions,
      save: (next) => {
        setSettings({ ...settings, splitGroups: next });
        void saveSettings(settings).catch((e) => console.error("분할 그룹 저장 실패", e));
        mark();
      },
      currentSplit: () => {
        const mode = tabs.getViewMode();
        if (mode === "tabs") return null;
        const ids = tabs.splitOf(mode).map((t) => t.session.id);
        return ids.length ? { mode, sessionIds: ids } : null;
      },
      apply: (g) => void applyGroup(tabs, g),
    });
  });

  // 저장된 배치 복원(설정에서 온 값 — 사람이 고를 기회가 없으므로 열린 탭 전부를 담는다).
  tabs.setViewMode(settings.viewMode);
  mark();
  tabs.onTabsChanged(mark); // 탭이 닫혀 분할이 풀리면 버튼 표시도 따라간다
}

/**
 * 그룹을 화면에 올린다 — 아직 열리지 않은 세션은 여기서 접속하고, 다 열리면 분할한다.
 *
 * 하나씩 기다려 여는 이유는 묶음 연결(0.80.2)과 같다: 자격증명·호스트키 창이 여러 개
 * 겹쳐 뜨면 어느 세션 것인지 알 수 없다. 지우거나 이름이 바뀐 세션은 조용히 건너뛴다 —
 * 그룹은 오래 남는 물건이라 목록과 어긋나는 일이 생긴다.
 */
async function applyGroup(tabs: TabManager, g: { name: string; mode: "vertical" | "horizontal"; sessionIds: string[] }): Promise<void> {
  const known = g.sessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is (typeof sessions)[number] => !!s);
  const usable = known.filter((s) => !s.disabled);
  if (usable.length === 0) {
    appToast(`'${g.name}' 그룹에 열 수 있는 세션이 없습니다`);
    return;
  }
  // 같은 세션이 여러 번 담길 수 있다(0.82.0) — 세션별로 '몇 개가 필요한지' 를 세어
  // 모자란 만큼만 새로 연다. 이미 열려 있는 탭은 그대로 쓴다.
  const want = new Map<string, number>();
  for (const s of usable) want.set(s.id, (want.get(s.id) ?? 0) + 1);
  for (const [id, n] of want) {
    const s = usable.find((x) => x.id === id);
    if (!s) continue;
    const have = tabs.tabsForSessions(Array.from({ length: n }, () => id)).length;
    for (let i = have; i < n; i++) await connectSession(s);
  }
  const picked = tabs.tabsForSessions(usable.map((s) => s.id));
  if (picked.length === 0) return;
  tabs.startSplit(g.mode, picked);
  const skipped = g.sessionIds.length - usable.length;
  appToast(
    skipped > 0
      ? `'${g.name}' — ${picked.length}개 분할(건너뜀 ${skipped}개)`
      : `'${g.name}' — ${picked.length}개 분할`,
  );
}

/** '이 PC 자동 잠금 해제' 토글. 켜면 마스터를 확인해 OS 키체인에 저장, 끄면 삭제. 최종 상태 반환. */
export function wireHostKeyPrompt(): void {
  void onHostKeyPrompt(async (e) => {
    let accept = false;
    try {
      accept = await hostKeyPrompt(e);
    } catch (err) {
      console.error("호스트키 확인 창 오류 — 거부로 처리합니다", err);
    }
    try {
      await hostKeyAnswer(e.id, accept);
    } catch (err) {
      console.error("호스트키 확인 응답 전달 실패", err);
    }
  });
}

/**
 * 세션영역: 폭 조절(드래그) + 도킹/언도킹(그라파나 방식, 0.73.0).
 *
 * - **고정(docked)**: 왼쪽에 붙어 자리를 차지한다. 경계선을 끌어 폭을 바꾼다.
 * - **고정 해제(undocked)**: 목록이 숨고 터미널이 전폭을 쓴다. 좌상단 메뉴 버튼으로
 *   잠깐 띄우고(오버레이), 바깥을 누르거나 Esc 로 닫는다. 목록 머리말의 핀 버튼으로
 *   다시 고정한다.
 *
 * 예전에는 경계선 한가운데 접기 버튼이 얹혀 있어 선이 두꺼워 보였고, 4px 트랙에 18px
 * 버튼이 떠 터미널 위를 덮었다 — 버튼을 머리말·타이틀바로 옮기고 선은 1px 로 줄였다.
 */
export function wireSidebarResize(): void {
  const app = document.getElementById("app")!;
  const resizer = $("sidebar-resizer");
  const navBtn = $("nav-toggle");
  const dockBtn = $("sidebar-dock");
  const sidebar = $("sidebar");
  applyIcon(navBtn, "menu");

  app.style.setProperty("--sidebar-w", `${settings.sidebarWidth}px`);

  /** 오버레이(임시 노출) 열림 여부 — 고정 해제 상태에서만 의미가 있다. */
  let peeking = false;

  const sync = (): void => {
    const docked = settings.sidebarDocked;
    app.classList.toggle("sidebar-undocked", !docked);
    app.classList.toggle("sidebar-peek", !docked && peeking);
    navBtn.style.display = docked ? "none" : "";
    applyIcon(dockBtn, docked ? "undock" : "dock");
    dockBtn.title = docked ? "세션 목록 고정 해제" : "세션 목록 고정";
    resizer.title = docked ? "드래그: 폭 조절" : "";
  };

  const save = (): void => {
    void saveSettings(settings).catch(() => undefined);
  };

  /** 고정 해제 상태에서 목록을 잠깐 띄운다. */
  const openPeek = (): void => {
    if (settings.sidebarDocked) return;
    peeking = true;
    sync();
    // 곧바로 검색창에 포커스를 주면 타이핑으로 바로 찾을 수 있다.
    setTimeout(() => document.getElementById("session-search")?.focus(), 0);
  };
  const closePeek = (): void => {
    if (!peeking) return;
    peeking = false;
    sync();
  };

  navBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    peeking ? closePeek() : openPeek();
  });

  dockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSettings({ ...settings, sidebarDocked: !settings.sidebarDocked });
    // 고정으로 돌아가면 임시 노출 상태는 의미가 없다. 해제하면 그대로 띄워 둔다 —
    // 방금 보던 목록이 눈앞에서 사라지면 무슨 일이 났는지 알기 어렵다.
    peeking = !settings.sidebarDocked;
    sync();
    save();
  });

  // 바깥을 누르면 닫는다(임시 노출일 때만). 목록·메뉴 버튼 안쪽 클릭은 유지.
  document.addEventListener("mousedown", (e) => {
    if (!peeking) return;
    const t = e.target as Node;
    if (sidebar.contains(t) || navBtn.contains(t)) return;
    // 세션 우클릭 메뉴처럼 목록에서 파생된 팝업 위 클릭은 닫지 않는다.
    if ((t as HTMLElement).closest?.(".ctx-menu, .modal-overlay")) return;
    closePeek();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && peeking && !document.querySelector(".modal-overlay")) closePeek();
  });

  // 세션을 열면 임시 노출은 닫는다(그라파나가 화면 이동 시 메뉴를 닫는 것과 같다).
  sidebar.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".tree-session, .recent-row")) closePeek();
  });

  resizer.addEventListener("mousedown", (down) => {
    if (!settings.sidebarDocked) return; // 고정 해제 상태에서는 폭 조절이 없다
    down.preventDefault();
    const startX = down.clientX;
    const startW = settings.sidebarWidth;
    const onMove = (m: MouseEvent) => {
      if (m.buttons === 0) return onUp();
      // 최소 폭 아래로는 줄이지 않는다 — 머리말 버튼이 영역 밖으로 나간다.
      const w = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, startW + (m.clientX - startX)));
      app.style.setProperty("--sidebar-w", `${w}px`);
      settings.sidebarWidth = w;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      save();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  sync();
}

/**
 * 세션 빠른 찾기(Ctrl+N)와 현재 세션 SFTP 열기(Ctrl+P) 배선.
 *
 * capture 단계에서 잡는다 — 브라우저 전용 단축키 차단(bootguards)이 먼저 삼키기 때문이다.
 * 0.79.1 에서 자리를 바꿨다: 찾기는 Ctrl+P → Ctrl+N, SFTP 가 Ctrl+P 를 쓴다(사용자 요청).
 */
export function wirePalette(): void {
  initPalette({
    sessions: () => sessions,
    openIds: () => tabManager?.openSessionIds() ?? [],
    focus: (id) => tabManager?.focusSession(id) ?? false,
    open: (s) => {
      void (async () => {
        const ready = await hydrateSecrets(s);
        await tabManager?.openSession(ready);
      })();
    },
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== "n" && k !== "p") return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "n") togglePalette();
      else openSftpForActive();
    },
    { capture: true },
  );
}

/**
 * 지금 보고 있는 세션의 SFTP 창을 연다(Ctrl+P).
 *
 * 열 수 없는 경우에는 조용히 넘어가지 않고 이유를 알린다 — 단축키를 눌렀는데 아무 일도
 * 일어나지 않으면 키가 먹지 않는 것으로 오해한다.
 */
function openSftpForActive(): void {
  const s = tabManager?.activeSession();
  if (!s) {
    appToast("열려 있는 세션이 없습니다 — 먼저 세션에 접속하세요");
    return;
  }
  if (s.kind !== "ssh") {
    appToast("SFTP 는 SSH 세션에서만 열 수 있습니다");
    return;
  }
  if (!s.enableSftp) {
    appToast(`'${s.name || s.host}' 세션은 SFTP 를 쓰지 않도록 설정돼 있습니다`);
    return;
  }
  void openSftpFor(s); // 차단된 세션인지는 이 안에서 함께 본다
}

/** 잠금 상태를 사이드바 오버레이에 반영(잠김 시 세션명 숨김). */
let autoLockTimer = 0;
export function restartAutoLock(): void {
  window.clearTimeout(autoLockTimer);
  const minutes = settings?.autoLockMinutes ?? 0;
  if (minutes <= 0) return;
  autoLockTimer = window.setTimeout(
    () => {
      void vaultLock();
      reflectLock(true);
    },
    minutes * 60 * 1000,
  );
}

/** 화면보호기 유휴 타이머(무활동 자동잠금=0 일 때만). 기본 5분. */
let screensaverTimer = 0;
const SCREENSAVER_IDLE_MS = 5 * 60 * 1000;
export function restartScreensaver(): void {
  window.clearTimeout(screensaverTimer);
  if (isScreensaverOn()) hideScreensaver();
  // 자동 잠금이 켜져 있으면(>0) 잠금이 우선 — 화면보호기는 띄우지 않는다.
  if ((settings?.autoLockMinutes ?? 0) !== 0) return;
  screensaverTimer = window.setTimeout(() => {
    const pick = settings.screensaver;
    showScreensaver(pick === "random" ? undefined : pick);
  }, SCREENSAVER_IDLE_MS);
}

export function wireAutoLock(): void {
  const onActivity = () => {
    if (isScreensaverOn()) hideScreensaver();
    restartAutoLock();
    restartScreensaver();
  };
  for (const ev of ["keydown", "mousedown", "mousemove", "wheel"]) {
    window.addEventListener(ev, onActivity, { passive: true });
  }
  restartAutoLock();
  restartScreensaver();
}

/** 사이드바 검색(250ms 디바운스 + ✕ 클리어). */
export function wireSidebarSearch(sidebar: Sidebar): void {
  const input = $<HTMLInputElement>("session-search");
  const clear = $("session-search-clear");
  let timer = 0;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => sidebar.setFilter(input.value), 250);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    sidebar.setFilter("");
    input.focus();
  });
}

/** 커스텀 타이틀바 창 버튼(최소화/최대화/닫기) 배선 + 종료 경고. */
export function wireWindowControls(tabs: TabManager): void {
  const win = getCurrentWindow();
  $("win-min").addEventListener("click", () => void win.minimize());
  $("win-max").addEventListener("click", () => void win.toggleMaximize());
  $("win-close").addEventListener("click", () => void win.close());

  // 최대화 상태에 따라 최대화/복원 아이콘을 토글한다.
  // 창을 화면 안으로 되돌리기 — 다른 해상도에서 쓰던 자리가 복원돼 제목줄이 화면
  // 밖으로 나가면, OS 제목줄이 없는 이 창은 잡아 옮길 손잡이가 없다. 시작할 때
  // 자동으로 들여놓지만(백엔드), 실행 중 모니터를 빼는 경우를 위해 길을 하나 둔다.
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.key !== "Home") return;
    e.preventDefault();
    void windowFitToScreen().catch(() => undefined);
  });

  const syncMaxIcon = async () => {
    try {
      applyIcon($("win-max"), (await win.isMaximized()) ? "restore" : "maximize");
    } catch {
      /* 무시 */
    }
  };
  void syncMaxIcon();
  void win.onResized(() => void syncMaxIcon());
  // 접속 중인 세션이 있으면 종료 전 확인 — 커스텀 버튼·Alt+F4·작업표시줄 닫기 모두 커버.
  // win.close() 는 이 이벤트를 거치고, win.destroy() 는 우회하므로 확인 후 destroy 로 강제 종료.
  let closing = false;
  void win.onCloseRequested(async (event) => {
    const n = tabs.connectedCount();
    if (n === 0) return; // 접속 세션 없음 → 그대로 종료
    event.preventDefault(); // 확인 전엔 항상 닫힘 차단
    if (closing) return; // 이미 확인창이 떠 있으면 중복 생성 방지
    closing = true;
    const ok = await confirmDialog(`접속 중인 세션이 ${n}개 있습니다. 프로그램을 종료할까요?`);
    closing = false;
    if (ok) await win.destroy();
  });
}

/** 한/CapsLock/NumLock 표시 — 키·IME 상태를 상태바에 반영. */
export function wireLockKeys(): void {
  const update = (e: KeyboardEvent) => {
    if (typeof e.getModifierState !== "function") return;
    $("st-caps").classList.toggle("on", e.getModifierState("CapsLock"));
    $("st-num").classList.toggle("on", e.getModifierState("NumLock"));
  };
  window.addEventListener("keydown", update, true);
  window.addEventListener("keyup", update, true);
  // 한글 입력(IME) 조합 중이면 '한' 을 켠다 — 웹뷰에서 얻을 수 있는 최선의 신호.
  window.addEventListener("compositionstart", () => $("st-hangul").classList.add("on"), true);
  window.addEventListener("compositionend", () => $("st-hangul").classList.remove("on"), true);
}

/** 하단 정보바 갱신(TabManager onStatus 콜백). */
export function updateStatusBar(info: StatusInfo): void {
  const session = $("st-session");
  session.textContent = info.label;
  session.className = "st-left st-" + info.state;
  $("st-enc").textContent = info.cipher;
  $("st-charset").textContent = info.encoding;
  $("st-cursor").textContent = info.cursor ? `⌖ ${info.cursor}` : "";
  $("st-size").textContent = info.size;
  const uptime = $("st-uptime");
  uptime.textContent = info.uptime ? `⏱ ${info.uptime}` : "";
  // 끊긴 세션은 최종 유지시간이 멈춘 값이므로 흐리게 — 흘러가는 값과 구분한다.
  uptime.classList.toggle("stale", info.state === "disconnected");
}

/** 동시 명령 창: 접속된 모든 세션(또는 활성 탭)에 명령 한 줄을 동시에 전송. */
