// 프론트 전역 공용 타입.

/** 패턴 감지 → 자동 입력 규칙(WPF TriggerEngine 대응). 값은 평문 저장 — 비밀번호 금지. */
export interface TriggerRule {
  /** 감지할 패턴(정규식 또는 부분문자열). */
  pattern: string;
  /** 감지 시 전송할 문자열(끝에 개행이 필요하면 직접 포함). */
  send: string;
  /** true 면 pattern 을 정규식으로 해석. */
  regex: boolean;
}

export type Charset = "UTF-8" | "EUC-KR" | "CP949";
/** 세션 종류 — SSH 원격 접속 또는 로컬 셸(서버 없이 cmd/PowerShell 실행). */
export type SessionKind = "ssh" | "local";

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
  /** 사이드바 트리 폴더 경로. "" = 루트, "a/b" = 중첩. */
  folder: string;
  /** true 면 접속 성공 시 비밀번호를 볼트에 저장. */
  savePassword: boolean;
  /** 같은 폴더 안에서의 수동 정렬 순서(작을수록 위). */
  sortOrder: number;
  /** 터미널 문자셋. 비-UTF-8 은 백엔드에서 변환. */
  charset: Charset;
  /** 접속 직후 자동 실행할 명령(줄바꿈 구분). */
  startupCommands: string;
  /** 패턴 감지 자동 입력 규칙. */
  triggers: TriggerRule[];
  /** true 면 터미널 수신 내용을 logs/ 에 파일로 기록. */
  enableLog: boolean;
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
    folder: "",
    savePassword: false,
    sortOrder: 0,
    charset: "UTF-8",
    startupCommands: "",
    triggers: [],
    enableLog: false,
  };
}

/** 저장 파일에 옛 세션(신규 필드 없음)이 있어도 안전하게 채운다. */
export function normalizeSession(s: Partial<SessionInfo>): SessionInfo {
  return {
    ...blankSession(),
    ...s,
    id: s.id ?? crypto.randomUUID(),
    triggers: Array.isArray(s.triggers) ? s.triggers : [],
  };
}
