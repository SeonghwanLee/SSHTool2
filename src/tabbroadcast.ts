// 동시 명령 대상 계산과 전송 — 여러 세션에 같은 입력을 보내는 규칙.
// tabs.ts 에서 분리(사내 규칙 800줄). 동작 변화 없음.

import { writeTo, type TerminalTab } from "./termtab";

const labelOf = (t: TerminalTab): string =>
  t.session.name || `${t.session.user}@${t.session.host}`;

/** 지금 보낼 수 있는 탭 목록(접속된 것만). 잠긴 탭도 표시는 하되 표시로 알린다. */
export function broadcastTargets(
  tabs: readonly TerminalTab[],
): { key: string; label: string; locked: boolean }[] {
  return tabs
    .filter((t) => t.liveId)
    .map((t) => ({ key: t.key, label: labelOf(t), locked: t.locked }));
}

/**
 * 고른 탭들에 같은 입력을 보낸다. `keys` 가 없으면 접속된 전부.
 *
 * 잠긴 탭은 건너뛴다. 잠금은 '실수로 명령이 들어가는 것'을 막는 장치인데, 동시 명령은
 * 그 사고가 가장 크게 번지는 경로다(운영 서버 10개에 한 줄). 몇 개를 건너뛰었는지
 * 돌려줘 호출부가 조용히 넘기지 않게 한다.
 */
export async function broadcastTo(
  tabs: readonly TerminalTab[],
  data: Uint8Array,
  keys?: ReadonlySet<string>,
): Promise<{ sent: number; locked: number; failed: string[] }> {
  let locked = 0;
  const writes: { label: string; p: Promise<void> }[] = [];
  for (const t of tabs) {
    if (!t.liveId) continue;
    if (keys && !keys.has(t.key)) continue;
    if (t.locked) {
      locked++;
      continue;
    }
    writes.push({ label: labelOf(t), p: writeTo(t.session, t.liveId, data) });
  }
  // 쓰기 실패를 버리면 '전송됨'이 거짓말이 된다(진단 0.62.0) — 백엔드가 세션을
  // 못 찾는 경합 창(방금 죽었는데 closed 이벤트가 아직 안 닿음)에서 실제로 난다.
  const results = await Promise.allSettled(writes.map((w) => w.p));
  const failed = writes.filter((_, i) => results[i].status === "rejected").map((w) => w.label);
  return { sent: writes.length - failed.length, locked, failed };
}

/** 닫힌 탭의 키를 걸러낸다 — 대상 집합이 유령 키를 들고 있지 않게. */
export function pruneKeys(
  tabs: readonly TerminalTab[],
  keys: ReadonlySet<string>,
): Set<string> {
  const live = new Set<string>(tabs.filter((t) => t.liveId).map((t) => t.key));
  return new Set([...keys].filter((k) => live.has(k)));
}
