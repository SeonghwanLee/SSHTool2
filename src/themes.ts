// 테마 — 요즘 널리 사랑받는 예쁜 팔레트 큐레이션.
// 사용자가 좋아하는 에버포레스트·그루브박스(+라이트)는 유지하고, 인기 테마
// (Catppuccin·Tokyo Night·Rose Pine·Nord·Dracula·One Dark)를 추가했다.
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
  // ── 다크 ──────────────────────────────────────────────────────────────────
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
    id: "catppuccin-mocha",
    name: "카푸치노 모카",
    dark: true,
    app: {
      bg: "#1e1e2e", panel: "#181825", panel2: "#313244", border: "#45475a",
      fg: "#cdd6f4", muted: "#a6adc8", accent: "#cba6f7", accentHover: "#d9bffa",
      accentInk: "#1e1e2e", error: "#f38ba8",
    },
    term: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e", selectionBackground: "#45475a",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
      brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
  },
  {
    id: "tokyo-night",
    name: "도쿄 나이트",
    dark: true,
    app: {
      bg: "#1a1b26", panel: "#16161e", panel2: "#24283b", border: "#2f334d",
      fg: "#c0caf5", muted: "#565f89", accent: "#7aa2f7", accentHover: "#8fb3f9",
      accentInk: "#1a1b26", error: "#f7768e",
    },
    term: {
      background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5",
      cursorAccent: "#1a1b26", selectionBackground: "#33467c",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
      brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  {
    id: "rose-pine",
    name: "로즈 파인",
    dark: true,
    app: {
      bg: "#191724", panel: "#1f1d2e", panel2: "#26233a", border: "#403d52",
      fg: "#e0def4", muted: "#908caa", accent: "#c4a7e7", accentHover: "#d0b8ee",
      accentInk: "#191724", error: "#eb6f92",
    },
    term: {
      background: "#191724", foreground: "#e0def4", cursor: "#e0def4",
      cursorAccent: "#191724", selectionBackground: "#403d52",
      black: "#26233a", red: "#eb6f92", green: "#31748f", yellow: "#f6c177",
      blue: "#9ccfd8", magenta: "#c4a7e7", cyan: "#ebbcba", white: "#e0def4",
      brightBlack: "#6e6a86", brightRed: "#eb6f92", brightGreen: "#31748f", brightYellow: "#f6c177",
      brightBlue: "#9ccfd8", brightMagenta: "#c4a7e7", brightCyan: "#ebbcba", brightWhite: "#e0def4",
    },
  },
  {
    id: "nord",
    name: "노르드",
    dark: true,
    app: {
      bg: "#2e3440", panel: "#3b4252", panel2: "#434c5e", border: "#4c566a",
      fg: "#d8dee9", muted: "#7b88a1", accent: "#88c0d0", accentHover: "#9fcbd8",
      accentInk: "#2e3440", error: "#bf616a",
    },
    term: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
      cursorAccent: "#2e3440", selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  {
    id: "dracula",
    name: "드라큘라",
    dark: true,
    app: {
      bg: "#282a36", panel: "#21222c", panel2: "#343746", border: "#44475a",
      fg: "#f8f8f2", muted: "#6272a4", accent: "#bd93f9", accentHover: "#cba6fa",
      accentInk: "#282a36", error: "#ff5555",
    },
    term: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
      cursorAccent: "#282a36", selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  {
    id: "one-dark",
    name: "원 다크",
    dark: true,
    app: {
      bg: "#282c34", panel: "#21252b", panel2: "#3e4451", border: "#4b5263",
      fg: "#abb2bf", muted: "#5c6370", accent: "#61afef", accentHover: "#7cbef2",
      accentInk: "#282c34", error: "#e06c75",
    },
    term: {
      background: "#282c34", foreground: "#abb2bf", cursor: "#528bff",
      cursorAccent: "#282c34", selectionBackground: "#3e4451",
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b",
      brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  {
    // 기존 13종은 모두 '예쁜' 쪽에 맞춰 대비를 낮게 잡은 팔레트다. 오래 보기엔 편하지만
    // 밝은 사무실·저가 모니터·시력 보정이 필요한 상황에서는 글자가 묻힌다. 그 자리를 채운다.
    // GitHub 의 High Contrast 팔레트를 기준으로 삼았다 — 접근성 기준(WCAG)을 목표로
    // 설계된 몇 안 되는 터미널 색 조합이고, ANSI 검정을 밝게 잡아 어두운 배경에서
    // 사라지지 않게 처리한 점이 특히 터미널에 맞는다.
    id: "high-contrast-dark",
    name: "고대비 다크",
    dark: true,
    app: {
      bg: "#0a0c10", panel: "#0d1117", panel2: "#161b22", border: "#7a828e",
      fg: "#f0f3f6", muted: "#bdc4cc", accent: "#71b7ff", accentHover: "#91cbff",
      accentInk: "#0a0c10", error: "#ff9492",
    },
    term: {
      background: "#0a0c10", foreground: "#f0f3f6", cursor: "#f0f3f6",
      cursorAccent: "#0a0c10", selectionBackground: "#2f4a77",
      // black 을 회색으로 올린다 — 원색 검정이면 이 배경에서 글자가 통째로 사라진다.
      black: "#7a828e", red: "#ff9492", green: "#26cd4d", yellow: "#f0b72f",
      blue: "#71b7ff", magenta: "#cb9eff", cyan: "#39c5cf", white: "#d9dee3",
      brightBlack: "#9ea7b3", brightRed: "#ffb1af", brightGreen: "#4ae168", brightYellow: "#f7c843",
      brightBlue: "#91cbff", brightMagenta: "#dbb7ff", brightCyan: "#56d4dd", brightWhite: "#ffffff",
    },
  },
  // ── 라이트 ────────────────────────────────────────────────────────────────
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
    id: "catppuccin-latte",
    name: "카푸치노 라테",
    dark: false,
    app: {
      bg: "#eff1f5", panel: "#e6e9ef", panel2: "#ccd0da", border: "#bcc0cc",
      fg: "#4c4f69", muted: "#6c6f85", accent: "#8839ef", accentHover: "#9c5cf0",
      accentInk: "#eff1f5", error: "#d20f39",
    },
    term: {
      background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78",
      cursorAccent: "#eff1f5", selectionBackground: "#ccd0da",
      black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
      blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
      brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b", brightYellow: "#df8e1d",
      brightBlue: "#1e66f5", brightMagenta: "#ea76cb", brightCyan: "#179299", brightWhite: "#4c4f69",
    },
  },
  {
    id: "rose-pine-dawn",
    name: "로즈 파인 던",
    dark: false,
    app: {
      bg: "#faf4ed", panel: "#fffaf3", panel2: "#f2e9e1", border: "#dfdad9",
      fg: "#575279", muted: "#797593", accent: "#907aa9", accentHover: "#a08bb8",
      accentInk: "#faf4ed", error: "#b4637a",
    },
    term: {
      background: "#faf4ed", foreground: "#575279", cursor: "#575279",
      cursorAccent: "#faf4ed", selectionBackground: "#dfdad9",
      black: "#f2e9e1", red: "#b4637a", green: "#286983", yellow: "#ea9d34",
      blue: "#56949f", magenta: "#907aa9", cyan: "#d7827e", white: "#575279",
      brightBlack: "#9893a5", brightRed: "#b4637a", brightGreen: "#286983", brightYellow: "#ea9d34",
      brightBlue: "#56949f", brightMagenta: "#907aa9", brightCyan: "#d7827e", brightWhite: "#575279",
    },
  },
  {
    // 기존 라이트 4종은 크림·베이지 배경이라 종이처럼 편하지만 대비가 낮다.
    // 이쪽은 순백 배경 + 거의 검정 글자로, 밝은 조명 아래나 화면 공유 때를 노린다.
    // ANSI 색은 전부 어둡게 잡았다 — 흰 배경에서 밝은 색은 그대로 날아간다.
    id: "high-contrast-light",
    name: "고대비 라이트",
    dark: false,
    app: {
      bg: "#ffffff", panel: "#f5f8fa", panel2: "#e7ecf0", border: "#3d444d",
      fg: "#0e1116", muted: "#4b535d", accent: "#0349b4", accentHover: "#023b93",
      accentInk: "#ffffff", error: "#a0111f",
    },
    term: {
      background: "#ffffff", foreground: "#0e1116", cursor: "#0e1116",
      cursorAccent: "#ffffff", selectionBackground: "#b6d4fb",
      black: "#0e1116", red: "#a0111f", green: "#024c1a", yellow: "#3f2200",
      // GitHub 원본의 cyan/brightCyan(#1b7c83 / #3192aa)은 bright 쪽이 흰 배경에서 3.61 로
      // AA(4.5)에 못 미쳤다. bright 를 더 어둡게 하면 기본색과 뒤집히므로 짝을 통째로 한 단
      // 낮춰 둘 다 통과시켰다(7.45 / 4.93).
      blue: "#0349b4", magenta: "#622cbc", cyan: "#155e64", white: "#66707b",
      brightBlack: "#4b535d", brightRed: "#86061d", brightGreen: "#055d20", brightYellow: "#4e2c00",
      brightBlue: "#1168e3", brightMagenta: "#844ae7", brightCyan: "#1b7c83", brightWhite: "#0e1116",
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
  // 터미널 배경색 — 행 높이 잔여 영역(하단 띠)을 이 색으로 칠해 검게 비치지 않게 한다.
  r.setProperty("--term-bg", theme.term.background ?? a.bg);
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
}
