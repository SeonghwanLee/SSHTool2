// 앱 부트스트랩: 세션 로드 → 사이드바/탭 매니저 배선 → 자동 업데이트 확인.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { blankSession, normalizeSession, type SessionInfo } from "./types";
import {
  sessionsLoad,
  sshProbe,
  rdpLaunch,
  browserOpen,
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
  vaultSetSecret,
  vaultGetSecret,
  vaultDeleteSecret,
  keystoreStore,
  keystoreGet,
  keystoreHas,
  keystoreClear,
  onHostKeyPrompt,
  hostKeyAnswer,
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
  hostKeyPrompt,
  saveFailureAlert,
} from "./dialogs";
import { sessionDialog } from "./sessiondialog";
import { settingsDialog } from "./settingsdialog";
import { bulkDeleteDialog } from "./bulkdelete";
import { importDialog } from "./importdialog";
import {
  openSftpBrowser,
  liveSftpOf,
  onLiveSftpChanged,
  disconnectLiveSftp,
} from "./sftpui";
import { aboutDialog } from "./about";
import {
  loadSettings,
  saveSettings,
  type Settings,
  type ViewModeSetting,
} from "./settings";
import { applyAppTheme, themeById } from "./themes";
import { logLine, setDebugLogging } from "./debuglog";
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
  try {
    await sessionsSave(sessions);
  } catch (e) {
    // 파일 암호화 키를 못 읽으면 백엔드가 평문 덮어쓰기를 거부한다 — 조용히 넘기면
    // 사용자는 저장된 줄 알고 계속 편집하게 된다.
    console.error("세션 저장 실패", e);
    await saveFailureAlert("세션 목록", e);
  }
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

    // 여기부터는 사용자에게 물어봐야 한다. 묻기 전에 **서버가 실제로 붙는지 먼저 확인**한다
    // — 예전에는 네트워크에 손도 대기 전에 비밀번호 창부터 떴다. 호스트가 죽었거나
    // 호스트키가 바뀐 경우에도 비밀번호를 받아 놓고 나서야 실패했다.
    // probe 는 TCP·키교환·호스트키 확인까지 마치고, 계정을 알린 뒤 서버 응답까지 받아 온다.
    // 로컬 셸은 이 경로를 타지 않는다(인증 자체가 없다).
    try {
      await sshProbe(session.host, session.port, session.user, session.allowLegacyAlgorithms);
    } catch (e) {
      // 붙지도 않는 서버에 비밀번호를 묻지 않는다. 실패 사유는 그대로 보여 준다.
      await alertDialog(String(e), "접속 실패");
      return null;
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
    "open-search": "search",
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
/**
 * 웹뷰가 통째로 다른 문서로 넘어가는 경로를 막는다. 넘어가면 접속 중인 세션이 전부 끊기고
 * 되돌릴 방법이 없다 — 키 차단(wireBrowserKeyGuard)만으로는 부족한 경로들이다.
 */
function wireNavigationGuard(): void {
  // (1) 웹뷰 기본 우클릭 메뉴를 어디서도 띄우지 않는다. '새로고침' 항목이 있어 한 번만
  //     잘못 눌러도 접속 중인 세션이 전부 날아간다 — 입력란도 예외로 두지 않는다.
  //     capture 단계라 앱 자체 메뉴(showContextMenu)보다 먼저 돌지만, preventDefault 는
  //     브라우저 기본 동작만 막고 전파는 그대로여서 앱 메뉴는 정상 동작한다.
  //     입력란 붙여넣기는 Ctrl+V 로 계속 된다.
  window.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

  // (1b) 모든 입력칸에서 웹뷰 자동완성(흰색 목록)·맞춤법 밑줄을 끈다.
  //     세션 검색·세션 편집 두 곳만 막았더니 나머지 26곳(빠른 접속 호스트, 동시 명령,
  //     터미널 검색, SFTP 경로 등)에서 같은 흰 목록이 떴다 — 개별 지정은 새 입력칸을
  //     만들 때마다 빠뜨린다. 포커스 위임으로 현재·미래의 입력칸을 전부 덮는다.
  //     datalist(폴더 선택)는 autocomplete=off 와 무관하게 동작하므로 기능 손실이 없고,
  //     xterm 의 IME 경로(textarea)는 건드리지 않는다.
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    if (t.closest(".xterm")) return;
    if (!t.hasAttribute("autocomplete")) t.setAttribute("autocomplete", "off");
    t.spellcheck = false;
  });

  // (2) 탐색기에서 창으로 파일을 떨어뜨리면 웹뷰가 그 파일 문서로 이동해 버린다.
  //     앱 내부 드래그(세션 정렬·SFTP 패널)는 파일이 아니라 자체 타입을 쓰므로 건드리지 않는다.
  const hasFiles = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  for (const type of ["dragover", "drop"] as const) {
    window.addEventListener(
      type,
      (e) => {
        if (hasFiles(e)) e.preventDefault();
      },
      { capture: false },
    );
  }
}

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

