// 경량 모달 유틸 + 세션 편집/비밀번호 입력/확인 다이얼로그. 프레임워크 없이 DOM 으로.

import type { SessionInfo } from "./types";

/**
 * 열려 있는 모달 오버레이 스택. Esc 는 **맨 위 모달만** 닫아야 한다
 * (전에는 각 모달이 document 리스너를 따로 걸어 Esc 한 번에 여러 개가 같이 닫혔다).
 */
export const modalStack: HTMLElement[] = [];

export function pushModal(el: HTMLElement): void {
  modalStack.push(el);
}
export function popModal(el: HTMLElement): void {
  const i = modalStack.lastIndexOf(el);
  if (i >= 0) modalStack.splice(i, 1);
}
export const isTopModal = (el: HTMLElement): boolean =>
  modalStack[modalStack.length - 1] === el;

const root = (): HTMLElement => {
  const el = document.getElementById("modal-root");
  if (!el) throw new Error("missing #modal-root");
  return el;
};

/**
 * 바깥 클릭 시 창을 닫는 대신 잠깐 두드러지게 — 열려 있음을 알린다.
 * 실수 클릭 한 번에 입력하던 내용이 날아가는 사고를 없앤 자리(0.56.1)라서,
 * 어떤 창에도 "바깥 클릭 = 닫기"를 다시 넣지 말 것. 닫기는 버튼과 Esc 만.
 */
export function attentionPulse(card: HTMLElement): void {
  card.classList.remove("modal-attn");
  void card.offsetWidth; // 리플로 강제 — 연타해도 매번 다시 반짝인다
  card.classList.add("modal-attn");
  card.addEventListener("animationend", () => card.classList.remove("modal-attn"), {
    once: true,
  });
}

/**
 * 오버레이 + 카드 골격을 만든다. build(close) 안의 버튼은 close() 로 닫고 자체 resolve 한다.
 * Esc 로 닫힐 때는 onDismiss 가 호출되므로 각 다이얼로그가 취소값(null/false)을
 * resolve 해야 caller 가 무한 대기하지 않는다. keydown 리스너는 모든 경로에서 정리된다.
 */
export function openModal(build: (close: () => void) => HTMLElement, onDismiss?: () => void): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && isTopModal(overlay)) dismiss();
  };
  const close = () => {
    popModal(overlay);
    overlay.remove();
    document.removeEventListener("keydown", esc);
  };
  const dismiss = () => {
    close();
    onDismiss?.();
  };
  const card = build(close);
  card.classList.add("modal-card");
  overlay.appendChild(card);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) attentionPulse(card); // 바깥 클릭으로는 닫지 않는다
  });
  document.addEventListener("keydown", esc);
  pushModal(overlay);
  root().appendChild(overlay);
}

export function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(span, input);
  return wrap;
}

/** 접속용 비밀번호 입력. 확인=문자열(빈 문자열 허용), 취소=null. */
export function passwordPrompt(session: SessionInfo): Promise<string | null> {
  return new Promise((resolve) => {
    openModal((close) => {
      const card = document.createElement("form");
      const title = document.createElement("h3");
      title.textContent = "비밀번호";
      const sub = document.createElement("div");
      sub.className = "modal-sub";
      sub.textContent = `${session.user || "?"}@${session.host}:${session.port}`;

      const isKey = session.authType === "key";
      const pass = document.createElement("input");
      pass.type = "password";
      pass.placeholder = isKey ? "키 암호 (없으면 비워두고 확인)" : "비밀번호 (없으면 비워두고 확인)";
      if (isKey) title.textContent = "개인키 암호";

      const buttons = document.createElement("div");
      buttons.className = "modal-buttons";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "취소";
      cancel.addEventListener("click", () => {
        close();
        resolve(null);
      });
      const ok = document.createElement("button");
      ok.type = "submit";
      ok.className = "btn-accent";
      ok.textContent = "접속";
      buttons.append(cancel, ok);

      card.append(title, sub, field(isKey ? "키 암호" : "비밀번호", pass), buttons);
      card.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = pass.value;
        close();
        resolve(v);
      });
      setTimeout(() => pass.focus(), 0);
      return card;
    }, () => resolve(null));
  });
}

/** 아이디+비밀번호 입력(계정 없는 세션 접속용). 확인={user,password}, 취소=null. */
export function loginPrompt(session: SessionInfo): Promise<{ user: string; password: string } | null> {
  const isKey = session.authType === "key";
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("form");
        const title = document.createElement("h3");
        title.textContent = "로그인";
        const sub = document.createElement("div");
        sub.className = "modal-sub";
        sub.textContent = `${session.name || session.host}:${session.port}`;

        const user = document.createElement("input");
        user.placeholder = "사용자 이름";
        user.value = session.user;
        const pass = document.createElement("input");
        pass.type = "password";
        pass.placeholder = isKey ? "키 암호 (없으면 비워두고 확인)" : "비밀번호";

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => {
          close();
          resolve(null);
        });
        const ok = document.createElement("button");
        ok.type = "submit";
        ok.className = "btn-accent";
        ok.textContent = "접속";
        buttons.append(cancel, ok);

        card.append(title, sub, field("사용자", user), field(isKey ? "키 암호" : "비밀번호", pass), buttons);
        card.addEventListener("submit", (e) => {
          e.preventDefault();
          const u = user.value.trim();
          if (!u) return; // 사용자 이름은 필수
          close();
          resolve({ user: u, password: pass.value });
        });
        setTimeout(() => (session.user ? pass : user).focus(), 0);
        return card;
      },
      () => resolve(null),
    );
  });
}

