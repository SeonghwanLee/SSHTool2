// 창이 열리고 닫힐 때의 포커스 옮김·되돌림.
//
// 왜 한곳에 모으나: 이 앱에는 창이 여러 종류다 — 확인·경고창(dialogs), 버전 정보,
// 세션 빠른 찾기, SFTP 파일 매니저. 각자 알아서 다루다 보니 어떤 창은 포커스를
// 가져오지 않았고(버전 정보 F1 — 창은 떴는데 키 입력이 뒤 터미널의 셸로 그대로
// 들어갔다), 어떤 창은 닫은 뒤 포커스를 돌려주지 않아 타이핑이 아무 데도 가지
// 않았다. 규칙을 한 곳에 두면 새 창을 만들 때도 같은 동작을 그냥 물려받는다.
//
// 규칙 두 가지 —
//   1. 열면 포커스를 창 안으로. 단, **버튼을 미리 고르지는 않는다** — 습관적인
//      Enter 로 덮어쓰기·삭제가 실행되면 안 된다. 입력 칸이 있으면 그리로,
//      없으면 창 자체에 준다(Esc·Tab 은 듣고, Enter 는 아무 일도 하지 않는다).
//   2. 닫으면 열기 전의 자리로. 대개 터미널이다.

/** 포커스를 받을 수 있는 입력 요소 — 버튼은 일부러 뺀다(위 규칙 1). */
const INPUTS = "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])";

/**
 * 지금 포커스 자리를 기억하고, 되돌리는 함수를 돌려준다.
 *
 * 되돌릴 때 그 요소가 이미 사라졌으면(목록이 다시 그려졌다든지) 아무 일도 하지 않는다 —
 * 없어진 자리에 포커스를 주려다 예외가 나면 창 닫기 자체가 막힌다.
 */
export function captureFocus(): () => void {
  const before = document.activeElement as HTMLElement | null;
  return () => {
    if (before?.isConnected) before.focus();
  };
}

/** 포커스를 창 안으로 옮긴다(입력 칸 우선, 없으면 창 자체). */
export function focusInto(container: HTMLElement): void {
  const first = container.querySelector<HTMLElement>(INPUTS);
  if (first) {
    first.focus();
    return;
  }
  if (container.tabIndex < 0) container.tabIndex = -1; // 포커스를 받을 수 있게
  container.focus();
}

/**
 * 열 때 한 번 부르고, 돌려받은 함수를 닫을 때 부른다.
 * `captureFocus` + `focusInto` 를 한 번에 — 창 쪽 코드가 한 줄로 끝난다.
 */
export function holdFocus(container: HTMLElement): () => void {
  const restore = captureFocus();
  focusInto(container);
  return restore;
}

/**
 * 앱의 '기본 자리' — 활성 터미널. 앱이 시작할 때 한 번 등록한다.
 *
 * 작은 확인창은 열기 전 자리로 돌려주는 것이 맞지만(사이드바에서 열었으면 사이드바로),
 * SFTP 창처럼 화면을 덮는 창은 다르다. 그 창은 대개 목록의 버튼을 눌러 여는데, 닫을 때
 * 그 버튼으로 돌려주면 키보드가 버튼에 머물러 터미널에 글자가 들어가지 않는다 —
 * 한 번 더 눌러야 했다(사용자 보고 0.78.2). 이런 창은 기본 자리로 보낸다.
 */
let home: (() => void) | null = null;

export function setFocusHome(fn: () => void): void {
  home = fn;
}

/** 기본 자리로 포커스를 보낸다. 등록 전이거나 터미널이 없으면 아무 일도 하지 않는다. */
export function focusHome(): void {
  home?.();
}
