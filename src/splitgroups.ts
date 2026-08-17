// 분할 그룹(0.81.0) — 자주 함께 보는 세션 묶음에 이름을 붙여 두고 한 번에 불러온다.
//
// 방향별 임시 기억(0.80.1)으로는 묶음이 둘뿐이었다. "운영 4대", "배치 6대"처럼 일하는
// 단위가 여럿이면 그때마다 다시 골라야 한다 — 이름을 붙여 여러 개 두고 오간다.
//
// 그룹은 탭이 아니라 **세션 id** 를 담는다. 앱을 껐다 켜도 남아야 하고, 불러올 때
// 아직 열리지 않은 세션은 그 자리에서 접속한다(사용자 결정).

import type { SessionInfo } from "./types";
import type { SplitGroup } from "./settings";
import { openModal } from "./dialogs";
import { confirmDialog } from "./dialogs";
import { applyIcon } from "./icons";
import { holdFocus } from "./focus";

export interface GroupMenuDeps {
  groups: () => SplitGroup[];
  sessions: () => SessionInfo[];
  /** 그룹을 화면에 적용(안 열린 세션 접속 → 분할). */
  apply: (g: SplitGroup) => void;
  /** 목록이 바뀌었을 때 저장. */
  save: (next: SplitGroup[]) => void;
  /** 지금 분할 중인 구성 — '지금 분할을 그룹으로' 의 재료. 분할 중이 아니면 null. */
  currentSplit: () => { mode: "vertical" | "horizontal"; sessionIds: string[] } | null;
}

const DIR_LABEL: Record<SplitGroup["mode"], string> = { vertical: "세로", horizontal: "가로" };

/** 이름을 비워 두면 붙여 주는 기본 이름 — 그룹1, 그룹2 … (이미 있는 번호는 건너뛴다). */
export function defaultGroupName(groups: SplitGroup[]): string {
  for (let i = 1; i < 1000; i++) {
    const name = `그룹${i}`;
    if (!groups.some((g) => g.name === name)) return name;
  }
  return `그룹${groups.length + 1}`;
}

/**
 * 그룹 하나를 만들거나 고친다. 이름·방향·세션을 한 창에서 정한다.
 * 세션 목록은 **저장된 세션 전체**다 — 지금 열려 있지 않아도 담을 수 있어야 한다.
 */
export function editGroupDialog(
  base: SplitGroup | null,
  sessions: SessionInfo[],
  groups: SplitGroup[],
): Promise<SplitGroup | null> {
  return new Promise((resolve) => {
    let settled = false;
    openModal(
      (close) => {
        const card = document.createElement("div");
        card.classList.add("group-card");
        const title = document.createElement("h3");
        title.textContent = base ? "분할 그룹 편집" : "새 분할 그룹";

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = base?.name ?? "";
        nameInput.placeholder = `비워 두면 ${defaultGroupName(groups)}`;

        // 방향 — 라디오 두 개. 그룹마다 따로 기억한다.
        const dirRow = document.createElement("div");
        dirRow.className = "group-dirs";
        const dirs: HTMLInputElement[] = [];
        for (const m of ["vertical", "horizontal"] as const) {
          const lab = document.createElement("label");
          lab.className = "group-dir";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "split-group-dir";
          radio.value = m;
          radio.checked = (base?.mode ?? "vertical") === m;
          const txt = document.createElement("span");
          txt.textContent = `${DIR_LABEL[m]} 분할`;
          lab.append(radio, txt);
          dirRow.appendChild(lab);
          dirs.push(radio);
        }

        const list = document.createElement("div");
        list.className = "group-list";
        const boxes = new Map<string, HTMLInputElement>();
        for (const s of sessions) {
          if (s.kind === "rdp") continue; // 원격 데스크톱은 별도 창이라 분할에 세울 수 없다
          const row = document.createElement("label");
          row.className = "group-row";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = base?.sessionIds.includes(s.id) ?? false;
          const name = document.createElement("span");
          name.className = "group-name";
          name.textContent = s.name || s.host;
          const detail = document.createElement("span");
          detail.className = "group-detail";
          detail.textContent = s.kind === "local" ? "로컬 셸" : `${s.user}@${s.host}`;
          row.append(box, name, detail);
          list.appendChild(row);
          boxes.set(s.id, box);
        }

        const count = document.createElement("div");
        count.className = "group-count";
        const sync = () => {
          const n = [...boxes.values()].filter((b) => b.checked).length;
          count.textContent = n > 0 ? `${n}개 선택` : "세션을 하나 이상 고르세요";
          ok.disabled = n === 0;
        };
        for (const b of boxes.values()) b.addEventListener("change", sync);

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => {
          settled = true;
          close();
          resolve(null);
        });
        const ok = document.createElement("button");
        ok.type = "button";
        ok.className = "btn-accent";
        ok.textContent = "저장";
        ok.addEventListener("click", () => {
          const picked = [...boxes.entries()].filter(([, b]) => b.checked).map(([id]) => id);
          if (picked.length === 0) return;
          settled = true;
          close();
          resolve({
            id: base?.id ?? crypto.randomUUID(),
            name: nameInput.value.trim() || defaultGroupName(groups),
            mode: (dirs.find((d) => d.checked)?.value as SplitGroup["mode"]) ?? "vertical",
            sessionIds: picked,
          });
        });
        buttons.append(cancel, ok);

        card.append(title, nameInput, dirRow, list, count, buttons);
        sync();
        return card;
      },
      () => {
        if (!settled) resolve(null);
      },
    );
  });
}

