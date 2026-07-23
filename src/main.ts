// 앱 부트스트랩: 세션 로드 → 사이드바/탭 매니저 배선 → 자동 업데이트 확인.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { blankSession, type SessionInfo } from "./types";
import {
  sessionsLoad,
  sessionsSave,
  vaultStatus,
  vaultInit,
  vaultUnlock,
  vaultSetPassword,
  vaultGetPassword,
  vaultDeletePassword,
} from "./ipc";
import { TabManager, type CredentialProvider, type StatusInfo } from "./tabs";
import { Sidebar } from "./sidebar";
import { sessionDialog, passwordPrompt, masterPrompt, confirmDialog } from "./dialogs";
import { settingsDialog } from "./settingsdialog";
import { openSftpBrowser } from "./sftpui";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { applyAppTheme, themeById } from "./themes";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let sessions: SessionInfo[] = [];
let settings: Settings;

async function persist(): Promise<void> {
  await sessionsSave(sessions);
}

/** 볼트가 잠겨 있으면 마스터 입력을 받아 해제(없으면 최초 생성). 준비되면 true. */
async function ensureVaultUnlocked(): Promise<boolean> {
  const st = await vaultStatus();
  if (st.unlocked) return true;

  if (!st.exists) {
    const master = await masterPrompt(
      "볼트 마스터 비밀번호 설정",
      "비밀번호를 저장하려면 볼트를 보호할 마스터 비밀번호를 정하세요. 분실 시 저장된 비밀번호는 복구할 수 없습니다.",
      "설정",
    );
    if (master === null) return false;
    await vaultInit(master);
    return true;
  }

  for (let i = 0; i < 3; i++) {
    const master = await masterPrompt(
      "볼트 잠금 해제",
      i === 0
        ? "저장된 비밀번호를 사용하려면 마스터 비밀번호를 입력하세요."
        : "마스터 비밀번호가 올바르지 않습니다. 다시 입력하세요.",
      "해제",
    );
    if (master === null) return false;
    if (await vaultUnlock(master)) return true;
  }
  return false;
}

/** 저장(볼트) 우선, 없으면 프롬프트. 성공 시 저장, 인증 실패 시 저장분 폐기. */
const credentials: CredentialProvider = {
  async resolve(session) {
    if (session.savePassword) {
      if (await ensureVaultUnlocked()) {
        const stored = await vaultGetPassword(session.id);
        if (stored !== null) return stored;
      }
    }
    return passwordPrompt(session);
  },
  async onConnected(session, password) {
    if (!session.savePassword) return;
    try {
      if (await ensureVaultUnlocked()) await vaultSetPassword(session.id, password);
    } catch (e) {
      console.error("비밀번호 저장 실패", e);
    }
  },
  async onError(session, error) {
    // 저장된 비밀번호가 틀렸을 수 있으니 인증 실패면 폐기 → 다음엔 다시 물어봄.
    if (session.savePassword && /인증/.test(error)) {
      try {
        await vaultDeletePassword(session.id);
      } catch {
        /* 무시 */
      }
    }
  },
};

