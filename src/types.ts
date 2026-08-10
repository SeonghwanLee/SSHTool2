// 프론트 전역 공용 타입.

/** 패턴 감지 → 자동 입력 규칙(WPF TriggerEngine 대응). 값은 평문 저장 — 비밀번호 금지. */
export interface TriggerRule {
  /** 감지할 패턴(정규식 또는 부분문자열). */
  pattern: string;
  /** 감지 시 전송할 문자열(끝에 개행이 필요하면 직접 포함). 비밀이면 볼트에 보관되어 여기선 빈 값. */
  send: string;
  /** true 면 send 를 세션 파일이 아니라 볼트에 저장한다(옵트인). */
  secret: boolean;
  /** true 면 pattern 을 정규식으로 해석. */
  regex: boolean;
}

export type Charset =
  | "UTF-8"
  | "EUC-KR"
  | "CP949"
  | "ISO-8859-1"
  | "Shift_JIS"
  | "GBK"
  | "US-ASCII";
/** 세션 종류 — SSH 원격 접속 또는 로컬 셸(서버 없이 cmd/PowerShell 실행). */
/**
 * 세션 종류. "rdp" 는 터미널 탭을 만들지 않고 Windows 기본 원격 데스크톱(mstsc.exe)을
 * 별도 창으로 띄운다 — RDP 는 그래픽 프로토콜이라 xterm 영역에 넣을 수 없다.
 */
export type SessionKind = "ssh" | "local" | "rdp";
/** 인증 방식 — 비밀번호 또는 개인키. */
export type AuthType = "password" | "key";

/** 저장되는 세션 정의(백엔드 store::SessionInfo 와 camelCase 1:1). */
/** 세션 호스트의 웹 서비스 하나 — 우클릭 '서비스 연결' 메뉴의 한 줄이 된다. */
export interface ServiceLink {
  name: string;
  scheme: "http" | "https";
  port: number;
  /** URL 뒷부분("/admin?tab=1" 등). 비워도 된다. */
  path: string;
  /** 열 브라우저. default = OS 기본. */
  browser: "default" | "chrome" | "edge";
}

export interface SessionInfo {
  /** 저장 세션의 안정적 id(접속마다 바뀌는 live id 와 다름). */
  id: string;
  name: string;
  /** "ssh" = 원격 접속, "local" = 로컬 셸. */
  kind: SessionKind;
  /** 로컬 셸 실행 파일(비우면 OS 기본 셸). kind="local" 일 때만 사용. */
  shellExe: string;
  /** 로컬 셸 시작 디렉터리. kind="local" 일 때만 사용. */
  workingDir: string;
  host: string;
  port: number;
  user: string;
  /** 인증 방식(SSH 세션). */
  authType: AuthType;
  /** 개인키 파일 경로(authType="key"). */
  privateKeyPath: string;
  /** 사이드바 트리 폴더 경로. "" = 루트, "a/b" = 중첩. */
  folder: string;
  /** true 면 접속 성공 시 비밀번호를 볼트에 저장. */
  savePassword: boolean;
  /** 같은 폴더 안에서의 수동 정렬 순서(작을수록 위). */
  sortOrder: number;
  /** 터미널 문자셋. 비-UTF-8 은 백엔드에서 변환. */
  charset: Charset;
  /** 접속 직후 자동 실행할 명령(줄바꿈 구분). 비밀이면 볼트에 보관되어 여기선 빈 값. */
  startupCommands: string;
  /** true 면 startupCommands 를 세션 파일이 아니라 볼트에 저장한다(옵트인). */
  startupCommandsSecret: boolean;
  /** 패턴 감지 자동 입력 규칙. */
  triggers: TriggerRule[];
  /** true 면 터미널 수신 내용을 logs/ 에 파일로 기록. */
  enableLog: boolean;
  /** false 면 이 세션은 SFTP 를 열지 않는다(터미널 전용). */
  enableSftp: boolean;
  /** 마지막 접속 시각(unix 초, 0=없음). '최근 접속순 정렬'에 사용. */
  lastConnectedUtc: number;
  /** 포트 포워딩 규칙(줄 단위). L:로컬포트:대상호스트:대상포트 / R:... */
  portForwards: string;
  /** 이 세션의 터미널 글자 크기(0 = 전역 설정 따름). Ctrl+휠 조절 시 세션별로 기록. */
  fontSize: number;
  /**
   * 이 서버에서 브라우저로 여는 웹 서비스 목록(관리콘솔·그라파나 등). 호스트는 세션 것을
   * 그대로 쓴다 — 서버 IP 가 바뀌면 세션만 고치면 전부 따라온다. 없으면 메뉴에 안 뜬다.
   */
  services?: ServiceLink[];
  /**
   * true 면 구형 서버(CentOS 5·OpenSSH 4.x 등)용 레거시 알고리즘(SHA-1 KEX·MAC, CBC 암호)을
   * 협상 목록 맨 뒤에 추가한다. 최신 서버와의 협상 결과는 바뀌지 않는다.
   */
  allowLegacyAlgorithms: boolean;
  /**
   * 세션 색 태그(0.67.0). 목록·탭에 띠로 표시해 운영/개발을 눈으로 가른다 —
   * 세션 잠금과 함께 "운영 서버에 실수" 를 막는 두 번째 방어선이다.
   * "" = 없음. 값은 SESSION_COLORS 의 id.
   */
  color?: SessionColor;
  /** true 면 연결이 끊겼을 때 스스로 다시 붙는다(사용자가 끊은 경우는 제외). */
  autoReconnect?: boolean;
  /** 자동 재접속 간격(초). 1~300, 기본 5. */
  autoReconnectDelaySec?: number;
  /** 자동 재접속 최대 시도 횟수(0 = 무제한 아님 — 기본 3회에서 멈춘다). */
  autoReconnectMax?: number;
}

