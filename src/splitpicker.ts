// 분할 보기에 올릴 세션 고르기(0.80.0) — 분할 버튼 바로 아래 뜨는 작은 창.
//
// 예전에는 분할 버튼을 누르면 열린 세션을 **전부** 나눠 보여 줬다. 탭이 대여섯 개면
// 한 칸이 손바닥만 해져 정작 읽을 수가 없다 — 볼 것만 골라 담는다.
//
// 모달(화면 가운데 창)이 아니라 버튼 아래 팝업으로 둔 이유: 고르는 대상이 버튼 옆
// 탭바에 그대로 보이고 있어서, 시선을 화면 가운데로 옮겼다 돌아올 이유가 없다.

import { holdFocus } from "./focus";
import { MAX_SPLIT_PANES } from "./settings";

export interface SplitChoice<T> {
  item: T;
  label: string;
  detail: string;
  checked: boolean;
}

/**
 * 버튼 아래에 목록을 띄우고 고른 것을 돌려준다. 취소·바깥 클릭·Esc 는 null.
 * 하나도 고르지 않고 확인하면 빈 배열 — 호출부는 그것을 '분할 해제' 로 받는다.
 */
export function pickSplitTargets<T>(
  anchor: HTMLElement,
  choices: SplitChoice<T>[],
  title = "분할해서 볼 세션",
): Promise<T[] | null> {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "split-layer";
    const pop = document.createElement("div");
    pop.className = "split-pop";
    layer.appendChild(pop);

    const head = document.createElement("div");
    head.className = "split-head";
    head.textContent = title;

    const list = document.createElement("div");
    list.className = "split-list";
    const boxes: HTMLInputElement[] = [];
    for (const c of choices) {
      const row = document.createElement("label");
      row.className = "split-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = c.checked;
      const text = document.createElement("span");
      text.className = "split-name";
      text.textContent = c.label;
      const sub = document.createElement("span");
      sub.className = "split-detail";
      sub.textContent = c.detail;
      row.append(box, text, sub);
      list.appendChild(row);
      boxes.push(box);
    }

    // 전부/해제 — 세션이 많을 때 하나씩 누르는 수고를 덜어 준다.
    const bulk = document.createElement("div");
    bulk.className = "split-bulk";
    const mkBulk = (label: string, on: boolean) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "split-link";
      b.textContent = label;
      b.addEventListener("click", () => {
        // '모두 선택' 도 상한을 넘지 않는다 — 넘겨 두고 저장할 때 잘리면 무엇이 빠졌는지
        // 알 수 없다. 여기서 앞의 N 개만 켜면 무엇이 올라갈지 눈으로 보인다.
        boxes.forEach((x, i) => (x.checked = on && i < MAX_SPLIT_PANES));
        sync();
      });
      return b;
    };
    bulk.append(mkBulk("모두 선택", true), mkBulk("모두 해제", false));

    const note = document.createElement("div");
    note.className = "split-note";

    const buttons = document.createElement("div");
    buttons.className = "split-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "취소";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn-accent";
    ok.textContent = "분할";
    buttons.append(cancel, ok);

    /**
     * 하나도 고르지 않으면 '분할 해제' — 전부 해제하는 것이 곧 "이 방향은 이제 안 쓴다"는
     * 뜻이다(사용자 요청 0.80.1). 버튼을 죽여 두면 창을 닫는 것 말고는 길이 없었다.
     */
    const sync = () => {
      const picked = boxes.filter((b) => b.checked).length;
      const none = picked === 0;
      ok.textContent = none ? "분할 해제" : "분할";
      ok.classList.toggle("btn-accent", !none);
      // 상한에 닿으면 안 고른 칸은 더 못 누르게 한다(0.85.0) — 누를 수는 있는데 저장할 때
      // 잘리는 것보다, 아예 못 누르는 편이 무엇이 올라갈지 분명하다. 이미 고른 것은
      // 그대로 둬야 마음을 바꿔 뺄 수 있다.
      const full = picked >= MAX_SPLIT_PANES;
      for (const b of boxes) b.disabled = full && !b.checked;
      note.textContent = full
        ? `최대 ${MAX_SPLIT_PANES}칸까지 — 더 담으려면 하나를 빼세요`
        : `${picked}개 선택 (최대 ${MAX_SPLIT_PANES})`;
      note.classList.toggle("full", full);
    };
    for (const b of boxes) b.addEventListener("change", sync);
    sync();

    pop.append(head, list, bulk, note, buttons);

    let done = false;
    const close = (value: T[] | null) => {
      if (done) return;
      done = true;
      release();
      document.removeEventListener("keydown", onKey, true);
      layer.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () =>
      close(choices.filter((_, i) => boxes[i].checked).map((c) => c.item)),
    );
    // 바깥을 누르면 취소 — 고르다 만 것을 저장할 이유가 없다(팔레트와 같은 규칙).
    layer.addEventListener("mousedown", (e) => {
      if (e.target === layer) close(null);
    });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(layer);
    // 버튼 아래에 붙이되 화면 밖으로 나가지 않게 민다.
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const left = Math.min(Math.max(6, r.left), window.innerWidth - pr.width - 6);
    const top = Math.min(r.bottom + 4, window.innerHeight - pr.height - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(6, top)}px`;

    const release = holdFocus(pop);
  });
}
