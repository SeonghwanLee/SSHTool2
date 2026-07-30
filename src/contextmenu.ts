// 우클릭 컨텍스트 메뉴. 항목마다 단축키(accel) 한 글자를 지정하면 메뉴가 열린 상태에서
// 그 키로 바로 실행된다(WPF 0.43.3 대응).

export interface MenuAction {
  label: string;
  /** 메뉴가 열린 동안 누르면 실행되는 한 글자(대소문자 무시). */
  accel?: string;
  action: () => void;
  danger?: boolean;
  separator?: false;
  children?: undefined;
}

/** 하위메뉴 — 올리면 옆으로 펼쳐진다. 자체 action 은 없다(펼치는 것이 동작의 전부). */
export interface MenuSubmenu {
  label: string;
  children: MenuItem[];
  accel?: undefined;
  danger?: boolean;
  separator?: false;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuAction | MenuSubmenu | MenuSeparator;

const isSeparator = (i: MenuItem): i is MenuSeparator => i.separator === true;
const isSubmenu = (i: MenuItem): i is MenuSubmenu => !isSeparator(i) && "children" in i && Array.isArray((i as MenuSubmenu).children);

let openMenu: HTMLElement | null = null;

/** 열려 있는 메뉴를 닫는다. */
export function closeContextMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  openMenu = menu;

  // 리스너까지 정리하는 cleanup 은 아래에서 정의되므로 참조를 통해 호출한다.
  // (closeContextMenu 만 부르면 capture 단계 keydown 리스너가 남아, 이어서 열리는
  //  다이얼로그의 첫 타이핑이 메뉴 단축키로 오인돼 삭제 등이 실행된다.)
  const run = (item: MenuAction) => {
    cleanup();
    item.action();
  };

  // 열려 있는 하위메뉴(한 번에 하나만).
  let openSub: HTMLElement | null = null;
  const closeSub = () => {
    openSub?.remove();
    openSub = null;
  };

  /** 항목 행에 마우스가 올라오면 하위메뉴를 그 옆에 펼친다. */
  const openSubmenu = (row: HTMLElement, sub: MenuSubmenu) => {
    closeSub();
    const panel = document.createElement("div");
    panel.className = "ctx-menu ctx-submenu";
    for (const child of sub.children) {
      if (isSeparator(child)) {
        panel.appendChild(document.createElement("hr"));
        continue;
      }
      if (isSubmenu(child)) continue; // 2단 중첩은 지원하지 않는다 — 필요해지면 그때 재귀로
      const r = document.createElement("button");
      r.className = "ctx-item" + (child.danger ? " danger" : "");
      const l = document.createElement("span");
      l.textContent = child.label;
      r.appendChild(l);
      r.addEventListener("click", () => run(child));
      panel.appendChild(r);
    }
    document.body.appendChild(panel);
    // 부모 항목의 오른쪽에 붙이고, 화면을 벗어나면 왼쪽으로 뒤집는다.
    const rr = row.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    let left = rr.right + 2;
    if (left + pr.width > window.innerWidth - 6) left = rr.left - pr.width - 2;
    let top = rr.top - 4;
    if (top + pr.height > window.innerHeight - 6) top = window.innerHeight - pr.height - 6;
    panel.style.left = `${Math.max(4, left)}px`;
    panel.style.top = `${Math.max(4, top)}px`;
    openSub = panel;
  };

  for (const item of items) {
    if (isSeparator(item)) {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const row = document.createElement("button");
    row.className = "ctx-item" + (item.danger ? " danger" : "");
    const label = document.createElement("span");
    label.textContent = item.label;
    row.appendChild(label);
    if (isSubmenu(item)) {
      row.classList.add("has-sub");
      const arrow = document.createElement("span");
      arrow.className = "ctx-accel";
      arrow.textContent = "▸";
      row.appendChild(arrow);
      row.addEventListener("mouseenter", () => openSubmenu(row, item));
      // 클릭으로도 펼친다 — 하위메뉴가 있다는 걸 모르고 눌러 본 경우 아무 일도 없으면
      // 죽은 항목으로 보인다.
      row.addEventListener("click", () => openSubmenu(row, item));
    } else {
      const accel = document.createElement("span");
      accel.className = "ctx-accel";
      accel.textContent = item.accel ? item.accel.toUpperCase() : "";
      row.appendChild(accel);
      // 하위메뉴가 아닌 항목에 올라오면 열려 있던 하위메뉴를 닫는다.
      row.addEventListener("mouseenter", closeSub);
      row.addEventListener("click", () => run(item));
    }
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  // 화면 밖으로 나가지 않도록 보정.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 6);
  const top = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      cleanup();
      return;
    }
    const flat = items.flatMap((i) => (isSubmenu(i) ? i.children : [i]));
    const hit = flat.find(
      (i): i is MenuAction =>
        !isSeparator(i) && !isSubmenu(i) && !!i.accel && i.accel.toLowerCase() === e.key.toLowerCase(),
    );
    if (hit) {
      e.preventDefault();
      cleanup();
      hit.action();
    }
  };
  const onDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !openSub?.contains(t)) cleanup();
  };
  const cleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    closeSub();
    closeContextMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
}
