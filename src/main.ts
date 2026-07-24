// 앱 부트스트랩: 세션 로드 → 사이드바/탭 매니저 배선 → 자동 업데이트 확인.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { blankSession, normalizeSession, type SessionInfo } from "./types";
import {
  sessionsLoad,
  sessionsSave,
  vaultStatus,
  vaultInit,
  vaultUnlock,
  vaultUnlockRecovery,
  vaultChangeMaster,
  vaultLock,
  vaultSetPassword,
  vaultGetPassword,
  vaultDeletePassword,
  keystoreStore,
  keystoreGet,
  keystoreHas,
  keystoreClear,
} from "./ipc";
import { TabManager, type CredentialProvider, type StatusInfo } from "./tabs";
import { Sidebar, type DropTarget } from "./sidebar";
import { passwordPrompt, masterPrompt, confirmDialog, textPrompt, alertDialog } from "./dialogs";
import { sessionDialog } from "./sessiondialog";
import { settingsDialog } from "./settingsdialog";
import { bulkDeleteDialog } from "./bulkdelete";
import { importDialog } from "./importdialog";
import { openSftpBrowser } from "./sftpui";
import { aboutDialog } from "./about";
import {
  loadSettings,
  saveSettings,
  type Settings,
  type ViewModeSetting,
} from "./settings";
import { applyAppTheme, themeById } from "./themes";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let sessions: SessionInfo[] = [];
let settings: Settings;
/** 사이드바 재그리기 — main() 에서 Sidebar 생성 후 실제 구현이 주입된다. */
let redraw: () => void = () => {};
/** 사이드바 표시 옵션 적용(정렬·세부정보) — 마찬가지로 main() 에서 주입된다. */
let applyDisplayOptions: (s: Settings) => void = () => {};

/**
 * 세션 파일을 정상적으로 읽었을 때만 true. 읽기에 실패한 상태에서 저장하면
 * 빈 목록으로 기존 파일을 덮어써 데이터가 유실되므로 저장을 잠근다.
 */
let sessionsLoaded = false;

async function persist(): Promise<void> {
  if (!sessionsLoaded) {
    console.error("세션 로드 실패 상태 — 데이터 보호를 위해 저장을 건너뜁니다.");
    return;
  }
  await sessionsSave(sessions);
}

/**
 * 같은 폴더 형제들 사이에서 위/아래로 한 칸 이동.
 * sortOrder 가 모두 같아(초기값 0) 순서가 이름순인 경우도 있으므로,
 * 현재 표시 순서대로 0..n-1 을 다시 매긴 뒤 이웃과 교환한다.
 */
function reorderSession(all: SessionInfo[], target: SessionInfo, dir: -1 | 1): SessionInfo[] {
  const siblings = all
    .filter((s) => s.folder === target.folder)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));

  const idx = siblings.findIndex((s) => s.id === target.id);
  const swapWith = idx + dir;
  if (idx < 0 || swapWith < 0 || swapWith >= siblings.length) return all;

  const order = new Map<string, number>();
  siblings.forEach((s, i) => order.set(s.id, i));
  order.set(siblings[idx].id, swapWith);
  order.set(siblings[swapWith].id, idx);

  return all.map((s) => (order.has(s.id) ? { ...s, sortOrder: order.get(s.id)! } : s));
}

/**
 * 드래그로 옮긴 결과를 세션 목록에 반영한다.
 * - 폴더에 드롭: 그 폴더로 이동(순서는 맨 뒤)
 * - 세션 위/아래에 드롭: 대상과 같은 폴더로 옮기고 그 앞/뒤에 끼운다
 */
