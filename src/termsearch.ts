// 터미널 검색바 — 입력 처리·강조색·다음/이전 이동. termtab.ts 에서 분리(0.67.0).
// 로직 변경 없음: 강조는 활성 일치=액센트, 나머지=액센트를 배경 쪽으로 죽인 색.

import type { Terminal } from "@xterm/xterm";
import type { SearchAddon, ISearchDecorationOptions } from "@xterm/addon-search";
import type { Settings } from "./settings";
import { themeById } from "./themes";
import { mixHex } from "./termtypes";

export class TermSearch {
  constructor(
    private readonly term: Terminal,
    private readonly addon: SearchAddon,
    private readonly bar: HTMLElement,
    private readonly input: HTMLInputElement,
    /** 현재 설정을 돌려준다 — 테마가 바뀌면 강조색도 따라가야 한다. */
    private readonly getSettings: () => Settings,
    private readonly onClose: () => void,
  ) {
    this.input.addEventListener("input", () => {
      if (this.input.value)
        this.addon.findNext(this.input.value, {
          incremental: true,
          decorations: this.decorations(),
        });
      else this.addon.clearDecorations();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "F3") {
        e.preventDefault();
        e.shiftKey ? this.prev() : this.next();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.onClose();
      }
    });
  }

  /**
   * 검색어 강조 색. clearDecorations() 만 부르고 decorations 를 넘기지 않으면 강조가
   * 아예 켜지지 않는다 — 현재 위치로 이동만 하고 나머지 일치는 표시되지 않는다.
   */
  private decorations(): ISearchDecorationOptions {
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a7c080";
    const bg = themeById(this.getSettings().theme).term.background ?? "#000000";
    return {
      matchBackground: mixHex(accent, bg, 0.5),
      matchOverviewRuler: accent,
      activeMatchBackground: accent,
      activeMatchColorOverviewRuler: accent,
    };
  }

  open(): void {
    this.bar.style.display = "flex";
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.bar.style.display = "none";
    this.addon.clearDecorations();
    this.term.focus();
  }

  next(): void {
    if (this.input.value)
      this.addon.findNext(this.input.value, { decorations: this.decorations() });
  }

  prev(): void {
    if (this.input.value)
      this.addon.findPrevious(this.input.value, { decorations: this.decorations() });
  }
}
