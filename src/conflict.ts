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
