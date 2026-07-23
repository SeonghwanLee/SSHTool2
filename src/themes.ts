// 테마 10종 — WPF SSHTool 0.34.x 큐레이션 팔레트(웜 다크 4·웜 라이트 2·완전 다크 2·화이트 2).
// 각 테마는 앱 크롬 색(CSS 변수)과 터미널 색(xterm ITheme)을 함께 정의한다.

import type { ITheme } from "@xterm/xterm";

export interface AppPalette {
  bg: string;
  panel: string;
  panel2: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  accentHover: string;
  accentInk: string; // 강조 배경 위 글자색(OnAccent) — 대비 확보(0.20.1 교훈)
  error: string;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  app: AppPalette;
  term: ITheme;
}

export const THEMES: Theme[] = [
  {
    id: "everforest",
    name: "에버포레스트",
    dark: true,
    app: {
      bg: "#2d353b", panel: "#343f44", panel2: "#3d484d", border: "#4f585e",
      fg: "#d3c6aa", muted: "#859289", accent: "#a7c080", accentHover: "#b6cf98",
      accentInk: "#2d353b", error: "#e67e80",
    },
    term: {
      background: "#2d353b", foreground: "#d3c6aa", cursor: "#d3c6aa",
      cursorAccent: "#2d353b", selectionBackground: "#475258",
      black: "#4b565c", red: "#e67e80", green: "#a7c080", yellow: "#dbbc7f",
      blue: "#7fbbb3", magenta: "#d699b6", cyan: "#83c092", white: "#d3c6aa",
      brightBlack: "#859289", brightRed: "#e67e80", brightGreen: "#a7c080", brightYellow: "#dbbc7f",
      brightBlue: "#7fbbb3", brightMagenta: "#d699b6", brightCyan: "#83c092", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "gruvbox",
    name: "그루브박스",
    dark: true,
    app: {
      bg: "#282828", panel: "#32302f", panel2: "#3c3836", border: "#504945",
      fg: "#ebdbb2", muted: "#a89984", accent: "#fe8019", accentHover: "#fe9d4c",
      accentInk: "#282828", error: "#fb4934",
    },
    term: {
      background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2",
      cursorAccent: "#282828", selectionBackground: "#504945",
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
      brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
  },
  {
    id: "kanagawa",
    name: "카나가와",
    dark: true,
    app: {
      bg: "#1f1f28", panel: "#2a2a37", panel2: "#363646", border: "#54546d",
      fg: "#dcd7ba", muted: "#727169", accent: "#c0a36e", accentHover: "#d4b483",
      accentInk: "#1f1f28", error: "#e82424",
    },
    term: {
      background: "#1f1f28", foreground: "#dcd7ba", cursor: "#c8c093",
      cursorAccent: "#1f1f28", selectionBackground: "#2d4f67",
      black: "#090618", red: "#c34043", green: "#76946a", yellow: "#c0a36e",
      blue: "#7e9cd8", magenta: "#957fb8", cyan: "#6a9589", white: "#c8c093",
      brightBlack: "#727169", brightRed: "#e82424", brightGreen: "#98bb6c", brightYellow: "#e6c384",
      brightBlue: "#7fb4ca", brightMagenta: "#938aa9", brightCyan: "#7aa89f", brightWhite: "#dcd7ba",
    },
  },
  {
    id: "monokai",
    name: "모노카이",
    dark: true,
    app: {
      bg: "#272822", panel: "#2d2e27", panel2: "#3e3d32", border: "#49483e",
      fg: "#f8f8f2", muted: "#75715e", accent: "#fd971f", accentHover: "#ffb454",
      accentInk: "#272822", error: "#f92672",
    },
    term: {
      background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0",
      cursorAccent: "#272822", selectionBackground: "#49483e",
      black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
      blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
      brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e", brightYellow: "#f4bf75",
      brightBlue: "#66d9ef", brightMagenta: "#ae81ff", brightCyan: "#a1efe4", brightWhite: "#f9f8f5",
    },
  },
  {
    id: "everforest-light",
    name: "에버포레스트 라이트",
    dark: false,
    app: {
      bg: "#fdf6e3", panel: "#f4f0d9", panel2: "#efebd4", border: "#ddd8be",
      fg: "#5c6a72", muted: "#939f91", accent: "#8da101", accentHover: "#a0b510",
      accentInk: "#fdf6e3", error: "#f85552",
    },
    term: {
      background: "#fdf6e3", foreground: "#5c6a72", cursor: "#5c6a72",
      cursorAccent: "#fdf6e3", selectionBackground: "#eaedc8",
      black: "#5c6a72", red: "#f85552", green: "#8da101", yellow: "#dfa000",
      blue: "#3a94c5", magenta: "#df69ba", cyan: "#35a77c", white: "#e0dcc7",
      brightBlack: "#939f91", brightRed: "#f85552", brightGreen: "#8da101", brightYellow: "#dfa000",
      brightBlue: "#3a94c5", brightMagenta: "#df69ba", brightCyan: "#35a77c", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "gruvbox-light",
    name: "그루브박스 라이트",
    dark: false,
    app: {
      bg: "#fbf1c7", panel: "#f2e5bc", panel2: "#ebdbb2", border: "#d5c4a1",
      fg: "#3c3836", muted: "#7c6f64", accent: "#d65d0e", accentHover: "#e07227",
      accentInk: "#fbf1c7", error: "#9d0006",
    },
    term: {
      background: "#fbf1c7", foreground: "#3c3836", cursor: "#3c3836",
      cursorAccent: "#fbf1c7", selectionBackground: "#d5c4a1",
      black: "#fbf1c7", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#7c6f64",
      brightBlack: "#928374", brightRed: "#9d0006", brightGreen: "#79740e", brightYellow: "#b57614",
      brightBlue: "#076678", brightMagenta: "#8f3f71", brightCyan: "#427b58", brightWhite: "#3c3836",
    },
  },
  {
    id: "midnight",
    name: "미드나이트",
    dark: true,
    app: {
      bg: "#111111", panel: "#181818", panel2: "#222222", border: "#333333",
      fg: "#d8d8d8", muted: "#8a8a8a", accent: "#e0a458", accentHover: "#eab472",
      accentInk: "#111111", error: "#e0574f",
    },
    term: {
      background: "#111111", foreground: "#d8d8d8", cursor: "#e0a458",
      cursorAccent: "#111111", selectionBackground: "#3a3a3a",
      black: "#111111", red: "#e0574f", green: "#8fbf7f", yellow: "#e0a458",
      blue: "#6a9fb5", magenta: "#b294bb", cyan: "#75b5aa", white: "#d8d8d8",
      brightBlack: "#8a8a8a", brightRed: "#e0574f", brightGreen: "#8fbf7f", brightYellow: "#e0a458",
      brightBlue: "#6a9fb5", brightMagenta: "#b294bb", brightCyan: "#75b5aa", brightWhite: "#f5f5f5",
    },
  },
  {
    id: "charcoal",
    name: "차콜",
    dark: true,
    app: {
      bg: "#1b1d1e", panel: "#232527", panel2: "#2d2f31", border: "#3c3f41",
      fg: "#cfd2d1", muted: "#868a89", accent: "#c8965a", accentHover: "#d8a86e",
      accentInk: "#1b1d1e", error: "#d16b5a",
    },
    term: {
      background: "#1b1d1e", foreground: "#cfd2d1", cursor: "#c8965a",
      cursorAccent: "#1b1d1e", selectionBackground: "#3a3d3f",
      black: "#1b1d1e", red: "#d16b5a", green: "#9bab6e", yellow: "#c8965a",
      blue: "#6f9dbf", magenta: "#a988b0", cyan: "#7bb0a8", white: "#cfd2d1",
      brightBlack: "#868a89", brightRed: "#d16b5a", brightGreen: "#9bab6e", brightYellow: "#c8965a",
      brightBlue: "#6f9dbf", brightMagenta: "#a988b0", brightCyan: "#7bb0a8", brightWhite: "#eef0ef",
    },
  },
  {
    id: "pure-white",
    name: "퓨어 화이트",
    dark: false,
    app: {
      bg: "#ffffff", panel: "#f5f5f5", panel2: "#ececec", border: "#dcdcdc",
      fg: "#2b2b2b", muted: "#888888", accent: "#c07830", accentHover: "#d48a3f",
      accentInk: "#ffffff", error: "#c0392b",
    },
    term: {
      background: "#ffffff", foreground: "#2b2b2b", cursor: "#2b2b2b",
      cursorAccent: "#ffffff", selectionBackground: "#d5e5f5",
      black: "#2b2b2b", red: "#c0392b", green: "#3c8a3c", yellow: "#b8860b",
      blue: "#2f6fb0", magenta: "#9b4f96", cyan: "#2f8f8f", white: "#dcdcdc",
      brightBlack: "#888888", brightRed: "#c0392b", brightGreen: "#3c8a3c", brightYellow: "#b8860b",
      brightBlue: "#2f6fb0", brightMagenta: "#9b4f96", brightCyan: "#2f8f8f", brightWhite: "#2b2b2b",
    },
  },
  {
    id: "stone-white",
    name: "스톤 화이트",
    dark: false,
    app: {
      bg: "#fafaf8", panel: "#f0f0ea", panel2: "#e6e6de", border: "#d4d4c8",
      fg: "#3a3a34", muted: "#8a8a7e", accent: "#7d8a2e", accentHover: "#8f9d37",
      accentInk: "#fafaf8", error: "#b23a30",
    },
    term: {
      background: "#fafaf8", foreground: "#3a3a34", cursor: "#3a3a34",
      cursorAccent: "#fafaf8", selectionBackground: "#e0e4c8",
      black: "#3a3a34", red: "#b23a30", green: "#7d8a2e", yellow: "#b07d1a",
      blue: "#37729e", magenta: "#96588f", cyan: "#2f8477", white: "#d4d4c8",
      brightBlack: "#8a8a7e", brightRed: "#b23a30", brightGreen: "#7d8a2e", brightYellow: "#b07d1a",
      brightBlue: "#37729e", brightMagenta: "#96588f", brightCyan: "#2f8477", brightWhite: "#3a3a34",
    },
  },
];

export const DEFAULT_THEME_ID = "everforest";

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** 앱 크롬 색을 :root CSS 변수로 적용. */
export function applyAppTheme(theme: Theme): void {
  const r = document.documentElement.style;
  const a = theme.app;
  r.setProperty("--bg", a.bg);
  r.setProperty("--panel", a.panel);
  r.setProperty("--panel-2", a.panel2);
  r.setProperty("--border", a.border);
  r.setProperty("--fg", a.fg);
  r.setProperty("--muted", a.muted);
  r.setProperty("--accent", a.accent);
  r.setProperty("--accent-hover", a.accentHover);
  r.setProperty("--accent-ink", a.accentInk);
  r.setProperty("--error", a.error);
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
}
