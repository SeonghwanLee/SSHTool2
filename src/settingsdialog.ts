// 설정 다이얼로그 — 기능별 탭(모양/터미널/보안/일반)으로 분류.
//
// 저장 정책(사용자 요청): 변경은 **라이브 미리보기**로 즉시 화면에 반영하되,
// 실제 저장은 **"저장" 버튼**을 눌러야만 한다. 취소/Esc/바깥클릭은 미리보기를 원래대로
// 되돌리고 저장하지 않는다.
// 단, 아래 항목은 이 규칙과 무관하게 **즉시 실행/저장**된다(설정 스냅샷이 아니라 별도 동작):
//   · 마스터 비밀번호 변경  · OS 키체인 자동해제 토글  · 알려진 호스트 관리
//   · 설정 내보내기/가져오기 · 완전 초기화  (각자 확인창이 있음)

import type { Settings, CursorStyle } from "./settings";
import { FONTS } from "./settings";
import { THEMES } from "./themes";
import { knownHostsDialog } from "./knownhosts";
import { save as saveDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { backupExport, backupImport, factoryReset } from "./ipc";
import { alertDialog, confirmDialog, pushModal, popModal, isTopModal } from "./dialogs";

export interface SettingsResult {
  /** true 면 저장, false 면 취소(미리보기 되돌림). */
  saved: boolean;
  settings: Settings;
}

export function settingsDialog(
  current: Settings,
  onLive: (s: Settings) => void,
  onChangeMaster: () => void,
  autoUnlock: { initial: boolean; toggle: (enable: boolean) => Promise<boolean> },
): Promise<SettingsResult> {
  return new Promise((resolve) => {
    const original: Settings = { ...current };
    let working: Settings = { ...current };
    const apply = () => onLive(working);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card settings-card";
    overlay.appendChild(card);

    const finish = (saved: boolean) => {
      popModal(overlay);
      overlay.remove();
      document.removeEventListener("keydown", onEsc);
      resolve({ saved, settings: saved ? working : original });
    };
    const save = () => finish(true);
    const cancel = () => {
      onLive(original); // 라이브 미리보기 되돌림
      finish(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopModal(overlay)) cancel();
    };
    document.addEventListener("keydown", onEsc);
    pushModal(overlay);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) cancel();
    });

    const title = document.createElement("h3");
    title.textContent = "설정";
    card.appendChild(title);

    // ── 탭 골격(세로 측면 탭 — 카테고리 다수라 본문을 넓게) ──
    const main = document.createElement("div");
    main.className = "settings-main";
    const tabbar = document.createElement("div");
    tabbar.className = "settings-tabs vertical";
    const body = document.createElement("div");
    body.className = "settings-body";
    main.append(tabbar, body);
    card.appendChild(main);

    const panels = new Map<string, HTMLElement>();
    const tabButtons = new Map<string, HTMLElement>();
    let activeTab = "";
    const selectTab = (id: string) => {
      activeTab = id;
      for (const [k, el] of panels) el.style.display = k === id ? "" : "none";
      for (const [k, el] of tabButtons) el.classList.toggle("active", k === id);
    };
    const addTab = (id: string, label: string): HTMLElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-tab";
      btn.textContent = label;
      btn.addEventListener("click", () => selectTab(id));
      tabbar.appendChild(btn);
      tabButtons.set(id, btn);
      const panel = document.createElement("div");
      panel.className = "settings-panel";
      body.appendChild(panel);
      panels.set(id, panel);
      return panel;
    };

    // ══════════ 탭: 모양 ══════════
    const look = addTab("look", "모양");

    look.appendChild(sectionLabel("테마"));
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
    look.appendChild(themeGrid);

    look.appendChild(sectionLabel("터미널 글꼴"));
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
    look.appendChild(fontList);

    // ══════════ 탭: 터미널 ══════════
    const term = addTab("term", "터미널");

    const sizeRow = controlRow("글꼴 크기 (전역 기본)");
    const size = numInput(String(working.fontSize), 9, 28, 1);
    size.addEventListener("change", () => {
      const v = clampNum(size, 9, 28, 14);
      working = { ...working, fontSize: v };
      apply();
    });
    sizeRow.appendChild(size);
    term.appendChild(sizeRow);

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
    term.appendChild(cursorRow);

    term.appendChild(
      checkRow("커서 깜박임", working.cursorBlink, (v) => {
        working = { ...working, cursorBlink: v };
        apply();
      }),
    );
    term.appendChild(
      checkRow("선택 시 자동 복사 (copy-on-select)", working.copyOnSelect, (v) => {
        working = { ...working, copyOnSelect: v };
        apply();
      }),
    );

    const scrollRow = controlRow("스크롤백 (줄)");
    const scroll = numInput(String(working.scrollback), 500, 100000, 500);
    scroll.addEventListener("change", () => {
      const v = clampNum(scroll, 500, 100000, 5000);
      working = { ...working, scrollback: v };
      apply();
    });
    scrollRow.appendChild(scroll);
    term.appendChild(scrollRow);

    term.appendChild(sectionLabel("세션 목록"));
    term.appendChild(
      checkRow("최근 접속순으로 정렬", working.sortByRecent, (v) => {
        working = { ...working, sortByRecent: v };
        apply();
      }),
    );
    term.appendChild(
      checkRow("세션 세부 정보 표시 (user@host:port)", working.showSessionDetail, (v) => {
        working = { ...working, showSessionDetail: v };
        apply();
      }),
    );

    const recentRow = controlRow("최근 접속 표시 개수 (0=숨김)");
    const recent = numInput(String(working.recentLimit), 0, 50, 1);
    recent.addEventListener("change", () => {
      const v = clampNum(recent, 0, 50, 10);
      working = { ...working, recentLimit: v };
      apply();
    });
    recentRow.appendChild(recent);
    term.appendChild(recentRow);

    // ══════════ 탭: 보안 ══════════
    const sec = addTab("sec", "보안");

    const lockRow = controlRow("무활동 자동 잠금 (분, 0=화면보호기)");
    const lockInput = numInput(String(working.autoLockMinutes), 0, 720, 1);
    lockInput.addEventListener("change", () => {
      const v = clampNum(lockInput, 0, 720, 0);
      working = { ...working, autoLockMinutes: v };
      apply();
    });
    lockRow.appendChild(lockInput);
    sec.appendChild(lockRow);
    const lockHint = document.createElement("div");
    lockHint.className = "settings-hint";
    lockHint.textContent =
      "1분 이상이면 그 시간 무활동 시 볼트를 잠급니다. 0이면 잠그지 않고, 5분 무활동 시 화면보호기(움직이는 애니메이션)를 띄웁니다.";
    sec.appendChild(lockHint);

    const autoRow = document.createElement("label");
    autoRow.className = "check-row control-row";
    const autoBox = document.createElement("input");
    autoBox.type = "checkbox";
    autoBox.checked = autoUnlock.initial;
    const autoText = document.createElement("span");
    autoText.textContent = "이 PC에서 자동 잠금 해제 (OS 키체인, 다른 PC에서는 안 됨)";
    autoRow.append(autoText, autoBox);
    autoBox.addEventListener("change", async () => {
      autoBox.disabled = true;
      autoBox.checked = await autoUnlock.toggle(autoBox.checked);
      autoBox.disabled = false;
    });
    sec.appendChild(autoRow);

    const masterRow = controlRow("마스터 비밀번호");
    masterRow.appendChild(mkSmallButton("변경…", () => onChangeMaster()));
    sec.appendChild(masterRow);

    const hostRow = controlRow("알려진 호스트(서버 지문)");
    hostRow.appendChild(mkSmallButton("관리…", () => void knownHostsDialog()));
    sec.appendChild(hostRow);

    // ══════════ 탭: 일반 ══════════
    const gen = addTab("gen", "일반");

    gen.appendChild(
      checkRow("시작 시 업데이트 확인 (내부망이면 꺼두세요)", working.checkUpdateOnStartup, (v) => {
        working = { ...working, checkUpdateOnStartup: v };
        apply();
      }),
    );

    gen.appendChild(sectionLabel("데이터"));

    const exportRow = controlRow("설정 내보내기 (PC 이전용)");
    exportRow.appendChild(
      mkSmallButton("내보내기…", async () => {
        const target = await saveDialog({ defaultPath: "sshtool2-backup.json" });
        if (!target) return;
        try {
          const n = await backupExport(target);
          await alertDialog(`${n}개 파일을 내보냈습니다.\n비밀번호는 암호화된 상태로 담겼습니다.`);
        } catch (e) {
          await alertDialog(`내보내기 실패: ${String(e)}`);
        }
      }),
    );
    gen.appendChild(exportRow);

    const importRow = controlRow("설정 가져오기");
    importRow.appendChild(
      mkSmallButton("가져오기…", async () => {
        const picked = await openFileDialog({ multiple: false });
        const source = Array.isArray(picked) ? picked[0] : picked;
        if (!source) return;
        const ok = await confirmDialog(
          "현재 설정을 덮어씁니다. 기존 설정은 import_backup 폴더에 보관됩니다. 계속할까요?",
        );
        if (!ok) return;
        try {
          const n = await backupImport(source);
          await alertDialog(`${n}개 파일을 복원했습니다. 앱을 다시 시작합니다.`);
          await relaunch();
        } catch (e) {
          await alertDialog(`가져오기 실패: ${String(e)}`);
        }
      }),
    );
    gen.appendChild(importRow);

    const resetRow = controlRow("완전 초기화");
    const resetBtn = mkSmallButton("초기화…", async () => {
      const first = await confirmDialog(
        "세션·볼트·설정·로그를 모두 삭제하고 첫 설치 상태로 되돌립니다. 계속할까요?",
      );
      if (!first) return;
      const second = await confirmDialog("되돌릴 수 없습니다. 정말 삭제할까요?");
      if (!second) return;
      try {
        await factoryReset();
        await alertDialog("초기화했습니다. 앱을 다시 시작합니다.");
        await relaunch();
      } catch (e) {
        await alertDialog(`초기화 실패: ${String(e)}`);
      }
    });
    resetBtn.classList.add("danger-btn");
    resetRow.appendChild(resetBtn);
    gen.appendChild(resetRow);

    // ── 하단: 취소 / 저장 ──
    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "취소";
    cancelBtn.addEventListener("click", cancel);
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn-accent";
    okBtn.textContent = "저장";
    okBtn.addEventListener("click", save);
    buttons.append(cancelBtn, okBtn);
    card.appendChild(buttons);

    selectTab("look");
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

function numInput(value: string, min: number, max: number, step: number): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "number";
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  el.value = value;
  el.className = "num-input";
  return el;
}

function clampNum(el: HTMLInputElement, min: number, max: number, fallback: number): number {
  const v = Math.min(max, Math.max(min, Number(el.value) || fallback));
  el.value = String(v);
  return v;
}

function mkSmallButton(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sftp-btn";
  b.textContent = label;
  b.addEventListener("click", () => void onClick());
  return b;
}

function badge(text: string, cls: string): HTMLElement {
  const b = document.createElement("span");
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}