/** 세션 색 태그 — 값(id)은 저장 파일에 남으므로 바꾸지 말 것. */
export const SESSION_COLORS = [
  { id: "", label: "없음", css: "" },
  { id: "red", label: "운영(빨강)", css: "#e06c75" },
  { id: "amber", label: "검증(주황)", css: "#d19a66" },
  { id: "green", label: "개발(초록)", css: "#98c379" },
  { id: "blue", label: "기타(파랑)", css: "#61afef" },
  { id: "violet", label: "기타(보라)", css: "#c678dd" },
] as const;
export type SessionColor = (typeof SESSION_COLORS)[number]["id"];
/** 색 id → CSS 색. 모르는 값(구버전·손상)이면 빈 문자열 = 표시 안 함. */
export const sessionColorCss = (id?: string): string =>
  SESSION_COLORS.find((c) => c.id === id)?.css ?? "";

/** 새 세션 기본값. */
export function blankSession(): SessionInfo {
  return {
    id: crypto.randomUUID(),
    name: "",
    kind: "ssh",
    shellExe: "",
    workingDir: "",
    host: "",
    port: 22,
    user: "",
    authType: "password",
    privateKeyPath: "",
    folder: "",
    savePassword: false,
    sortOrder: 0,
    charset: "UTF-8",
    startupCommands: "",
    startupCommandsSecret: false,
    triggers: [],
    enableLog: false,
    enableSftp: true,
    lastConnectedUtc: 0,
    portForwards: "",
    fontSize: 0,
    allowLegacyAlgorithms: false,
    color: "",
    autoReconnect: false,
    autoReconnectDelaySec: 5,
    autoReconnectMax: 3,
  };
}

/** 저장 파일에 옛 세션(신규 필드 없음)이 있어도 안전하게 채운다. */
export function normalizeSession(s: Partial<SessionInfo>): SessionInfo {
  return {
    ...blankSession(),
    ...s,
    id: s.id ?? crypto.randomUUID(),
    triggers: Array.isArray(s.triggers)
      ? s.triggers.map((t) => ({ ...t, secret: t.secret ?? false }))
      : [],
    // 구버전 파일·손상값 방어 — 모르는 색은 '없음', 간격·횟수는 범위 안으로.
    color: SESSION_COLORS.some((c) => c.id === s.color) ? s.color : "",
    autoReconnectDelaySec: Math.max(1, Math.min(300, Math.round(s.autoReconnectDelaySec ?? 5))),
    autoReconnectMax: Math.max(1, Math.min(99, Math.round(s.autoReconnectMax ?? 3))),
  };
}
