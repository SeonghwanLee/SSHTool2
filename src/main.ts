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
import { TabManager, type CredentialProvider, type ResolvedCreds, type StatusInfo } from "./tabs";
import { Sidebar, type DropTarget } from "./sidebar";
import {
  passwordPrompt,
  loginPrompt,
  masterPrompt,
  confirmDialog,
  textPrompt,
  alertDialog,
  choiceDialog,
} from "./dialogs";
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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { applyIcon } from "./icons";
import { showScreensaver, hideScreensaver, isScreensaverOn } from "./screensaver";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let sessions: SessionInfo[] = [];
let settings: Settings;
/** 자동 업데이트 경고 등에서 접속 세션 수를 참조하기 위한 모듈 레벨 핸들. */
let tabManager: TabManager | undefined;
/** 사이드바 재그리기 — main() 에서 Sidebar 생성 후 실제 구현이 주입된다. */
let redraw: () => void = () => {};
/** 사이드바 표시 옵션 적용(정렬·세부정보) — 마찬가지로 main() 에서 주입된다. */
let applyDisplayOptions: (s: Settings) => void = () => {};
/** 세션 가져오기 — main() 에서 실제 구현 주입. */
let runImport: () => Promise<void> = async () => {};
/** 새 폴더 — main() 에서 실제 구현 주입. */
let newFolderFlow: (parent: string) => Promise<void> = async () => {};

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

/** 세션별 글자 크기 저장 — Ctrl+휠 조절 시 세션에 기록해 다음 접속에 복원.
 *  휠은 빠르게 연속 발생하므로 저장은 디바운스한다. 임시(미저장) 세션은 무시. */