/** 마스터 비밀번호 입력(볼트 생성/잠금해제 공용). 확인=문자열, 취소=null. */
export function masterPrompt(
  title: string,
  subtitle: string,
  okText = "확인",
  /** true 면 확인 입력란을 추가해 오타로 인한 영구 잠김을 막는다(생성/변경 시). */
  requireConfirm = false,
  /** true 면 빈 값도 제출 허용(구버전 평문 백업 가져오기 등). */
  allowEmpty = false,
): Promise<string | null> {
  return new Promise((resolve) => {
    openModal((close) => {
      const card = document.createElement("form");
      const h = document.createElement("h3");
      h.textContent = title;
      const sub = document.createElement("div");
      sub.className = "modal-sub";
      sub.textContent = subtitle;

      const pass = document.createElement("input");
      pass.type = "password";
      pass.placeholder = "마스터 비밀번호";

      const confirm = document.createElement("input");
      confirm.type = "password";
      confirm.placeholder = "한 번 더 입력";

      const err = document.createElement("div");
      err.className = "modal-err";

      const buttons = document.createElement("div");
      buttons.className = "modal-buttons";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "취소";
      cancel.addEventListener("click", () => {
        close();
        resolve(null);
      });
      const ok = document.createElement("button");
      ok.type = "submit";
      ok.className = "btn-accent";
      ok.textContent = okText;
      buttons.append(cancel, ok);

      card.append(h, sub, field("마스터", pass));
      if (requireConfirm) card.append(field("확인", confirm));
      card.append(err, buttons);
      card.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = pass.value;
        if (!v && !allowEmpty) return; // 빈 값 불허(단 allowEmpty 면 통과)
        if (requireConfirm && v !== confirm.value) {
          err.textContent = "두 입력이 일치하지 않습니다.";
          return;
        }
        close();
        resolve(v);
      });
      setTimeout(() => pass.focus(), 0);
      return card;
    }, () => resolve(null));
  });
}

/**
 * 한 줄 텍스트 입력(폴더 만들기·이름 변경 등).
 * 확인 = 입력값(빈 문자열일 수 있음), 취소/Esc/바깥클릭 = null.
 * 빈 값과 취소를 반드시 구분해야 하는 곳(폴더를 루트로 이동 등)이 있어 분리한다.
 */
export function textPrompt(title: string, initial = "", okText = "확인"): Promise<string | null> {
  return new Promise((resolve) => {
    openModal((close) => {
      const card = document.createElement("form");
      const h = document.createElement("h3");
      h.textContent = title;
      const input = document.createElement("input");
      input.value = initial;

      const buttons = document.createElement("div");
      buttons.className = "modal-buttons";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "취소";
      cancel.addEventListener("click", () => {
        close();
        resolve(null);
      });
      const ok = document.createElement("button");
      ok.type = "submit";
      ok.className = "btn-accent";
      ok.textContent = okText;
      buttons.append(cancel, ok);

      card.append(h, field("", input), buttons);
      card.addEventListener("submit", (e) => {
        e.preventDefault();
        close();
        resolve(input.value.trim()); // 빈 문자열도 '확인'으로 전달(취소는 null)
      });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return card;
    }, () => resolve(null));
  });
}

/** 알림(확인 버튼만). */
export function alertDialog(message: string, title = "알림"): Promise<void> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        const h = document.createElement("h3");
        h.textContent = title;
        const msg = document.createElement("div");
        msg.className = "modal-msg";
        msg.textContent = message;

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const ok = document.createElement("button");
        ok.className = "btn-accent";
        ok.textContent = "확인";
        ok.addEventListener("click", () => {
          close();
          resolve();
        });
        buttons.appendChild(ok);

        card.append(h, msg, buttons);
        setTimeout(() => ok.focus(), 0);
        return card;
      },
      () => resolve(),
    );
  });
}

/**
 * 설정 저장이 거부·실패했을 때의 알림.
 *
 * 설정 파일 암호화 키를 읽지 못하면 백엔드가 평문 덮어쓰기를 거부한다(다운그레이드 방지).
 * 저장은 자동으로 여러 번 일어나므로 실행당 한 번만 알린다 — 매번 띄우면 창이 쌓여
 * 앱을 쓸 수 없다.
 */
