// 프론트 전역 공용 타입.

/** 저장되는 세션 정의(백엔드 store::SessionInfo 와 camelCase 1:1). */
export interface SessionInfo {
  /** 저장 세션의 안정적 id(접속마다 바뀌는 live id 와 다름). */
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** 사이드바 트리 폴더 경로. "" = 루트, "a/b" = 중첩. */
  folder: string;
  /** true 면 접속 성공 시 비밀번호를 볼트에 저장(볼트 기능에서 사용). */
  savePassword: boolean;
}

/** 새 세션 기본값. */
export function blankSession(): SessionInfo {
  return {
    id: crypto.randomUUID(),
    name: "",
    host: "",
    port: 22,
    user: "",
    folder: "",
    savePassword: false,
  };
}
