// 자동 재접속 예약 규칙 — 예기치 않게 끊긴 탭을 정해진 간격·횟수만큼 다시 붙인다.
// tabs.ts 에서 분리(사내 규칙 800줄). 동작 변화 없음.
//
// 사용자가 직접 끊었거나 탭을 닫은 경로는 애초에 여기까지 오지 않는다(호출부가
// 매핑을 먼저 지운다). 잠긴 탭은 건너뛴다 — 잠금은 오조작 방지가 목적이라
// 자동 동작이 그 위를 지나가면 안 된다.

import type { TerminalTab } from "./termtab";

/** 예약 상태. 탭이 닫히면 호출부가 함께 정리한다. */
export interface AutoState {
  timers: Map<TerminalTab, number>;
  tries: Map<TerminalTab, number>;
}

export function scheduleAutoReconnect(
  st: AutoState,
  tab: TerminalTab,
  reconnect: () => void,
): void {
  if (!tab.session.autoReconnect) return;
  if (tab.locked) return; // 잠긴 세션은 오조작 방지가 우선
  const max = Math.max(1, tab.session.autoReconnectMax ?? 3);
  const tries = st.tries.get(tab) ?? 0;
  if (tries >= max) {
    tab.showRetryNote(`자동 재접속 ${max}회 실패 — 자동 시도를 멈췄습니다.`);
    return;
  }
  const delay = Math.max(1, tab.session.autoReconnectDelaySec ?? 5);
  st.tries.set(tab, tries + 1);
  tab.showRetryNote(`${delay}초 후 자동 재접속… (${tries + 1}/${max})`);
  const id = window.setTimeout(() => {
    st.timers.delete(tab);
    if (tab.disposed) return;
    if (tab.status === "connected" || tab.status === "connecting") return;
    reconnect();
  }, delay * 1000);
  st.timers.set(tab, id);
}

/** 예약된 자동 재접속을 취소한다(사용자가 직접 끊거나 탭을 닫을 때). */
export function cancelAutoReconnect(st: AutoState, tab: TerminalTab): void {
  const id = st.timers.get(tab);
  if (id !== undefined) window.clearTimeout(id);
  st.timers.delete(tab);
}