async function main(): Promise<void> {
  // 설정 로드 + 테마 즉시 적용(첫 페인트 전).
  settings = await loadSettings();
  applyAppTheme(themeById(settings.theme));

  const tabs = new TabManager(
    $("tabbar"),
    $("panes"),
    $("empty-state"),
    credentials,
    (name) => confirmDialog(`'${name}' 세션이 연결되어 있습니다. 닫을까요?`),
    settings,
    updateStatusBar,
  );

  const sidebar = new Sidebar(
    $("session-tree"),
    {
      onOpen: (s) => void tabs.openSession(s),
      onEdit: async (s) => {
        const edited = await sessionDialog(s, "세션 편집");
        if (!edited) return;
        sessions = sessions.map((x) => (x.id === edited.id ? edited : x));
        await persist();
        sidebar.render(sessions);
      },
      onDelete: async (s) => {
        const ok = await confirmDialog(`'${s.name || s.host}' 세션을 삭제할까요?`);
        if (!ok) return;
        sessions = sessions.filter((x) => x.id !== s.id);
        await persist();
        try {
          await vaultDeletePassword(s.id); // 저장된 비밀번호도 함께 정리
        } catch {
          /* 무시 */
        }
        sidebar.render(sessions);
      },
      onSftp: async (s) => {
        // SFTP 는 셸과 별개의 연결이라 비밀번호가 필요 — 저장분 우선, 없으면 프롬프트.
        const pw = await credentials.resolve(s);
        if (pw === null) return;
        await openSftpBrowser(s, pw);
      },
      onNew: async () => {
        const created = await sessionDialog(blankSession(), "새 세션");
        if (!created) return;
        sessions = [...sessions, created];
        await persist();
        sidebar.render(sessions);
      },
      onQuick: async () => {
        // 저장하지 않는 1회성 접속.
        const temp = await sessionDialog(blankSession(), "빠른 접속 (저장 안 함)");
        if (!temp) return;
        void tabs.openSession(temp);
      },
    },
    $("new-session"),
    $("quick-connect"),
  );

  wireCommandBar(tabs);
  wireSettings(tabs);
  wireSidebarSearch(sidebar);

  try {
    sessions = await sessionsLoad();
  } catch (e) {
    console.error("세션 로드 실패", e);
    sessions = [];
  }
  sidebar.render(sessions);

  void checkForUpdates();
}

/** 설정 버튼(⚙): 다이얼로그에서 변경 즉시 라이브 적용, 닫으면 영속화. */
function wireSettings(tabs: TabManager): void {
  $("open-settings").addEventListener("click", async () => {
    const before = { ...settings };
    const result = await settingsDialog(settings, (live) => {
      settings = live;
      applyAppTheme(themeById(live.theme));
      tabs.applySettings(live);
    });
    settings = result;
    if (JSON.stringify(before) !== JSON.stringify(result)) {
      try {
        await saveSettings(result);
      } catch (e) {
        console.error("설정 저장 실패", e);
      }
    }
  });
}

/** 사이드바 검색(250ms 디바운스 + ✕ 클리어). */
function wireSidebarSearch(sidebar: Sidebar): void {
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

/** 하단 상태바 갱신(TabManager onStatus 콜백). */
function updateStatusBar(info: StatusInfo): void {
  const session = $("st-session");
  session.textContent = info.label;
  session.className = "st-left st-" + info.state;
  $("st-size").textContent = info.size;
  $("st-cursor").textContent = info.cursor ? `⌖ ${info.cursor}` : "";
  $("st-enc").textContent = info.encoding;
}

/** 동시 명령 창: 접속된 모든 세션(또는 활성 탭)에 명령 한 줄을 동시에 전송. */
function wireCommandBar(tabs: TabManager): void {
  const bar = $("cmdbar");
  const toggle = $("cmd-toggle");
  const input = $<HTMLInputElement>("cmd-input");
  const all = $<HTMLInputElement>("cmd-all");
  const send = $("cmd-send");
  const status = $("cmd-status");

  toggle.addEventListener("click", () => {
    bar.classList.toggle("hidden");
    toggle.classList.toggle("active", !bar.classList.contains("hidden"));
    if (!bar.classList.contains("hidden")) input.focus();
  });

  const run = () => {
    const line = input.value;
    if (!line) return;
    const bytes = new TextEncoder().encode(line + "\n");
    if (all.checked) {
      const n = tabs.broadcast(bytes);
      status.textContent = n > 0 ? `${n}개 세션 전송` : "접속된 세션 없음";
    } else {
      const ok = tabs.sendActive(bytes);
      status.textContent = ok ? "활성 세션 전송" : "활성 세션 없음";
    }
    input.value = "";
    input.focus();
  };

  send.addEventListener("click", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });
}

async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    const ok = confirm(`새 버전 ${update.version} 이(가) 있습니다. 지금 설치할까요?`);
    if (!ok) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch {
    // 무업데이트/오프라인/미구성은 조용히 무시.
  }
}

void main();
