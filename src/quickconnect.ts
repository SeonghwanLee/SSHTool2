// 빠른 접속 입력 폼(0.90.0) — 저장하지 않고 한 번만 붙는 접속.
//
// 예전에는 세션 편집 창(연결·인증·자동화·트리거·서비스 5개 탭)을 그대로 띄웠다. 한 번
// 쓰고 버릴 접속에 이름·폴더·색 태그·트리거를 묻는 셈이라 정작 필요한 세 칸(호스트·포트·
// 계정)이 묻혔다(사용자 지적). 여기서는 그 세 칸만 받는다.
//
// 비밀번호는 여기서 묻지 않는다 — 접속 흐름이 서버에 먼저 붙어 보고(probe) 서버가 허용한
// 인증 방식을 안 뒤에 물어보기 때문이다. 미리 받아 두면 호스트가 죽었을 때도 비밀번호부터
// 받게 된다.

import { openModal, field, numInput } from "./dialogs";
import { blankSession, type SessionInfo } from "./types";

export interface QuickConnectResult {
  session: SessionInfo;
  /** 접속에 성공하면 세션 목록에 저장할지. */
  save: boolean;
}

/** 빠른 접속 폼. 취소하면 null. */
export function quickConnectDialog(): Promise<QuickConnectResult | null> {
  return new Promise((resolve) => {
    openModal((close) => {
      const card = document.createElement("form");
      const title = document.createElement("h3");
      title.textContent = "빠른 접속";

      const hint = document.createElement("div");
      hint.className = "settings-hint";
      hint.textContent =
        "한 번만 접속합니다. 호스트와 계정은 반드시 넣어야 합니다 — 비밀번호는 서버에 연결한 뒤 물어봅니다.";

      const host = document.createElement("input");
      host.className = "txt-input";
      host.placeholder = "example.com 또는 10.0.0.5";
      host.autocomplete = "off";
      const port = numInput("22", 1, 65535, 1);
      const user = document.createElement("input");
      user.className = "txt-input";
      user.placeholder = "root";
      user.autocomplete = "off";

      // 호스트·포트는 늘 함께 보므로 한 줄에 둔다.
      const hostRow = document.createElement("div");
      hostRow.className = "quick-hostrow";
      hostRow.append(field("호스트", host), field("포트", port));

      const saveRow = document.createElement("label");
      saveRow.className = "check-row";
      const saveBox = document.createElement("input");
      saveBox.type = "checkbox";
      const saveText = document.createElement("span");
      saveText.textContent = "접속에 성공하면 세션 목록에 저장";
      saveRow.append(saveText, saveBox);

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
      ok.textContent = "접속";
      buttons.append(cancel, ok);

      card.append(title, hint, hostRow, field("계정", user), saveRow, err, buttons);

      card.addEventListener("submit", (e) => {
        e.preventDefault();
        const h = host.value.trim();
        if (!h) {
          err.textContent = "호스트를 입력하세요.";
          host.focus();
          return;
        }
        const p = Number(port.value);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          err.textContent = "포트는 1~65535 사이의 정수여야 합니다.";
          port.focus();
          return;
        }
        // 계정도 반드시 받는다. 비워 두면 접속 자체가 되지 않는데 그 사실이 백엔드
        // 오류로만 드러나, 무엇이 잘못됐는지 알 수 없는 문구를 보게 됐다(사용자 지적).
        const u = user.value.trim();
        if (!u) {
          err.textContent = "계정을 입력하세요.";
          user.focus();
          return;
        }
        close();
        resolve({
          session: { ...blankSession(), host: h, port: p, user: u },
          save: saveBox.checked,
        });
      });

      setTimeout(() => host.focus(), 0);
      return card;
    }, () => resolve(null));
  });
}
