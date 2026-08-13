// 전송 대상에 같은 이름이 있을 때의 처리 선택 — 덮어쓰기 / 이름 바꾸기 / 건너뛰기 / 취소.
// 여러 파일이면 "남은 항목에 모두 적용"으로 한 번만 물어본다(WPF 0.28.0 대응).

import { openModal } from "./dialogs";

export type ConflictChoice = "overwrite" | "rename" | "skip" | "cancel";

export interface ConflictResult {
  choice: ConflictChoice;
  /** true 면 남은 충돌에도 같은 선택을 적용. */
  applyToRest: boolean;
}

export function conflictDialog(name: string, remaining: number): Promise<ConflictResult> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = "같은 이름이 있습니다";
        const msg = document.createElement("div");
        msg.className = "modal-msg";
        msg.textContent = `'${name}' 이(가) 이미 존재합니다. 어떻게 할까요?`;

        const applyRow = document.createElement("label");
        applyRow.className = "check-row";
        const apply = document.createElement("input");
        apply.type = "checkbox";
        const applyText = document.createElement("span");
        applyText.textContent = `남은 ${remaining}개 항목에 모두 적용`;
        applyRow.append(apply, applyText);

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons conflict-buttons";
        const pick = (choice: ConflictChoice) => {
          close();
          resolve({ choice, applyToRest: apply.checked });
        };
        const mk = (label: string, choice: ConflictChoice, accent = false) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          if (accent) b.className = "btn-accent";
          b.addEventListener("click", () => pick(choice));
          return b;
        };
        buttons.append(
          mk("취소", "cancel"),
          mk("건너뛰기", "skip"),
          mk("이름 바꾸기", "rename"),
          mk("덮어쓰기", "overwrite", true),
        );

        card.append(title, msg);
        if (remaining > 0) card.append(applyRow);
        card.append(buttons);
        return card;
      },
      () => resolve({ choice: "cancel", applyToRest: false }),
    );
  });
}

// ── 이어받기(0.74.0) ──
//
// 전송이 끊기면 받다 만 조각(`.part`)을 남긴다. 다음에 같은 파일을 옮기려 하면 여기서
// 묻는다 — 내용이 같은 파일인지는 확인할 방법이 없으므로(서버가 그 사이 파일을 바꿨을
// 수도 있다) 크기를 보여 주고 사용자가 고르게 한다. 다른 클라이언트도 같은 방식이다.

export type ResumeChoice = "resume" | "restart" | "skip" | "cancel";

export interface ResumeResult {
  choice: ResumeChoice;
  applyToRest: boolean;
}

const fmtBytes = (n: number): string => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
};

export function resumeDialog(
  name: string,
  done: number,
  total: number,
  /** 방향 — 올릴 때와 받을 때의 말이 다르다("이어보내기" / "이어받기"). */
  dir: "up" | "down" = "down",
): Promise<ResumeResult> {
  const 보냄 = dir === "up";
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = 보냄 ? "보내다 만 파일이 있습니다" : "받다 만 파일이 있습니다";
        const msg = document.createElement("div");
        msg.className = "modal-msg";
        const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
        msg.textContent =
          `'${name}' 을(를) ${보냄 ? "보내다" : "받다"} 중단된 조각이 남아 있습니다 — ` +
          `${fmtBytes(done)} / ${fmtBytes(total)} (${pct}%).\n` +
          (보냄
            ? "중단된 뒤 원본이 바뀌었다면 이어 보낸 파일이 깨집니다. 확실하지 않으면 처음부터 보내세요."
            : "중단된 뒤 원본이 바뀌었다면 이어받은 파일이 깨집니다. 확실하지 않으면 처음부터 받으세요.");
        msg.style.whiteSpace = "pre-line";

        const applyRow = document.createElement("label");
        applyRow.className = "check-row";
        const apply = document.createElement("input");
        apply.type = "checkbox";
        const applyText = document.createElement("span");
        applyText.textContent = "이후 항목에도 모두 적용";
        applyRow.append(apply, applyText);

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons conflict-buttons";
        const mk = (label: string, choice: ResumeChoice, accent = false) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          if (accent) b.className = "btn-accent";
          b.addEventListener("click", () => {
            close();
            resolve({ choice, applyToRest: apply.checked });
          });
          return b;
        };
        buttons.append(
          mk("취소", "cancel"),
          mk("건너뛰기", "skip"),
          mk("처음부터", "restart"),
          mk(보냄 ? "이어보내기" : "이어받기", "resume", true),
        );

        card.append(title, msg, applyRow, buttons);
        return card;
      },
      () => resolve({ choice: "cancel", applyToRest: false }),
    );
  });
}

/** "이름 (2).txt" 형태로 겹치지 않는 이름을 만든다. */
export function uniqueName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}
