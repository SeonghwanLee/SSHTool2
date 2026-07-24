// 세션 편집기 — 연결 / 분류 / 자동화 섹션. WPF 세션 편집 창(0.4.1 구성) 대응.
// 필수값은 이름·호스트·포트만(사용자 이름은 비워도 저장 가능 — 접속 시 입력받음).

import { openModal, field } from "./dialogs";
import type { SessionInfo, TriggerRule, Charset, SessionKind, AuthType } from "./types";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { applyIcon } from "./icons";

const CHARSETS: Charset[] = [
  "UTF-8",
  "EUC-KR",
  "CP949",
  "ISO-8859-1",
  "Shift_JIS",
  "GBK",
  "US-ASCII",
];

export function sessionDialog(initial: SessionInfo, titleText: string): Promise<SessionInfo | null> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("form");
        card.className = "session-card";

        const title = document.createElement("h3");
        title.textContent = titleText;

        // ── 종류(SSH 원격 / 로컬 셸) ──
        const kind = document.createElement("select");
        kind.className = "sel-input";
        for (const [val, label] of [
          ["ssh", "SSH 원격 접속"],
          ["local", "로컬 셸 (서버 없이 실행)"],
        ] as [SessionKind, string][]) {
          const o = document.createElement("option");
          o.value = val;
          o.textContent = label;
          if (val === initial.kind) o.selected = true;
          kind.appendChild(o);
        }

        const shellExe = textInput(initial.shellExe, "실행 파일 (비우면 기본 셸: cmd/pwsh)");
        const workingDir = textInput(initial.workingDir, "시작 폴더 (선택)");

        // ── 연결 ──
        const name = textInput(initial.name, "표시 이름");
        const host = textInput(initial.host, "호스트 / IP");
        const port = textInput(String(initial.port || 22), "22");
        port.inputMode = "numeric";
        const user = textInput(initial.user, "사용자 (비워두면 접속 시 입력)");

        // ── 인증 방식 ──
        const auth = document.createElement("select");
        auth.className = "sel-input";
        for (const [val, label] of [
          ["password", "비밀번호"],
          ["key", "개인키"],
        ] as [AuthType, string][]) {
          const o = document.createElement("option");
          o.value = val;
          o.textContent = label;
          if (val === initial.authType) o.selected = true;
          auth.appendChild(o);
        }
        const keyPath = textInput(initial.privateKeyPath, "개인키 파일 경로");
        const keyBrowse = document.createElement("button");
        keyBrowse.type = "button";
        keyBrowse.className = "sftp-btn";
        keyBrowse.textContent = "찾기…";
        keyBrowse.addEventListener("click", async () => {
          const picked = await openFileDialog({ multiple: false });
          const path = Array.isArray(picked) ? picked[0] : picked;
          if (path) keyPath.value = path;
        });
        const keyRow = document.createElement("div");
        keyRow.className = "key-row";
        keyRow.append(keyPath, keyBrowse);

        const savePw = document.createElement("input");
        savePw.type = "checkbox";
        savePw.checked = initial.savePassword;
        const saveRow = document.createElement("label");
        saveRow.className = "check-row";
        const saveText = document.createElement("span");
        saveText.textContent = "접속 성공 시 비밀번호/키 암호 저장 (볼트에 암호화)";
        saveRow.append(savePw, saveText);

        // ── 분류 ──
        const folder = textInput(initial.folder, "폴더 (선택, 예: 운영/DB)");

        // ── 자동화 ──
        const charset = document.createElement("select");
        charset.className = "sel-input";
        for (const c of CHARSETS) {
          const o = document.createElement("option");
          o.value = c;
          o.textContent = c;
          if (c === initial.charset) o.selected = true;
          charset.appendChild(o);
        }

        const startup = document.createElement("textarea");
        startup.className = "area-input";
        startup.rows = 3;
        startup.placeholder = "접속 후 자동 실행 (한 줄에 하나)\n예: cd /projects\n예: claude";
        startup.value = initial.startupCommands;

        const forwards = document.createElement("textarea");
        forwards.className = "area-input";
        forwards.rows = 2;
        forwards.placeholder =
          "포트 포워딩 (한 줄에 하나)\n예: L:8080:127.0.0.1:80  (로컬→서버 경유→대상)\n예: R:9000:127.0.0.1:3000  (서버 포트→내 쪽 대상)";
        forwards.value = initial.portForwards;

        const sftpRow = document.createElement("label");
        sftpRow.className = "check-row";
        const sftpBox = document.createElement("input");
        sftpBox.type = "checkbox";
        sftpBox.checked = initial.enableSftp;
        const sftpText = document.createElement("span");
        sftpText.textContent = "SFTP 사용 (끄면 터미널 전용)";
        sftpRow.append(sftpBox, sftpText);

        const logRow = document.createElement("label");
        logRow.className = "check-row";
        const logBox = document.createElement("input");
        logBox.type = "checkbox";
        logBox.checked = initial.enableLog;
        const logText = document.createElement("span");
        logText.textContent = "세션 로그 기록 (설정 폴더의 logs/ 에 저장)";
        logRow.append(logBox, logText);

        const triggers = new TriggerEditor(initial.triggers);

        const err = document.createElement("div");
        err.className = "modal-err";

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => {
          close();
          resolve(null);
        });
        const ok = document.createElement("button");
        ok.type = "submit";
        ok.className = "btn-accent";
        ok.textContent = "저장";
        buttons.append(cancel, ok);

        const charsetField = field("문자셋", charset);
        const forwardsField = field("포트 포워딩", forwards);
        const hostField = field("호스트", host);
        const portField = field("포트", port);
        const userField = field("사용자", user);
        const authField = field("인증", auth);
        const keyField = field("개인키", keyRow);
        const shellField = field("실행 파일", shellExe);
        const dirField = field("시작 폴더", workingDir);

        // 종류에 따라 필요한 입력만 보인다.
        const syncKind = () => {
          const local = kind.value === "local";
          const key = auth.value === "key";
          for (const el of [hostField, portField, userField, saveRow, authField])
            (el as HTMLElement).style.display = local ? "none" : "";
          keyField.style.display = local || !key ? "none" : "";
          for (const el of [shellField, dirField])
            (el as HTMLElement).style.display = local ? "" : "none";
          // 문자셋 변환은 SSH 전용 — 로컬 셸에서는 적용되지 않으므로 숨긴다.
          charsetField.style.display = local ? "none" : "";
          forwardsField.style.display = local ? "none" : "";
          sftpRow.style.display = local ? "none" : "";
        };
        kind.addEventListener("change", syncKind);
        auth.addEventListener("change", syncKind);

        card.append(
          title,
          section("연결"),
          field("종류", kind),
          field("이름", name),
          hostField,
          portField,
          // 사용자 이름과 비밀번호 저장을 연달아 배치(WPF 0.43.2 피드백).
          userField,
          authField,
          keyField,
          saveRow,
          shellField,
          dirField,
          section("분류"),
          field("폴더", folder),
          section("자동화"),
          charsetField,
          field("접속 시 자동 실행", startup),
          forwardsField,
          logRow,
          triggers.render(),
          err,
          buttons,
        );

        card.addEventListener("submit", (e) => {
          e.preventDefault();
          const local = kind.value === "local";
          const h = host.value.trim();
          if (!local && !h) {
            err.textContent = "호스트를 입력하세요.";
            return;
          }
          // 포트는 u16 범위여야 한다 — 벗어나면 저장(직렬화)이 조용히 실패한다.
          const p = local ? 22 : Number(port.value);
          if (!local && (!Number.isInteger(p) || p < 1 || p > 65535)) {
            err.textContent = "포트는 1~65535 사이의 정수여야 합니다.";
            return;
          }
          const fallbackName = local ? shellExe.value.trim() || "로컬 셸" : h;
          const result: SessionInfo = {
            ...initial,
            kind: kind.value as SessionKind,
            shellExe: shellExe.value.trim(),
            workingDir: workingDir.value.trim(),
            name: name.value.trim() || fallbackName,
            host: h,
            port: p,
            user: user.value.trim(),
            authType: auth.value as AuthType,
            privateKeyPath: keyPath.value.trim(),
            folder: folder.value.trim(),
            savePassword: savePw.checked,
            charset: charset.value as Charset,
            startupCommands: startup.value,
            portForwards: forwards.value,
            enableLog: logBox.checked,
            enableSftp: sftpBox.checked,
            triggers: triggers.value(),
          };
          close();
          resolve(result);
        });

        syncKind();
        setTimeout(() => name.focus(), 0);
        return card;
      },
      () => resolve(null),
    );
  });
}