let fontSaveTimer = 0;
function onSessionFontSize(session: SessionInfo, size: number): void {
  const idx = sessions.findIndex((x) => x.id === session.id);
  if (idx < 0) return; // 빠른 접속 등 저장되지 않은 세션
  if (sessions[idx].fontSize === size) return;
  sessions = sessions.map((x) => (x.id === session.id ? { ...x, fontSize: size } : x));
  window.clearTimeout(fontSaveTimer);
  fontSaveTimer = window.setTimeout(() => void persist(), 500);
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

/**
 * 폴더를 다른 폴더 안(destParent) 또는 루트("")로 옮긴다.
 * 하위 폴더·세션 경로 접두사를 함께 바꿔 안의 것들이 모두 따라 이동한다.
 */
async function moveFolder(sourcePath: string, destParent: string): Promise<void> {
  const seg = sourcePath.split("/").pop() ?? sourcePath;
  const newPath = destParent ? `${destParent}/${seg}` : seg;
  if (newPath === sourcePath) return; // 제자리
  if (destParent === sourcePath || destParent.startsWith(`${sourcePath}/`)) {
    await alertDialog("폴더를 자기 자신이나 그 하위로 옮길 수 없습니다.");
    return;
  }
  const rePrefix = (folder: string): string => {
    if (folder === sourcePath) return newPath;
    if (folder.startsWith(`${sourcePath}/`)) return newPath + folder.slice(sourcePath.length);
    return folder;
  };
  sessions = sessions.map((s) => ({ ...s, folder: rePrefix(s.folder) }));
  settings = { ...settings, folders: settings.folders.map(rePrefix) };
  await persist();
  await saveSettings(settings);
  redraw();
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

/**
 * 자격증명 해결:
 * - savePassword + 볼트에 저장돼 있고 사용자 이름도 있으면 → 그대로 사용(프롬프트 없음)
 * - 사용자 이름이 없으면 → 로그인(아이디+비밀번호) 입력
 * - 그 외 → 비밀번호만 입력
 */
const credentials: CredentialProvider = {
  async resolve(session) {
    try {
      if (session.savePassword && session.user && (await ensureVaultUnlocked())) {
        const stored = await vaultGetPassword(session.id);
        if (stored !== null) return { user: session.user, password: stored, prompted: false };
      }
    } catch (e) {
      console.error("볼트 사용 실패 — 직접 입력받습니다", e);
      await alertDialog(`저장된 비밀번호를 사용할 수 없습니다: ${String(e)}`);
    }

    if (!session.user) {
      // 가져온 세션 등 계정이 없는 경우 — 아이디+비밀번호를 함께 입력받는다.
      const login = await loginPrompt(session);
      if (login === null) return null;
      return { user: login.user, password: login.password, prompted: true };
    }
    const pw = await passwordPrompt(session);
    if (pw === null) return null;
    return { user: session.user, password: pw, prompted: true };
  },

  async onConnected(session, creds) {
    void refreshLockIndicator();
    // 저장된 자격증명을 그대로 쓴 경우엔 물어볼 게 없다.
    if (!creds.prompted) return;
    // 임시(빠른 접속) 세션은 목록에 없으니 저장 제안 안 함.
    const saved = sessions.find((x) => x.id === session.id);
    if (!saved) return;

    const persistCreds = async (updateUser: boolean) => {
      if (updateUser || !saved.savePassword) {
        sessions = sessions.map((x) =>
          x.id === session.id ? { ...x, user: creds.user, savePassword: true } : x,
        );
        // 이 탭에서의 재접속도 저장된 계정을 쓰도록 라이브 세션도 갱신.
        session.user = creds.user;
        session.savePassword = true;
        await persist();
        redraw();
      }
      try {
        if (await ensureVaultUnlocked()) await vaultSetPassword(session.id, creds.password);
      } catch (e) {
        console.error("비밀번호 저장 실패", e);
      }
    };

    if (saved.savePassword) {
      // 이미 저장 대상 — 조용히 최신 값으로 갱신(사용자 이름이 바뀌었으면 함께).
      await persistCreds(saved.user !== creds.user);
      return;
    }
    // 저장 안 하던 세션 — 입력한 계정 정보를 저장할지 물어본다(WPF 0.42.0).
    const yes = await confirmDialog("입력한 계정 정보를 이 세션에 저장할까요?");
    if (yes) await persistCreds(true);
  },

  async onError(session, error) {
    // 저장된 비밀번호가 틀렸을 수 있으니 '인증 실패' 면 폐기 → 다음엔 다시 물어봄.
    // (백엔드는 자격증명 오류에 항상 '인증 실패' 를 쓴다 — '인증서' 등 오탐 회피)
    if (session.savePassword && error.includes("인증 실패")) {
      try {
        await vaultDeletePassword(session.id);
      } catch {
        /* 무시 */
      }
    }
  },
};

/** 정적 버튼(타이틀바·사이드바 헤더·창버튼)에 WPF 동일 Segoe 아이콘 적용. */
function applyStaticIcons(): void {
  const map: Record<string, string> = {
    "view-tabs": "viewTabs",
    "view-vertical": "viewVertical",
    "view-horizontal": "viewHorizontal",
    "cmd-toggle": "command",
    "open-settings": "settings",
    "open-about": "info",
    "win-min": "minimize",
    "win-max": "maximize",
    "win-close": "close",
    "quick-connect": "quickConnect",
    "new-session": "newSession",
    "new-folder": "newFolder",
    "open-import": "import",
    "vault-lock": "lock",
    "session-search-clear": "cancel",
  };
  for (const [id, name] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) applyIcon(el, name);
  }
  const lockGlyph = document.querySelector(".lock-overlay-glyph");
  if (lockGlyph) applyIcon(lockGlyph, "lock");
}

/**
 * 웹뷰 기본 단축키(리로드·찾기·인쇄·확대 등) 차단 — 앱이 의도적으로 쓰는 키는 보존.
 * preventDefault 만 하고 전파는 막지 않으므로, 각 컴포넌트의 자체 핸들러(SFTP F5 새로고침,
 * 터미널 검색 등)는 그대로 동작한다.
 */
function wireBrowserKeyGuard(): void {
  // 앱이 쓰지 않는 브라우저 전용 기능키.
  const blockedFn = new Set(["F1", "F3", "F6", "F7"]);
  // Ctrl 단독 조합 중 브라우저 전용(찾기·인쇄·저장·열기·소스·다운로드·히스토리).
  const blockedCtrl = new Set(["f", "g", "p", "s", "o", "u", "j", "h", "d"]);
  window.addEventListener(
    "keydown",
    (e) => {
      // 리로드: F5 / Ctrl+R / Ctrl+Shift+R — 앱이 통째로 새로고침되지 않도록 차단.
      if (e.key === "F5" || (e.ctrlKey && (e.key === "r" || e.key === "R"))) {
        e.preventDefault();
        return;
      }
      if (blockedFn.has(e.key)) {
        e.preventDefault();
        return;
      }
      if (!e.ctrlKey || e.altKey) return;
      if (e.shiftKey) return; // Ctrl+Shift+F(검색)·Ctrl+Shift+T(빠른접속) 등 앱 단축키 보존
      const k = e.key.toLowerCase();
      // 웹뷰 확대/축소(Ctrl +,-,0) 차단 — 터미널 폰트 줌은 자체 핸들러가 처리.
      if (k === "=" || k === "-" || k === "+" || k === "0" || blockedCtrl.has(k)) {
        e.preventDefault();
      }
    },
    { capture: true },
  );
}

/** 앱 전역 토스트(하단 가운데, 자동 소멸) — 세션 토스트와 별개의 짧은 안내. */
function appToast(message: string): void {
  const el = document.createElement("div");
  el.className = "app-toast";
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.classList.add("show"), 10);
  window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 250);
  }, 2200);
}

