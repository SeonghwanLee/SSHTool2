// 세션 빠른 찾기(Ctrl+P) — 키보드만으로 찾아서 바로 접속·전환한다.
//
// 사이드바와 역할이 다르다: 목록은 훑어보고 정리하는 곳, 이 창은 "찾아서 가는" 곳이다.
// 그래서 고르면 즉시 사라지고, 바깥을 누르거나 Esc 로도 닫힌다(모달 정책과 다른 이유 —
// 여기서는 입력하던 내용이 사라져 아쉬울 것이 없다).
//
// 이미 열려 있는 세션이면 새로 붙지 않고 그 탭으로 이동한다 — 빠른 '이동' 이 목적이고,
// 접속을 하나 더 열고 싶으면 사이드바에서 더블클릭하면 된다(기존 경로 유지).

import type { SessionInfo } from "./types";
import { sessionColorCss } from "./types";
import { applyIcon } from "./icons";
import { pushModal, popModal, isTopModal } from "./dialogs";

/** 목록에 함께 보여 줄 표기(사이드바와 같은 규칙). */
const detailOf = (s: SessionInfo): string =>
  s.kind === "local"
    ? `로컬 셸${s.shellExe ? ` · ${s.shellExe}` : ""}`
    : s.kind === "rdp"
      ? `원격 데스크톱 · ${s.user ? `${s.user}@` : ""}${s.host}:${s.port}`
      : s.user
        ? `${s.user}@${s.host}:${s.port}`
        : `${s.host}:${s.port}`;

const kindIcon = (s: SessionInfo): string =>
  s.kind === "local" ? "local" : s.kind === "rdp" ? "rdp" : "remote";

export interface PaletteDeps {
  /** 저장된 세션 전체. */
  sessions: () => SessionInfo[];
  /** 이미 열려 있으면 그 탭으로 이동하고 true. */
  focus: (sessionId: string) => boolean;
  /** 새로 접속(사이드바 더블클릭과 같은 경로). */
  open: (s: SessionInfo) => void;
  /** 지금 탭으로 열려 있는 세션 id 들 — '열림' 배지 표시용. */
  openIds: () => string[];
}

let deps: PaletteDeps | null = null;
let openOverlay: HTMLElement | null = null;

export function initPalette(d: PaletteDeps): void {
  deps = d;
}

/** 열려 있으면 닫고, 닫혀 있으면 연다(같은 키를 다시 눌렀을 때). */
export function togglePalette(): void {
  if (openOverlay) {
    closePalette();
    return;
  }
  showPalette();
}

export function closePalette(): void {
  if (!openOverlay) return;
  popModal(openOverlay);
  openOverlay.remove();
  openOverlay = null;
}

