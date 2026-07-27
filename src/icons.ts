// 앱 전역 아이콘 — WPF(SSHTool) 와 동일한 Segoe Fluent Icons / Segoe MDL2 Assets
// 코드포인트를 그대로 사용(윈도우 내장 아이콘 폰트, currentColor 로 테마색 반영).
// 화면분할(탭/세로/가로) 버튼만 WPF 처럼 도형으로 그려 SVG 로 처리.

/** Segoe MDL2/Fluent 코드포인트 — 기능별. (WPF MainWindow/SftpPanel/FileIcons 와 일치) */
export const GLYPH: Record<string, string> = {
  settings: "",
  info: "",
  command: "", // 동시 명령(CommandPrompt)
  minimize: "", // 창 최소화(ChromeMinimize)
  maximize: "", // 창 최대화(ChromeMaximize)
  restore: "", // 창 복원(ChromeRestore)
  close: "", // 창/탭 닫기(ChromeClose)
  cancel: "", // 지우기/취소(Cancel)

  quickConnect: "",
  newSession: "", // Add
  newFolder: "", // Folder
  folder: "",
  folderOpen: "",
  import: "", // Import
  lock: "",
  unlock: "",

  remote: "", // 원격 세션
  local: "", // 로컬 셸 세션 / SFTP 로컬 패널
  globe: "", // SFTP 원격 패널

  edit: "",
  duplicate: "",
  delete: "",
  moveUp: "",
  moveDown: "",
  refresh: "",
  search: "", // 터미널 검색(Search)
  up: "",
  setDefault: "",
  sftp: "",
};

/** WPF 도형 뷰 아이콘(16×13) — 탭 보기 / 세로 분할 / 가로 분할. */
const VIEW_SVG: Record<string, string> = {
  viewTabs:
    '<svg class="ic ic-view" viewBox="0 0 16 13" aria-hidden="true">' +
    '<rect x="0" y="3" width="16" height="10" rx="2" fill="currentColor" opacity="0.5"/>' +
    '<rect x="0" y="0" width="9" height="4" rx="1" fill="currentColor"/></svg>',
  viewVertical:
    '<svg class="ic ic-view" viewBox="0 0 16 13" aria-hidden="true">' +
    '<rect x="0" y="0" width="7" height="13" rx="2" fill="currentColor"/>' +
    '<rect x="9" y="0" width="7" height="13" rx="2" fill="currentColor"/></svg>',
  viewHorizontal:
    '<svg class="ic ic-view" viewBox="0 0 16 13" aria-hidden="true">' +
    '<rect x="0" y="0" width="16" height="5.5" rx="2" fill="currentColor"/>' +
    '<rect x="0" y="7.5" width="16" height="5.5" rx="2" fill="currentColor"/></svg>',
};

/** 요소에 아이콘을 적용 — 뷰 도형이면 SVG, 그 외엔 Segoe 글리프. */
export function applyIcon(el: Element, name: string): void {
  if (name in VIEW_SVG) {
    el.classList.remove("mdl2");
    el.innerHTML = VIEW_SVG[name];
  } else {
    el.classList.add("mdl2");
    el.textContent = GLYPH[name] ?? "";
  }
}

/** 아이콘을 담은 span 생성(동적 목록용). */
export function iconSpan(name: string, className = ""): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = className;
  applyIcon(s, name);
  return s;
}

// ── SFTP 파일 유형 아이콘 — WPF Sftp/FileIcons.cs 와 동일(글리프 + 색) ──────────
const FILE_TABLE: Array<[string[], number, string]> = [
  [["xls", "xlsx", "xlsm", "csv"], 0xe80a, "#4cc273"], // Table
  [["doc", "docx", "hwp", "hwpx", "rtf", "odt"], 0xe8a5, "#5b9bd5"], // Document
  [["ppt", "pptx"], 0xe786, "#ed7d31"], // Slideshow
  [["pdf"], 0xea90, "#e5534b"],
  [["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff"], 0xe91b, "#b180d7"], // Photo
  [["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz"], 0xe7b8, "#c9a227"], // Package
  [
    // prettier-ignore
    ["sh","py","js","ts","jsx","tsx","json","xml","yml","yaml","sql","c","h","cpp","hpp","cs","java","go","rs","php","html","css","conf","ini","toml","ps1"],
    0xe943,
    "#56b6c2",
  ], // Code
  [["exe", "msi", "bat", "cmd", "com"], 0xe756, "#98c379"], // CommandPrompt
  [["txt", "log", "md"], 0xe8a5, "#9da5b4"], // plain
  [["mp3", "wav", "flac", "ogg", "m4a"], 0xe8d6, "#d19a66"], // MusicNote
  [["mp4", "avi", "mkv", "mov", "wmv", "webm"], 0xe714, "#d19a66"], // Video
];

/** 파일명·폴더 여부로 (글리프, 색) 반환 — WPF FileIcons 규칙. */
export function fileIcon(name: string, isDir: boolean): { glyph: string; color: string } {
  if (isDir) return { glyph: String.fromCharCode(0xe8b7), color: "#e8c170" }; // Folder — warm yellow
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  for (const [exts, cp, color] of FILE_TABLE) {
    if (exts.includes(ext)) return { glyph: String.fromCharCode(cp), color };
  }
  return { glyph: String.fromCharCode(0xe8a5), color: "#9da5b4" }; // default document
}