async function main(): Promise<void> {
  applyStaticIcons();
  wireBrowserKeyGuard();
  // 설정 로드 + 테마 즉시 적용(첫 페인트 전).
  settings = await loadSettings();
  applyAppTheme(themeById(settings.theme));

  // 중복 실행 시 백엔드(single-instance)가 기존 창을 앞으로 가져오고 이 이벤트를 보낸다.
  void listen("second-instance", () => appToast("이미 실행 중입니다 — 기존 창을 표시합니다"));

  const tabs = new TabManager(
    $("tabbar"),
    $("panes"),
    $("empty-state"),
    credentials,
    (name) => confirmDialog(`'${name}' 세션이 연결되어 있습니다. 닫을까요?`),
    settings,
    updateStatusBar,
    onSessionFontSize,
  );
  tabManager = tabs;

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
        // SFTP 는 셸과 별개의 연결이라 자격증명이 필요 — 저장분 우선, 없으면 프롬프트.
        const creds = await credentials.resolve(s);
        if (creds === null) return;
        const target = creds.user !== s.user ? { ...s, user: creds.user } : s;
        // 저장은 SFTP 인증이 '성공한 뒤에만' — 틀린 비번을 볼트에 넣지 않는다.
        await openSftpBrowser(target, creds.password, () => credentials.onConnected(s, creds));
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
      onRemoveRecent: async (s) => {
        // 세션은 유지하고 접속 이력(lastConnectedUtc)만 지운다.
        sessions = sessions.map((x) => (x.id === s.id ? { ...x, lastConnectedUtc: 0 } : x));
        await persist();
        redraw();
      },
      onClearRecent: async () => {
        const ok = await confirmDialog("최근 접속 기록을 모두 지울까요? (세션은 삭제되지 않습니다)");
        if (!ok) return;
        sessions = sessions.map((x) => (x.lastConnectedUtc > 0 ? { ...x, lastConnectedUtc: 0 } : x));
        await persist();
        redraw();
      },
      onImport: () => void runImport(),
      onDropSession: async (sourceId, target) => {
        sessions = applyDrop(sessions, sourceId, target);
        await persist();
        redraw();
      },
      onMoveFolder: async (sourcePath, destParent) => {
        await moveFolder(sourcePath, destParent);
      },
      onNewFolder: (parent) => void newFolderFlow(parent),
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
        const inFolder = (x: SessionInfo) => x.folder === path || x.folder.startsWith(`${path}/`);
        const count = sessions.filter(inFolder).length;
        const choice = await choiceDialog(
          count > 0
            ? `'${path}' 폴더에 세션 ${count}개가 있습니다. 어떻게 삭제할까요?`
            : `'${path}' 폴더를 삭제할까요?`,
          [
            { label: "폴더만 삭제 (세션은 루트로)", value: "folder", accent: true },
            ...(count > 0
              ? [{ label: "폴더 + 세션까지 삭제", value: "all", danger: true } as const]
              : []),
          ],
          "폴더 삭제",
        );
        if (!choice) return;

        if (choice === "all") {
          const ok = await confirmDialog(
            `폴더 안의 세션 ${count}개까지 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`,
          );
          if (!ok) return;
          const removed = sessions.filter(inFolder);
          sessions = sessions.filter((x) => !inFolder(x));
          for (const s of removed) {
            try {
              await vaultDeletePassword(s.id);
            } catch {
              /* 무시 */
            }
          }
        } else {
          // 폴더만: 안의 세션은 루트로 이동.
          sessions = sessions.map((x) => (inFolder(x) ? { ...x, folder: "" } : x));
        }
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

  // PuTTY/SecureCRT/MobaXterm 세션 가져오기 — 헤더 버튼과 우클릭 메뉴 공용.
  runImport = async () => {
    const imported = await importDialog(sessions);
    if (imported.length === 0) return;
    sessions = [...sessions, ...imported];
    await persist();
    redraw();
  };
  $("open-import").addEventListener("click", () => void runImport());
  // 테마는 환경설정(⚙) 다이얼로그 안에 통합됨 — 별도 테마 버튼 없음.
  wireWindowControls(tabs);

  newFolderFlow = async (parent) => {
    const name = await textPrompt("새 폴더 이름 ('A/B' 로 중첩 가능)", "", "만들기");
    if (!name) return;
    const path = parent ? `${parent}/${name}` : name;
    if (!settings.folders.includes(path)) {
      settings = { ...settings, folders: [...settings.folders, path] };
      await saveSettings(settings);
    }
    redraw();
  };

  // 사이드바 재그리기(세션 + 빈 폴더).
  redraw = () => sidebar.render(sessions, settings.folders);
  applyDisplayOptions = (s) =>
    sidebar.setDisplayOptions(s.sortByRecent, s.showSessionDetail, s.recentLimit);
  applyDisplayOptions(settings);

  wireCommandBar(tabs);
  wireViewModes(tabs);
  wireSettings(tabs);
  wireSidebarSearch(sidebar);
  wireAutoLock();
  wireLockKeys();
  wireSidebarResize();
  // 잠금 버튼 = 토글: 열려 있으면 잠그고, 잠겨 있으면 마스터 비밀번호로 해제.
  $("vault-lock").addEventListener("click", async () => {
    const st = await vaultStatus();
    if (!st.exists) {
      await alertDialog("아직 볼트가 없습니다. 세션 비밀번호를 저장하면 마스터 비밀번호를 설정하게 됩니다.");
      return;
    }
    if (st.unlocked) {
      await vaultLock();
      reflectLock(true);
      await alertDialog("볼트를 잠갔습니다. 저장된 비밀번호를 쓰려면 다시 마스터 비밀번호가 필요합니다.");
    } else if (await ensureVaultUnlocked()) {
      await refreshLockIndicator();
    }
  });
  // 잠금 오버레이 클릭으로도 바로 해제.
  $("lock-overlay").addEventListener("click", async () => {
    if (await ensureVaultUnlocked()) await refreshLockIndicator();
  });
  $("new-folder").addEventListener("click", () => void newFolderFlow(""));
  // 버전정보 열기 — 버튼과 F1 이 공유. 이미 열려 있으면 중복으로 띄우지 않는다.
  let aboutOpen = false;
  const openAbout = () => {
    if (aboutOpen) return;
    aboutOpen = true;
    void aboutDialog(() => tabs.connectedCount()).finally(() => {
      aboutOpen = false;
    });
  };
  $("open-about").addEventListener("click", openAbout);

  // 캡처 단계 — 터미널(xterm)보다 먼저 처리해 F1 이 셸로 전달되지 않게 한다.
  document.addEventListener(
    "keydown",
    (e) => {
      // F1 = 포커스 위치와 무관하게 버전정보 창 열기(전역).
      if (e.key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        openAbout();
        return;
      }
      // Ctrl+Shift+T = 빠른 접속(WPF 0.31.0)
      if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        $("quick-connect").click();
      }
    },
    true,
  );

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

  // OS 키체인에 저장된 마스터가 있으면 볼트를 자동 해제(프롬프트 없이). — 배선 누락이었음
  await tryAutoUnlock();
  await refreshLockIndicator(); // 시작 시 잠금 버튼 아이콘·오버레이 초기화
  void checkForUpdates();
}

