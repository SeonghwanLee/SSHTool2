// 앱 부트스트랩: 세션 로드 → 사이드바/탭 매니저 배선 → 자동 업데이트 확인.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { blankSession, type SessionInfo } from "./types";
import { sessionsLoad, sessionsSave } from "./ipc";
import { TabManager } from "./tabs";
import { Sidebar } from "./sidebar";
import { sessionDialog, passwordPrompt, confirmDialog } from "./dialogs";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let sessions: SessionInfo[] = [];

async function persist(): Promise<void> {
  await sessionsSave(sessions);
}

async function main(): Promise<void> {
  const tabs = new TabManager(
    $("tabbar"),
    $("panes"),
    $("empty-state"),
    passwordPrompt,
    (name) => confirmDialog(`'${name}' 세션이 연결되어 있습니다. 닫을까요?`),
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
        sidebar.render(sessions);
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

  try {
    sessions = await sessionsLoad();
  } catch (e) {
    console.error("세션 로드 실패", e);
    sessions = [];
  }
  sidebar.render(sessions);

  void checkForUpdates();
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
