// 이모지 표현 선택자(VS16, U+FE0F)의 폭 보정.
//
// 왜 필요한가(0.71.0): xterm 의 Unicode 11 표는 VS16 을 폭 0 결합문자로 보고 앞 글자에
// 합쳐 **1칸**으로 둔다. 반면 Node 로 만든 CLI(Claude CLI 등이 쓰는 string-width)와
// 최신 터미널(Windows Terminal·iTerm2)은 VS16 이 붙으면 이모지 표현 = **2칸**으로 센다.
// 그래서 ⚠️ ℹ️ ⚙️ ❤️ ☑️ 같은 글자가 한 줄에 하나 나올 때마다 원격이 계산한 열과
// 우리 화면의 열이 1칸씩 어긋나고, 그 줄에서 커서 위치가 틀어진다(사용자 보고:
// 전체화면 Claude CLI 에서 간헐적으로 커서가 밀림 — 출력에 이런 이모지가 섞일 때).
//
// 고치는 방법: Unicode11 공급자를 감싸 VS16 만 다르게 처리한다. 그 공급자 인스턴스는
// 애드온이 내부에서 만들어 등록하므로 공개 API 로는 꺼낼 수 없다 — 등록되는 순간을
// 가로채 붙잡는다. **실패하면 아무것도 바꾸지 않는다**(예전 동작 그대로) — 라이브러리
// 구조가 바뀌어도 터미널이 깨지지 않게 하기 위한 안전장치다.

import type { Terminal, IUnicodeVersionProvider } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";

/** VS16 — 앞 글자를 이모지 모양으로 그리라는 표시. */
const VS16 = 0xfe0f;
/** 우리가 등록하는 버전 이름. 실패 시에는 원래의 "11" 이 그대로 쓰인다. */
const VERSION = "11-vs16";

/**
 * xterm 이 폭·결합 정보를 담는 정수 포맷(UnicodeService.createPropertyValue 와 같은 규칙):
 * `charset << 3 | width << 1 | shouldJoin`. 여기서는 charset 을 쓰지 않는다.
 */
const packWidth = (width: number, shouldJoin: boolean): number =>
  ((3 & width) << 1) | (shouldJoin ? 1 : 0);
const unpackWidth = (props: number): number => (props >> 1) & 3;

/**
 * Unicode 11 애드온을 붙이고, 가능하면 VS16 보정판까지 등록한다.
 * 보정에 실패해도 Unicode 11 은 정상 적용된다(현행 동작).
 */
export function loadUnicode(term: Terminal): void {
  let base: IUnicodeVersionProvider | null = null;

  // term.unicode 는 접근할 때마다 새 객체라 그 위의 register 를 갈아 끼워도 소용없다.
  // 인스턴스에 own 프로퍼티를 정의해 프로토타입 getter 를 잠깐 가리고, Proxy 로
  // register 호출만 들여다본다(호출 자체는 그대로 통과시킨다).
  const proto = Object.getPrototypeOf(term) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "unicode");
  const getter = desc?.get;
  if (getter) {
    Object.defineProperty(term, "unicode", {
      configurable: true,
      get() {
        const api = getter.call(term) as Terminal["unicode"];
        return new Proxy(api, {
          get(target, key) {
            if (key === "register") {
              return (p: IUnicodeVersionProvider) => {
                base ??= p;
                target.register(p);
              };
            }
            const value = Reflect.get(target, key) as unknown;
            return typeof value === "function" ? (value as () => void).bind(target) : value;
          },
          set(target, key, value) {
            return Reflect.set(target, key, value);
          },
        });
      },
    });
  }

  try {
    term.loadAddon(new Unicode11Addon());
  } finally {
    // 가림막은 반드시 걷는다 — 남겨 두면 이후 모든 unicode 접근이 Proxy 를 거친다.
    if (getter) delete (term as unknown as Record<string, unknown>).unicode;
  }

  // 대입이 콜백 안에서 일어나 TS 흐름 분석이 계속 null 로 본다 — 단언으로 끊는다.
  const v11 = base as IUnicodeVersionProvider | null;
  if (!v11) {
    term.unicode.activeVersion = "11"; // 보정 없이 기존 동작
    return;
  }
  term.unicode.register({
    version: VERSION,
    wcwidth: (codepoint: number) => v11.wcwidth(codepoint),
    charProperties(codepoint: number, preceding: number): number {
      const props = v11.charProperties(codepoint, preceding);
      if (codepoint !== VS16) return props;
      // 앞 글자가 1칸일 때만 2칸으로 넓힌다. 이미 2칸(🔥 등)이면 그대로 두고,
      // 앞이 없거나 폭 0 이면 원래 계산을 따른다(잘못 넓히지 않는다).
      return unpackWidth(preceding) === 1 ? packWidth(2, true) : props;
    },
  });
  term.unicode.activeVersion = VERSION;
}
