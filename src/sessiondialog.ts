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

/**
 * 세션 편집 창.
 *
 * `folders` 는 지금 존재하는 폴더 경로 목록 — 폴더 칸에서 목록으로 고르거나, 고른 뒤
 * `기존폴더/새이름` 처럼 이어 적어 하위 폴더를 새로 만들 수 있게 한다. 직접 타이핑도
 * 그대로 되므로(자유 입력 유지) 기존 사용 방식이 막히지 않는다.
 */
export function sessionDialog(
  initial: SessionInfo,
  titleText: string,
  folders: string[] = [],
): Promise<SessionInfo | null> {
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
        // datalist 로 기존 폴더를 제안한다. select 로 막지 않는 이유 —
        // 새 폴더를 만들려면 목록에 없는 값을 칠 수 있어야 하기 때문이다.
        const folderList = document.createElement("datalist");
        folderList.id = `folder-list-${crypto.randomUUID()}`;
        folder.setAttribute("list", folderList.id);
        // 고른 뒤 이어 적기 쉽도록 '기존폴더/' 형태도 함께 제안한다.
        const suggestions = [...new Set(folders.flatMap((f) => [f, `${f}/`]))].sort((a, b) =>
          a.localeCompare(b, "ko"),
        );
        for (const f of suggestions) {
          const o = document.createElement("option");
          o.value = f;
          folderList.appendChild(o);
        }
        folder.title =
          folders.length > 0
            ? "목록에서 고르거나 직접 입력. '기존폴더/새이름' 으로 하위 폴더를 새로 만들 수 있습니다."
            : "예: 운영/DB — '/' 로 하위 폴더를 만듭니다.";

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

        // 시작 명령도 트리거와 같은 기준 — 체크한 세션만 볼트로 보낸다.
        // (무조건 볼트로 보내면 `cd /projects` 만 쓰는 세션도 접속마다 볼트 해제를 요구하게 된다.)
        const startupSecretRow = document.createElement("label");
        startupSecretRow.className = "check-row";
        const startupSecretBox = document.createElement("input");
        startupSecretBox.type = "checkbox";
        startupSecretBox.checked = initial.startupCommandsSecret;
        const startupSecretText = document.createElement("span");
        startupSecretText.textContent = "시작 명령에 비밀 값 포함 (볼트에 저장)";
        startupSecretRow.title =
          "체크하면 위 명령을 세션 파일 대신 볼트에 저장합니다. 접속할 때 볼트 해제가 필요합니다.";
        startupSecretRow.append(startupSecretBox, startupSecretText);

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

        // 구형 서버 호환 — 기본은 꺼 둔다. 켜면 약한 알고리즘이 협상 목록 맨 뒤에 붙어,
        // 그것밖에 없는 서버에서만 실제로 쓰인다(최신 서버 접속은 그대로).
        const legacyRow = document.createElement("label");
        legacyRow.className = "check-row";
        const legacyBox = document.createElement("input");
        legacyBox.type = "checkbox";
        legacyBox.checked = initial.allowLegacyAlgorithms;
        const legacyText = document.createElement("span");
        legacyText.textContent = "구형 서버 호환 (레거시 알고리즘 허용)";
        legacyRow.title =
          "CentOS 5·OpenSSH 4.x 등 오래된 서버는 SHA-1 키교환·MAC 과 CBC 암호만 제공합니다.\n" +
          "이들은 오늘날 안전하지 않아 기본적으로 사용하지 않습니다.\n" +
          "이 옵션은 해당 알고리즘을 후순위로만 추가하므로, 최신 서버와의 접속에는 영향이 없습니다.";
        legacyRow.append(legacyBox, legacyText);

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

        // ── 표준 가로 탭(연결/인증/자동화/트리거) ──
        const tabbar = document.createElement("div");
        tabbar.className = "settings-tabs";
        const body = document.createElement("div");
        body.className = "settings-body";
        const panels = new Map<string, HTMLElement>();
        const tabButtons = new Map<string, HTMLElement>();
        const selectTab = (id: string) => {
          for (const [k, el] of panels) el.style.display = k === id ? "" : "none";
          for (const [k, el] of tabButtons) el.classList.toggle("active", k === id);
        };
        const addTab = (id: string, label: string, ...children: HTMLElement[]): void => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "settings-tab";
          btn.textContent = label;
          btn.addEventListener("click", () => selectTab(id));
          tabbar.appendChild(btn);
          tabButtons.set(id, btn);
          const panel = document.createElement("div");
          panel.className = "settings-panel";
          panel.append(...children);
          body.appendChild(panel);
          panels.set(id, panel);
        };

        addTab(
          "conn",
          "연결",
          field("종류", kind),
          field("이름", name),
          hostField,
          portField,
          userField,
          shellField,
          dirField,
          field("폴더", folder),
        );
        addTab("auth", "인증", authField, keyField, saveRow, legacyRow);
        addTab(
          "auto",
          "자동화",
          charsetField,
          field("접속 시 자동 실행", startup),
          startupSecretRow,
          forwardsField,
          sftpRow,
          logRow,
        );
        addTab("trig", "트리거", triggers.render());

        // datalist 는 화면에 그려지지 않지만 문서 안에 있어야 input[list] 가 인식한다.
        card.append(title, tabbar, body, err, buttons, folderList);
        selectTab("conn");

        // 로컬 셸은 인증 개념이 없어 "인증" 탭을 숨긴다(빈 탭 방지).
        const syncAuthTab = () => {
          const local = kind.value === "local";
          const btn = tabButtons.get("auth")!;
          btn.style.display = local ? "none" : "";
          if (local && btn.classList.contains("active")) selectTab("conn");
        };
        kind.addEventListener("change", syncAuthTab);
        syncAuthTab();

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
            startupCommandsSecret: startupSecretBox.checked,
            portForwards: forwards.value,
            enableLog: logBox.checked,
            enableSftp: sftpBox.checked,
            allowLegacyAlgorithms: legacyBox.checked,
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
      this.rules = [...this.rules, { pattern: "", send: "", regex: false, secret: false }];
      this.draw();
    });
    head.append(label, add);

    // 자동 전송의 위험은 '저장 위치'가 아니라 '발동 조건'에 있다. 규칙을 어디에
    // 보관하든, 전송을 촉발하는 것은 **서버가 보낸 출력**이라는 점을 분명히 적는다.
    const warn = document.createElement("div");
    warn.className = "trigger-warn";
    warn.textContent =
      "⚠ 트리거는 서버가 보낸 출력에 반응해 값을 자동으로 전송합니다.\n" +
      "서버를 장악한 쪽이 패턴 문자열을 아무 때나 출력하면 그 값을 그대로 받아낼 수 있습니다. " +
      "색상 코드로 위장한 출력도 감지되고, 1초 간격으로 반복해서 끌어낼 수 있습니다.\n" +
      "규칙은 접속 후 10초 안에만 발동합니다 — 그 뒤에 같은 패턴이 나와도 전송하지 않습니다.\n" +
      "비밀번호·sudo 암호는 넣지 마세요.\n" +
      "'비밀' 을 체크하면 값이 세션 파일 대신 볼트에 저장되지만, 그것은 디스크에 남는 것만 " +
      "가립니다 — 위의 자동 전송 위험은 그대로입니다.";

    // 체크박스 두 개가 무엇인지 알 수 있도록 열 머리글을 붙인다.
    const cols = document.createElement("div");
    cols.className = "trigger-cols";
    for (const t of ["감지할 패턴", "전송할 값", "정규식", "비밀", ""]) {
      const c = document.createElement("span");
      c.textContent = t;
      cols.appendChild(c);
    }

    this.list.className = "trigger-list";
    this.draw();
    wrap.append(head, warn, cols, this.list);
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

      // 체크한 규칙의 값만 볼트로 간다. y/q 같은 무해한 규칙까지 볼트를 요구하지 않기 위해
      // 옵트인으로 둔다(끄면 값은 세션 파일에 평문으로 남는다).
      const sec = document.createElement("input");
      sec.type = "checkbox";
      sec.checked = rule.secret;
      sec.title = "비밀 값 — 세션 파일 대신 볼트에 저장(볼트 마스터 필요)";
      sec.classList.add("trigger-secret");
      sec.addEventListener("change", () => (this.rules[i].secret = sec.checked));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tree-act";
      applyIcon(del, "delete");
      del.title = "규칙 삭제";
      del.addEventListener("click", () => {
        this.rules = this.rules.filter((_, k) => k !== i);
        this.draw();
      });

      row.append(pattern, send, rx, sec, del);
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
