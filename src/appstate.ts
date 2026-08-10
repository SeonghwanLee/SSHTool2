// 앱 전역 가변 상태 — main.ts 에 흩어져 있던 모듈 변수를 한곳에 모은다.
//
// 왜 필요한가(0.67.0 정지작업): main.ts 가 1,300줄을 넘겨 흐름별로 쪼개려는데, 그 함수들이
// 전부 `sessions`·`settings` 같은 모듈 변수를 직접 읽고 쓰고 있었다. 함수만 옮기면
// 참조가 끊긴다. 호출부마다 인자로 넘기는 방식은 변경량이 크고 실수 여지가 많아,
// 상태를 한 모듈에 두고 어디서나 같은 것을 보게 한다 — 동작은 이전과 완전히 같다.
//
// 규칙: 여기 담는 것은 **앱 수명 동안 유지되는 공유 상태**뿐이다. 특정 화면 안에서만
// 쓰는 값은 그 모듈에 둔다(SFTP 창 크기처럼).

import type { SessionInfo } from "./types";
import type { Settings } from "./settings";
import type { TabManager } from "./tabs";
import { sessionsSave } from "./ipc";
import { saveFailureAlert } from "./dialogs";

/** 저장된 세션 목록. 항상 새 배열로 교체한다(불변 취급). */
export let sessions: SessionInfo[] = [];
export const setSessions = (next: SessionInfo[]): void => {
  sessions = next;
};

/** 앱 설정. 마찬가지로 새 객체로 교체한다. */
export let settings: Settings;
export const setSettings = (next: Settings): void => {
  settings = next;
};

/**
 * 세션 파일을 정상적으로 읽었을 때만 true. 읽기에 실패한 상태에서 저장하면
 * 빈 목록으로 기존 파일을 덮어써 데이터가 유실되므로 저장을 잠근다.
 */
export let sessionsLoaded = false;
export const setSessionsLoaded = (v: boolean): void => {
  sessionsLoaded = v;
};

/** 자동 업데이트 경고 등에서 접속 세션 수를 참조하기 위한 핸들. */
export let tabManager: TabManager | undefined;
export const setTabManager = (t: TabManager): void => {
  tabManager = t;
};

// ── main() 이 사이드바를 만든 뒤 주입하는 동작들 ──
// 기본 구현은 무동작 — 주입 전에 불려도 터지지 않게 한다(초기화 순서 사고 방지).

/** 사이드바 재그리기. */
export let redraw: () => void = () => {};
/** 사이드바 표시 옵션 적용(정렬·세부정보). */
export let applyDisplayOptions: (s: Settings) => void = () => {};
/** 세션 가져오기 창. */
export let runImport: () => Promise<void> = async () => {};
/** 새 폴더 만들기. */
export let newFolderFlow: (parent: string) => Promise<void> = async () => {};

export function injectActions(a: {
  redraw: () => void;
  applyDisplayOptions: (s: Settings) => void;
  runImport: () => Promise<void>;
  newFolderFlow: (parent: string) => Promise<void>;
}): void {
  redraw = a.redraw;
  applyDisplayOptions = a.applyDisplayOptions;
  runImport = a.runImport;
  newFolderFlow = a.newFolderFlow;
}

export async function persist(): Promise<void> {
  if (!sessionsLoaded) {
    console.error("세션 로드 실패 상태 — 데이터 보호를 위해 저장을 건너뜁니다.");
    return;
  }
  try {
    await sessionsSave(sessions);
  } catch (e) {
    // 파일 암호화 키를 못 읽으면 백엔드가 평문 덮어쓰기를 거부한다 — 조용히 넘기면
    // 사용자는 저장된 줄 알고 계속 편집하게 된다.
    console.error("세션 저장 실패", e);
    await saveFailureAlert("세션 목록", e);
  }
}

