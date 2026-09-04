// 앱 설정 모델 + 영속화 + 폰트 목록. 스키마는 프론트 소유(백엔드는 JSON 통째 저장).

import { settingsLoad, settingsSave } from "./ipc";
import { saveFailureAlert } from "./dialogs";
import { DEFAULT_THEME_ID, THEMES } from "./themes";
import { SAVER_NAMES, type SaverName } from "./screensaver";

/**
 * 세션영역 최소 폭(px).
 *
 * 실측(0.76.2, 실기 보고): 250px 아래로 줄이면 머리말 버튼이 영역 **밖으로** 나가
 * 터미널 위에 겹쳐 보였다. 줄바꿈 허용을 넣은 뒤로는 밖으로 나가지는 않지만 265px
 * 미만에서 머리말이 두 줄이 된다 — 원래 한 줄 디자인이 유지되는 값으로 잡는다.
 * 예전 기본(240)은 이미 깨지는 폭이었으므로 기본값도 여기에 맞춘다.
 */
/**
 * 분할 보기에 세울 수 있는 최대 칸 수(0.85.0, 사용자 요청).
 *
 * 왜 막는가: 칸이 늘수록 한 칸이 좁아져 어차피 읽을 수 없고, 터미널 하나하나가
 * 화면을 그리는 비용을 그대로 더한다 — 열 칸을 세우면 전부가 굼떠진다. 아홉이면
 * 3×3 으로 딱 떨어지는 가장 큰 배치다.
 */
export const MAX_SPLIT_PANES = 9;

export const SIDEBAR_MIN_W = 280;
export const SIDEBAR_MAX_W = 560;

export type CursorStyle = "block" | "underline" | "bar";
/** 세션 화면 배치(tabs.ts ViewMode 와 동일 — 순환 import 를 피하려 여기서 정의). */
export type ViewModeSetting = "tabs" | "vertical" | "horizontal";

/** 분할 그룹 하나 — 이름·방향·세션 목록. */
export interface SplitGroup {
  id: string;
  name: string;
  mode: "vertical" | "horizontal";
  sessionIds: string[];
}

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
  /**
   * 화면보호기가 뜨기까지의 무활동 시간(분). 0 = 띄우지 않음.
   *
   * 0.86.0 이전에는 이 값이 없었고 autoLockMinutes 하나가 둘을 겸했다 — 0이면 '잠그지
   * 않고 5분 뒤 화면보호기', 1 이상이면 '그 시간에 잠그고 화면보호기는 영영 안 뜸'.
   * 그래서 '화면보호기 5분 + 잠금 30분' 같은 당연한 조합이 불가능했고, 화면보호기가
   * 싫으면 잠금을 켜는 수밖에 없었다(사용자 지적). 둘을 갈라 놓는다.
   */
  screensaverMinutes: number;
  /** 세션 화면 배치(탭/세로 분할/가로 분할). */
  viewMode: ViewModeSetting;
  /**
   * 분할 그룹(0.81.0) — 자주 함께 보는 세션 묶음에 이름을 붙여 둔 것.
   * 탭이 아니라 **세션 id** 를 담는다: 앱을 껐다 켜도 남고, 불러올 때 안 열린 세션은
   * 그때 연다. 방향(세로/가로)도 묶음마다 따로 기억한다.
   */
  splitGroups?: SplitGroup[];
  /** 분할 칸 비중 — 격자 모양("vertical-2x3")별로 줄·칸 비중을 담는다(0.92.0). */
  splitSizes?: Record<string, { cols: number[]; rows: number[] }>;
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
  screensaverMinutes: 10,
  viewMode: "tabs",
  splitGroups: [],
  splitSizes: {},
  checkUpdateOnStartup: true,
  sortByRecent: false,
  showSessionDetail: true,
  recentLimit: 10,
  sidebarWidth: SIDEBAR_MIN_W,
  sidebarCollapsed: false,
  sidebarDocked: true,
  pasteConfirmLines: 2,
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
  // 0.88.0 추가. Iosevka 는 폭이 좁아 같은 너비에 글자가 더 들어간다 — 분할 보기에 유리하다.
  // 원본은 한 벌에 7.7MB(글리프가 방대)라 터미널이 쓰는 구간만 남겨 250KB 로 줄였다:
  // 라틴·그리스·문장부호·화살표·수학·기술기호·박스드로잉·블록·도형·딩뱃·점자·파워라인.
  { id: "Iosevka Term", label: "Iosevka Term", note: "내장 · OFL (좁은 폭)", embedded: true },
  { id: "Meslo LG S", label: "Meslo LG S", note: "내장 · Apache 2.0", embedded: true },
  { id: "0xProto", label: "0xProto", note: "내장 · OFL", embedded: true },
  { id: "Ubuntu Mono", label: "Ubuntu Mono", note: "내장 · UFL", embedded: true },
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
    // 예전 기본(240)이나 사용자가 더 좁혀 둔 값은 머리말 버튼이 삐져나가는 폭이다.
    // 읽는 김에 최소 폭으로 끌어올려 깨진 상태가 저절로 낫게 한다.
    if (!Number.isFinite(merged.sidebarWidth)) merged.sidebarWidth = SIDEBAR_MIN_W;
    merged.sidebarWidth = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, merged.sidebarWidth));
    // 구버전 파일이나 손상된 값이 경로 자리에 오면 SFTP 가 열리다 만다 — 문자열만 받는다.
    if (typeof merged.sftpLocalDir !== "string") merged.sftpLocalDir = "";
    // 구버전 파일에는 없던 항목 — 형식이 깨져 있으면 트리 정렬이 통째로 멈춘다.
    if (!merged.folderSort || typeof merged.folderSort !== "object") merged.folderSort = {};
    // 화면보호기 시간 이관(0.86.0) — 예전 파일에는 이 항목이 없다. **지금 하던 대로**
    // 옮겨야 판올림만으로 동작이 달라지지 않는다: 잠금이 0이었으면 5분 뒤 화면보호기가
    // 떴고, 1 이상이었으면 화면보호기는 뜨지 않았다.
    // 이관은 **쓰던 사람에게만** 적용한다(다음 배포). 처음 설치하는 경우까지 여기서 5로
    // 덮어쓰면 기본값(10분)을 바꿔도 새 사용자에게 닿지 않는다 — 실제로 그럴 뻔했다.
    if (!firstRun && typeof (raw as Partial<Settings>)?.screensaverMinutes !== "number")
      merged.screensaverMinutes = merged.autoLockMinutes > 0 ? 0 : 5;
    if (!Number.isFinite(merged.screensaverMinutes))
      merged.screensaverMinutes = DEFAULT_SETTINGS.screensaverMinutes;
    merged.screensaverMinutes = Math.max(0, Math.min(720, Math.round(merged.screensaverMinutes)));
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