/**
 * 설정 버튼(⚙): 변경은 라이브 미리보기로 즉시 반영하되, 저장은 '저장' 버튼을 눌러야만 한다.
 * 취소/Esc/바깥클릭은 미리보기를 되돌리고 저장하지 않는다(사용자 요청).
 */
function wireSettings(tabs: TabManager): void {
  const applyLive = (live: Settings) => {
    settings = live;
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
    // vaultUnlock 이 ok:false 를 '정상 반환'하면 마스터가 틀린 것(파일 손상 등은 Rust 가
    // Err 를 던져 여기 catch 로 빠지므로, 이 분기는 '마스터 불일치'로 안전하게 단정 가능).
    const outcome = await vaultUnlock(master);
    if (!outcome.ok) {
      await keystoreClear(); // 마스터가 바뀜 — 낡은 키 정리(다음엔 프롬프트)
    } else if (outcome.migratedRecovery) {
      await showRecoveryKey(outcome.migratedRecovery);
    }
  } catch (e) {
    // 볼트 파일 잠김/손상 등 일시적 오류 — 키체인은 보존한다(잘못 지우지 않음).
    console.error("자동 잠금 해제 실패(키체인 보존)", e);
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
      if (await keystoreHas().catch(() => false)) await keystoreStore(next);
    } catch (e) {
      console.error("키체인 갱신 실패", e);
    }
    await showRecoveryKey(recovery);
  } catch (e) {
    await alertDialog(`마스터 변경 실패: ${String(e)}`);
  }
}

