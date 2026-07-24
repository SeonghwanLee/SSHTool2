// 세션 일괄 삭제 — 폴더별로 묶어 체크박스로 고르고 한 번에 삭제(WPF 0.38.0 대응).
// 반환: 삭제할 세션 id 목록(취소면 null).

import { openModal } from "./dialogs";
import type { SessionInfo } from "./types";

export function bulkDeleteDialog(sessions: SessionInfo[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        card.className = "settings-card";

        const title = document.createElement("h3");
        title.textContent = "세션 일괄 삭제";
        const sub = document.createElement("div");
        sub.className = "modal-sub";
        sub.textContent = "삭제할 세션을 선택하세요. 되돌릴 수 없습니다.";

        const checks = new Map<string, HTMLInputElement>();

        const all = document.createElement("label");
        all.className = "check-row";
        const allBox = document.createElement("input");
        allBox.type = "checkbox";
        const allText = document.createElement("span");
        allText.textContent = "전체 선택";
        all.append(allBox, allText);
        allBox.addEventListener("change", () => {
          for (const cb of checks.values()) cb.checked = allBox.checked;
          updateCount();
        });

        const list = document.createElement("div");
        list.className = "bulk-list";

        // 폴더별 그룹화(루트는 맨 위).
        const groups = new Map<string, SessionInfo[]>();
        for (const s of sessions) {
          const key = s.folder || "";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(s);
        }
        const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, "ko"));

        for (const key of keys) {
          const head = document.createElement("div");
          head.className = "bulk-group";
          head.textContent = key || "(루트)";
          list.appendChild(head);

          for (const s of groups.get(key)!.sort((a, b) => a.name.localeCompare(b.name, "ko"))) {
            const row = document.createElement("label");
            row.className = "bulk-row";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.addEventListener("change", updateCount);
            checks.set(s.id, cb);
            const label = document.createElement("span");
            label.className = "bulk-label";
            label.textContent = s.name || s.host;
            const detail = document.createElement("span");
            detail.className = "bulk-detail";
            detail.textContent = s.user ? `${s.user}@${s.host}:${s.port}` : `${s.host}:${s.port}`;
            row.append(cb, label, detail);
            list.appendChild(row);
          }
        }

        const count = document.createElement("div");
        count.className = "modal-err";
        function updateCount(): void {
          const n = [...checks.values()].filter((c) => c.checked).length;
          count.textContent = n ? `${n}개 선택됨` : "";
          del.disabled = n === 0;
        }

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => {
          close();
          resolve(null);
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn-accent";
        del.textContent = "삭제";
        del.disabled = true;
        del.addEventListener("click", () => {
          const ids = [...checks.entries()].filter(([, c]) => c.checked).map(([id]) => id);
          close();
          resolve(ids);
        });
        buttons.append(cancel, del);

        card.append(title, sub, all, list, count, buttons);
        return card;
      },
      () => resolve(null),
    );
  });
}