function applyDrop(all: SessionInfo[], sourceId: string, target: DropTarget): SessionInfo[] {
  const source = all.find((s) => s.id === sourceId);
  if (!source) return all;

  if (target.kind === "folder") {
    if (source.folder === target.path) return all;
    // 대상 폴더 형제들을 0..n-1 로 다시 매기고 source 를 맨 뒤에 붙인다
    // (그냥 folder 만 바꾸면 sortOrder 가 전부 0 으로 겹쳐 순서가 뒤죽박죽이 된다).
    const siblings = all
      .filter((s) => s.folder === target.path && s.id !== sourceId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));
    const order = new Map(siblings.map((s, i) => [s.id, i]));
    order.set(sourceId, siblings.length);
    return all.map((s) =>
      order.has(s.id)
        ? { ...s, folder: target.path, sortOrder: order.get(s.id)! }
        : s,
    );
  }

  const dest = all.find((s) => s.id === target.id);
  if (!dest || dest.id === sourceId) return all;

  // 대상 폴더의 형제들을 현재 표시 순서대로 모아 source 를 원하는 자리에 끼운다.
  const siblings = all
    .filter((s) => s.folder === dest.folder && s.id !== sourceId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));

  const at = siblings.findIndex((s) => s.id === dest.id);
  const insertAt = target.before ? at : at + 1;
  const ordered = [...siblings.slice(0, insertAt), source, ...siblings.slice(insertAt)];

  const order = new Map(ordered.map((s, i) => [s.id, i]));
  return all.map((s) =>
    order.has(s.id) ? { ...s, folder: dest.folder, sortOrder: order.get(s.id)! } : s,
  );
}

/** 볼트가 잠겨 있으면 마스터 입력을 받아 해제(없으면 최초 생성). 준비되면 true. */
async function ensureVaultUnlocked(): Promise<boolean> {
  const st = await vaultStatus();
  if (st.unlocked) return true;

  if (!st.exists) {
    const master = await masterPrompt(
      "볼트 마스터 비밀번호 설정",
      "비밀번호를 저장하려면 볼트를 보호할 마스터 비밀번호를 정하세요.",
      "설정",
      true,
    );
    if (master === null) return false;
    const recovery = await vaultInit(master);
    await showRecoveryKey(recovery);
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
    const outcome = await vaultUnlock(master);
    if (outcome.ok) {
      // 구형 볼트가 방금 이관됐다면 새로 발급된 복구 키를 반드시 보여준다.
      if (outcome.migratedRecovery) await showRecoveryKey(outcome.migratedRecovery);
      return true;
    }
  }

  // 3회 실패 → 복구 키로 열 기회를 준다.
  const useRecovery = await confirmDialog(
    "마스터 비밀번호로 열지 못했습니다. 복구 키로 잠금을 해제할까요?",
  );
  if (!useRecovery) return false;
  const key = await textPrompt("복구 키 입력 (XXXX-XXXX-… 형식)", "", "해제");
  if (!key) return false;
  try {
    if (!(await vaultUnlockRecovery(key))) {
      await alertDialog("복구 키가 올바르지 않습니다.");
      return false;
    }
  } catch (e) {
    await alertDialog(`복구 해제 실패: ${String(e)}`);
    return false;
  }
  // 복구로 열었으면 새 마스터를 반드시 설정하게 한다.
  const next = await masterPrompt(
    "새 마스터 비밀번호 설정",
    "복구 키로 열었습니다. 새 마스터 비밀번호를 설정하세요.",
    "설정",
    true,
  );
  if (next === null) {
    await alertDialog(
      "새 마스터 비밀번호를 설정하지 않았습니다.\n" +
        "이번 실행에서는 볼트를 쓸 수 있지만, 다시 시작하면 예전 마스터 비밀번호나 복구 키가 다시 필요합니다.",
    );
    return true;
  }
  const newRecovery = await vaultChangeMaster(next);
  await showRecoveryKey(newRecovery);
  return true;
}

/** 복구 키를 1회 표시하고 클립보드 복사를 돕는다(다시 볼 수 없음). */
async function showRecoveryKey(recovery: string): Promise<void> {
  let copied = false;
  try {
    await navigator.clipboard.writeText(recovery);
    copied = true;
  } catch {
    copied = false; // 복사 실패를 숨기면 사용자가 키를 잃는다
  }
  await alertDialog(
    `복구 키: ${recovery}\n\n` +
      "마스터 비밀번호를 잊었을 때 볼트를 여는 유일한 수단입니다.\n" +
      (copied
        ? "클립보드에 복사해 두었습니다 — 안전한 곳에 보관하세요."
        : "⚠ 클립보드 복사에 실패했습니다. 위 키를 직접 옮겨 적으세요.") +
      "\n이 화면 이후에는 다시 볼 수 없습니다.",
    "복구 키 (1회 표시)",
  );
}