/** 사이드바 폭 조절(드래그) + 접기(더블클릭). 폭·접힘은 설정에 저장. */
function wireSidebarResize(): void {
  const app = document.getElementById("app")!;
  const resizer = $("sidebar-resizer");
  // 시작 시 복원.
  app.style.setProperty("--sidebar-w", `${settings.sidebarWidth}px`);
  app.classList.toggle("sidebar-collapsed", settings.sidebarCollapsed);

  const toggleCollapse = async () => {
    settings = { ...settings, sidebarCollapsed: !settings.sidebarCollapsed };
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
function reflectLock(locked: boolean): void {
  const sidebar = document.getElementById("sidebar")!;
  sidebar.classList.toggle("locked", locked);
  $("lock-overlay").classList.toggle("hidden", !locked);
  // 버튼 아이콘·툴팁으로 현재 상태와 클릭 동작을 함께 표시.
  const btn = $("vault-lock");
  applyIcon(btn, locked ? "lock" : "unlock");
  btn.title = locked ? "잠김 — 클릭하여 마스터 비밀번호로 잠금 해제" : "볼트 잠금";
}

/** 실제 볼트 상태를 조회해 잠금 표시를 맞춘다(존재하고 잠겨 있으면 잠금). */
async function refreshLockIndicator(): Promise<void> {
  try {
    const st = await vaultStatus();
    reflectLock(st.exists && !st.unlocked);
  } catch {
    /* 무시 */
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
      reflectLock(true);
    },
    minutes * 60 * 1000,
  );
}

/** 화면보호기 유휴 타이머(무활동 자동잠금=0 일 때만). 기본 5분. */
let screensaverTimer = 0;
const SCREENSAVER_IDLE_MS = 5 * 60 * 1000;
function restartScreensaver(): void {
  window.clearTimeout(screensaverTimer);
  if (isScreensaverOn()) hideScreensaver();
  // 자동 잠금이 켜져 있으면(>0) 잠금이 우선 — 화면보호기는 띄우지 않는다.
  if ((settings?.autoLockMinutes ?? 0) !== 0) return;
  screensaverTimer = window.setTimeout(() => showScreensaver(), SCREENSAVER_IDLE_MS);
}

function wireAutoLock(): void {
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

/** 커스텀 타이틀바 창 버튼(최소화/최대화/닫기) 배선 + 종료 경고. */
function wireWindowControls(tabs: TabManager): void {
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
function wireLockKeys(): void {
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
function updateStatusBar(info: StatusInfo): void {
  const session = $("st-session");
  session.textContent = info.label;
  session.className = "st-left st-" + info.state;
  $("st-enc").textContent = info.cipher;
  $("st-charset").textContent = info.encoding;
  $("st-cursor").textContent = info.cursor ? `⌖ ${info.cursor}` : "";
  $("st-size").textContent = info.size;
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
    if (!bar.classList.contains("hidden")) {
      updateCount();
      input.focus();
    }
  });

  const history: string[] = [];
  let histIdx = -1;

  const updateCount = () => {
    const n = tabs.connectedCount();
    status.textContent = all.checked ? `대상 ${n}개 세션` : "활성 세션";
  };
  all.addEventListener("change", updateCount);

  const run = () => {
    const line = input.value;
    if (!line) return;
    history.push(line);
    histIdx = history.length;
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
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histIdx > 0) input.value = history[--histIdx];
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx < history.length - 1) input.value = history[++histIdx];
      else {
        histIdx = history.length;
        input.value = "";
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      bar.classList.add("hidden");
      toggle.classList.remove("active");
    }
  });
}

