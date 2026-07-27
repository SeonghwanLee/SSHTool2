// 앱 설정 모델 + 영속화 + 폰트 목록. 스키마는 프론트 소유(백엔드는 JSON 통째 저장).

import { settingsLoad, settingsSave } from "./ipc";
import { saveFailureAlert } from "./dialogs";
import { DEFAULT_THEME_ID, THEMES } from "./themes";

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
  /** 접어 둔 세션 폴더 경로. 재시작해도 접힌 상태가 유지되도록 저장한다. */
  collapsedFolders: string[];
  /** 무활동 자동 잠금(분). 0 = 사용 안 함. */
  autoLockMinutes: number;
  /** 세션 화면 배치(탭/세로 분할/가로 분할). */
  viewMode: ViewModeSetting;
  /** 시작 시 업데이트 확인. 내부망 전용 PC 에서는 꺼두면 외부 통신을 시도하지 않는다. */
  checkUpdateOnStartup: boolean;
  /** 세션 목록을 최근 접속순으로 정렬(끄면 수동 순서 + 이름순). */
  sortByRecent: boolean;
  /** 세션 행에 user@host:port 한 줄을 함께 표시. */
  showSessionDetail: boolean;
  /** 사이드바 "최근 접속" 표시 개수(0=숨김, 최대 50). */
  recentLimit: number;
  /** 사이드바 폭(px). */
  sidebarWidth: number;
  /** 사이드바 접힘 여부. */
  sidebarCollapsed: boolean;
  /**
   * SFTP 를 열 때 로컬 창이 시작할 폴더. 빈 값이면 OS 기본(문서/홈)을 쓴다.
   * 직전에 보던 폴더가 있으면(연결 재사용) 그쪽이 우선 — 하던 일을 끊지 않는 게 먼저다.
   */
  sftpLocalDir: string;
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
  collapsedFolders: [],
  autoLockMinutes: 0,
  viewMode: "tabs",
  checkUpdateOnStartup: true,
  sortByRecent: false,
  showSessionDetail: true,
  recentLimit: 10,
  sidebarWidth: 240,
  sidebarCollapsed: false,
  sftpLocalDir: "",
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
  { id: "Cascadia Code", label: "Cascadia Code", note: "내장 · OFL (Microsoft)", embedded: true },
  { id: "Fira Code", label: "Fira Code", note: "내장 · OFL", embedded: true },
  { id: "Source Code Pro", label: "Source Code Pro", note: "내장 · OFL (Adobe)", embedded: true },
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
    const firstRun = !raw || Object.keys(raw).length === 0;
    const merged = { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
    // 옛 설정 파일에 folders 가 없거나 형식이 깨진 경우 방어.
    if (!Array.isArray(merged.folders)) merged.folders = [];
    // 최초 실행(설정 파일 없음)에는 세션바를 무조건 펼친 상태로 시작한다.
    if (firstRun) merged.sidebarCollapsed = false;
    // 제거된 테마 id(구버전)를 저장해 둔 경우 기본 테마로 정규화한다.
    if (!THEMES.some((t) => t.id === merged.theme)) merged.theme = DEFAULT_THEME_ID;
    // 제거된 폰트(나눔고딕코딩 등)를 선택해 둔 경우 기본 폰트로 정규화.
    if (!FONTS.some((f) => f.id === merged.fontFamily)) merged.fontFamily = DEFAULT_SETTINGS.fontFamily;
    // 최근 접속 개수는 0~50 범위(구버전 파일 방어).
    if (!Number.isFinite(merged.recentLimit))
      merged.recentLimit = DEFAULT_SETTINGS.recentLimit;
    merged.recentLimit = Math.max(0, Math.min(50, Math.round(merged.recentLimit)));
    // 구버전 파일이나 손상된 값이 경로 자리에 오면 SFTP 가 열리다 만다 — 문자열만 받는다.
    if (typeof merged.sftpLocalDir !== "string") merged.sftpLocalDir = "";
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    await settingsSave(s);
  } catch (e) {
    // 저장이 거부되는 대표 원인은 설정 파일 암호화 키를 읽지 못하는 경우다.
    // 알린 뒤 그대로 던져 기존 호출부의 처리(로그 등)를 바꾸지 않는다.
    await saveFailureAlert("설정", e);
    throw e;
  }
}
