// 앱 설정 모델 + 영속화 + 폰트 목록. 스키마는 프론트 소유(백엔드는 JSON 통째 저장).

import { settingsLoad, settingsSave } from "./ipc";
import { DEFAULT_THEME_ID } from "./themes";

export type CursorStyle = "block" | "underline" | "bar";
/** 세션 화면 배치(tabs.ts ViewMode 와 동일 — 순환 import 를 피하려 여기서 정의). */
export type ViewModeSetting = "tabs" | "vertical" | "horizontal";

export interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  copyOnSelect: boolean;
  scrollback: number;
  /** 명시적으로 만든 폴더 경로 — 세션이 하나도 없어도 트리에 유지된다(빈 폴더). */
  folders: string[];
  /** 무활동 자동 잠금(분). 0 = 사용 안 함. */
  autoLockMinutes: number;
  /** 세션 화면 배치(탭/세로 분할/가로 분할). */
  viewMode: ViewModeSetting;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME_ID,
  fontFamily: "D2Coding",
  fontSize: 14,
  cursorBlink: true,
  cursorStyle: "block",
  copyOnSelect: true,
  scrollback: 5000,
  folders: [],
  autoLockMinutes: 0,
  viewMode: "tabs",
};

export interface FontChoice {
  id: string;
  label: string;
  note: string;
  embedded: boolean;
}

/** 내장 4종(설치 불필요) + 대표 시스템 고정폭. 내장은 @font-face 로 로드됨. */
export const FONTS: FontChoice[] = [
  { id: "D2Coding", label: "D2Coding", note: "내장 · 한글+영문 (Naver)", embedded: true },
  { id: "JetBrains Mono", label: "JetBrains Mono", note: "내장 · Apache 2.0", embedded: true },
  { id: "IBM Plex Mono", label: "IBM Plex Mono", note: "내장 · SIL OFL", embedded: true },
  { id: "Hack", label: "Hack", note: "내장 · MIT", embedded: true },
  { id: "Consolas", label: "Consolas", note: "시스템", embedded: false },
  { id: "Courier New", label: "Courier New", note: "시스템", embedded: false },
];

/** 선택 폰트 + 폴백. D2Coding 을 항상 폴백에 둬 한글이 깨지지 않게 한다(WPF 교훈). */
export function fontStack(family: string): string {
  return `"${family}", "D2Coding", Consolas, "Courier New", monospace`;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await settingsLoad();
    const merged = { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
    // 옛 설정 파일에 folders 가 없거나 형식이 깨진 경우 방어.
    if (!Array.isArray(merged.folders)) merged.folders = [];
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await settingsSave(s);
}
