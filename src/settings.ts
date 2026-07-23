// 앱 설정 모델 + 영속화 + 폰트 목록. 스키마는 프론트 소유(백엔드는 JSON 통째 저장).

import { settingsLoad, settingsSave } from "./ipc";
import { DEFAULT_THEME_ID } from "./themes";

export type CursorStyle = "block" | "underline" | "bar";

export interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  copyOnSelect: boolean;
  scrollback: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME_ID,
  fontFamily: "D2Coding",
  fontSize: 14,
  cursorBlink: true,
  cursorStyle: "block",
  copyOnSelect: true,
  scrollback: 5000,
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
    return { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await settingsSave(s);
}