/** 트리거 규칙 목록 편집기(추가/삭제). 평문 저장이라 비밀번호 금지 경고 표시. */
class TriggerEditor {
  private rules: TriggerRule[];
  private readonly list = document.createElement("div");

  constructor(initial: TriggerRule[]) {
    this.rules = initial.map((r) => ({ ...r }));
  }

  render(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "trigger-wrap";

    const head = document.createElement("div");
    head.className = "trigger-head";
    const label = document.createElement("span");
    label.textContent = "자동 입력 규칙 (패턴 감지 → 전송)";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sftp-btn";
    add.textContent = "규칙 추가";
    add.addEventListener("click", () => {
      this.rules = [...this.rules, { pattern: "", send: "", regex: false }];
      this.draw();
    });
    head.append(label, add);

    const warn = document.createElement("div");
    warn.className = "trigger-warn";
    warn.textContent = "⚠ 규칙 값은 암호화되지 않습니다 — 비밀번호를 넣지 마세요.";

    this.list.className = "trigger-list";
    this.draw();
    wrap.append(head, warn, this.list);
    return wrap;
  }

  private draw(): void {
    this.list.innerHTML = "";
    this.rules.forEach((rule, i) => {
      const row = document.createElement("div");
      row.className = "trigger-row";

      const pattern = textInput(rule.pattern, "감지할 패턴");
      pattern.addEventListener("input", () => (this.rules[i].pattern = pattern.value));

      const send = textInput(rule.send, "전송할 값 (\\n 은 개행)");
      send.addEventListener("input", () => (this.rules[i].send = send.value));

      const rx = document.createElement("input");
      rx.type = "checkbox";
      rx.checked = rule.regex;
      rx.title = "정규식으로 해석";
      rx.addEventListener("change", () => (this.rules[i].regex = rx.checked));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tree-act";
      applyIcon(del, "delete");
      del.title = "규칙 삭제";
      del.addEventListener("click", () => {
        this.rules = this.rules.filter((_, k) => k !== i);
        this.draw();
      });

      row.append(pattern, send, rx, del);
      this.list.appendChild(row);
    });
  }

  value(): TriggerRule[] {
    return this.rules.filter((r) => r.pattern.trim() !== "");
  }
}

function textInput(value: string, placeholder: string): HTMLInputElement {
  const el = document.createElement("input");
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

function section(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "settings-section";
  el.textContent = text;
  return el;
}
