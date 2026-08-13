// 진단 로그 — 켜져 있을 때만 `<설정폴더>/debug.log` 에 쌓는다.
//
// 세션별 로그(세션 편집의 '로그 저장')와는 다른 물건이다. 그쪽은 "이 세션에서 무엇을
// 했나"를 남기고, 이쪽은 "앱이 왜 그렇게 동작했나"를 쫓는다 — 접속·끊김, 터미널이 받은
// 원시 바이트, 프런트에서 터진 예외가 시각과 함께 한 줄기로 들어온다.
//
// 청크마다 IPC 를 부르면 출력이 많은 세션에서 호출만으로 부담이 된다. 모아 두었다가
// 주기적으로 한 번에 넘긴다.

import { debugLogAppend, debugLogReset } from "./ipc";

/** 모아 둔 줄을 넘기는 주기(ms). */
const FLUSH_MS = 700;
/** 한 청크에서 기록할 최대 글자 수 — 대량 출력에서 파일이 순식간에 커지는 것을 막는다. */
const CHUNK_CHARS = 4000;

let enabled = false;
let buffer: string[] = [];
let timer: number | null = null;
/** 쓰기가 실패해도 매번 콘솔을 채우지 않도록 한 번만 알린다. */
let warned = false;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, "0")}`;
}

function flush(): void {
  timer = null;
  if (buffer.length === 0) return;
  const text = buffer.join("");
  buffer = [];
  void debugLogAppend(text).catch((e) => {
    if (warned) return;
    warned = true;
    console.error("진단 로그 기록 실패", e);
  });
}

function schedule(): void {
  if (timer !== null) return;
  timer = window.setTimeout(flush, FLUSH_MS);
}

/** 진단 로깅 사용 여부. 켜는 순간 파일을 새로 시작한다. */
export async function setDebugLogging(on: boolean): Promise<void> {
  if (on === enabled) return;
  enabled = on;
  if (!on) {
    flush(); // 끄기 직전까지의 내용은 남긴다
    return;
  }
  warned = false;
  // 예전 세션의 내용이 남아 있으면 문제를 넘길 때 무엇이 딸려 가는지 알 수 없다.
  await debugLogReset().catch((e) => console.error("진단 로그 초기화 실패", e));
  logLine("로깅 시작", `${navigator.userAgent}`);
}


/** 사건 한 줄. */
export function logLine(tag: string, text = ""): void {
  if (!enabled) return;
  buffer.push(`[${stamp()}] ${tag}${text ? ` ${text}` : ""}\n`);
  schedule();
}

/**
 * 터미널이 받은 원시 바이트. 눈으로 읽을 수 있게 제어문자를 이스케이프한다 —
 * 화면에 무엇이 그려졌는지가 아니라 서버가 무엇을 보냈는지가 알고 싶은 것이다.
 */
export function logBytes(tag: string, bytes: Uint8Array): void {
  if (!enabled) return;
  let out = "";
  for (const b of bytes) {
    if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x09) out += "\\t";
    else if (b === 0x1b) out += "\\e";
    else if (b < 0x20 || b === 0x7f) out += `\\x${b.toString(16).padStart(2, "0")}`;
    else if (b < 0x80) out += String.fromCharCode(b);
    // 0x80 이상은 UTF-8 조각이라 낱개로는 뜻이 없다 — 바이트값 그대로 남긴다.
    else out += `\\x${b.toString(16).padStart(2, "0")}`;
    if (out.length > CHUNK_CHARS) {
      out += `… (총 ${bytes.length}바이트)`;
      break;
    }
  }
  buffer.push(`[${stamp()}] ${tag} ${out}\n`);
  schedule();
}