async function checkForUpdates(): Promise<void> {
  // 내부망 전용 PC 에서는 아예 시도하지 않는다.
  if (!settings.checkUpdateOnStartup) return;

  let update: Awaited<ReturnType<typeof check>> = null;
  try {
    update = await check();
  } catch (e) {
    // 시작 시 확인 실패는 조용히 넘어간다 — 매니페스트 미발행/프록시/일시 오류를
    // '인터넷 불가'로 단정하거나 사용자를 방해하지 않는다(WPF 동작).
    // 실패를 눈으로 확인하려면 버전 정보 창의 '업데이트 확인' 버튼을 쓴다.
    console.error("시작 시 업데이트 확인 실패(무시)", e);
    return;
  }

  if (!update) return;
  const live = tabManager?.connectedCount() ?? 0;
  const msg =
    live > 0
      ? `새 버전 ${update.version} 이(가) 있습니다.\n접속 중인 세션 ${live}개가 있으며, 업데이트를 진행하면 모두 종료됩니다.\n지금 설치할까요?`
      : `새 버전 ${update.version} 이(가) 있습니다. 지금 설치할까요?`;
  const ok = await confirmDialog(msg);
  if (!ok) return;
  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    await alertDialog(`업데이트 설치에 실패했습니다: ${String(e)}`);
  }
}

void main();
