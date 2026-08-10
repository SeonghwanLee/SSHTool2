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
import { wireCommandBar } from "./cmdbar";
import { updateErrorText } from "./updateerror";
import {
  ensureVaultUnlocked,
  toggleAutoUnlock,
  tryAutoUnlock,
  changeMasterFlow,
  reflectLock,
  refreshLockIndicator,
} from "./vaultflow";
import {
  moveFolder,
  extractSecrets,
  hydrateSecrets,
  allFolderPaths,
  editSessionFlow,
  renameSessionFlow,
  openSftpFor,
  isSavedSession,
} from "./sessionflow";
import { credentials } from "./credentials";
import {
  wireSettings,
  wireViewModes,
  wireHostKeyPrompt,
  wireSidebarResize,
  wireAutoLock,
  wireSidebarSearch,
  wireWindowControls,
  wireLockKeys,
  updateStatusBar,
  restartAutoLock,
  restartScreensaver,
} from "./wiring";
import {
  sessions,
  setSessions,
  settings,
  setSettings,
  sessionsLoaded,
  setSessionsLoaded,
  tabManager,
  setTabManager,
  redraw,
  applyDisplayOptions,
  runImport,
  newFolderFlow,
  injectActions,
  persist,
} from "./appstate";
import { applyStaticIcons, wireNavigationGuard, wireBrowserKeyGuard } from "./bootguards";
import { reorderSession, applyDrop } from "./sessionorder";
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

// 앱 전역 가변 상태는 appstate.ts 로 옮겼다(0.67.0 정지작업) — 흐름별 모듈이
// 같은 상태를 보도록 하기 위함이다. 읽기는 import 한 이름 그대로, 쓰기는 set* 로 한다.

/** 세션별 글자 크기 저장 — Ctrl+휠 조절 시 세션에 기록해 다음 접속에 복원.
 *  휠은 빠르게 연속 발생하므로 저장은 디바운스한다. 임시(미저장) 세션은 무시. */
let fontSaveTimer = 0;
function onSessionFontSize(session: SessionInfo, size: number): void {
  const idx = sessions.findIndex((x) => x.id === session.id);
  if (idx < 0) return; // 빠른 접속 등 저장되지 않은 세션
  if (sessions[idx].fontSize === size) return;
  setSessions(sessions.map((x) => (x.id === session.id ? { ...x, fontSize: size } : x)));
  window.clearTimeout(fontSaveTimer);
  fontSaveTimer = window.setTimeout(() => void persist(), 500);
}

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

