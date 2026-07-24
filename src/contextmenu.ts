// 우클릭 컨텍스트 메뉴. 항목마다 단축키(accel) 한 글자를 지정하면 메뉴가 열린 상태에서
// 그 키로 바로 실행된다(WPF 0.43.3 대응).

export interface MenuAction {
  label: string;
  /** 메뉴가 열린 동안 누르면 실행되는 한 글자(대소문자 무시). */
  accel?: string;
  action: () => void;
  danger?: boolean;
  separator?: false;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuAction | MenuSeparator;

const isSeparator = (i: MenuItem): i is MenuSeparator => i.separator === true;

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

  for (const item of items) {
    if (isSeparator(item)) {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const row = document.createElement("button");
    row.className = "ctx-item" + (item.danger ? " danger" : "");
    const label = document.createElement("span");
    label.textContent = item.label;
    const accel = document.createElement("span");
    accel.className = "ctx-accel";
    accel.textContent = item.accel ? item.accel.toUpperCase() : "";
    row.append(label, accel);
    row.addEventListener("click", () => run(item));
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
    const hit = items.find(
      (i): i is MenuAction =>
        !isSeparator(i) && !!i.accel && i.accel.toLowerCase() === e.key.toLowerCase(),
    );
    if (hit) {
      e.preventDefault();
      cleanup();
      hit.action();
    }
  };
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) cleanup();
  };
  const cleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    closeContextMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
}
