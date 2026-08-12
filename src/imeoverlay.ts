// IME 조합 오버레이 고정 — 한글을 칠 때 조합 중 글자가 커서를 따라 튀지 않게 한다.
// termtab.ts 에서 분리(0.67.0 정지작업). 로직 변경 없음.
//
// xterm 의 비공개 구조를 만지는 방어적 코드라 한 곳에 모아 둔다 — 업그레이드로 구조가
// 바뀌면 고정만 조용히 꺼지고 기본 동작으로 남는다.

import type { Terminal } from "@xterm/xterm";

/**
 * 조합(IME) 오버레이를 조합이 시작된 셀에 고정한다.
 *
 * xterm 은 조합 중인 글자를 '지금 커서 셀'에 띄우고 렌더마다 다시 놓는다. claude CLI 처럼
 * 입력 중에도 화면을 계속 다시 그리는 앱에서는, 스피너 출력이 커서를 다른 곳에 두고
 * 끝나는 순간 조합 중이던 한글이 그 자리로 점프해 보인다(시뮬레이션으로 재현·확인).
 * 조합 중에는 아무것도 서버로 전송되지 않아 실제 입력 지점은 움직이지 않으므로,
 * 시작 셀에 붙여 두는 것이 맞다.
 *
 * 안정성 원칙: xterm 의 상태(버퍼 등)는 일절 만지지 않는다. 원본 함수를 먼저 그대로
 * 실행한 뒤 오버레이·textarea 의 left/top 스타일만 되돌려 놓는다. 비공개 API 라
 * 구조가 다르면(업그레이드 등) 고정만 조용히 꺼지고 기본 동작으로 남는다.
 */
export function pinCompositionOverlay(term: Terminal): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (term as any)._core;
    const helper = core?._compositionHelper;
    const ta = term.textarea;
    if (!helper || !ta || typeof helper.updateCompositionElements !== "function") return;

    /** 고정 기준 셀. null 이면 고정하지 않는다(기본 동작). */
    let pinned: { col: number; row: number } | null = null;

    ta.addEventListener("compositionstart", () => {
      try {
        const buf = core._bufferService?.buffer;
        pinned = buf ? { col: buf.x, row: buf.y } : null;
      } catch {
        pinned = null;
      }
    });
    ta.addEventListener("compositionend", () => {
      pinned = null;
    });

    const original = helper.updateCompositionElements.bind(helper);
    helper.updateCompositionElements = (dontRecurse?: unknown) => {
      original(dontRecurse);
      if (pinned === null || !helper._isComposing) return;
      try {
        const buf = core._bufferService?.buffer;
        const cols = core._bufferService?.cols ?? 0;
        const cell = core._renderService?.dimensions?.css?.cell;
        if (!buf || !cell || !(cell.width > 0)) return;

        // 커서가 가까이서 움직이면 그것이 실제 입력 지점이다 — 앞뒤 모두 따라간다.
        // 먼 점프·다른 줄(스피너·상태줄 재그리기)만 무시한다. 그게 원래 고치려던 증상이다.
        //
        // 예전에는 **앞으로만** 따라갔다(buf.x >= pinned.col). 그러면 입력줄 전체를 매
        // 타건마다 다시 그리는 앱(claude CLI)에서 커서가 잠깐 줄 끝으로 갔다 돌아올 때
        // 돌아온 자리를 못 따라가고, 그 차이가 **한 칸씩 쌓였다** — 조합 글자 앞이 점점
        // 벌어지는 증상(0.75.1 실기 보고). 래칫을 없애고 창(±8칸) 안이면 그대로 따른다.
        if (buf.y === pinned.row && Math.abs(buf.x - pinned.col) <= 8) {
          pinned = { col: buf.x, row: buf.y };
        }

        const left = Math.min(pinned.col, Math.max(0, cols - 1)) * cell.width;
        const top = pinned.row * cell.height;
        const view = helper._compositionView as HTMLElement | undefined;
        if (view) {
          view.style.left = `${left}px`;
          view.style.top = `${top}px`;
        }
        // IME 후보창(한자 변환 목록 등)은 textarea 위치를 따라간다 — 같이 붙인다.
        const t = helper._textarea as HTMLElement | undefined;
        if (t) {
          t.style.left = `${left}px`;
          t.style.top = `${top}px`;
        }
      } catch {
        /* 계측 실패 시 이번 렌더는 기본 위치(원본이 이미 놓았다)로 둔다 */
      }
    };
  } catch {
    // 내부 구조가 예상과 다르면 고정 없이 기본 동작 — 기능 하나가 앱을 위협하지 않는다.
  }
}
