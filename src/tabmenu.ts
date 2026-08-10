// 세션 탭 우클릭 메뉴. tabs.ts 에서 분리(0.67.0). 로직 변경 없음.
// 주입되지 않은 동작(TabActions)은 항목 자체를 넣지 않는다 — 눌러도 아무 일 없는
// 항목을 두지 않기 위해서다.

import { showContextMenu, type MenuItem } from "./contextmenu";
import type { TerminalTab } from "./termtab";
import type { TabActions } from "./termtypes";

/** 메뉴가 tabs.ts 에서 필요로 하는 것만. */
export interface TabMenuCtx {
  tabs: TerminalTab[];
  actions: TabActions;
  connectedCount: () => number;
  openSession: (s: import("./types").SessionInfo) => Promise<void>;
  closeTab: (t: TerminalTab) => Promise<void>;
  closeAll: () => Promise<void>;
  disconnectAll: () => Promise<void>;
  runDisconnect: (t: TerminalTab) => void;
  reconnectFromMenu: (t: TerminalTab) => void;
  runRename: (t: TerminalTab) => void;
  runEdit: (t: TerminalTab) => void;
  setTabLocked: (t: TerminalTab, locked: boolean) => void;
}

/**
 * 세션 탭 우클릭 메뉴 구성. 성격별로 묶어 구분선을 넣는다 —
 * 세션 정의(편집·이름 변경) → 열기 계열 → 접속 계열 → 닫기·전체 종료.
 * 상황에 맞지 않는 항목은 아예 넣지 않는다(임시 세션의 편집, 로컬 셸의 SFTP 등).
 */
export function tabMenu(ctx: TabMenuCtx, tab: TerminalTab): MenuItem[] {
  const s = tab.session;
  // 빠른 접속처럼 저장 목록에 없는 세션은 편집·이름 변경이 아무것도 남기지 못한다.
  const saved = ctx.actions.isSaved?.(s) ?? false;
  const items: MenuItem[] = [];

  if (saved && ctx.actions.edit) {
    items.push({ label: "세션 편집", accel: "e", action: () => void ctx.runEdit(tab) });
  }
  if (saved && ctx.actions.rename) {
    items.push({ label: "세션 이름 변경", accel: "n", action: () => void ctx.runRename(tab) });
  }
  if (items.length) items.push({ separator: true });

  // 같은 세션으로 접속을 하나 더 연다. tab.session 을 그대로 쓰므로 볼트에서 꺼낸
  // 비밀 값(트리거·시작 명령)이 이미 채워져 있어 다시 묻지 않는다.
  items.push({ label: "세션 하나 더 열기", accel: "d", action: () => void ctx.openSession(s) });
  // 로컬 셸과 SFTP 를 끈 세션에는 전송 항목을 넣지 않는다(사이드바와 같은 기준).
  if (ctx.actions.sftp && s.kind === "ssh" && s.enableSftp) {
    items.push({ label: "SFTP 파일 전송", accel: "f", action: () => ctx.actions.sftp?.(s) });
  }

  items.push({ separator: true });
  items.push({ label: "재접속", accel: "r", action: () => void ctx.reconnectFromMenu(tab) });
  if (tab.status === "connected") {
    // '닫기' 와 다르다 — 연결만 끊고 탭은 남겨 재접속 화면이 되게 한다.
    items.push({ label: "세션 종료", accel: "t", action: () => void ctx.runDisconnect(tab) });
  }

  // 이 탭만의 잠금이다. 앱 전체 볼트 잠금과 헷갈리지 않도록 '세션' 을 붙여 부른다.
  items.push({ separator: true });
  items.push(
    tab.locked
      ? { label: "세션 잠금 해제", accel: "l", action: () => ctx.setTabLocked(tab, false) }
      : { label: "세션 잠금", accel: "l", action: () => ctx.setTabLocked(tab, true) },
  );

  items.push({ separator: true });
  items.push({
    label: "세션 닫기",
    accel: "c",
    danger: true,
    action: () => void ctx.closeTab(tab),
  });
  // 접속이 하나뿐이면 위의 '세션 종료' 와 결과가 같아 굳이 내놓지 않는다.
  if (ctx.connectedCount() >= 2) {
    items.push({
      label: "접속된 모든 세션 종료",
      accel: "a",
      danger: true,
      action: () => void ctx.disconnectAll(),
    });
  }
  // 탭이 둘 이상일 때만 — 하나뿐이면 '세션 닫기' 와 같은 동작이라 메뉴만 늘어난다.
  if (ctx.tabs.length > 1) {
    items.push({
      label: "모든 세션 닫기",
      accel: "w",
      danger: true,
      action: () => void ctx.closeAll(),
    });
  }
  return items;
}
