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
export type SessionKind = "ssh" | "local";
/** 인증 방식 — 비밀번호 또는 개인키. */
export type AuthType = "password" | "key";

/** 저장되는 세션 정의(백엔드 store::SessionInfo 와 camelCase 1:1). */
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
   * true 면 구형 서버(CentOS 5·OpenSSH 4.x 등)용 레거시 알고리즘(SHA-1 KEX·MAC, CBC 암호)을
   * 협상 목록 맨 뒤에 추가한다. 최신 서버와의 협상 결과는 바뀌지 않는다.
   */
  allowLegacyAlgorithms: boolean;
}

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
  };
}