async function main(): Promise<void> {
  applyStaticIcons();
  wireBrowserKeyGuard();
  wireNavigationGuard();
  // 설정 로드 + 테마 즉시 적용(첫 페인트 전).
  setSettings(await loadSettings());
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
  setTabManager(tabs);

  const sidebar = new Sidebar(
    $("session-tree"),
    {
      onOpen: (s) => {
        // 최근 접속순 정렬용으로 마지막 접속 시각을 기록한다(저장 세션만).
        if (sessions.some((x) => x.id === s.id)) {
          const now = Math.floor(Date.now() / 1000);
          setSessions(sessions.map((x) => (x.id === s.id ? { ...x, lastConnectedUtc: now } : x)));
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
        setSessions(sessions.filter((x) => x.id !== s.id));
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
        setSettings({ ...settings, collapsedFolders: paths });
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
        setSessions([...sessions, stripped]);
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
        setSessions([...sessions, copy]);
        await persist();
        redraw();
      },
      onMove: async (s) => {
        const next = await textPrompt("폴더 이동 (빈 값 = 루트)", s.folder, "이동");
        if (next === null) return; // 취소 — 빈 값 확인(루트 이동)과 구분됨
        const folder = next.trim();
        if (folder === s.folder) return;
        setSessions(sessions.map((x) => (x.id === s.id ? { ...x, folder } : x)));
        await persist();
        redraw();
      },
      onRename: async (s) => {
        await renameSessionFlow(s);
      },
      onReorder: async (s, dir) => {
        setSessions(reorderSession(sessions, s, dir));
        await persist();
        redraw();
      },
      onBulkDelete: async () => {
        const ids = await bulkDeleteDialog(sessions);
        if (!ids || ids.length === 0) return;
        const ok = await confirmDialog(`${ids.length}개 세션을 삭제할까요? 되돌릴 수 없습니다.`);
        if (!ok) return;
        setSessions(sessions.filter((x) => !ids.includes(x.id)));
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
        setSessions(sessions.map((x) => (x.id === s.id ? { ...x, lastConnectedUtc: 0 } : x)));
        await persist();
        redraw();
      },
      onClearRecent: async () => {
        const ok = await confirmDialog("최근 접속 기록을 모두 지울까요? (세션은 삭제되지 않습니다)");
        if (!ok) return;
        setSessions(sessions.map((x) => (x.lastConnectedUtc > 0 ? { ...x, lastConnectedUtc: 0 } : x)));
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
            setSettings({
              ...settings,
              folderSort: { ...settings.folderSort, [path]: "manual" },
            });
            sidebar.setFolderSort(settings.folderSort);
            void saveSettings(settings).catch(() => {});
            appToast(`'${path || "루트"}' 정렬을 '수동'으로 바꿨습니다`);
          }
        }
        setSessions(applyDrop(sessions, sourceId, target));
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
        setSettings({ ...settings, folderSort: { ...settings.folderSort, [path]: mode } });
        sidebar.setFolderSort(settings.folderSort);
        redraw();
        await saveSettings(settings).catch(() => {});
      },
      onMoveFolder: async (sourcePath, destParent) => {
        await moveFolder(sourcePath, destParent);
      },
      // 폴더 단위 일괄 접속(0.67.0) — 운영 서버 묶음을 한 번에 띄운다. 순차로 여는 것은
      // 의도적이다: 동시에 열면 비밀번호·호스트키 창이 여러 개 겹쳐 뜬다.
      onOpenFolder: (path, list) => {
        void (async () => {
          if (list.length === 0) {
            appToast("이 폴더에 세션이 없습니다.");
            return;
          }
          // 실수로 수십 개를 여는 사고를 막는다 — 몇 개인지 보여 주고 확인받는다.
          if (list.length > 3) {
            const go = await confirmDialog(
              `'${path}' 의 세션 ${list.length}개를 모두 엽니다. 계속할까요?`,
            );
            if (!go) return;
          }
          for (const s of list) {
            const ready = await hydrateSecrets(s);
            await tabs.openSession(ready);
          }
        })();
      },
      onNewFolder: (parent) => void newFolderFlow(parent),
      onRenameFolder: async (path) => {
        const last = path.split("/").pop() ?? path;
        const next = await textPrompt("폴더 이름 변경", last, "변경");
        if (!next || next === last) return;
        const parent = path.split("/").slice(0, -1).join("/");
        const newPath = parent ? `${parent}/${next}` : next;
        setSessions(sessions.map((x) =>
          x.folder === path || x.folder.startsWith(`${path}/`)
            ? { ...x, folder: newPath + x.folder.slice(path.length) }
            : x,
        ));
        setSettings({
          ...settings,
          folders: settings.folders.map((f) =>
            f === path || f.startsWith(`${path}/`) ? newPath + f.slice(path.length) : f,
          ),
        });
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
          setSessions(sessions.filter((x) => !inFolder(x)));
          for (const s of removed) {
            try {
              await vaultDeletePassword(s.id);
            } catch {
              /* 무시 */
            }
          }
        } else {
          // 폴더만: 안의 세션은 루트로 이동.
          setSessions(sessions.map((x) => (inFolder(x) ? { ...x, folder: "" } : x)));
        }
        setSettings({
          ...settings,
          folders: settings.folders.filter((f) => f !== path && !f.startsWith(`${path}/`)),
        });
        await persist();
        await saveSettings(settings);
        redraw();
      },
    },
    $("new-session"),
    $("quick-connect"),
  );

  // PuTTY/SecureCRT/MobaXterm 세션 가져오기 — 헤더 버튼과 우클릭 메뉴 공용.
  // 스캔(레지스트리·ini 훑기)이 수 초 걸려 버튼이 먹통처럼 보인다 — 여러 번 눌러
  // 창이 겹쳐 뜨던 문제(0.67.0). 도는 동안 버튼을 잠그고 진행 중임을 밝힌다.
  let importRunning = false;
  const runImportImpl = async (): Promise<void> => {
    if (importRunning) return;
    importRunning = true;
    const btn = $("open-import") as HTMLButtonElement;
    const prevTitle = btn.title;
    btn.disabled = true;
    btn.classList.add("busy");
    btn.title = "외부 프로그램 세션을 찾는 중…";
    try {
      await runImportBody();
    } finally {
      importRunning = false;
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.title = prevTitle;
    }
  };
  const runImportBody = async (): Promise<void> => {
    const imported = await importDialog(sessions);
    if (imported.length === 0) return;
    setSessions([...sessions, ...imported]);
    await persist();
    redraw();
  };
  $("open-import").addEventListener("click", () => void runImport());
  // 테마는 환경설정(⚙) 다이얼로그 안에 통합됨 — 별도 테마 버튼 없음.
  wireWindowControls(tabs);

  const newFolderFlowImpl = async (parent: string): Promise<void> => {
    const name = await textPrompt("새 폴더 이름 ('A/B' 로 중첩 가능)", "", "만들기");
    if (!name) return;
    const path = parent ? `${parent}/${name}` : name;
    if (!settings.folders.includes(path)) {
      setSettings({ ...settings, folders: [...settings.folders, path] });
      await saveSettings(settings);
    }
    redraw();
  };

  // 사이드바 재그리기(세션 + 빈 폴더).
  const redrawImpl = (): void => sidebar.render(sessions, settings.folders);
  const applyDisplayOptionsImpl = (s: Settings): void => {
    sidebar.setDisplayOptions(s.sortByRecent, s.showSessionDetail, s.recentLimit);
    sidebar.setFolderSort(s.folderSort);
  };
  // 사이드바가 만들어진 지금에서야 실제 구현을 넣는다 — 다른 모듈(세션·볼트 흐름)도
  // 이 통로로 같은 동작을 부른다.
  injectActions({
    redraw: redrawImpl,
    applyDisplayOptions: applyDisplayOptionsImpl,
    runImport: runImportImpl,
    newFolderFlow: newFolderFlowImpl,
  });
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
    setSessions((await sessionsLoad()).map(normalizeSession));
    setSessionsLoaded(true);
  } catch (e) {
    console.error("세션 로드 실패", e);
    setSessions([]);
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
  setSettings({ ...settings, checkUpdateOnStartup: false, offlineMode: true });
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
    logLine("업데이트 확인 실패", updateErrorText(e)); // 주소는 로그에도 남기지 않는다
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