// ── 세션의 '비밀 값'(트리거 send · 시작 명령) 볼트 분리 ──────────────────────
//
// 옵트인이다 — 사용자가 '비밀' 을 체크한 것만 볼트로 간다. 체크가 없으면 볼트를 쓰지
// 않으므로, 볼트를 설정하지 않은 사용자도 무해한 트리거를 그대로 쓸 수 있다.
// 세션 파일에는 빈 값 + 플래그만 남고, 실제 값은 접속 직전에 다시 채운다.

const trigKey = (id: string): string => `${id}:triggers`;
const startKey = (id: string): string => `${id}:startup`;

/** 세션에 볼트로 보낼 비밀 값이 하나라도 있는가. */
const hasSecrets = (s: SessionInfo): boolean =>
  s.startupCommandsSecret || s.triggers.some((t) => t.secret);

/**
 * 저장 직전 호출 — 비밀 값을 볼트에 넣고, 파일에 남길 세션에서는 그 값을 비운다.
 * 볼트 해제를 취소하면 null 을 돌려 저장 자체를 중단시킨다(평문으로 새어 나가지 않게).
 */
async function extractSecrets(s: SessionInfo): Promise<SessionInfo | null> {
  if (!hasSecrets(s)) {
    // 체크를 해제한 경우 볼트에 남아 있던 항목을 정리한다(실패는 무시 — 저장을 막지 않는다).
    await vaultDeleteSecret(trigKey(s.id)).catch(() => {});
    await vaultDeleteSecret(startKey(s.id)).catch(() => {});
    return s;
  }
  if (!(await ensureVaultUnlocked())) return null;

  const secretTriggers = s.triggers.filter((t) => t.secret);
  if (secretTriggers.length) {
    // 비밀 규칙의 send 만 모아 한 항목으로 — 패턴은 비밀이 아니라 파일에 남는다.
    await vaultSetSecret(trigKey(s.id), JSON.stringify(secretTriggers.map((t) => t.send)));
  } else {
    await vaultDeleteSecret(trigKey(s.id)).catch(() => {});
  }

  if (s.startupCommandsSecret) await vaultSetSecret(startKey(s.id), s.startupCommands);
  else await vaultDeleteSecret(startKey(s.id)).catch(() => {});

  return {
    ...s,
    startupCommands: s.startupCommandsSecret ? "" : s.startupCommands,
    triggers: s.triggers.map((t) => (t.secret ? { ...t, send: "" } : t)),
  };
}

/**
 * 접속 직전 호출 — 볼트에서 비밀 값을 꺼내 메모리 상의 세션을 원래대로 되돌린다.
 * 해제를 취소하면 값이 빈 채로 접속한다(트리거가 안 걸릴 뿐, 접속 자체는 막지 않는다).
 */