/** 저장(볼트) 우선, 없으면 프롬프트. 성공 시 저장, 인증 실패 시 저장분 폐기. */
const credentials: CredentialProvider = {
  async resolve(session) {
    // 볼트 오류로 전체 접속이 조용히 실패하지 않도록 여기서 흡수하고 프롬프트로 폴백한다.
    try {
      if (session.savePassword && (await ensureVaultUnlocked())) {
        const stored = await vaultGetPassword(session.id);
        if (stored !== null) return stored;
      }
    } catch (e) {
      console.error("볼트 사용 실패 — 비밀번호를 직접 입력받습니다", e);
      await alertDialog(`저장된 비밀번호를 사용할 수 없습니다: ${String(e)}`);
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
      onOpen: (s) => {
        // 최근 접속순 정렬용으로 마지막 접속 시각을 기록한다(저장 세션만).
        if (sessions.some((x) => x.id === s.id)) {
          const now = Math.floor(Date.now() / 1000);
          sessions = sessions.map((x) => (x.id === s.id ? { ...x, lastConnectedUtc: now } : x));
          void persist().then(redraw);
        }
        void tabs.openSession(s);
      },
      onEdit: async (s) => {
        const edited = await sessionDialog(s, "세션 편집");
        if (!edited) return;
        sessions = sessions.map((x) => (x.id === edited.id ? edited : x));
        await persist();
        redraw();
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
        redraw();
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
        redraw();
      },
      onQuick: async () => {
        // 저장하지 않는 1회성 접속.
        const temp = await sessionDialog(blankSession(), "빠른 접속 (저장 안 함)");
        if (!temp) return;
        void tabs.openSession(temp);
      },
      onDuplicate: async (s) => {
        const copy: SessionInfo = {
          ...s,
          id: crypto.randomUUID(),
          name: `${s.name || s.host} (복사)`,
          sortOrder: s.sortOrder + 1,
        };
        sessions = [...sessions, copy];
        await persist();
        redraw();
      },
      onMove: async (s) => {
        const next = await textPrompt("폴더 이동 (빈 값 = 루트)", s.folder, "이동");
        if (next === null) return; // 취소 — 빈 값 확인(루트 이동)과 구분됨
        const folder = next.trim();
        if (folder === s.folder) return;
        sessions = sessions.map((x) => (x.id === s.id ? { ...x, folder } : x));
        await persist();
        redraw();
      },
      onRename: async (s) => {
        const next = await textPrompt("이름 변경", s.name, "변경");
        if (!next) return;
        sessions = sessions.map((x) => (x.id === s.id ? { ...x, name: next } : x));
        await persist();
        redraw();
      },
      onReorder: async (s, dir) => {
        sessions = reorderSession(sessions, s, dir);
        await persist();
        redraw();
      },
      onBulkDelete: async () => {
        const ids = await bulkDeleteDialog(sessions);
        if (!ids || ids.length === 0) return;
        const ok = await confirmDialog(`${ids.length}개 세션을 삭제할까요? 되돌릴 수 없습니다.`);
        if (!ok) return;
        sessions = sessions.filter((x) => !ids.includes(x.id));
        await persist();
        for (const id of ids) {
          try {
            await vaultDeletePassword(id);
          } catch {
            /* 무시 */
          }
        }
        redraw();
      },
      onImport: async () => {
        const imported = await importDialog(sessions);
        if (imported.length === 0) return;
        sessions = [...sessions, ...imported];
        await persist();
        redraw();
      },
      onDropSession: async (sourceId, target) => {
        sessions = applyDrop(sessions, sourceId, target);
        await persist();
        redraw();
      },
      onNewFolder: async (parent) => {
        const name = await textPrompt("새 폴더 이름 ('A/B' 로 중첩 가능)", "", "만들기");
        if (!name) return;
        const path = parent ? `${parent}/${name}` : name;
        if (!settings.folders.includes(path)) {
          settings = { ...settings, folders: [...settings.folders, path] };
          await saveSettings(settings);
        }
        redraw();
      },
      onRenameFolder: async (path) => {
        const last = path.split("/").pop() ?? path;
        const next = await textPrompt("폴더 이름 변경", last, "변경");
        if (!next || next === last) return;
        const parent = path.split("/").slice(0, -1).join("/");
        const newPath = parent ? `${parent}/${next}` : next;
        sessions = sessions.map((x) =>
          x.folder === path || x.folder.startsWith(`${path}/`)
            ? { ...x, folder: newPath + x.folder.slice(path.length) }
            : x,
        );
        settings = {
          ...settings,
          folders: settings.folders.map((f) =>
            f === path || f.startsWith(`${path}/`) ? newPath + f.slice(path.length) : f,
          ),
        };
        await persist();
        await saveSettings(settings);
        redraw();
      },
      onDeleteFolder: async (path) => {
        const ok = await confirmDialog(
          `'${path}' 폴더를 삭제할까요? 안의 세션은 삭제되지 않고 루트로 이동합니다.`,
        );
        if (!ok) return;
        sessions = sessions.map((x) =>
          x.folder === path || x.folder.startsWith(`${path}/`) ? { ...x, folder: "" } : x,
        );
        settings = {
          ...settings,
          folders: settings.folders.filter((f) => f !== path && !f.startsWith(`${path}/`)),
        };
        await persist();
        await saveSettings(settings);
        redraw();
      },
    },
    $("new-session"),
    $("quick-connect"),
  );

  // 사이드바 재그리기(세션 + 빈 폴더).
  redraw = () => sidebar.render(sessions, settings.folders);
  applyDisplayOptions = (s) => sidebar.setDisplayOptions(s.sortByRecent, s.showSessionDetail);
  applyDisplayOptions(settings);

  wireCommandBar(tabs);
  wireViewModes(tabs);
  wireSettings(tabs);
  wireSidebarSearch(sidebar);
  wireAutoLock();
  wireLockKeys();
  $("open-about").addEventListener("click", () => void aboutDialog());

  // Ctrl+Shift+T = 빠른 접속(WPF 0.31.0)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
      e.preventDefault();
      $("quick-connect").click();
    }
  });

  try {
    // 옛 sessions.json(신규 필드 없음)도 안전하게 읽도록 정규화.
    sessions = (await sessionsLoad()).map(normalizeSession);
    sessionsLoaded = true;
  } catch (e) {
    console.error("세션 로드 실패", e);
    sessions = [];
    void alertDialog(
      "세션 목록을 읽지 못했습니다. 기존 파일을 덮어쓰지 않도록 저장이 비활성화됩니다.\n" +
        "설정 폴더의 sessions.json 을 확인한 뒤 앱을 다시 시작하세요.",
      "세션 로드 실패",
    );
  }
  redraw();

  void checkForUpdates();
}

