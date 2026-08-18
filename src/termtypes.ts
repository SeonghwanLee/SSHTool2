// 터미널 탭의 타입·상수·순수 헬퍼 — 화면을 만들지 않는 것들만 모았다.
// termtab.ts 에서 분리(0.67.0 정지작업). 로직 변경 없음.

import type { SessionInfo } from "./types";

/** 접속에 쓸 자격증명 + 사용자가 직접 입력했는지 여부(저장 제안용). */
export interface ResolvedCreds {
  user: string;
  password: string;
  /** true 면 이번에 프롬프트로 입력받은 것(저장 여부를 물어볼 대상). */
  prompted: boolean;
}

/** 자격증명 해결·저장 정책. 볼트 연동은 main.ts 가 구현(탭은 UI-비종속). */
/**
 * 자격증명 해결 결과 — null 은 사용자가 스스로 취소한 것, { failed } 는 서버 확인(probe)
 * 실패다. 실패를 팝업이 아니라 탭 오버레이에 보여 주려면 둘을 구분해야 한다(0.59.0).
 */
export type CredResolution = ResolvedCreds | null | { failed: string };

export interface CredentialProvider {
  resolve(session: SessionInfo): Promise<CredResolution>;
  onConnected(session: SessionInfo, creds: ResolvedCreds): Promise<void>;
  onError(session: SessionInfo, error: string): Promise<void>;
}

export const LOCAL_CREDS: ResolvedCreds = { user: "", password: "", prompted: false };

/**
 * 세션 탭 우클릭 메뉴가 앱 쪽(main.ts)에 위임하는 동작 묶음.
 *
 * 인자를 하나씩 늘리는 대신 객체로 받는다 — 생성자 인자가 이미 여덟 개라 순서로 구분하기
 * 어렵고, 항목이 늘 때마다 호출부가 위치로 어긋날 위험이 크다.
 * 주입되지 않은 동작은 메뉴에 항목 자체를 넣지 않는다(눌러도 아무 일 없는 항목 금지).
 */
export interface TabActions {
  /** SFTP 파일 전송 창 열기. */
  sftp?: (session: SessionInfo) => void;
  /** 저장 세션 이름 변경. 바뀐 이름을 돌려주면 탭 라벨을 즉시 갱신한다(취소는 null). */
  rename?: (session: SessionInfo) => Promise<string | null>;
  /** 저장 세션 편집. 편집 결과를 돌려주면 탭이 들고 있는 세션도 함께 갱신한다(취소는 null). */
  edit?: (session: SessionInfo) => Promise<SessionInfo | null>;
  /**
   * 이 세션이 저장 목록에 있는지. 빠른 접속 같은 임시 세션은 저장 목록에 없어
   * 이름 변경·편집이 아무것도 바꾸지 못하므로, false 면 두 항목을 메뉴에서 숨긴다.
   */
  isSaved?: (session: SessionInfo) => boolean;
}

export interface StatusInfo {
  label: string;
  state: "none" | "connecting" | "connected" | "disconnected";
  size: string;
  cursor: string;
  encoding: string; // 문자셋(charset)
  cipher: string; // 암호화 방식(원격 SSH 세션에만)
  /** 접속 유지시간(MM:SS 또는 HH:MM:SS). 접속 전이면 빈 문자열. */
  uptime: string;
}

/** 세션 화면 배치: 탭 / 세로 분할 / 가로 분할(WPF 0.20.0). */
export type ViewMode = "tabs" | "vertical" | "horizontal";

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const LF = new Uint8Array([0x0a]);

/**
 * 잠긴 세션에서 입력이 막혔을 때 띄우는 안내.
 * 아무 반응이 없으면 고장으로 오해하므로 왜 안 나가는지 매번 알려 준다.
 */
export const LOCKED_HINT = "세션 잠김 — 탭 우클릭 → 세션 잠금 해제";

/** 확대/축소 배율 표시가 떠 있는 시간(ms). */
export const ZOOM_BADGE_MS = 900;

/**
 * 트리거 발동 허용 창(ms). 접속 직후에만 발동시켜, 한참 뒤에 나타난 패턴 출력에는
 * 반응하지 않게 한다 — 서버를 장악한 쪽이 패턴을 출력해 값을 받아내는 것을 막는
 * 안전장치다(0.72.0). 로그인·sudo 프롬프트는 접속 직후에 나오므로 정상 용도는 이 안에 든다.
 *
 * 다만 다단계 규칙(su → 비밀번호 → 명령)은 앞 단계의 응답을 기다린 뒤에 오므로 접속
 * 시각만 기준으로 재면 2단계부터 막힌다(사용자 보고 0.83.0). 그래서 **발동할 때마다
 * 이 창을 다시 연다** — 이어지는 동안에는 유효하고, 아무 일 없이 조용하면 닫힌다.
 */
export const TRIGGER_WINDOW_MS = 10_000;

/**
 * 연장에도 불구하고 넘길 수 없는 상한(ms). 규칙이 서로를 계속 깨우는 경우에도
 * 접속 후 이만큼이 지나면 더는 발동하지 않는다 — 안전장치가 무한정 열려 있지 않게.
 */
export const TRIGGER_MAX_MS = 120_000;

/** "#RRGGBB" 를 [r,g,b] 로. 형식이 아니면 null. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 두 색을 t 비율로 섞는다(0 = a, 1 = b). 검색 강조색을 테마에 맞춰 만드는 데 쓴다 —
 * 색을 고정하면 밝은 테마에서 글자가 안 보이거나 어두운 테마에서 튄다.
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const mix = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return "#" + mix.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** 접속 유지시간 표기 — 1시간을 넘기면 HH:MM:SS, 그 전까지는 MM:SS. */
export const formatUptime = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const mins = Math.floor(total / 60) % 60;
  const secs = total % 60;
  return hours > 0 ? `${pad(hours)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
};

/**
 * 트리거 매칭용으로 ANSI 제어 시퀀스를 제거한다. 컬러 프롬프트
 * (예: "\x1b[32mpassword:\x1b[0m")에서도 사용자가 눈으로 본 문자열로 매칭되게 한다.
 */
// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[\]()#;?]*[0-9;]*[A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/**
 * 세션이 끊긴 뒤 터미널에 남는 입력 모드를 원상복구하는 시퀀스.
 *
 * 원격 앱(Claude CLI·vim·tmux 등)이 켜 둔 모드는 **터미널 쪽 상태**라 세션이 죽어도
 * 그대로 남는다. 특히 마우스 추적이 켜진 채 재접속하면 마우스를 움직이는 것만으로
 * `ESC[<35;82;12M` 같은 시퀀스가 새 셸로 날아가, 프롬프트에 `35;82;12M…` 이 찍힌다.
 * 끊긴 시점에 꺼 두면 다음 세션이 깨끗한 상태에서 시작한다.
 *
 * term.reset() 은 쓰지 않는다 — 화면과 스크롤백까지 지워서, 끊긴 세션의 마지막 출력을
 * 남겨 두는 '세션 종료' 동작과 어긋난다. 모드만 골라서 끈다.
 */
export const RESET_INPUT_MODES =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l" + // 마우스 추적(클릭·버튼이동·전체이동)
  "\x1b[?1005l\x1b[?1006l\x1b[?1015l" + // 마우스 좌표 확장 인코딩
  "\x1b[?2004l" + // 괄호 붙여넣기
  "\x1b[?1l\x1b>"; // 커서키·키패드를 일반 모드로

