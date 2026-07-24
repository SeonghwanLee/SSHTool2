// 설정 다이얼로그 — 테마(스와치)·글꼴(배지)·크기·커서·동작. 변경 즉시 라이브 적용,
// 닫으면 최종 설정을 반환(호출자가 저장).

import type { Settings, CursorStyle } from "./settings";
import { FONTS } from "./settings";
import { THEMES } from "./themes";
import { knownHostsDialog } from "./knownhosts";

export function settingsDialog(
  current: Settings,
  onLive: (s: Settings) => void,
): Promise<Settings> {
  return new Promise((resolve) => {
    let working: Settings = { ...current };
    const apply = () => onLive(working);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card settings-card";
    overlay.appendChild(card);

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onEsc);
      resolve(working);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onEsc);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });

    const title = document.createElement("h3");
    title.textContent = "설정";
    card.appendChild(title);

    // ── 테마 ──
    card.appendChild(sectionLabel("테마"));
    const themeGrid = document.createElement("div");
    themeGrid.className = "theme-grid";
    const themeButtons = new Map<string, HTMLElement>();
    for (const t of THEMES) {
      const b = document.createElement("button");
      b.className = "theme-swatch";
      b.title = t.name;
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
      b.addEventListener("click", () => {
        working = { ...working, theme: t.id };
        markTheme();
        apply();
      });
      themeButtons.set(t.id, b);
      themeGrid.appendChild(b);
    }
    const markTheme = () => {
      for (const [id, el] of themeButtons) el.classList.toggle("selected", id === working.theme);
    };
    markTheme();
    card.appendChild(themeGrid);

    // ── 글꼴 ──
    card.appendChild(sectionLabel("터미널 글꼴"));
    const fontList = document.createElement("div");
    fontList.className = "font-list";
    const fontRows = new Map<string, HTMLElement>();
    for (const f of FONTS) {
      const row = document.createElement("button");
      row.className = "font-row";
      const nm = document.createElement("span");
      nm.className = "font-name";
      nm.style.fontFamily = `"${f.id}", monospace`;
      nm.textContent = f.label;
      const badges = document.createElement("span");
      badges.className = "font-badges";
      if (f.embedded) badges.appendChild(badge("내장", "badge-embedded"));
      const note = document.createElement("span");
      note.className = "font-note";
      note.textContent = f.note;
      badges.appendChild(note);
      row.append(nm, badges);
      row.addEventListener("click", () => {
        working = { ...working, fontFamily: f.id };
        markFont();
        apply();
      });
      fontRows.set(f.id, row);
      fontList.appendChild(row);
    }
    const markFont = () => {
      for (const [id, el] of fontRows) el.classList.toggle("selected", id === working.fontFamily);
    };
    markFont();
    card.appendChild(fontList);

    // ── 크기 / 커서 / 동작 ──
    card.appendChild(sectionLabel("터미널"));

    const sizeRow = controlRow("글꼴 크기");
    const size = document.createElement("input");
    size.type = "number";
    size.min = "9";
    size.max = "28";
    size.value = String(working.fontSize);
    size.className = "num-input";
    size.addEventListener("change", () => {
      const v = Math.min(28, Math.max(9, Number(size.value) || 14));
      size.value = String(v);
      working = { ...working, fontSize: v };
      apply();
    });
    sizeRow.appendChild(size);
    card.appendChild(sizeRow);

    const cursorRow = controlRow("커서 모양");
    const cursorSel = document.createElement("select");
    cursorSel.className = "sel-input";
    for (const [val, label] of [
      ["block", "블록"],
      ["bar", "막대"],
      ["underline", "밑줄"],
    ] as [CursorStyle, string][]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (val === working.cursorStyle) opt.selected = true;
      cursorSel.appendChild(opt);
    }
    cursorSel.addEventListener("change", () => {
      working = { ...working, cursorStyle: cursorSel.value as CursorStyle };
      apply();
    });
    cursorRow.appendChild(cursorSel);
    card.appendChild(cursorRow);

    card.appendChild(checkRow("커서 깜박임", working.cursorBlink, (v) => {
      working = { ...working, cursorBlink: v };
      apply();
    }));
    card.appendChild(checkRow("선택 시 자동 복사 (copy-on-select)", working.copyOnSelect, (v) => {
      working = { ...working, copyOnSelect: v };
      apply();
    }));

    const scrollRow = controlRow("스크롤백 (줄)");
    const scroll = document.createElement("input");
    scroll.type = "number";
    scroll.min = "500";
    scroll.max = "100000";
    scroll.step = "500";
    scroll.value = String(working.scrollback);
    scroll.className = "num-input";
    scroll.addEventListener("change", () => {
      const v = Math.min(100000, Math.max(500, Number(scroll.value) || 5000));
      scroll.value = String(v);
      working = { ...working, scrollback: v };
      apply();
    });
    scrollRow.appendChild(scroll);
    card.appendChild(scrollRow);

    // ── 보안 ──
    card.appendChild(sectionLabel("보안"));
    const hostRow = controlRow("알려진 호스트(서버 지문)");
    const hostBtn = document.createElement("button");
    hostBtn.type = "button";
    hostBtn.className = "sftp-btn";
    hostBtn.textContent = "관리…";
    hostBtn.addEventListener("click", () => void knownHostsDialog());
    hostRow.appendChild(hostBtn);
    card.appendChild(hostRow);

    // ── 닫기 ──
    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    const ok = document.createElement("button");
    ok.className = "btn-accent";
    ok.textContent = "닫기";
    ok.addEventListener("click", close);
    buttons.appendChild(ok);
    card.appendChild(buttons);

    document.body.appendChild(overlay);
  });
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "settings-section";
  el.textContent = text;
  return el;
}

function controlRow(label: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "control-row";
  const l = document.createElement("span");
  l.textContent = label;
  row.appendChild(l);
  return row;
}

function checkRow(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = document.createElement("label");
  row.className = "check-row control-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  const span = document.createElement("span");
  span.textContent = label;
  row.append(span, cb);
  return row;
}

function badge(text: string, cls: string): HTMLElement {
  const b = document.createElement("span");
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}
