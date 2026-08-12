// 앱 설정 모델 + 영속화 + 폰트 목록. 스키마는 프론트 소유(백엔드는 JSON 통째 저장).

import { settingsLoad, settingsSave } from "./ipc";
import { saveFailureAlert } from "./dialogs";
import { DEFAULT_THEME_ID, THEMES } from "./themes";
import { SAVER_NAMES, type SaverName } from "./screensaver";

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
  /** @deprecated 0.73.0 부터 sidebarDocked 로 대체. 구버전 파일 이관에만 쓴다. */
  sidebarCollapsed: boolean;
  /**
   * 세션영역 고정(도킹) 여부. true = 화면 왼쪽에 붙어 자리를 차지한다(기본).
   * false = 숨겨 두고 좌상단 메뉴 버튼으로 잠깐 띄운다(그라파나 방식).
   */
  sidebarDocked: boolean;
  /**
   * 붙여넣기 확인을 띄울 최소 줄 수. 0 = 묻지 않음(예전 동작), 2 = 두 줄 이상이면 확인(기본).
   * 여러 줄을 붙이면 줄바꿈이 곧 실행이라, 운영 서버에서는 한 번 되짚을 값어치가 있다.
   */
  pasteConfirmLines: number;
  /**
   * 한글 조합 중인 글자를 조합이 시작된 셀에 고정할지(기본 켬). 끄면 xterm 기본 동작 —
   * 커서를 따라 매 렌더마다 다시 놓는다. 앱마다 커서를 두는 자리가 달라, 어느 쪽이
   * 맞는지는 실제로 써 보고 고르는 편이 빠르다.
   */
  imePinning: boolean;
  /**
   * SFTP 를 열 때 로컬 창이 시작할 폴더. 빈 값이면 OS 기본(문서/홈)을 쓴다.
   * 직전에 보던 폴더가 있으면(연결 재사용) 그쪽이 우선 — 하던 일을 끊지 않는 게 먼저다.
   */
  sftpLocalDir: string;
  /**
   * SFTP 전송 속도 상한(KB/s). 0 = 무제한(기본). 여기 값은 '기본값'이고, 전송 중에는
   * SFTP 창에서 즉석으로 바꿀 수 있다 — 급해서 한 번 줄인 값이 다음 주까지 따라다니지
   * 않도록 창에서 바꾼 것은 저장하지 않는다.
   */
  sftpRateLimitKbps: number;
  /**
   * 진단 로그(debug.log) 사용 여부. 터미널이 받은 원시 바이트까지 남기므로 기본은 꺼짐이다 —
   * 화면에 뜬 설정값·키·토큰이 그대로 파일에 남는다. 문제를 재현하는 동안에만 켠다.
   */
  verboseLog: boolean;
  /**
   * 내부망 전용 모드. 켜지면 GitHub 로 나가는 UI(업데이트 확인 등)를 감춘다.
   * 시작 시 업데이트 확인을 다시 켜면 자동으로 풀린다 — "이 PC 는 인터넷이 된다"는 선언이다.
   */
  offlineMode: boolean;
  /**
   * 폴더별 세션 정렬 방식. 키는 폴더 경로("" = 루트), 값이 없으면 전역 규칙을 따른다
   * (최근 접속순 설정이 켜져 있으면 그 기준, 아니면 끌어서 정한 순서).
   * 폴더마다 성격이 달라서 — 운영 서버는 이름순이 편하고 임시 작업 폴더는 손으로
   * 배치하는 게 편하다 — 전역 하나로는 부족했다.
   */
  folderSort: Record<string, FolderSort>;
  /** 화면보호기 종류. "random" = 켜질 때마다 무작위. */
  screensaver: ScreensaverChoice;
}

export type ScreensaverChoice = "random" | SaverName;

/** 폴더 정렬 방식. `manual` = 끌어서 정한 순서(sortOrder). */
export type FolderSort = "manual" | "name-asc" | "name-desc" | "recent";

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
  sidebarDocked: true,
  pasteConfirmLines: 2,
  imePinning: true,
  sftpLocalDir: "",
  sftpRateLimitKbps: 0,
  verboseLog: false,
  offlineMode: false,
  folderSort: {},
  screensaver: "random",
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
    // 구버전 파일 이관(0.73.0): 접혀 있었으면 '고정 해제' 상태로 옮긴다.
    if (typeof (raw as Partial<Settings>)?.sidebarDocked !== "boolean")
      merged.sidebarDocked = !merged.sidebarCollapsed;
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
    // 구버전 파일에는 없던 항목 — 형식이 깨져 있으면 트리 정렬이 통째로 멈춘다.
    if (!merged.folderSort || typeof merged.folderSort !== "object") merged.folderSort = {};
    // 삭제된 화면보호기(생명게임·프롬프트 등)를 골라 뒀던 파일 방어 — 무작위로 되돌린다.
    if (merged.screensaver !== "random" && !(SAVER_NAMES as readonly string[]).includes(merged.screensaver))
      merged.screensaver = "random";
    settingsUsable = true;
    return merged;
  } catch {
    // 읽기 실패(키스토어 일시 오류 등)면 기본값으로 뜨되 **저장을 잠근다** —
    // 안 그러면 이후 아무 설정 변경이 기본값으로 파일을 덮어써 폴더 트리·정렬·
    // 접힘 상태가 통째로 유실된다(진단 0.62.0, 세션 쪽 잠금과 같은 원리).
    settingsUsable = false;
    return { ...DEFAULT_SETTINGS };
  }
}

/** 설정 파일을 정상적으로 읽었는가 — 실패 상태에서는 저장을 거부해 덮어쓰기를 막는다. */
export let settingsUsable = true;
let lockAlerted = false; // 잠김 안내는 한 번만 — 설정 변경 때마다 뜨면 그것대로 공해다

export async function saveSettings(s: Settings): Promise<void> {
  if (!settingsUsable) {
    // 조용히 버리면 사용자는 저장된 줄 안다 — 한 번 알리고, 던져서 호출부 처리를 태운다.
    if (!lockAlerted) {
      lockAlerted = true;
      // await 하지 않는다 — 사용자가 확인을 누를 때까지 저장 호출부가 붙들리면 안 된다.
      void saveFailureAlert(
        "설정",
        new Error("시작할 때 설정 파일을 읽지 못해 저장을 잠갔습니다(기존 설정 보호). 앱을 재시작해 보세요."),
      );
    }
    throw new Error("설정 저장 잠김(읽기 실패 보호)");
  }
  try {
    await settingsSave(s);
  } catch (e) {
    // 저장이 거부되는 대표 원인은 설정 파일 암호화 키를 읽지 못하는 경우다.
    // 알린 뒤 그대로 던져 기존 호출부의 처리(로그 등)를 바꾸지 않는다.
    await saveFailureAlert("설정", e);
    throw e;
  }
}
