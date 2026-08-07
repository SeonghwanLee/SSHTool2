// 부팅 시 1회 배선 — 정적 아이콘, 웹뷰 내비게이션/브라우저 단축키 차단.
// main.ts 에서 분리(0.63.0 정지작업). 로직 변경 없음.

import { applyIcon } from "./icons";

/** 정적 버튼(타이틀바·사이드바 헤더·창버튼)에 WPF 동일 Segoe 아이콘 적용. */
export function applyStaticIcons(): void {
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
export function wireNavigationGuard(): void {
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

export function wireBrowserKeyGuard(): void {
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
