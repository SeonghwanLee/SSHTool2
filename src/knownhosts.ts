// 알려진 호스트(TOFU 지문) 관리 — 목록 확인 / 개별 삭제 / 전체 삭제.
// 서버 재설치 등으로 호스트키가 정당하게 바뀌면 해당 항목을 지워야 다시 접속된다.

import { openModal, confirmDialog } from "./dialogs";
import { hostkeysList, hostkeyRemove, hostkeysClear, type KnownHostEntry } from "./ipc";
import { applyIcon } from "./icons";

export async function knownHostsDialog(): Promise<void> {
  let entries: KnownHostEntry[] = [];
  try {
    entries = await hostkeysList();
  } catch {
    entries = [];
  }

  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        card.className = "settings-card";

        const title = document.createElement("h3");
        title.textContent = "알려진 호스트";
        const sub = document.createElement("div");
        sub.className = "modal-sub";
        sub.textContent =
          "첫 접속 시 저장된 서버 지문입니다. 지문이 바뀌면 접속이 거부됩니다 — 정당한 변경이면 해당 항목을 삭제하세요.";

        const list = document.createElement("div");
        list.className = "bulk-list";

        function draw(): void {
          list.innerHTML = "";
          if (entries.length === 0) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "저장된 호스트가 없습니다.";
            list.appendChild(empty);
            return;
          }
          for (const e of entries) {
            const row = document.createElement("div");
            row.className = "bulk-row";
            const label = document.createElement("span");
            label.className = "bulk-label";
            label.textContent = e.target;
            const fp = document.createElement("span");
            fp.className = "bulk-detail";
            fp.textContent = e.fingerprint;
            const del = document.createElement("button");
            del.className = "tree-act";
            applyIcon(del, "delete");
            del.title = "삭제";
            del.addEventListener("click", async () => {
              await hostkeyRemove(e.target);
              entries = entries.filter((x) => x.target !== e.target);
              draw();
            });
            row.append(label, fp, del);
            list.appendChild(row);
          }
        }
        draw();

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const clear = document.createElement("button");
        clear.type = "button";
        clear.textContent = "전체 삭제";
        clear.addEventListener("click", async () => {
          const ok = await confirmDialog("저장된 호스트 지문을 모두 삭제할까요?");
          if (!ok) return;
          await hostkeysClear();
          entries = [];
          draw();
        });
        const done = document.createElement("button");
        done.type = "button";
        done.className = "btn-accent";
        done.textContent = "닫기";
        done.addEventListener("click", () => {
          close();
          resolve();
        });
        buttons.append(clear, done);

        card.append(title, sub, list, buttons);
        return card;
      },
      () => resolve(),
    );
  });
}