function showPalette(): void {
  if (!deps) return;
  const all = deps.sessions();

  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  const card = document.createElement("div");
  card.className = "palette-card";
  overlay.appendChild(card);

  const input = document.createElement("input");
  input.className = "palette-input";
  input.placeholder = "세션 찾기 — 이름·계정@호스트·폴더 (↑↓ 이동, Enter 접속, Esc 닫기)";
  input.autocomplete = "off";
  input.spellcheck = false;
  const list = document.createElement("div");
  list.className = "palette-list";
  const hint = document.createElement("div");
  hint.className = "palette-hint";
  card.append(input, list, hint);

  let rows: SessionInfo[] = [];
  let cursor = 0;

  /** 검색어로 거르고 순서를 정한다. 빈 검색어면 최근 접속 순(바로 Enter 로 복귀). */
  const filtered = (q: string): SessionInfo[] => {
    const query = q.trim().toLowerCase();
    const withText = all.map((s) => ({
      s,
      text: `${s.name} ${detailOf(s)} ${s.folder}`.toLowerCase(),
      nameLc: (s.name || s.host).toLowerCase(),
    }));
    const hit = query ? withText.filter((x) => x.text.includes(query)) : withText;
    return hit
      .sort((a, b) => {
        if (query) {
          // 이름이 검색어로 시작하는 것을 앞에 — 가장 흔한 의도다.
          const as = a.nameLc.startsWith(query) ? 0 : 1;
          const bs = b.nameLc.startsWith(query) ? 0 : 1;
          if (as !== bs) return as - bs;
        }
        if (a.s.lastConnectedUtc !== b.s.lastConnectedUtc)
          return b.s.lastConnectedUtc - a.s.lastConnectedUtc;
        return a.nameLc.localeCompare(b.nameLc, "ko");
      })
      .slice(0, 50) // 화면에 담기지 않는 만큼은 검색어를 더 치는 편이 빠르다
      .map((x) => x.s);
  };

  const draw = (): void => {
    list.innerHTML = "";
    rows.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "palette-row" + (i === cursor ? " active" : "");
      const css = sessionColorCss(s.color);
      if (css) row.style.setProperty("--session-color", css);
      row.classList.toggle("has-color", !!css);

      const icon = document.createElement("span");
      icon.className = "palette-icon";
      applyIcon(icon, kindIcon(s));
      const main = document.createElement("div");
      main.className = "palette-main";
      const name = document.createElement("div");
      name.className = "palette-name";
      name.textContent = s.name || s.host;
      const detail = document.createElement("div");
      detail.className = "palette-detail";
      detail.textContent = detailOf(s) + (s.folder ? `  ·  ${s.folder}` : "");
      main.append(name, detail);
      row.append(icon, main);
      if (isOpenTab(s)) {
        const badge = document.createElement("span");
        badge.className = "palette-badge";
        badge.textContent = "열림";
        row.appendChild(badge);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 입력 포커스를 잃지 않게
        cursor = i;
        choose();
      });
      list.appendChild(row);
    });
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = all.length ? "일치하는 세션이 없습니다." : "저장된 세션이 없습니다.";
      list.appendChild(empty);
    }
    hint.textContent = rows.length ? `${rows.length}개 · Enter 로 접속(열려 있으면 그 탭으로 이동)` : "";
    list.querySelector(".palette-row.active")?.scrollIntoView({ block: "nearest" });
  };

  /** 이미 열려 있는 세션인지 — 표시만 하고, 실제 이동은 focus() 가 판단한다. */
  const openIds = new Set<string>();
  const isOpenTab = (s: SessionInfo): boolean => openIds.has(s.id);
  // focus 는 이동까지 해 버리므로 조회용으로 쓸 수 없다 — 열린 탭 목록을 따로 받는다.
  deps.openIds().forEach((id) => openIds.add(id));

  const choose = (): void => {
    const s = rows[cursor];
    if (!s || !deps) return;
    closePalette();
    if (deps.focus(s.id)) return; // 이미 열려 있으면 그 탭으로
    deps.open(s);
  };

  input.addEventListener("input", () => {
    rows = filtered(input.value);
    cursor = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = Math.min(rows.length - 1, cursor + 1);
      draw();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });
  // 바깥(어두운 영역) 클릭 = 닫기. 카드 안쪽 클릭은 유지한다.
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closePalette();
  });
  // 카드 안 빈 곳(여백·힌트·목록 배경)을 누르면 포커스가 body 로 빠져 키 입력이 전부
  // 죽는다 — 창은 떠 있는데 아무 반응이 없어 '먹통' 으로 보인다. 눌러도 입력 칸이
  // 포커스를 잃지 않게 막는다. 목록은 스크롤바 드래그를 막지 않도록 제외하고,
  // 대신 아래 focusout 그물로 되돌린다.
  card.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t === input || list.contains(t)) return;
    e.preventDefault();
  });
  // 그래도 포커스가 빠져나가면(스크롤바 드래그, 창 전환 후 복귀) 입력 칸으로 되돌린다.
  overlay.addEventListener("focusout", () => {
    setTimeout(() => {
      if (openOverlay !== overlay) return; // 이미 닫혔으면 관여하지 않는다
      if (card.contains(document.activeElement)) return;
      input.focus();
    }, 0);
  });
  // 다른 창이 위에 떠 있으면 그쪽이 Esc 를 가져간다(모달 스택 규칙).
  document.addEventListener("keydown", function esc(e) {
    if (!openOverlay) {
      document.removeEventListener("keydown", esc);
      return;
    }
    if (e.key === "Escape" && isTopModal(overlay)) closePalette();
  });

  const root = document.getElementById("modal-root") ?? document.body;
  root.appendChild(overlay);
  pushModal(overlay);
  openOverlay = overlay;

  rows = filtered("");
  cursor = 0;
  draw();
  setTimeout(() => input.focus(), 0);
}
