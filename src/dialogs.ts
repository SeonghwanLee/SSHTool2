// 경량 모달 유틸 + 세션 편집/비밀번호 입력/확인 다이얼로그. 프레임워크 없이 DOM 으로.

import type { SessionInfo } from "./types";

const root = (): HTMLElement => {
  const el = document.getElementById("modal-root");
  if (!el) throw new Error("missing #modal-root");
  return el;
};

/** 오버레이 + 카드 골격을 만들고, 닫기 함수를 넘겨준다. */
function openModal(build: (close: () => void) => HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const close = () => overlay.remove();
  const card = build(close);
  card.classList.add("modal-card");
  overlay.appendChild(card);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close(); // 바깥 클릭 = 취소
  });
  document.addEventListener(
    "keydown",
    function esc(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", esc);
      }
    },
  );
  root().appendChild(overlay);
}

function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(span, input);
  return wrap;
}

/** 세션 새로 만들기/편집. 저장하면 갱신된 SessionInfo, 취소면 null. */
export function sessionDialog(initial: SessionInfo, titleText: string): Promise<SessionInfo | null> {
  return new Promise((resolve) => {
    openModal((close) => {
      const card = document.createElement("form");
      const title = document.createElement("h3");
      title.textContent = titleText;

      const name = document.createElement("input");
      name.value = initial.name;
      name.placeholder = "표시 이름";
      const host = document.createElement("input");
      host.value = initial.host;
      host.placeholder = "호스트 / IP";
      const port = document.createElement("input");
      port.value = String(initial.port || 22);
      port.inputMode = "numeric";
      const user = document.createElement("input");
      user.value = initial.user;
      user.placeholder = "사용자";
      const folder = document.createElement("input");
      folder.value = initial.folder;
      folder.placeholder = "폴더 (선택, 예: 운영/DB)";

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
      ok.textContent = "저장";
      buttons.append(cancel, ok);

      card.append(
        title,
        // 사용자 이름과 비밀번호(볼트) 자리를 연달아 배치(WPF 피드백) — 비번은 접속 시 입력.
        field("이름", name),
        field("호스트", host),
        field("포트", port),
        field("사용자", user),
        field("폴더", folder),
        err,
        buttons,
      );

      card.addEventListener("submit", (e) => {
        e.preventDefault();
        const h = host.value.trim();
        const u = user.value.trim();
        if (!h) {
          err.textContent = "호스트를 입력하세요.";
          return;
        }
        const p = Number(port.value) || 22;
        const result: SessionInfo = {
          ...initial,
          name: name.value.trim() || h,
          host: h,
          port: p,
          user: u,
          folder: folder.value.trim(),
        };
        close();
        resolve(result);
      });

      setTimeout(() => name.focus(), 0);
      return card;
    });
  });
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

      const pass = document.createElement("input");
      pass.type = "password";
      pass.placeholder = "비밀번호 (없으면 비워두고 확인)";

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

      card.append(title, sub, field("비밀번호", pass), buttons);
      card.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = pass.value;
        close();
        resolve(v);
      });
      setTimeout(() => pass.focus(), 0);
      return card;
    });
  });
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
      setTimeout(() => yes.focus(), 0);
      return card;
    });
  });
}
