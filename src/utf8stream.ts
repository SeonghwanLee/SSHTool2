// SSH/로컬 셸 수신 바이트를 xterm 에 넘기기 전 UTF-8 문자 경계로 정렬하는 게이트.
//
// 왜 필요한가(0.59.1): xterm 6.0.0 의 스트리밍 UTF-8 디코더(Utf8ToUtf32)는 청크가
// 문자 중간에서 끊기면 남은 바이트를 interim 버퍼에 들고 있다가 다음 청크에서 잇는데,
// 그 재개 루프의 종료 조건이 `63 & interim[o]`(payload)다. 연속 바이트 0x80 은 payload
// 가 0 이라 "버퍼 끝"으로 오인되어 그 문자가 통째로 버려진다. — … " " 。「」 전각공백
// (U+3000) 등 2번째 바이트가 0x80 인 흔한 문자가 전부 해당한다. 문자 하나가 사라지면
// 그 줄 전체가 한 칸 당겨지므로, vi 분할처럼 출력이 큰 TUI 에서 '줄 밀림·화면 깨짐'
// 으로 나타난다(청크 경계가 많을수록 확률 증가). 완성 문자만 넘기면 interim 경로 자체를
// 타지 않아 안전하다.

/** 버퍼에서 "완성된 UTF-8"이 끝나는 지점을 돌려준다(그 뒤는 미완성 꼬리). */
function completeBoundary(b: Uint8Array): number {
  const n = b.length;
  // UTF-8 은 최장 4바이트 — 끝에서 리드 바이트를 최대 3칸만 거슬러 찾으면 된다.
  for (let i = n - 1; i >= 0 && i >= n - 3; i--) {
    const c = b[i];
    if (c < 0x80) return n; // ASCII 로 끝 — 전부 완성
    if ((c & 0xc0) === 0xc0) {
      // 리드 바이트 발견 — 필요한 길이가 다 찼으면 완성, 아니면 리드 앞까지만.
      const need =
        (c & 0xe0) === 0xc0 ? 2 : (c & 0xf0) === 0xe0 ? 3 : (c & 0xf8) === 0xf0 ? 4 : 1;
      return n - i >= need ? n : i;
    }
    // 연속 바이트(0x80~0xBF)면 계속 거슬러 올라간다.
  }
  // 3바이트 안에 리드가 없다 — 올바른 UTF-8 이 아니므로 붙들지 않고 그대로 흘린다.
  return n;
}

/** 청크 스트림을 문자 경계로 재정렬한다. 세션(탭)마다 하나씩 갖는다. */
export class Utf8Gate {
  private tail = new Uint8Array(0);

  /** 완성분을 돌려주고, 미완성 꼬리(최대 3바이트)는 다음 청크 앞에 붙인다. */
  feed(chunk: Uint8Array): Uint8Array {
    let buf = chunk;
    if (this.tail.length) {
      buf = new Uint8Array(this.tail.length + chunk.length);
      buf.set(this.tail);
      buf.set(chunk, this.tail.length);
    }
    const cut = completeBoundary(buf);
    this.tail = buf.slice(cut); // 복사 — 다음 feed 에서 buf 를 다시 쓰더라도 안전
    return buf.subarray(0, cut);
  }

  /** 재접속 등 새 스트림 시작 시 꼬리를 버린다 — 이전 스트림의 반쪽 문자와 잇지 않게. */
  clear(): void {
    this.tail = new Uint8Array(0);
  }

  /**
   * 스트림이 끝날 때(세션 종료) 남은 꼬리를 내보낸다 — 잘린/유효하지 않은 UTF-8 로
   * 끝나는 출력(바이너리 열람 등)의 마지막 바이트가 조용히 사라지지 않도록.
   * xterm 은 불완전 시퀀스를 대체 글리프로 그린다(진단 0.62.0).
   */
  flush(): Uint8Array {
    const t = this.tail;
    this.tail = new Uint8Array(0);
    return t;
  }
}