/** 설정 버튼(⚙): 다이얼로그에서 변경 즉시 라이브 적용, 닫으면 영속화. */
function wireSettings(tabs: TabManager): void {
  $("open-settings").addEventListener("click", async () => {
    const before = { ...settings };
    const result = await settingsDialog(
      settings,
      (live) => {
        settings = live;
        applyAppTheme(themeById(live.theme));
        tabs.applySettings(live);
        applyDisplayOptions(live);
        restartAutoLock();
      },
      () => void changeMasterFlow(),
      {
        initial: await keystoreHas(),
        toggle: (enable) => toggleAutoUnlock(enable),
      },
    );
    // 다이얼로그가 열려 있는 동안 백그라운드(업데이트 확인 실패 등)에서 바뀐 항목은
    // 스냅샷으로 되돌리지 않는다. onLive 가 settings 를 이미 최신으로 유지한다.
    settings = { ...result, checkUpdateOnStartup: settings.checkUpdateOnStartup };
    const result2 = settings;
    if (JSON.stringify(before) !== JSON.stringify(result2)) {
      try {
        await saveSettings(result2);
      } catch (e) {
        console.error("설정 저장 실패", e);
      }
    }
  });
}

/** 뷰 모드(탭/세로 분할/가로 분할) 버튼. 선택은 설정에 저장된다. */
function wireViewModes(tabs: TabManager): void {
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
      settings = { ...settings, viewMode: mode };
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
async function toggleAutoUnlock(enable: boolean): Promise<boolean> {
  if (!enable) {
    try {
      await keystoreClear();
    } catch (e) {
      console.error("키체인 삭제 실패", e);
    }
    return false;
  }
  // 켤 때는 마스터를 확인받아 저장한다(볼트가 없으면 먼저 생성 흐름).
  const st = await vaultStatus();
  if (!st.exists) {
    await alertDialog("먼저 비밀번호를 저장할 세션에 접속해 볼트를 만든 뒤 사용하세요.");
    return false;
  }
  const master = await masterPrompt(
    "이 PC 자동 잠금 해제",
    "확인을 위해 마스터 비밀번호를 입력하세요. OS 키체인(이 PC·이 계정)에 저장됩니다.",
    "저장",
  );
  if (master === null) return false;
  if (!(await vaultUnlock(master)).ok) {
    await alertDialog("마스터 비밀번호가 올바르지 않습니다.");
    return false;
  }
  try {
    await keystoreStore(master);
    return true;
  } catch (e) {
    await alertDialog(`키체인 저장 실패: ${String(e)}`);
    return false;
  }
}

/** 시작 시 OS 키체인에 저장된 마스터가 있으면 볼트를 자동 해제한다. */
async function tryAutoUnlock(): Promise<void> {
  try {
    const master = await keystoreGet();
    if (!master) return;
    const outcome = await vaultUnlock(master);
    if (!outcome.ok) {
      // 마스터가 바뀌었는데 키체인이 낡은 경우 — 조용히 정리(다음엔 프롬프트).
      await keystoreClear();
    } else if (outcome.migratedRecovery) {
      await showRecoveryKey(outcome.migratedRecovery);
    }
  } catch (e) {
    console.error("자동 잠금 해제 실패", e);
  }
}

/** 마스터 비밀번호 변경 — 잠겨 있으면 먼저 해제한 뒤 새 비밀번호를 받는다. */
async function changeMasterFlow(): Promise<void> {
  try {
    if (!(await ensureVaultUnlocked())) return;
    const next = await masterPrompt(
      "새 마스터 비밀번호",
      "저장된 비밀번호는 다시 암호화하지 않아도 됩니다(키만 재포장). 기존 복구 키는 무효가 됩니다.",
      "변경",
    );
    if (next === null) return;
    const recovery = await vaultChangeMaster(next);
    // 자동 해제가 켜져 있었다면 키체인의 마스터도 새 값으로 갱신한다.
    try {
      if (await keystoreHas()) await keystoreStore(next);
    } catch (e) {
      console.error("키체인 갱신 실패", e);
    }
    await showRecoveryKey(recovery);
  } catch (e) {
    await alertDialog(`마스터 변경 실패: ${String(e)}`);
  }
}

/** 무활동 자동 잠금 — 설정된 시간 동안 입력이 없으면 볼트를 잠근다. */
let autoLockTimer = 0;
function restartAutoLock(): void {
  window.clearTimeout(autoLockTimer);
  const minutes = settings?.autoLockMinutes ?? 0;
  if (minutes <= 0) return;
  autoLockTimer = window.setTimeout(
    () => {
      void vaultLock();
    },
    minutes * 60 * 1000,
  );
}

function wireAutoLock(): void {
  for (const ev of ["keydown", "mousedown", "wheel"]) {
    window.addEventListener(ev, () => restartAutoLock(), { passive: true });
  }
  restartAutoLock();
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

/** CapsLock/NumLock 표시 — 키 이벤트에서 상태를 읽어 상태바에 반영. */
function wireLockKeys(): void {
  const update = (e: KeyboardEvent) => {
    if (typeof e.getModifierState !== "function") return;
    $("st-caps").classList.toggle("on", e.getModifierState("CapsLock"));
    $("st-num").classList.toggle("on", e.getModifierState("NumLock"));
  };
  window.addEventListener("keydown", update, true);
  window.addEventListener("keyup", update, true);
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
  // 내부망 전용 PC 에서는 아예 시도하지 않는다.
  if (!settings.checkUpdateOnStartup) return;

  let update: Awaited<ReturnType<typeof check>> = null;
  try {
    // '연결 불가' 판정은 확인 단계에만 적용한다 — 설치 실패까지 여기서 잡으면
    // 일시적 오류 한 번으로 업데이트를 영구히 꺼버리게 된다.
    update = await check();
  } catch (e) {
    // 인터넷이 안 되는 환경이면 매번 실패하므로, 그 자리에서 끌 수 있게 제안한다.
    console.error("업데이트 확인 실패", e);
    const turnOff = await confirmDialog(
      "업데이트 확인에 실패했습니다(인터넷 연결 불가로 보입니다).\n" +
        "시작 시 업데이트 확인 기능을 끌까요? (설정에서 다시 켤 수 있습니다)",
    );
    if (turnOff) {
      settings = { ...settings, checkUpdateOnStartup: false };
      try {
        await saveSettings(settings);
      } catch {
        /* 무시 */
      }
    }
    return;
  }

  if (!update) return;
  const ok = await confirmDialog(`새 버전 ${update.version} 이(가) 있습니다. 지금 설치할까요?`);
  if (!ok) return;
  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    await alertDialog(`업데이트 설치에 실패했습니다: ${String(e)}`);
  }
}

void main();