async function hydrateSecrets(s: SessionInfo): Promise<SessionInfo> {
  if (!hasSecrets(s)) return s;
  if (!(await ensureVaultUnlocked())) return s;

  let startup = s.startupCommands;
  if (s.startupCommandsSecret) startup = (await vaultGetSecret(startKey(s.id))) ?? "";

  let triggers = s.triggers;
  if (s.triggers.some((t) => t.secret)) {
    const raw = await vaultGetSecret(trigKey(s.id));
    const sends: string[] = raw ? JSON.parse(raw) : [];
    let n = 0;
    triggers = s.triggers.map((t) => (t.secret ? { ...t, send: sends[n++] ?? "" } : t));
  }
  return { ...s, startupCommands: startup, triggers };
}

/**
 * 지금 존재하는 폴더 경로 전부 — 명시적으로 만든 폴더(settings.folders)와 세션이 실제로
 * 들어 있는 폴더를 합치고, 중간 경로(`운영/DB` 의 `운영`)까지 펼쳐서 돌려준다.
 * 세션 편집 창의 폴더 제안 목록으로 쓴다.
 */
function allFolderPaths(): string[] {
  const out = new Set<string>();
  for (const raw of [...settings.folders, ...sessions.map((s) => s.folder)]) {
    const path = (raw ?? "").trim();
    if (!path) continue;
    let acc = "";
    for (const seg of path.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      out.add(acc);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, "ko"));
}

/**
 * 세션 하나에 대해 SFTP 브라우저를 연다. 사이드바(세션·최근 접속)와 세션 탭 우클릭이
 * 같은 경로를 쓰도록 한 곳에 둔다.
 */
/**
 * 세션 편집 창을 열고 결과를 저장한다. 사이드바와 세션 탭 우클릭이 같은 경로를 쓰도록
 * 한 곳에 둔다. 반환값은 편집 결과(볼트 값이 채워진 메모리 상의 세션) — 열려 있는 탭이
 * 들고 있는 세션을 갱신하는 데 쓴다. 취소하거나 저장이 중단되면 null.
 */
async function editSessionFlow(s: SessionInfo): Promise<SessionInfo | null> {
  // 편집 창에는 볼트에 있던 값도 채워서 보여 준다(빈 칸으로 열리면 지운 걸로 오해한다).
  const edited = await sessionDialog(await hydrateSecrets(s), "세션 편집", allFolderPaths());
  if (!edited) return null;
  const stripped = await extractSecrets(edited);
  if (!stripped) return null; // 볼트 해제 취소 — 평문으로 새지 않도록 저장 자체를 중단
  sessions = sessions.map((x) => (x.id === stripped.id ? stripped : x));
  await persist();
  redraw();
  return edited;
}

/**
 * 세션 이름 변경 — 사이드바와 세션 탭 우클릭 공용. 바뀐 이름을 돌려주면
 * 호출한 쪽(탭)이 라벨을 즉시 갱신한다. 취소하면 null.
 */
async function renameSessionFlow(s: SessionInfo): Promise<string | null> {
  const next = await textPrompt("이름 변경", s.name, "변경");
  if (!next) return null;
  sessions = sessions.map((x) => (x.id === s.id ? { ...x, name: next } : x));
  await persist();
  redraw();
  return next;
}

/** 저장 목록에 있는 세션인지 — 빠른 접속 등 임시 세션과 구분한다. */
const isSavedSession = (s: SessionInfo): boolean => sessions.some((x) => x.id === s.id);

async function openSftpFor(s: SessionInfo): Promise<void> {
  // SFTP 는 셸과 별개의 연결이라 자격증명이 필요 — 저장분 우선, 없으면 프롬프트.
  const creds = await credentials.resolve(s);
  if (creds === null) return;
  const target = creds.user !== s.user ? { ...s, user: creds.user } : s;
  // 저장은 SFTP 인증이 '성공한 뒤에만' — 틀린 비번을 볼트에 넣지 않는다.
  await openSftpBrowser(
    target,
    creds.password,
    () => credentials.onConnected(s, creds),
    settings.sftpLocalDir,
  );
}

