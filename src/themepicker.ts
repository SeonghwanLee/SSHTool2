// 상단 테마 버튼 — 스와치 그리드로 즉시 테마 전환(WPF 0.19.0 팔레트 버튼 대응).
import { openModal } from "./dialogs";
import { THEMES, applyAppTheme, themeById } from "./themes";

export function themePicker(current: string, onPick: (id: string) => void): Promise<void> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        const h = document.createElement("h3");
        h.textContent = "테마";
        const grid = document.createElement("div");
        grid.className = "theme-grid";
        for (const t of THEMES) {
          const b = document.createElement("button");
          b.className = "theme-swatch" + (t.id === current ? " selected" : "");
          const bar = document.createElement("div");
          bar.className = "swatch-preview";
          bar.style.background = t.app.bg;
          const dot = document.createElement("span");
          dot.className = "swatch-accent";
          dot.style.background = t.app.accent;
          const txt = document.createElement("span");
          txt.className = "swatch-text";
          txt.style.color = t.app.fg;
          txt.textContent = "Ab";
          bar.append(dot, txt);
          const name = document.createElement("div");
          name.className = "swatch-name";
          name.textContent = t.name;
          b.append(bar, name);
          b.addEventListener("mouseenter", () => applyAppTheme(t)); // 미리보기
          b.addEventListener("click", () => {
            close();
            onPick(t.id);
            resolve();
          });
          grid.appendChild(b);
        }
        // 마우스가 벗어나면 현재 선택으로 복원(호버 미리보기 취소).
        grid.addEventListener("mouseleave", () => applyAppTheme(themeById(current)));
        card.append(h, grid);
        return card;
      },
      () => {
        applyAppTheme(themeById(current)); // 취소 시 원복
        resolve();
      },
    );
  });
}
