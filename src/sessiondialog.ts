// 세션 편집기 — 연결 / 분류 / 자동화 섹션. WPF 세션 편집 창(0.4.1 구성) 대응.
// 필수값은 이름·호스트·포트만(사용자 이름은 비워도 저장 가능 — 접속 시 입력받음).

import { openModal, field, numInput, clampNum } from "./dialogs";
import type { SessionInfo, TriggerRule, Charset, SessionKind, AuthType, ServiceLink, SessionColor } from "./types";
import { SESSION_COLORS, sessionColorCss } from "./types";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { applyIcon } from "./icons";
import { helpIcon } from "./help";

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
        card.setAttribute("autocomplete", "off"); // WebView2 자동완성 목록(흰색) 차단

        const title = document.createElement("h3");
        title.textContent = titleText;

        // ── 종류(SSH 원격 / 로컬 셸 / 원격 데스크톱) ──
        // 드롭다운은 폭이 좁아 긴 라벨이 잘렸다 — 한 줄 라디오로 세 종류를 모두 보인다.
        // 라디오는 change 가 컨테이너로 버블링되므로 기존 change 배선이 그대로 통한다.
        const kind = document.createElement("div");
        kind.className = "kind-radios";
        const KINDS: [SessionKind, string][] = [
          ["ssh", "SSH 원격"],
          ["local", "로컬 셸"],
          ["rdp", "원격 데스크톱"],
        ];
        // 저장된 값이 없거나 알 수 없는 값이면 SSH 가 기본(새 세션의 기본값).
        const initialKind = KINDS.some(([v]) => v === initial.kind) ? initial.kind : "ssh";
        for (const [val, label] of KINDS) {
          const lab = document.createElement("label");
          lab.className = "kind-radio";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "session-kind";
          radio.value = val;
          radio.checked = val === initialKind;
          const icon = document.createElement("span");
          icon.className = "kind-radio-icon";
          applyIcon(icon, val === "local" ? "local" : val === "rdp" ? "rdp" : "remote");
          const text = document.createElement("span");
          text.textContent = label;
          lab.append(radio, icon, text);
          kind.appendChild(lab);
        }
        /** 지금 선택된 종류. 라디오 그룹에는 select 처럼 value 가 없어 헬퍼로 읽는다. */
        const kindValue = (): SessionKind =>
          (kind.querySelector<HTMLInputElement>("input:checked")?.value ?? "ssh") as SessionKind;

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

        // ── 색 태그(0.67.0) — 목록·탭에 띠로 표시해 운영/개발을 눈으로 가른다 ──
        const colorSel = document.createElement("select");
        colorSel.className = "sel-input";
        for (const c of SESSION_COLORS) {
          const o = document.createElement("option");
          o.value = c.id;
          o.textContent = c.label;
          if (c.id === (initial.color ?? "")) o.selected = true;
          colorSel.appendChild(o);
        }
        const colorSwatch = document.createElement("span");
        colorSwatch.className = "color-swatch";
        const paintSwatch = (): void => {
          const css = sessionColorCss(colorSel.value);
          colorSwatch.style.background = css || "transparent";
          colorSwatch.style.borderColor = css ? css : "var(--border)";
        };
        paintSwatch();
        colorSel.addEventListener("change", paintSwatch);
        const colorWrap = document.createElement("div");
        colorWrap.className = "color-row";
        colorWrap.append(colorSel, colorSwatch);

        // ── 자동 재접속(0.67.0) ──
        const autoRow = document.createElement("label");
        autoRow.className = "check-row";
        const autoBox = document.createElement("input");
        autoBox.type = "checkbox";
        autoBox.checked = initial.autoReconnect ?? false;
        const autoText = document.createElement("span");
        autoText.textContent = "연결이 끊기면 자동으로 다시 접속";
        autoRow.append(autoBox, autoText);
        autoRow.title =
          "예기치 않게 끊겼을 때만 시도합니다 — 사용자가 직접 끊거나 탭을 닫은 경우는 제외.\n" +
          "저장된 비밀번호가 없으면 입력 창이 뜨므로 자동 재접속이 멈춥니다.";
        const autoDelay = numInput(String(initial.autoReconnectDelaySec ?? 5), 1, 300, 1);
        const autoMax = numInput(String(initial.autoReconnectMax ?? 3), 1, 99, 1);
        const autoDelayField = field("재시도 간격(초)", autoDelay);
        const autoMaxField = field("최대 시도 횟수", autoMax);
        const syncAuto = (): void => {
          const on = autoBox.checked;
          autoDelayField.style.display = on ? "" : "none";
          autoMaxField.style.display = on ? "" : "none";
        };
        autoBox.addEventListener("change", syncAuto);
        syncAuto();

        const triggers = new TriggerEditor(initial.triggers);
        const services = new ServiceEditor(initial.services);

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
          const local = kindValue() === "local";
          // RDP 는 mstsc 가 화면·입력을 맡는다 — 터미널/SSH 전용 설정은 의미가 없다.
          const rdp = kindValue() === "rdp";
          const key = auth.value === "key";
          for (const el of [hostField, portField, userField])
            (el as HTMLElement).style.display = local ? "none" : "";
          // 인증·비밀번호 저장은 앱이 직접 인증하는 SSH 에서만 쓴다(RDP 는 mstsc 가 묻는다).
          for (const el of [saveRow, authField])
            (el as HTMLElement).style.display = local || rdp ? "none" : "";
          keyField.style.display = local || rdp || !key ? "none" : "";
          for (const el of [shellField, dirField])
            (el as HTMLElement).style.display = local ? "" : "none";
          // 문자셋 변환은 SSH 전용 — 로컬 셸에서는 적용되지 않으므로 숨긴다.
          charsetField.style.display = local || rdp ? "none" : "";
          forwardsField.style.display = local || rdp ? "none" : "";
          sftpRow.style.display = local || rdp ? "none" : "";
        };
        kind.addEventListener("change", () => {
          // 종류를 바꿨는데 포트가 이전 기본값 그대로면 새 기본값으로 맞춘다.
          // 사용자가 직접 넣은 값은 건드리지 않는다.
          const DEFAULTS: Record<string, string> = { ssh: "22", rdp: "3389" };
          const cur = port.value.trim();
          if (Object.values(DEFAULTS).includes(cur) || cur === "") {
            port.value = DEFAULTS[kindValue()] ?? cur;
          }
          syncKind();
        });
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
          field("색 태그", colorWrap),
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
          autoRow,
          autoDelayField,
          autoMaxField,
        );
        addTab("trig", "트리거", triggers.render());
        addTab("svc", "서비스", services.render());

        // datalist 는 화면에 그려지지 않지만 문서 안에 있어야 input[list] 가 인식한다.
        card.append(title, tabbar, body, err, buttons, folderList);
        selectTab("conn");

        // 로컬 셸은 인증 개념이 없어 "인증" 탭을 숨긴다(빈 탭 방지).
        const syncAuthTab = () => {
          const local = kindValue() === "local";
          const btn = tabButtons.get("auth")!;
          btn.style.display = local ? "none" : "";
          // 서비스는 세션 호스트에 접속하므로 호스트가 없는 로컬 셸에는 의미가 없다.
          const svcBtn = tabButtons.get("svc")!;
          svcBtn.style.display = local ? "none" : "";
          if (local && (btn.classList.contains("active") || svcBtn.classList.contains("active")))
            selectTab("conn");
        };
        kind.addEventListener("change", syncAuthTab);
        syncAuthTab();

        card.addEventListener("submit", (e) => {
          e.preventDefault();
          const local = kindValue() === "local";
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
            kind: kindValue(),
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
            color: colorSel.value as SessionColor,
            autoReconnect: autoBox.checked,
            autoReconnectDelaySec: clampNum(autoDelay, 1, 300, 5),
            autoReconnectMax: clampNum(autoMax, 1, 99, 3),
            enableSftp: sftpBox.checked,
            allowLegacyAlgorithms: legacyBox.checked,
            triggers: triggers.value(),
            services: services.value(),
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
    // 긴 설명은 전구 뒤로. 위험의 핵심 한 줄(아래 warn)은 화면에 남긴다 —
    // 위험은 읽을 기회가 있어야 경고다.
    const help = helpIcon(
      "트리거는 서버가 보낸 출력에 반응해 값을 자동으로 전송합니다.\n" +
        "서버를 장악한 쪽이 패턴 문자열을 아무 때나 출력하면 그 값을 그대로 받아낼 수 있습니다. " +
        "색상 코드로 위장한 출력도 감지되고, 1초 간격으로 반복해서 끌어낼 수 있습니다.\n" +
        "규칙은 접속 후 10초 안에만 발동합니다 — 그 뒤에 같은 패턴이 나와도 전송하지 않습니다.\n" +
        "'비밀'을 체크하면 값이 세션 파일 대신 볼트에 저장되지만, 그것은 디스크에 남는 것만 " +
        "가립니다 — 자동 전송 위험은 그대로입니다.",
      "트리거 안내",
    );
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sftp-btn";
    add.textContent = "규칙 추가";
    add.addEventListener("click", () => {
      this.rules = [...this.rules, { pattern: "", send: "", regex: false, secret: false }];
      this.draw();
    });
    head.append(label, help, add);

    // 자동 전송의 위험은 '저장 위치'가 아니라 '발동 조건'에 있다 — 핵심만 한 줄 남긴다.
    const warn = document.createElement("div");
    warn.className = "trigger-warn";
    warn.textContent =
      "⚠ 서버 출력에 반응해 값을 자동 전송합니다 — 비밀번호·sudo 암호는 넣지 마세요.";

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

/** 웹 서비스 목록 편집기 — 트리거 편집기와 같은 행 추가/삭제 패턴. */
class ServiceEditor {
  private items: ServiceLink[];
  private readonly list = document.createElement("div");

  constructor(initial: ServiceLink[] | undefined) {
    this.items = (initial ?? []).map((x) => ({ ...x }));
  }

  render(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "trigger-wrap";

    const head = document.createElement("div");
    head.className = "trigger-head";
    const label = document.createElement("span");
    label.textContent = "웹 서비스 (우클릭 '서비스 연결' 메뉴에 표시)";
    const help = helpIcon(
      "호스트는 이 세션의 호스트를 그대로 씁니다 — 서버 주소가 바뀌면 세션만 고치면 됩니다.\n" +
        "경로는 '/admin?tab=1' 처럼 URL 뒷부분이며 비워도 됩니다.\n" +
        "http/https 주소만 열 수 있고, 브라우저는 목록(기본/Chrome/Edge)에서만 실행됩니다.",
      "웹 서비스 안내",
    );
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sftp-btn";
    add.textContent = "서비스 추가";
    add.addEventListener("click", () => {
      this.items = [...this.items, { name: "", scheme: "http", port: 8080, path: "", browser: "default" }];
      this.draw();
    });
    head.append(label, help, add);

    const cols = document.createElement("div");
    cols.className = "trigger-cols svc-cols";
    for (const t of ["이름", "프로토콜", "포트", "경로 (선택)", "브라우저", ""]) {
      const c = document.createElement("span");
      c.textContent = t;
      cols.appendChild(c);
    }

    this.list.className = "trigger-list";
    this.draw();
    wrap.append(head, cols, this.list);
    return wrap;
  }

  private draw(): void {
    this.list.innerHTML = "";
    this.items.forEach((svc, i) => {
      const row = document.createElement("div");
      row.className = "trigger-row svc-row";

      const name = textInput(svc.name, "예: 관리콘솔");
      name.addEventListener("input", () => (this.items[i].name = name.value));

      const scheme = document.createElement("select");
      scheme.className = "sel-input";
      for (const v of ["http", "https"] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        if (v === svc.scheme) o.selected = true;
        scheme.appendChild(o);
      }
      scheme.addEventListener("change", () => (this.items[i].scheme = scheme.value as ServiceLink["scheme"]));

      const port = document.createElement("input");
      port.type = "number";
      port.min = "1";
      port.max = "65535";
      port.value = String(svc.port);
      port.addEventListener("input", () => (this.items[i].port = Number(port.value)));

      const path = textInput(svc.path, "/admin (선택)");
      path.addEventListener("input", () => (this.items[i].path = path.value));

      const browser = document.createElement("select");
      browser.className = "sel-input";
      for (const [v, l] of [
        ["default", "기본 브라우저"],
        ["chrome", "Chrome"],
        ["edge", "Edge"],
      ] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        if (v === svc.browser) o.selected = true;
        browser.appendChild(o);
      }
      browser.addEventListener("change", () => (this.items[i].browser = browser.value as ServiceLink["browser"]));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tree-act";
      applyIcon(del, "delete");
      del.title = "서비스 삭제";
      del.addEventListener("click", () => {
        this.items = this.items.filter((_, k) => k !== i);
        this.draw();
      });

      row.append(name, scheme, port, path, browser, del);
      this.list.appendChild(row);
    });
  }

  value(): ServiceLink[] {
    // 이름이 빈 행은 버린다 — 이름 없는 메뉴 항목은 무엇인지 알 수 없고,
    // '추가'만 누르고 만 빈 행이 저장되는 것이 더 흔한 실수다.
    return this.items.filter(
      (x) => x.name.trim() !== "" && Number.isInteger(x.port) && x.port >= 1 && x.port <= 65535,
    );
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
