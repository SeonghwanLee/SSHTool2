// 도움말 아이콘(Segoe MDL2 Help 글리프) — 긴 안내문을 아이콘 뒤로 접는다.
//
// 설정·세션편집 화면의 안내문이 본문보다 길어져 정작 입력칸이 묻혔다. 안내는 처음 한두 번만
// 필요하고 그 뒤로는 자리만 차지한다 — 클릭하면 말풍선으로 보여 주고 평소에는 아이콘 하나만
// 남긴다. 단, 위험 고지(자동 전송·평문 기록 등)는 한 줄 요약을 화면에 남긴다 — 위험은
// 읽을 기회가 있어야 경고다.

import { applyIcon } from "./icons";

let openPop: HTMLElement | null = null;
let cleanupFns: Array<() => void> = [];

function closeHelp(): void {
  openPop?.remove();
  openPop = null;
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
}

/** 전구 버튼을 만든다. 클릭하면 옆에 말풍선이 뜨고, 바깥 클릭·Esc·재클릭으로 닫힌다. */
export function helpIcon(text: string, title = "도움말"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button"; // form 안에서 submit 으로 오인되지 않게
  btn.className = "help-bulb";
  // 이모지가 아니라 앱 전역과 같은 Segoe MDL2 글리프(Help) — 디자인 일관성(사용자 요청).
  applyIcon(btn, "help");
  btn.title = title;

  btn.addEventListener("click", (e) => {
    // 라벨(<label>) 안에 놓이면 클릭이 체크박스 토글로 이어진다 — 도움말이 설정을
    // 바꾸면 안 되므로 기본 동작을 끊는다.
    e.preventDefault();
    e.stopPropagation();

    if (openPop) {
      closeHelp();
      return;
    }

    const pop = document.createElement("div");
    pop.className = "help-pop";
    const head = document.createElement("div");
    head.className = "help-pop-title";
    head.textContent = title;
    const body = document.createElement("div");
    body.className = "help-pop-body";
    body.textContent = text; // \n 은 CSS(pre-line)가 줄바꿈으로 살린다
    pop.append(head, body);
    document.body.appendChild(pop);

    // 아이콘 아래에 붙이고, 화면을 벗어나면 안쪽으로 민다.
    const r = btn.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
    const top =
      r.bottom + 6 + pr.height > window.innerHeight - 8 ? r.top - pr.height - 6 : r.bottom + 6;
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(8, top)}px`;
    openPop = pop;

    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (!pop.contains(t) && t !== btn) closeHelp();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // 말풍선만 닫는다 — 밑에 있는 설정/편집 창까지 닫히면 입력하던 것이 날아간다.
      ev.stopPropagation();
      ev.preventDefault();
      closeHelp();
    };
    // capture 로 걸어야 다이얼로그의 Esc 처리보다 먼저 받는다.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    cleanupFns.push(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  return btn;
}