async function main(): Promise<void> {
  applyStaticIcons();
  wireBrowserKeyGuard();
  wireNavigationGuard();
  // 설정 로드 + 테마 즉시 적용(첫 페인트 전).
  settings = await loadSettings();
  applyAppTheme(themeById(settings.theme));
  // 진단 로깅은 설정을 읽자마자 붙인다 — 시작 과정에서 나는 문제도 잡으려는 것이다.
  void setDebugLogging(settings.verboseLog);
  // 프런트에서 터진 예외는 콘솔에만 남아 사용자 화면에서는 흔적이 없다. 로그로 끌어온다.
  window.addEventListener("error", (e) => logLine("오류", `${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => logLine("미처리 거부", String(e.reason)));

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
    {
      sftp: (s) => void openSftpFor(s),
      rename: renameSessionFlow,
      edit: editSessionFlow,
      isSaved: isSavedSession,
    },
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
        // RDP 는 터미널 탭을 만들지 않는다 — mstsc 가 별도 창으로 화면을 맡는다.
        if (s.kind === "rdp") {
          void rdpLaunch(s.host, s.port, s.user).catch((e) =>
            alertDialog(String(e), "원격 데스크톱 실행 실패"),
          );
          return;
        }
        // 볼트에 있는 비밀 값(트리거·시작 명령)을 메모리에서만 되채워 넘긴다.
        void hydrateSecrets(s).then((ready) => tabs.openSession(ready));
      },
      onEdit: async (s) => {
        await editSessionFlow(s);
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
      onSftp: openSftpFor,
      // 폴더 접힘은 설정에 저장한다 — 재시작할 때마다 다시 접는 건 번거롭다.
      onCollapsedChange: (paths) => {
        settings = { ...settings, collapsedFolders: paths };
        void saveSettings(settings).catch(() => {});
      },
      // 모달을 닫아도 연결이 살아 있으므로, 그 사실과 진행률을 칩에 드러낸다.
      sftpLive: (s) => {
        const live = liveSftpOf(s.id);
        if (!live) return null;
        const transferring = live.transferId !== null;
        const percent = live.total > 0 ? Math.min(100, Math.round((live.done / live.total) * 100)) : 0;
        return { transferring, percent };
      },
      onSftpDisconnect: (s) => void disconnectLiveSftp(s.id),
      onNew: async () => {
        const created = await sessionDialog(blankSession(), "새 세션", allFolderPaths());
        if (!created) return;
        const stripped = await extractSecrets(created);
        if (!stripped) return;
        sessions = [...sessions, stripped];
        await persist();
        redraw();
      },
      onQuick: async () => {
        // 저장하지 않는 1회성 접속.
        const temp = await sessionDialog(blankSession(), "빠른 접속 (저장 안 함)", allFolderPaths());
        if (!temp) return;
        void tabs.openSession(temp);
      },
      onDuplicate: async (s) => {
        // 복제본은 id 가 달라 원본의 볼트 항목을 가리키지 못한다. 비밀 값은 딸려가지
        // 않으므로 플래그를 끄고 값도 비워 '있는 척' 하지 않게 한다.
        const copy: SessionInfo = {
          ...s,
          id: crypto.randomUUID(),
          name: `${s.name || s.host} (복사)`,
          sortOrder: s.sortOrder + 1,
          startupCommands: s.startupCommandsSecret ? "" : s.startupCommands,
          startupCommandsSecret: false,
          triggers: s.triggers.map((t) => (t.secret ? { ...t, send: "", secret: false } : t)),
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
        await renameSessionFlow(s);
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
        // 정렬이 걸린 폴더에서 끌어 순서를 바꾸면 화면이 꿈쩍도 하지 않는다 — 정렬이
        // 다시 제자리로 돌려놓기 때문이다. 끌어서 옮겼다는 것 자체가 "내가 직접
        // 배치하겠다"는 뜻이므로 그 폴더를 수동으로 되돌리고 그 사실을 알린다.
        if (target.kind === "session") {
          const moved = sessions.find((x) => x.id === sourceId);
          const path = moved?.folder ?? "";
          const mode = settings.folderSort[path];
          if (mode && mode !== "manual") {
            settings = {
              ...settings,
              folderSort: { ...settings.folderSort, [path]: "manual" },
            };
            sidebar.setFolderSort(settings.folderSort);
            void saveSettings(settings).catch(() => {});
            appToast(`'${path || "루트"}' 정렬을 '수동'으로 바꿨습니다`);
          }
        }
        sessions = applyDrop(sessions, sourceId, target);
        await persist();
        redraw();
      },
      onOpenService: (s, svc) => {
        // 기본 포트(http 80 / https 443)는 생략한다 — :80 이 붙은 주소는 어색하다.
        const defaultPort = svc.scheme === "https" ? 443 : 80;
        const portPart = svc.port === defaultPort ? "" : `:${svc.port}`;
        // 경로 앞의 / 는 사용자가 빼먹기 쉬우니 보정한다.
        const path = svc.path && !svc.path.startsWith("/") ? `/${svc.path}` : svc.path;
        const url = `${svc.scheme}://${s.host}${portPart}${path}`;
        void browserOpen(svc.browser, url).catch((e) =>
          alertDialog(String(e), "서비스 연결 실패"),
        );
      },
      onFolderSort: async (path, mode) => {
        settings = { ...settings, folderSort: { ...settings.folderSort, [path]: mode } };
        sidebar.setFolderSort(settings.folderSort);
        redraw();
        await saveSettings(settings).catch(() => {});
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
  applyDisplayOptions = (s) => {
    sidebar.setDisplayOptions(s.sortByRecent, s.showSessionDetail, s.recentLimit);
    sidebar.setFolderSort(s.folderSort);
  };
  applyDisplayOptions(settings);
  // 저장돼 있던 폴더 접힘 상태 복원(설정 로드 후 첫 렌더에 반영).
  sidebar.setCollapsed(settings.collapsedFolders ?? []);

  // 전체 접기/펼치기(Grafana 방식) — 하나라도 펼쳐져 있으면 모두 접는다.
  // 아이콘·툴팁이 다음 동작을 예고한다(접힘 상태면 '펼치기' 모양).
  const foldBtn = $("fold-all");
  const syncFoldIcon = (folded: boolean) => {
    applyIcon(foldBtn, folded ? "expandAll" : "collapseAll");
    foldBtn.title = folded ? "폴더 모두 펼치기" : "폴더 모두 접기";
  };
  // 접기는 연출 뒤에 상태가 반영되므로, 아이콘은 토글의 반환값(목표 상태)으로 즉시 바꾼다.
  foldBtn.addEventListener("click", () => syncFoldIcon(sidebar.toggleFoldAll()));
  syncFoldIcon(sidebar.isAllFolded());

  wireCommandBar(tabs);
  wireViewModes(tabs);
  wireSettings(tabs);
  wireSidebarSearch(sidebar);
  wireAutoLock();
  wireLockKeys();
  wireSidebarResize();
  wireHostKeyPrompt();
  // 단축키(Ctrl+Shift+F)를 모르면 찾기 기능을 못 쓴다 — 타이틀바 버튼으로도 연다.
  $("open-search").addEventListener("click", () => tabs.openSearch());
  // 살아있는 SFTP 상태·진행률이 바뀌면 사이드바 칩을 다시 그린다.
  onLiveSftpChanged(() => redraw());
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
    void aboutDialog(() => tabs.connectedCount(), () => settings.offlineMode).finally(() => {
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

/**
 * 처음 보는 호스트키 확인 요청 처리. 백엔드의 접속은 이 응답이 갈 때까지 멈춰 있으므로,
 * 어떤 경로로 끝나든 반드시 답을 보낸다(안 보내면 백엔드 타임아웃까지 매달린다).
 */
function wireHostKeyPrompt(): void {
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
  screensaverTimer = window.setTimeout(() => {
    const pick = settings.screensaver;
    showScreensaver(pick === "random" ? undefined : pick);
  }, SCREENSAVER_IDLE_MS);
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
  const uptime = $("st-uptime");
  uptime.textContent = info.uptime ? `⏱ ${info.uptime}` : "";
  // 끊긴 세션은 최종 유지시간이 멈춘 값이므로 흐리게 — 흘러가는 값과 구분한다.
  uptime.classList.toggle("stale", info.state === "disconnected");
}

/** 동시 명령 창: 접속된 모든 세션(또는 활성 탭)에 명령 한 줄을 동시에 전송. */
function wireCommandBar(tabs: TabManager): void {
  const bar = $("cmdbar");
  const toggle = $("cmd-toggle");
  const input = $<HTMLInputElement>("cmd-input");
  const mode = $<HTMLSelectElement>("cmd-mode");
  const pickBtn = $("cmd-pick");
  const picker = $("cmd-picker");
  const send = $("cmd-send");
  const status = $("cmd-status");

  /**
   * '선택한 세션' 모드의 대상 탭 키. 탭이 닫히면 유령 키가 남으므로 갱신 때마다 걸러낸다.
   * 세션 id 가 아니라 탭 키로 잡는다 — 같은 세션을 두 탭으로 열어 두면 둘은 별개다.
   */
  let picked = new Set<string>();

  toggle.addEventListener("click", () => {
    bar.classList.toggle("hidden");
    toggle.classList.toggle("active", !bar.classList.contains("hidden"));
    if (bar.classList.contains("hidden")) {
      togglePicker(false);
      tabs.markBroadcast(null);
      return;
    }
    updateCount();
    input.focus();
  });

  const history: string[] = [];
  let histIdx = -1;

  /** 지금 명령이 나갈 탭 키 집합. 전체·활성 모드에서는 null(따로 겨누지 않음). */
  const targetKeys = (): ReadonlySet<string> | null =>
    mode.value === "pick" ? picked : null;

  const updateCount = () => {
    picked = tabs.pruneKeys(picked);
    pickBtn.classList.toggle("hidden", mode.value !== "pick");
    if (mode.value === "all") status.textContent = `대상 ${tabs.connectedCount()}개 세션`;
    else if (mode.value === "active") status.textContent = "활성 세션";
    else status.textContent = picked.size > 0 ? `대상 ${picked.size}개 세션` : "대상을 고르세요";
    // 창이 열려 있을 때만 탭바를 물들인다 — 닫아 두고 강조만 남으면 영문을 모른다.
    const open = !bar.classList.contains("hidden");
    tabs.markBroadcast(open && mode.value === "pick" ? picked : null);
    if (!picker.classList.contains("hidden")) drawPicker();
  };

  /** 대상 고르기 패널 — 접속 중인 탭을 체크박스로 나열한다. */
  const drawPicker = () => {
    picker.innerHTML = "";
    const targets = tabs.broadcastTargets();
    if (targets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cmd-pick-empty";
      empty.textContent = "접속된 세션이 없습니다.";
      picker.appendChild(empty);
      return;
    }
    for (const t of targets) {
      const row = document.createElement("label");
      row.className = "cmd-pick-row" + (t.locked ? " locked" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = picked.has(t.key);
      // 잠긴 탭은 고를 수 있게 두되 어차피 전송에서 빠진다는 걸 밝힌다 — 목록에서 빼 버리면
      // 왜 그 세션엔 안 갔는지 알 수 없다.
      cb.disabled = t.locked;
      cb.addEventListener("change", () => {
        if (cb.checked) picked.add(t.key);
        else picked.delete(t.key);
        updateCount();
      });
      const name = document.createElement("span");
      name.textContent = t.label + (t.locked ? " (잠김 — 전송되지 않음)" : "");
      row.append(cb, name);
      picker.appendChild(row);
    }
    const foot = document.createElement("div");
    foot.className = "cmd-pick-foot";
    const mkFoot = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    foot.append(
      mkFoot("모두 선택", () => {
        for (const t of targets) if (!t.locked) picked.add(t.key);
        updateCount();
      }),
      mkFoot("모두 해제", () => {
        picked.clear();
        updateCount();
      }),
    );
    picker.appendChild(foot);
  };

  const togglePicker = (open: boolean) => {
    picker.classList.toggle("hidden", !open);
    if (open) drawPicker();
  };

  mode.addEventListener("change", () => {
    if (mode.value !== "pick") togglePicker(false);
    updateCount();
    // 모드를 바꾸자마자 고를 수 있게 — 한 번 더 누르게 하지 않는다.
    if (mode.value === "pick") togglePicker(true);
  });
  pickBtn.addEventListener("click", () => togglePicker(picker.classList.contains("hidden")));
  // 창 밖을 누르면 닫힌다. 명령 입력줄 자체는 예외 — 고르자마자 바로 치는 흐름이 자연스럽다.
  document.addEventListener("mousedown", (e) => {
    if (picker.classList.contains("hidden")) return;
    const t = e.target as Node;
    if (picker.contains(t) || pickBtn.contains(t) || input.contains(t)) return;
    togglePicker(false);
  });

  // 창을 켜 둔 채 세션이 열리거나 닫혀도 대상 개수가 따라가야 한다.
  tabs.onTabsChanged(() => {
    if (!bar.classList.contains("hidden")) updateCount();
  });

  const run = () => {
    const line = input.value;
    if (!line) return;
    history.push(line);
    histIdx = history.length;
    const bytes = new TextEncoder().encode(line + "\n");
    if (mode.value === "active") {
      const r = tabs.sendActive(bytes);
      status.textContent =
        r === "sent" ? "활성 세션 전송" : r === "locked" ? "활성 세션이 잠겨 있음" : "활성 세션 없음";
    } else {
      const keys = targetKeys();
      if (keys && keys.size === 0) {
        status.textContent = "대상을 고르세요";
        return;
      }
      const { sent, locked } = tabs.broadcast(bytes, keys ?? undefined);
      // 잠겨서 빠진 세션은 반드시 밝힌다 — 보냈다고 믿고 넘어가는 것이 가장 위험하다.
      status.textContent =
        sent > 0
          ? `${sent}개 세션 전송` + (locked > 0 ? ` · 잠김 ${locked}개 제외` : "")
          : locked > 0
            ? `모두 잠겨 있어 보내지 않음 (${locked}개)`
            : "접속된 세션 없음";
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
      togglePicker(false);
      tabs.markBroadcast(null);
    }
  });
}

/**
 * 업데이트 확인 실패가 '인터넷이 안 되는' 쪽으로 보이는가.
 *
 * 프록시·매니페스트 미발행·일시 오류까지 내부망으로 단정하면, 잠깐 끊긴 것뿐인 PC 에
 * 오프라인 모드를 권하게 된다. 연결 자체가 성립하지 않은 경우만 고른다.
 */
function looksOffline(e: unknown): boolean {
  const m = String(e).toLowerCase();
  return (
    m.includes("dns") ||
    m.includes("failed to lookup") ||
    m.includes("connection refused") ||
    m.includes("network") ||
    m.includes("unreachable") ||
    m.includes("timed out") ||
    m.includes("timeout")
  );
}

/**
 * 내부망 PC 로 보이면 오프라인 모드를 제안한다(WPF 이식).
 *
 * 묻기 전에 먼저 감추지 않는다 — '아니요'를 골랐는데 UI 가 사라져 있으면 되돌릴 방법이
 * 없다. 탈출구는 '시작 시 업데이트 확인'을 다시 켜는 것이고, 그 항목만은 늘 남겨 둔다.
 */
async function offerOfflineMode(): Promise<void> {
  if (settings.offlineMode) return; // 이미 켜져 있으면 다시 묻지 않는다
  const ok = await confirmDialog(
    "업데이트 확인에 실패했습니다 (인터넷 연결 불가).\n" +
      "시작 시 업데이트 확인을 끄고 GitHub 관련 메뉴를 감출까요?\n" +
      "설정 > 일반의 '시작 시 업데이트 확인'을 다시 켜면 원래대로 돌아옵니다.",
  );
  if (!ok) return;
  settings = { ...settings, checkUpdateOnStartup: false, offlineMode: true };
  await saveSettings(settings).catch(() => {});
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
    logLine("업데이트 확인 실패", String(e));
    // 다만 '연결 자체가 안 되는' 실패라면 내부망일 수 있으므로 한 번 묻는다.
    if (looksOffline(e)) await offerOfflineMode();
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
