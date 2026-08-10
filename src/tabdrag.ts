// 탭바 드래그로 순서 바꾸기. tabs.ts 에서 분리(0.67.0). 로직 변경 없음.
//
// 5px 을 넘겨 움직였을 때만 '끌기'로 보고, 그 전에는 클릭으로 남긴다 — 탭을 누르려다
// 손이 조금 흔들려도 순서가 바뀌면 안 된다.

import type { TerminalTab } from "./termtab";
import type { ViewMode } from "./termtypes";

/** 드래그가 tabs.ts 에서 필요로 하는 것만. */
export interface DragCtx {
  tabbar: HTMLElement;
  tabs: TerminalTab[];
  viewMode: ViewMode;
  /** 드래그로 판정됐는지 — 놓은 직후의 click(탭 전환)을 걸러내려고 탭바가 읽는다.
   *  값이 아니라 게터/세터로 받는다(복사하면 탭바 쪽에 반영되지 않는다). */
  getDragMoved: () => boolean;
  setDragMoved: (v: boolean) => void;
  layout: (focusActive?: boolean) => void;
  renderTabbar: () => void;
}

/**
 * 탭을 끌어 순서를 바꾼다.
 *
 * HTML5 드래그앤드롭 대신 마우스 이벤트로 처리한다. 탭바는 폭이 좁고 항목이 촘촘해
 * 놓을 자리를 픽셀 단위로 보여 줘야 하는데, dragover 는 자식 요소를 지날 때마다
 * 들락거려 표시가 깜빡인다. 좌표를 직접 보면 그 문제가 없다.
 *
 * 5px 을 넘겨야 드래그로 친다 — 그 전에는 그냥 클릭(탭 전환)이다.
 */
export function beginTabDrag(
  ctx: DragCtx,
  tab: TerminalTab,
  item: HTMLElement,
  down: MouseEvent,
): void {
  if (ctx.tabs.length < 2) return;
  const startX = down.clientX;
  ctx.setDragMoved(false);
  let dropAt = -1; // 삽입될 위치(ctx.tabs 기준 인덱스)

  const clearMarks = () => {
    for (const el of ctx.tabbar.children) el.classList.remove("drop-before", "drop-after");
  };

  const onMove = (m: MouseEvent) => {
    if (!ctx.getDragMoved()) {
      if (Math.abs(m.clientX - startX) < 5) return;
      ctx.setDragMoved(true);
      item.classList.add("dragging");
      document.body.classList.add("dragging-tab");
    }
    clearMarks();
    // 커서가 어느 탭의 어느 쪽에 있는지로 삽입 위치를 정한다.
    const items = [...ctx.tabbar.children] as HTMLElement[];
    dropAt = items.length; // 기본값 = 맨 끝
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (m.clientX < r.left + r.width / 2) {
        dropAt = i;
        break;
      }
    }
    const from = ctx.tabs.indexOf(tab);
    // 제자리(자기 앞/뒤)면 표시하지 않는다 — 옮겨지지 않는데 선이 보이면 헷갈린다.
    if (dropAt === from || dropAt === from + 1) {
      dropAt = -1;
      return;
    }
    if (dropAt < items.length) items[dropAt].classList.add("drop-before");
    else items[items.length - 1].classList.add("drop-after");
  };

  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("dragging-tab");
    item.classList.remove("dragging");
    clearMarks();
    if (ctx.getDragMoved() && dropAt >= 0) {
      const from = ctx.tabs.indexOf(tab);
      ctx.tabs.splice(from, 1);
      // 앞쪽에서 빼냈으면 목표 인덱스가 하나 당겨진다.
      ctx.tabs.splice(dropAt > from ? dropAt - 1 : dropAt, 0, tab);
      ctx.renderTabbar();
      // 화면 배치도 탭 순서를 따라야 한다. 탭 모드에서도 부른다 — layout 이 DOM 순서를
      // 맞추므로, 나중에 분할로 바꿔도 방금 정한 순서 그대로 깔린다(0.70.0).
      ctx.layout(false);
    }
    // click 은 mouseup 뒤에 온다 — 다음 프레임에 풀어야 그 클릭을 걸러낼 수 있다.
    setTimeout(() => {
      ctx.setDragMoved(false);
    }, 0);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
