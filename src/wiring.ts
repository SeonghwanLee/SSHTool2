// 화면 배선 — 설정창·분할보기·호스트키 프롬프트·사이드바 폭·자동잠금·화면보호기·
// 창버튼·잠금 단축키·상태바. main.ts 에서 분리(0.67.0 정지작업). 로직 변경 없음.

import type { TabManager, StatusInfo, ViewMode } from "./tabs";
import type { Sidebar } from "./sidebar";
import { settings, setSettings, applyDisplayOptions, redraw, tabManager } from "./appstate";
import { saveSettings, type Settings, type ViewModeSetting } from "./settings";
import { settingsDialog } from "./settingsdialog";
import { aboutDialog } from "./about";
import { applyAppTheme, themeById } from "./themes";
import { setDebugLogging } from "./debuglog";
import { onHostKeyPrompt, hostKeyAnswer, vaultLock } from "./ipc";
import { hostKeyPrompt, confirmDialog, alertDialog } from "./dialogs";
import { applyIcon } from "./icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showScreensaver, hideScreensaver, isScreensaverOn } from "./screensaver";
import { reflectLock, refreshLockIndicator, changeMasterFlow, toggleAutoUnlock } from "./vaultflow";
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
  const mark = (mode: ViewModeSetting) => {
    for (const [id, m] of buttons) $(id).classList.toggle("active", m === mode);
  };
  for (const [id, mode] of buttons) {
    $(id).addEventListener("click", async () => {
      tabs.setViewMode(mode);
      mark(mode);
      setSettings({ ...settings, viewMode: mode });
      try {
        await saveSettings(settings);
      } catch (e) {
        console.error("뷰 모드 저장 실패", e);
      }
    });
  }
  // 저장된 배치 복원.
  tabs.setViewMode(settings.viewMode);
  mark(settings.viewMode);
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

/** 사이드바 폭 조절(드래그) + 접기(더블클릭). 폭·접힘은 설정에 저장. */
export function wireSidebarResize(): void {
  const app = document.getElementById("app")!;
  const resizer = $("sidebar-resizer");
  // 시작 시 복원.
  app.style.setProperty("--sidebar-w", `${settings.sidebarWidth}px`);
  app.classList.toggle("sidebar-collapsed", settings.sidebarCollapsed);

  const toggleCollapse = async () => {
    setSettings({ ...settings, sidebarCollapsed: !settings.sidebarCollapsed });
    app.classList.toggle("sidebar-collapsed", settings.sidebarCollapsed);
    syncToggleBtn();
    try {
      await saveSettings(settings);
    } catch {
      /* 무시 */
    }
  };

  // 눈에 보이는 접기/펼치기 버튼(화살표) — 호버 시 표시, 접힌 상태에선 항상 보임.
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "sidebar-toggle";
  const syncToggleBtn = () => {
    const collapsed = settings.sidebarCollapsed;
    toggleBtn.textContent = collapsed ? "»" : "«";
    toggleBtn.title = collapsed ? "세션 목록 펼치기" : "세션 목록 접기";
  };
  // 버튼 조작이 폭조절 드래그/더블클릭 접기로 이중 처리되지 않도록 전파 차단.
  toggleBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  toggleBtn.addEventListener("dblclick", (e) => e.stopPropagation());
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleCollapse();
  });
  resizer.appendChild(toggleBtn);
  syncToggleBtn();

  resizer.addEventListener("dblclick", () => void toggleCollapse());
  resizer.addEventListener("mousedown", (down) => {
    if (settings.sidebarCollapsed) return;
    down.preventDefault();
    const startX = down.clientX;
    const startW = settings.sidebarWidth;
    const onMove = (m: MouseEvent) => {
      if (m.buttons === 0) return onUp();
      const w = Math.max(160, Math.min(560, startW + (m.clientX - startX)));
      app.style.setProperty("--sidebar-w", `${w}px`);
      settings.sidebarWidth = w;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      void saveSettings(settings).catch(() => undefined);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
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