/** 분할 그룹 목록 — 버튼 아래 팝업. 줄을 누르면 적용, 연필은 편집, ×는 삭제. */
export function openGroupMenu(anchor: HTMLElement, deps: GroupMenuDeps): void {
  const layer = document.createElement("div");
  layer.className = "split-layer";
  const pop = document.createElement("div");
  pop.className = "split-pop group-pop";
  layer.appendChild(pop);

  let release: () => void = () => {};
  const close = () => {
    release();
    document.removeEventListener("keydown", onKey, true);
    layer.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const head = document.createElement("div");
  head.className = "split-head";
  head.textContent = "분할 그룹";
  pop.appendChild(head);

  const groups = deps.groups();
  const list = document.createElement("div");
  list.className = "split-list";
  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "group-empty";
    empty.textContent = "아직 만든 그룹이 없습니다.";
    list.appendChild(empty);
  }
  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "group-item";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "group-apply";
    const label = document.createElement("span");
    label.className = "group-name";
    label.textContent = g.name;
    const meta = document.createElement("span");
    meta.className = "group-detail";
    meta.textContent = `${DIR_LABEL[g.mode]} ${g.sessionIds.length}`;
    name.append(label, meta);
    name.addEventListener("click", () => {
      close();
      deps.apply(g);
    });

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "group-act";
    edit.title = "이름·방향·세션 바꾸기";
    applyIcon(edit, "edit");
    edit.addEventListener("click", async () => {
      close();
      const next = await editGroupDialog(g, deps.sessions(), deps.groups());
      if (next) deps.save(deps.groups().map((x) => (x.id === g.id ? next : x)));
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "group-act danger";
    del.title = "그룹 삭제";
    applyIcon(del, "delete");
    del.addEventListener("click", async () => {
      close();
      if (!(await confirmDialog(`'${g.name}' 그룹을 삭제할까요? 세션은 그대로 남습니다.`))) return;
      deps.save(deps.groups().filter((x) => x.id !== g.id));
    });

    row.append(name, edit, del);
    list.appendChild(row);
  }
  pop.appendChild(list);

  const foot = document.createElement("div");
  foot.className = "split-bulk";
  const mk = (text: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "split-link";
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  };
  // 지금 화면 그대로를 그룹으로 — 마음에 드는 배치를 만든 직후가 가장 저장하고 싶은 때다.
  const cur = deps.currentSplit();
  if (cur) {
    foot.appendChild(
      mk("지금 분할을 그룹으로", async () => {
        close();
        const next = await editGroupDialog(
          { id: "", name: "", mode: cur.mode, sessionIds: cur.sessionIds },
          deps.sessions(),
          deps.groups(),
        );
        if (next) deps.save([...deps.groups(), { ...next, id: crypto.randomUUID() }]);
      }),
    );
  }
  foot.appendChild(
    mk("새 그룹", async () => {
      close();
      const next = await editGroupDialog(null, deps.sessions(), deps.groups());
      if (next) deps.save([...deps.groups(), next]);
    }),
  );
  pop.appendChild(foot);

  layer.addEventListener("mousedown", (e) => {
    if (e.target === layer) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(layer);

  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(6, r.left), window.innerWidth - pr.width - 6)}px`;
  pop.style.top = `${Math.max(6, Math.min(r.bottom + 4, window.innerHeight - pr.height - 6))}px`;
  release = holdFocus(pop);
}