let saveFailureShown = false;
export async function saveFailureAlert(what: string, detail: unknown): Promise<void> {
  if (saveFailureShown) return;
  saveFailureShown = true;
  await alertDialog(`${what}을(를) 저장하지 못했습니다.\n\n${String(detail)}`, "저장 실패");
}

/** 예/아니오 확인. */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    openModal((close) => {
      const card = document.createElement("div");
      const msg = document.createElement("div");
      msg.className = "modal-msg";
      msg.textContent = message;

      const buttons = document.createElement("div");
      buttons.className = "modal-buttons";
      const no = document.createElement("button");
      no.textContent = "아니오";
      no.addEventListener("click", () => {
        close();
        resolve(false);
      });
      const yes = document.createElement("button");
      yes.className = "btn-accent";
      yes.textContent = "예";
      yes.addEventListener("click", () => {
        close();
        resolve(true);
      });
      buttons.append(no, yes);

      card.append(msg, buttons);
      // y/n 한 키로 즉답(사용자 요청 — 모든 확인창 공통). 확인창에는 입력칸이 없어
      // 타이핑과 충돌하지 않는다. Enter(=예)·Esc(=아니오)는 기존대로 동작한다.
      card.addEventListener("keydown", (e) => {
        const k = e.key.toLowerCase();
        if (k !== "y" && k !== "n") return;
        e.preventDefault();
        e.stopPropagation();
        close();
        resolve(k === "y");
      });
      setTimeout(() => yes.focus(), 0);
      return card;
    }, () => resolve(false));
  });
}

/**
 * 처음 보는 호스트의 키 지문 확인. 반환 true 일 때만 접속을 이어간다.
 *
 * 확인(confirmDialog)과 달리 기본 포커스를 '취소'에 둔다 — Enter 를 습관적으로 눌러
 * 검증 없이 통과시키는 일이 없어야 한다. Esc·바깥 클릭도 거부로 처리한다.
 */
export function hostKeyPrompt(info: {
  host: string;
  port: number;
  fingerprint: string;
  keyType: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");

        // 다른 다이얼로그와 같은 h3 를 쓴다 — div.modal-title 은 CSS 정의가 없어
        // 제목이 본문 글씨로 렌더됐다. 보안 확인창이라 제목이 눈에 띄어야 한다.
        const title = document.createElement("h3");
        title.textContent = "처음 접속하는 서버입니다";

        const msg = document.createElement("div");
        msg.className = "modal-msg";
        msg.textContent =
          `${info.host}:${info.port} 의 호스트 키를 아직 신뢰한 적이 없습니다.\n` +
          `아래 지문이 서버 관리자가 알려준 값과 같은지 확인하세요.\n` +
          `다르다면 중간자 공격일 수 있습니다.`;

        const fp = document.createElement("div");
        fp.className = "hostkey-fp";
        fp.textContent = `${info.keyType}\n${info.fingerprint}`;

        const note = document.createElement("div");
        note.className = "modal-msg hostkey-note";
        note.textContent = "연결하면 이 지문을 저장하고, 다음부터는 묻지 않습니다.";

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const no = document.createElement("button");
        no.textContent = "취소";
        no.addEventListener("click", () => {
          close();
          resolve(false);
        });
        const yes = document.createElement("button");
        yes.className = "btn-accent";
        yes.textContent = "연결";
        yes.addEventListener("click", () => {
          close();
          resolve(true);
        });
        buttons.append(no, yes);

        card.append(title, msg, fp, note, buttons);
        setTimeout(() => no.focus(), 0);
        return card;
      },
      () => resolve(false),
    );
  });
}

/** 여러 선택지 중 하나 고르기. 반환=선택한 value, 취소/Esc/바깥클릭=null. */
export function choiceDialog(
  message: string,
  choices: { label: string; value: string; danger?: boolean; accent?: boolean }[],
  title = "선택",
): Promise<string | null> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        const h = document.createElement("h3");
        h.textContent = title;
        const msg = document.createElement("div");
        msg.className = "modal-msg";
        msg.textContent = message;

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons choice-buttons";
        const cancel = document.createElement("button");
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => {
          close();
          resolve(null);
        });
        buttons.appendChild(cancel);
        for (const c of choices) {
          const b = document.createElement("button");
          b.textContent = c.label;
          if (c.accent) b.className = "btn-accent";
          if (c.danger) b.classList.add("danger-btn");
          b.addEventListener("click", () => {
            close();
            resolve(c.value);
          });
          buttons.appendChild(b);
        }

        card.append(h, msg, buttons);
        return card;
      },
      () => resolve(null),
    );
  });
}

// 숫자 입력 상자와 값 정리 — 설정창·세션편집이 함께 쓴다(0.67.0 에 이리로 모음).
export function numInput(value: string, min: number, max: number, step: number): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "number";
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  el.value = value;
  el.className = "num-input";
  return el;
}

export function clampNum(el: HTMLInputElement, min: number, max: number, fallback: number): number {
  const v = Math.min(max, Math.max(min, Number(el.value) || fallback));
  el.value = String(v);
  return v;
}
