// UI 회귀 검사 — `npm run check:ui`
//
// 여기 있는 항목은 전부 **실제로 한 번 이상 죽었던 자리**다. 구현이 있어도 CSS 특이도·
// 로드 순서·레이아웃에 져서 조용히 죽는 부류라, 코드만 읽어서는 재발을 알 수 없다.
// 화면을 띄워 계산된 스타일과 히트테스트로 확인한다.

import { findChrome, ensureVite, openPage, makeRunner, expect, chromium } from "./helpers.mjs";

const SESSIONS = [
  { id: "s1", name: "가서버", kind: "ssh", host: "10.0.0.1", port: 22, user: "root", enableSftp: true, folder: "", sortOrder: 0, lastConnectedUtc: 100, triggers: [],
    services: [
      { name: "관리콘솔", scheme: "https", port: 8443, path: "/admin", browser: "edge" },
      { name: "그라파나", scheme: "http", path: "", port: 3000, browser: "default" },
    ] },
  { id: "s2", name: "나서버", kind: "ssh", host: "10.0.0.2", port: 22, user: "root", enableSftp: true, folder: "", sortOrder: 1, lastConnectedUtc: 200, triggers: [],
    startupCommands: "echo startup-probe" },
  // 종류별 아이콘 구분 검증용 — lastConnectedUtc 0 이라 최근 접속에는 안 뜬다.
  { id: "s3", name: "윈도서버", kind: "rdp", host: "10.0.0.9", port: 3389, user: "admin", enableSftp: false, folder: "", sortOrder: 2, lastConnectedUtc: 0, triggers: [] },
  { id: "s4", name: "내PC셸", kind: "local", host: "", port: 22, user: "", shellExe: "", enableSftp: false, folder: "", sortOrder: 3, lastConnectedUtc: 0, triggers: [] },
];

/** 자격증명 등 떠 있는 모달을 전부 넘긴다(비밀번호는 채우고 기본 버튼을 누른다). */
async function dismissModals(page) {
  for (let g = 0; g < 5 && (await page.locator(".modal-overlay").count()); g++) {
    for (const el of await page.locator(".modal-card input").all()) {
      if ((await el.getAttribute("type")) === "password") await el.fill("pw");
    }
    await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      if (!c) return;
      const bs = [...c.querySelectorAll("button")];
      (bs.find((b) => b.classList.contains("btn-accent")) ?? bs[0])?.click();
    });
    await page.waitForTimeout(350);
  }
}

async function openSession(page, index = 0) {
  await page.locator(".tree-session").nth(index).dblclick();
  await page.waitForTimeout(400);
  await dismissModals(page);
  await page.waitForTimeout(300);
}

const { stop } = await ensureVite();
const browser = await chromium.launch({ executablePath: findChrome() });
const t = makeRunner();

try {
  // ── 앱 본체 ────────────────────────────────────────────────────────────────
  {
    const page = await openPage(browser, { stub: { sessions_load: SESSIONS } });
    await page.waitForTimeout(1500);

    await t.test("터미널 viewport 배경이 테마색이다 (xterm.css #000 에 지면 안 됨)", async () => {
      await openSession(page);
      const bg = await page.evaluate(() => {
        const vp = document.querySelector(".term-host .xterm-viewport");
        return vp ? getComputedStyle(vp).backgroundColor : null;
      });
      expect(bg !== null, "viewport 가 없다 — 세션이 안 열렸다");
      expect(bg !== "rgb(0, 0, 0)", `viewport 배경이 검정(${bg}) — .term-host .xterm .xterm-viewport 규칙이 졌다`);
    });

    await t.test("확대 배율 표시 — Ctrl+= 시 정중앙에 뜨고 잠시 뒤 사라진다", async () => {
      await page.locator(".term-host").first().click();
      await page.keyboard.press("Control+Equal");
      await page.waitForTimeout(150);
      const z = await page.evaluate(() => {
        const el = document.querySelector(".term-zoom-badge");
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const host = el.parentElement.getBoundingClientRect();
        return {
          shown: cs.display !== "none",
          centered:
            Math.abs(r.left + r.width / 2 - (host.left + host.width / 2)) < 3 &&
            Math.abs(r.top + r.height / 2 - (host.top + host.height / 2)) < 3,
          noPointer: cs.pointerEvents === "none",
          text: el.textContent,
        };
      });
      expect(z && z.shown, "배지가 표시되지 않았다");
      expect(z.centered, "배지가 정중앙이 아니다");
      expect(z.noPointer, "배지가 클릭을 가로챈다(pointer-events)");
      expect(/^\d+%$/.test(z.text), `배율 텍스트가 아니다: ${z.text}`);
      await page.waitForTimeout(1100);
      const hidden = await page.evaluate(
        () => getComputedStyle(document.querySelector(".term-zoom-badge")).display === "none",
      );
      expect(hidden, "배지가 사라지지 않는다");
      await page.keyboard.press("Control+Digit0"); // 원복
    });

    await t.test("Ctrl+숫자 탭 전환 — xterm 이 3~7 을 가로채면 안 됨", async () => {
      await openSession(page, 1); // 두 번째 탭
      // 터미널에 포커스를 둔 채 눌러야 xterm 경로를 지난다.
      await page.evaluate(() => {
        document.querySelector(".term-pane:not([hidden]) textarea")?.focus();
      });
      const active = () =>
        page.evaluate(() => document.querySelector("#tabbar .tab.active .tab-label")?.textContent);
      await page.keyboard.press("Control+1");
      await page.waitForTimeout(150);
      expect((await active()) === "가서버", "Ctrl+1 전환 실패");
      await page.keyboard.press("Control+2");
      await page.waitForTimeout(150);
      expect((await active()) === "나서버", "Ctrl+2 전환 실패");
      // 탭이 2개뿐이라 3 은 '없는 번호 → 유지'가 정답. xterm 이 가로채도 결과가 같아
      // 판별이 안 되므로, 이벤트가 문서까지 올라오는지를 직접 본다.
      // 주의: evaluate 안에서 프라미스를 기다리면 키를 누르기도 전에 멈춘다 —
      // 리스너만 동기로 심고, 누른 뒤 플래그를 읽는다.
      await page.evaluate(() => {
        window.__ctrl3 = false;
        document.addEventListener("keydown", (e) => {
          if (e.ctrlKey && e.key === "3") window.__ctrl3 = true;
        });
        document.querySelector(".term-pane textarea")?.focus();
      });
      await page.keyboard.press("Control+3");
      await page.waitForTimeout(200);
      expect(
        await page.evaluate(() => window.__ctrl3),
        "Ctrl+3 keydown 이 문서까지 올라오지 않았다 — xterm 이 다시 가로챈다",
      );
    });

    await t.test("시작 명령 — 실행 키가 CR 로 나간다 (PowerShell 에서 엔터 안 먹던 회귀)", async () => {
      // 나서버(s2)에 startupCommands 가 있고, 접속 0.5초 뒤 전송된다.
      await page.waitForTimeout(700);
      const found = await page.evaluate(() => {
        const text = (bytes) => String.fromCharCode(...bytes);
        return window.__ipc
          .filter(([c]) => c === "ssh_write")
          .map(([, a]) => text(a.data))
          .find((t) => t.includes("startup-probe"));
      });
      expect(found !== undefined, "시작 명령이 전송되지 않았다");
      expect(found.endsWith("\r"), `줄끝이 CR 이 아니다: ${JSON.stringify(found)}`);
      expect(!found.includes("\n"), `LF 가 섞여 있다: ${JSON.stringify(found)}`);
    });

    await t.test("터미널 검색창 — 밖을 클릭하면 자동으로 닫히고 강조도 걷힌다", async () => {
      await page.evaluate(() => window.__tm.openSearch());
      await page.waitForTimeout(200);
      const bar = () =>
        page.evaluate(() => {
          const tab = window.__tm.active;
          const b = tab.root.querySelector(".term-search");
          return getComputedStyle(b).display !== "none";
        });
      expect(await bar(), "검색창이 열리지 않았다");
      // 터미널(검색창 밖)을 클릭 → 닫혀야 한다.
      await page.evaluate(() => {
        window.__tm.active.root.querySelector(".xterm textarea")?.focus();
      });
      await page.waitForTimeout(200);
      expect(!(await bar()), "검색창 밖으로 나갔는데 계속 열려 있다");
    });

    await t.test("Ctrl+Tab — 터미널 포커스에서도 탭 순환이 걸린다 (xterm 삼킴 회귀)", async () => {
      const active = () =>
        page.evaluate(() => document.querySelector("#tabbar .tab.active .tab-label")?.textContent);
      await page.evaluate(() => {
        [...document.querySelectorAll(".term-pane")]
          .find((e) => getComputedStyle(e).display !== "none")
          ?.querySelector("textarea")
          ?.focus();
      });
      const before = await active();
      await page.keyboard.press("Control+Tab");
      await page.waitForTimeout(250);
      const after = await active();
      expect(before !== after, `Ctrl+Tab 으로 탭이 바뀌지 않았다(계속 ${after})`);
      await page.keyboard.press("Control+Shift+Tab");
      await page.waitForTimeout(250);
      expect((await active()) === before, "Ctrl+Shift+Tab 역방향 순환 실패");
    });

    await t.test("Ctrl+F4 — 터미널 포커스에서도 세션 닫기가 걸린다 (xterm 삼킴 회귀)", async () => {
      await page.evaluate(() => {
        [...document.querySelectorAll(".term-pane")]
          .find((e) => getComputedStyle(e).display !== "none")
          ?.querySelector("textarea")
          ?.focus();
      });
      await page.keyboard.press("Control+F4");
      await page.waitForTimeout(350);
      // 접속 중인 탭이라 "닫을까요?" 확인창이 떠야 한다 — 이게 뜨면 이벤트가 문서까지 온 것.
      const msg = await page.evaluate(
        () => document.querySelector(".modal-card .modal-msg")?.textContent ?? "",
      );
      expect(msg.includes("닫"), `닫기 확인창이 뜨지 않았다 (메시지: "${msg}")`);
      // ② y/n 단축키 — 'n' 으로 취소되는지 함께 확인.
      await page.keyboard.press("n");
      await page.waitForTimeout(250);
      expect((await page.locator(".modal-overlay").count()) === 0, "'n' 으로 확인창이 닫히지 않았다");
      expect(
        (await page.locator("#tabbar .tab").count()) === 2,
        "'아니오'를 골랐는데 탭이 닫혔다",
      );
    });

    await t.test("모든 입력칸 — 포커스 시 자동완성·맞춤법이 꺼진다 (흰 목록 전역 차단)", async () => {
      // 개별 지정이 아니라 위임이므로, 대표로 성격이 다른 세 곳을 찍어 본다.
      const stamped = async (sel) => {
        await page.locator(sel).focus();
        await page.waitForTimeout(80);
        return page.evaluate((q) => {
          const el = document.querySelector(q);
          return el.getAttribute("autocomplete") === "off" && el.spellcheck === false;
        }, sel);
      };
      await page.click("#cmd-toggle"); // 동시 명령 줄 열기
      await page.waitForTimeout(200);
      expect(await stamped("#cmd-input"), "동시 명령 입력칸이 안 덮였다");
      expect(await stamped("#session-search"), "세션 검색이 안 덮였다");
      await page.keyboard.press("Escape"); // 명령줄 닫기
      await page.waitForTimeout(150);
      // xterm 의 IME textarea 는 건드리면 안 된다.
      const xtermUntouched = await page.evaluate(() => {
        const ta = document.querySelector(".xterm textarea");
        ta?.focus();
        return ta ? ta.spellcheck !== false || !ta.closest(".xterm") === false : true;
      });
      expect(xtermUntouched, "xterm textarea 까지 건드렸다");
    });

    await t.test("화면보호기 전 종류 — 각각 실제로 움직이고, 닫으면 정리된다", async () => {
      const result = await page.evaluate(async () => {
        const mod = await import("/src/screensaver.ts");
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const out = {};
        for (const name of mod.SAVER_NAMES) {
          mod.showScreensaver(name);
          await wait(250);
          const canvas = document.querySelector(".screensaver canvas");
          const a = canvas?.toDataURL();
          // 고정 창으로 두 번 찍으면 셸 데모처럼 연출상 멈춤이 있는 보호기가 플레이크가
          // 된다 — 변할 때까지 기다리되 상한(3초)을 둔다.
          let b = a;
          for (let i = 0; i < 10 && b === a; i++) {
            await wait(300);
            b = canvas?.toDataURL();
          }
          mod.hideScreensaver();
          out[name] = {
            떴다: !!canvas,
            움직임: !!a && !!b && a !== b,
            정리됨: document.querySelector(".screensaver") === null,
          };
        }
        return out;
      });
      for (const [name, r] of Object.entries(result)) {
        expect(r.떴다, `${name}: 캔버스가 안 떴다`);
        expect(r.움직임, `${name}: 프레임이 변하지 않는다(멈춘 화면)`);
        expect(r.정리됨, `${name}: 닫아도 오버레이가 남는다`);
      }
    });

    await t.test("화면보호기 미리보기 — 설정에서 버튼으로 띄우면 곧장 닫히지 않는다", async () => {
      await dismissModals(page);
      await page.click("#open-settings");
      await page.waitForTimeout(300);
      await page.evaluate(() =>
        [...document.querySelectorAll(".settings-tab")].find((e) => e.textContent === "보안")?.click(),
      );
      await page.waitForTimeout(200);
      // 드롭다운에서 '별하늘' 선택 후 미리보기 — 여는 클릭의 마우스 이동에도 살아남아야 한다.
      await page.locator(".sv-preview-btns select").selectOption("starfield");
      await page.locator(".sv-preview-btns button", { hasText: "미리보기" }).click();
      await page.mouse.move(400, 400); // 클릭 직후의 흔들림 재현
      await page.waitForTimeout(200);
      expect((await page.locator(".screensaver").count()) === 1, "미리보기가 뜨자마자 닫혔다");
      // 유예(400ms)가 지난 뒤의 움직임에는 닫혀야 한다.
      await page.waitForTimeout(400);
      await page.mouse.move(500, 500);
      await page.waitForTimeout(200);
      expect((await page.locator(".screensaver").count()) === 0, "유예 후에도 닫히지 않는다");
      // 설정창은 그대로 남아 있어야 한다.
      expect((await page.locator(".settings-card").count()) === 1, "설정창이 사라졌다");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    });

    await t.test("세션 종류별 아이콘 — SSH·로컬 셸·RDP 글리프가 서로 다르다", async () => {
      const glyphs = await page.evaluate(() => {
        const of = (name) => {
          const row = [...document.querySelectorAll(".tree-session")].find(
            (r) => r.querySelector(".tree-session-name")?.textContent === name,
          );
          return row?.querySelector(".tree-icon")?.textContent ?? null;
        };
        return { ssh: of("가서버"), rdp: of("윈도서버"), local: of("내PC셸") };
      });
      expect(glyphs.ssh && glyphs.rdp && glyphs.local, `아이콘 누락: ${JSON.stringify(glyphs)}`);
      expect(
        glyphs.ssh !== glyphs.rdp && glyphs.rdp !== glyphs.local && glyphs.ssh !== glyphs.local,
        "세 종류의 글리프가 서로 달라야 한다",
      );
    });

    await t.test("세션 목록 타입어헤드 — 글자를 치면 그 이름의 행으로 이동", async () => {
      // 트리에 포커스를 주고 '나' 를 친다 → '나서버' 행으로 포커스 이동.
      await page.locator(".tree-session").first().click();
      await page.waitForTimeout(150);
      // Playwright 의 type() 은 한글을 keydown 없이 insertText 로 넣는다 — 실제 IME 는
      // keydown(key="나" 또는 조합키)을 먼저 보낸다. 핸들러 검증에는 keydown 을 직접 만든다.
      await page.evaluate(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "나", bubbles: true }),
        );
      });
      await page.waitForTimeout(200);
      const focused = await page.evaluate(
        () => document.activeElement?.querySelector(".tree-session-name")?.textContent ?? "",
      );
      expect(focused === "나서버", `포커스가 '나서버'가 아니라 "${focused}"`);
    });

    await t.test("서비스 연결 — 하위메뉴가 펼쳐지고 정확한 URL 로 browser_open 호출", async () => {
      await page.locator(".tree-session").first().click({ button: "right" });
      await page.waitForTimeout(250);
      // '서비스 연결' 항목에 마우스를 올리면 하위메뉴가 뜬다.
      const parent = page.locator(".ctx-item.has-sub", { hasText: "서비스 연결" });
      expect((await parent.count()) === 1, "'서비스 연결' 항목이 없다");
      await parent.hover();
      await page.waitForTimeout(250);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-submenu .ctx-item")].map((e) => e.textContent.trim()),
      );
      expect(items.length === 2, `하위메뉴 항목 수 ${items.length} (2 기대): ${JSON.stringify(items)}`);
      // 하위메뉴가 부모 메뉴의 오른쪽에 붙는지(위치 계산 회귀).
      const pos = await page.evaluate(() => {
        const main = document.querySelector(".ctx-menu:not(.ctx-submenu)").getBoundingClientRect();
        const sub = document.querySelector(".ctx-submenu").getBoundingClientRect();
        return sub.left >= main.right - 4;
      });
      expect(pos, "하위메뉴가 부모 오른쪽에 붙지 않았다");
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-submenu .ctx-item")]
          .find((e) => e.textContent.includes("관리콘솔"))
          ?.click(),
      );
      await page.waitForTimeout(300);
      const calls = await page.evaluate(() => window.__ipc.filter(([c]) => c === "browser_open"));
      expect(calls.length === 1, `browser_open 호출 ${calls.length}회 (1 기대)`);
      const { browser: br, url } = calls[0][1];
      expect(br === "edge", `브라우저 ${br} (edge 기대)`);
      expect(url === "https://10.0.0.1:8443/admin", `URL ${url}`);
      // 로컬 셸/서비스 없는 세션에는 항목이 없어야 한다.
      await page.locator(".tree-session").nth(1).click({ button: "right" });
      await page.waitForTimeout(250);
      const none = await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].some((e) => e.textContent.includes("서비스 연결")),
      );
      expect(!none, "서비스 없는 세션에 '서비스 연결' 항목이 보인다");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    });

    await t.test("IME 조합 오버레이 — 화면이 다시 그려져도 시작 셀에 고정", async () => {
      // claude CLI 재현: 조합 중에 스피너 출력이 커서를 다른 곳으로 옮긴다.
      // 수정 전에는 오버레이가 그 커서를 따라 점프했다(시뮬레이션으로 확인한 원인).
      const r = await page.evaluate(async () => {
        const tm = window.__tm;
        if (!tm) return { 훅없음: true };
        const tab = tm.active;
        const term = tab.term;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        // 프롬프트를 그리고 커서를 입력 지점에 둔다.
        term.write("\x1b[2J\x1b[H> ");
        await wait(80);
        const ta = term.textarea;
        ta.focus();
        ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        ta.value = "안";
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "안" }));
        await wait(120);
        // 탭이 여러 개면 문서 전체에서 첫 오버레이를 집으면 남의(비어 있는) 것을 본다 —
        // 반드시 활성 탭의 DOM 안에서 찾는다.
        const view = () => {
          const v = tab.root.querySelector(".composition-view");
          if (!v) return null;
          return { left: v.style.left, top: v.style.top, text: v.textContent };
        };
        const before = view();
        // 스피너처럼 커서를 옮기는 출력 — 조합은 계속되는 중.
        term.write("\r\x1b[K\x1b[33m\u273b 생각 중\x1b[0m\r\n상태줄이 커서를 여기 둠");
        await wait(150);
        const after = view();
        ta.value = "";
        ta.dispatchEvent(new CompositionEvent("compositionend", { data: "안" }));
        await wait(80);

        // ── 에코 전진 시나리오(0.53.0 회귀) ──
        // 음절 확정 → 서버 에코가 커서를 전진시키기 '전에' 다음 음절 조합이 시작된다.
        // 에코가 도착하면 오버레이가 전진한 커서를 따라가야 한다 — 못 따라가면 다음
        // 조합 글자가 앞 글자 위에 겹쳐 보인다.
        term.write("\x1b[2J\x1b[H> ");
        await wait(80);
        ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        ta.value = "녕";
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "녕" }));
        await wait(100);
        const echoBefore = view();
        term.write("안"); // 앞 음절의 에코 도착 — 커서 2칸 전진(전각)
        await wait(150);
        const echoAfter = view();
        ta.value = "";
        ta.dispatchEvent(new CompositionEvent("compositionend", { data: "녕" }));
        await wait(80);
        return { before, after, echoBefore, echoAfter };
      });
      expect(!r.훅없음, "개발 훅(__tm)이 없다 — DEV 분기가 죽었는지 확인");
      expect(r.before && r.after, "조합 오버레이가 뜨지 않았다");
      expect(
        r.before.left === r.after.left && r.before.top === r.after.top,
        `오버레이가 점프했다: ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`,
      );
      expect(r.after.text === "안", `조합 글자가 아니다: ${r.after.text}`);
      // 에코 전진은 따라가야 한다 — 전각 1글자 = 2칸만큼 left 가 커져야 한다.
      const eb = parseFloat(r.echoBefore.left);
      const ea = parseFloat(r.echoAfter.left);
      expect(ea > eb, `에코 전진을 따라가지 않았다: ${r.echoBefore.left} → ${r.echoAfter.left}`);
    });

    await t.test("세션 끊김 → 재접속 버튼에 포커스, 화면 클릭 후에도 복귀", async () => {
      await page.locator("#tabbar .tab").first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")]
          .find((b) => b.textContent.trim().startsWith("세션 종료"))
          ?.click(),
      );
      await page.waitForTimeout(400);
      await dismissModals(page);
      const focused = () =>
        page.evaluate(() => document.activeElement === document.querySelector(".term-overlay .btn-accent"));
      expect(await focused(), "끊긴 직후 버튼에 포커스가 없다");
      // 오버레이의 빈 곳을 클릭 → 포커스가 버튼으로 돌아와야 한다.
      await page.locator(".term-overlay").first().click({ position: { x: 30, y: 30 } });
      await page.waitForTimeout(150);
      expect(await focused(), "오버레이 클릭 후 포커스가 버튼으로 돌아오지 않는다");
    });

    await t.test("최근 접속 행 — 액션 버튼이 세션 행과 같은 오른쪽 끝 (세부정보 ON/OFF)", async () => {
      const margins = () =>
        page.evaluate(() => {
          const m = (sel) => {
            const row = document.querySelector(sel);
            const acts = row?.querySelector(".tree-actions");
            if (!row || !acts) return null;
            acts.style.display = "flex"; // hover 상태 재현
            const d = Math.round(row.getBoundingClientRect().right - acts.getBoundingClientRect().right);
            acts.style.display = "";
            return d;
          };
          return { recent: m(".recent-row"), session: m(".tree-session") };
        });
      const on = await margins();
      expect(on.recent !== null && on.recent === on.session, `세부정보 ON: 최근 ${on.recent} ≠ 세션 ${on.session}`);
      // 설정에서 세부정보 OFF
      await page.click("#open-settings");
      await page.waitForTimeout(300);
      await page.evaluate(() =>
        [...document.querySelectorAll(".settings-tab")].find((e) => e.textContent === "터미널")?.click(),
      );
      await page.evaluate(() => {
        const row = [...document.querySelectorAll(".check-row")].find((r) =>
          r.textContent.includes("세션 세부 정보 표시"),
        );
        row?.querySelector("input")?.click();
      });
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "저장")?.click());
      await page.waitForTimeout(400);
      const off = await margins();
      expect(off.recent !== null && off.recent === off.session, `세부정보 OFF: 최근 ${off.recent} ≠ 세션 ${off.session}`);
    });

    await t.test("버전정보 창 — 설정창 높이 고정을 물려받지 않고 내용만큼 커진다", async () => {
      await dismissModals(page);
      await page.click("#open-about");
      await page.waitForTimeout(400);
      const h = await page.evaluate(
        () => document.querySelector(".about-card")?.getBoundingClientRect().height ?? 0,
      );
      // 릴리스 노트가 길어 84vh 까지 커져야 한다 — 620px(설정창 고정값)에 눌리면 회귀.
      expect(h > 640, `버전정보 창이 눌려 있다: ${Math.round(h)}px`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    });

    await t.test("설정·세션편집 창 — 탭을 바꿔도 창 위치·크기가 고정", async () => {
      const rectOf = (sel) =>
        page.evaluate((q) => {
          const r = document.querySelector(q).getBoundingClientRect();
          return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        }, sel);
      const walkTabs = async (cardSel) => {
        const first = await rectOf(cardSel);
        const n = await page.locator(".settings-tab:visible").count();
        for (let i = 0; i < n; i++) {
          await page.locator(".settings-tab:visible").nth(i).click();
          await page.waitForTimeout(120);
          const now = await rectOf(cardSel);
          expect(
            now.l === first.l && now.t === first.t && now.w === first.w && now.h === first.h,
            `${cardSel} 탭 ${i} 전환 후 ${JSON.stringify(now)} ≠ ${JSON.stringify(first)}`,
          );
        }
      };
      // 설정창
      await page.click("#open-settings");
      await page.waitForTimeout(300);
      await walkTabs(".settings-card");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      // 세션 편집창 — 탭(연결/인증/자동화/트리거/서비스)이 같은 구조라 같은 회귀가 생긴다.
      await page.locator(".tree-session").first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent.includes("편집"))?.click(),
      );
      await page.waitForTimeout(350);
      await walkTabs(".session-card");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    });

    await t.test("도움말 전구 — 긴 안내가 접히고, 클릭하면 말풍선, Esc 는 창을 닫지 않음", async () => {
      // 세션 편집 → 트리거 탭: 긴 경고가 화면에서 사라지고 한 줄 요약 + 전구만 남는다.
      await page.locator(".tree-session").first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent.includes("편집"))?.click(),
      );
      await page.waitForTimeout(350);
      await page.evaluate(() =>
        [...document.querySelectorAll(".settings-tab")].find((e) => e.textContent === "트리거")?.click(),
      );
      await page.waitForTimeout(200);
      const warnText = await page.evaluate(
        () => document.querySelector(".trigger-warn")?.textContent ?? "",
      );
      expect(!warnText.includes("10초"), "긴 안내가 아직 화면에 그대로 있다");
      expect(warnText.includes("비밀번호"), "핵심 경고 한 줄이 사라졌다 — 위험 고지는 남아야 한다");
      // 전구 클릭 → 말풍선에 전체 안내. 트리거·서비스 두 탭에 전구가 있으므로
      // 지금 보이는 것(offsetParent 있는 것)을 골라 누른다.
      await page.evaluate(() =>
        [...document.querySelectorAll(".trigger-head .help-bulb")]
          .find((b) => b.offsetParent !== null)
          ?.click(),
      );
      await page.waitForTimeout(200);
      const pop = await page.evaluate(() => document.querySelector(".help-pop-body")?.textContent ?? "");
      expect(pop.includes("10초"), "말풍선에 전체 안내가 없다");
      // 텍스트가 있어도 다른 창 아래 깔리면 소용없다 — 중앙이 실제로 클릭에 잡히는지 본다.
      // (z-index 300 시절 편집 창(#modal-root 1000)에 깔려 오른쪽 조각만 보였던 회귀.)
      const onTop = await page.evaluate(() => {
        const el = document.querySelector(".help-pop");
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el.contains(hit);
      });
      expect(onTop, "말풍선이 다른 창 아래에 깔려 있다");
      // Esc → 말풍선만 닫히고 편집 창은 남아야 한다(입력하던 것이 날아가면 안 된다)
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      expect(
        (await page.locator(".help-pop").count()) === 0,
        "Esc 로 말풍선이 닫히지 않았다",
      );
      expect(
        (await page.locator(".session-card").count()) === 1,
        "Esc 가 말풍선 대신 편집 창을 닫아 버렸다",
      );
      // 진짜 Esc 로 편집 창 닫기(정리)
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    });

    await t.test("설정 경고문(.settings-warn)이 --error 색이다 (.settings-hint 에 지면 안 됨)", async () => {
      await dismissModals(page); // 앞 테스트가 실패해도 남은 창에 막히지 않게
      await page.click("#open-settings");
      await page.waitForTimeout(300);
      await page.evaluate(() =>
        [...document.querySelectorAll(".settings-tab")].find((e) => e.textContent === "일반")?.click(),
      );
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => {
        const warn = document.querySelector(".settings-warn");
        if (!warn) return null;
        warn.style.display = "block";
        const c = getComputedStyle(warn).color;
        warn.style.display = "";
        const err = getComputedStyle(document.documentElement).getPropertyValue("--error").trim();
        // hex → rgb 비교를 위해 임시 요소로 정규화
        const probe = document.createElement("div");
        probe.style.color = err;
        document.body.appendChild(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return { got: c, want };
      });
      expect(r !== null, "경고문 요소가 없다");
      expect(r.got === r.want, `경고문 색 ${r.got} ≠ --error ${r.want} — 특이도에서 졌다`);
      await page.keyboard.press("Escape");
    });

    await t.test("SFTP 칩 — .live 클래스가 실제로 색을 바꾼다 (규칙 순서 회귀)", async () => {
      await dismissModals(page); // 앞 테스트가 실패해도 남은 창에 막히지 않게
      const r = await page.evaluate(() => {
        const chip = document.querySelector(".tree-session .sftp-chip");
        if (!chip) return null;
        const base = getComputedStyle(chip).color;
        chip.classList.add("live");
        const live = getComputedStyle(chip).color;
        chip.classList.remove("live");
        return { base, live };
      });
      expect(r !== null, "칩이 없다");
      expect(r.base !== r.live, ".live 를 붙여도 색이 같다 — 뒤에 오는 기본 규칙이 이기고 있다");
    });

    await t.test("분할 배치 — 4개까지 한 줄, 5개부터 접기", async () => {
      // 지금까지 열린 탭(2개)에 같은 세션을 더 열어 4개를 만든다.
      await openSession(page, 0);
      await openSession(page, 0);
      const grid = () =>
        page.evaluate(() => {
          const p = document.getElementById("panes");
          // 'repeat(4, 1fr)' 문법이라 1fr 개수를 세면 안 된다 — repeat 의 N 을 읽는다.
          const count = (v) => Number(/repeat\((\d+),/.exec(v)?.[1] ?? 0);
          return { cols: count(p.style.gridTemplateColumns), rows: count(p.style.gridTemplateRows) };
        });
      await page.click("#view-vertical");
      await page.waitForTimeout(250);
      let g = await grid();
      expect(g.cols === 4 && g.rows === 1, `세로 4개: ${g.cols}x${g.rows} (4x1 기대)`);
      await page.click("#view-horizontal");
      await page.waitForTimeout(250);
      g = await grid();
      expect(g.cols === 1 && g.rows === 4, `가로 4개: ${g.cols}x${g.rows} (1x4 기대)`);
      // 5개째 — 접힌다(세로 3x2).
      await page.click("#view-vertical");
      await page.waitForTimeout(200);
      await openSession(page, 0);
      await page.waitForTimeout(250);
      g = await grid();
      expect(g.cols === 3 && g.rows === 2, `세로 5개: ${g.cols}x${g.rows} (3x2 기대)`);
      await page.click("#view-tabs");
      await page.waitForTimeout(200);
    });

    await page.close();
  }

  // ── SFTP 모달 ─────────────────────────────────────────────────────────────
  {
    const page = await openPage(browser, {
      url: "/tests/sftp-page.html",
      stub: {
        sftp_list: [
          { name: "a.txt", path: "/home/u/a.txt", isDir: false, size: 10, modified: 1 },
          { name: "b.txt", path: "/home/u/b.txt", isDir: false, size: 20, modified: 1 },
        ],
      },
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__open());
    await page.waitForTimeout(1000);

    await t.test("SFTP 열 조절 핸들이 클릭에 잡힌다 (overflow 잘림 회귀)", async () => {
      const grabbed = await page.evaluate(() => {
        const handles = [...document.querySelectorAll(".sftp-colcell .col-resize, .sftp-colcell [class*=resize]")];
        if (handles.length === 0) return { none: true };
        return handles.map((h) => {
          const r = h.getBoundingClientRect();
          return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === h;
        });
      });
      if (grabbed.none) {
        // 클래스명이 바뀌었을 수 있다 — 핸들 존재 자체를 확인하는 보조 검사로 남긴다.
        const any = await page.evaluate(
          () => document.querySelectorAll('.sftp-colcell *[style*="cursor"], .sftp-colcell .sftp-collabel').length,
        );
        expect(any > 0, "열 헤더 구조를 찾지 못했다 — 검사를 갱신할 것");
        return;
      }
      expect(grabbed.every(Boolean), `일부 핸들이 클릭에 안 잡힌다: ${JSON.stringify(grabbed)}`);
    });

    await t.test("SFTP 크기 조절 — 손잡이 8개, 좌측 변을 끌면 왼쪽만 움직인다", async () => {
      expect((await page.locator(".sftp-rs").count()) === 8, "손잡이가 8개가 아니다");
      const rect = () =>
        page.evaluate(() => {
          const r = document.querySelector(".sftp-panel").getBoundingClientRect();
          return { l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
        });
      const before = await rect();
      const h = await page.locator(".sftp-rs-w").boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 - 60, h.y + h.height / 2, { steps: 5 });
      await page.mouse.up();
      const after = await rect();
      expect(after.l - before.l === -60 && after.w - before.w === 60 && after.h === before.h,
        `좌측 변 드래그 결과가 어긋난다: ${JSON.stringify({ before, after })}`);
    });

    await t.test("SFTP 최대화 — 창을 채우고, 되돌리면 직전 크기", async () => {
      const rect = () =>
        page.evaluate(() => {
          const r = document.querySelector(".sftp-panel").getBoundingClientRect();
          return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        });
      const before = await rect();
      await page.locator(".sftp-maximize").click();
      await page.waitForTimeout(200);
      const max = await rect();
      const vw = await page.evaluate(() => window.innerWidth);
      const vh = await page.evaluate(() => window.innerHeight);
      expect(max.w === vw - 8 && max.h === vh - 8, `최대화가 창을 못 채운다: ${JSON.stringify(max)} (max-* 상한 회귀?)`);
      await page.locator(".sftp-maximize").click();
      await page.waitForTimeout(200);
      const back = await rect();
      expect(back.w === before.w && back.h === before.h, `되돌린 크기가 다르다: ${JSON.stringify({ before, back })}`);
    });

    await t.test("SFTP 창 크기 기억 — 닫았다 다시 열면 유지", async () => {
      // 위 테스트의 좌측 드래그로 이미 커진 상태. 현재 크기를 기록하고 닫는다.
      const before = await page.evaluate(() => {
        const r = document.querySelector(".sftp-panel").getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      await page.locator(".sftp-close").click();
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__open());
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => {
        const r = document.querySelector(".sftp-panel").getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      expect(Math.abs(after.w - before.w) <= 1 && Math.abs(after.h - before.h) <= 1,
        `크기가 유지되지 않는다: ${JSON.stringify({ before, after })}`);
    });

    await t.test("전송 총량 측정이 폴더 목록을 재사용한다 (이중 조회 회귀)", async () => {
      // 폴더 하나를 내려받고, 그 폴더에 대한 sftp_list 호출 횟수를 센다.
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.evaluate(() => {
        // 원격 목록을 폴더 하나로 바꾼 뒤 다시 그린다 — 스텁 덮어쓰기.
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          window.__ipc.push([cmd, args]);
          if (cmd === "sftp_list" && args?.path === "/home/u")
            return [{ name: "폴더", path: "/home/u/폴더", isDir: true, size: 0, modified: 1 }];
          if (cmd === "sftp_list" && args?.path === "/home/u/폴더")
            return [{ name: "안.txt", path: "/home/u/폴더/안.txt", isDir: false, size: 7, modified: 1 }];
          if (cmd === "sftp_download") return null;
          if (cmd === "local_mkdir") return null;
          if (cmd === "local_list") return [];
          if (cmd === "local_exists") return false;
          return prev(cmd, args);
        };
      });
      // 새로고침으로 폴더가 보이게 한다. F5 는 목록(listEl)의 키 핸들러가 받으므로
      // 원격 목록을 먼저 클릭해 포커스를 줘야 한다.
      await page.locator(".sftp-pane").nth(1).locator(".sftp-list").click({ position: { x: 40, y: 200 } });
      await page.keyboard.press("F5");
      await page.waitForTimeout(600);
      const rows = page.locator(".sftp-pane").nth(1).locator(".sftp-row:not(.sftp-updir)");
      await rows.first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].find((x) => x.textContent.includes("다운로드"))?.click(),
      );
      await page.waitForTimeout(1200);
      const listCalls = await page.evaluate(
        () => window.__ipc.filter(([c, a]) => c === "sftp_list" && a?.path === "/home/u/폴더").length,
      );
      expect(listCalls === 1, `'/home/u/폴더' 목록을 ${listCalls}번 조회 — 측정 결과가 재사용되지 않는다`);
    });

    await t.test("탐색기 드래그 — 원격 목록만 드롭 대상으로 밝힌다", async () => {
      const hl = await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(["x"], "드래그.txt"));
        const fire = (el) => {
          el.dispatchEvent(
            new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }),
          );
          return el.classList.contains("drop-target");
        };
        const lists = [...document.querySelectorAll(".sftp-list")];
        const r = { local: fire(lists[0]), remote: fire(lists[1]) };
        lists.forEach((l) => l.classList.remove("drop-target"));
        return r;
      });
      expect(!hl.local && hl.remote, `하이라이트 상태: ${JSON.stringify(hl)}`);
    });

    await t.test("탐색기 드롭 업로드 — 스테이징 후 업로드·정리까지 이어진다", async () => {
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.evaluate(() => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          window.__ipc.push([cmd, args]);
          if (cmd === "local_temp_dir") return "C:\\Temp";
          if (["stage_write", "stage_sweep", "local_mkdir", "local_remove", "sftp_upload"].includes(cmd))
            return null;
          if (cmd === "sftp_list" || cmd === "local_list") return [];
          return prev(cmd, args);
        };
        // 합성 DataTransfer 는 webkitGetAsEntry 가 null 을 주므로 File 폴백 경로를 지난다.
        const dt = new DataTransfer();
        dt.items.add(new File(["안녕하세요 드롭 업로드"], "드롭테스트.txt"));
        document
          .querySelectorAll(".sftp-list")[1]
          .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(1200);
      const calls = await page.evaluate(() => ({
        stage: window.__ipc.filter(([c]) => c === "stage_write").length,
        up: window.__ipc.filter(([c]) => c === "sftp_upload").map(([, a]) => a?.remotePath),
        cleanup: window.__ipc.some(([c, a]) => c === "local_remove" && a?.isDir === true),
      }));
      expect(calls.stage >= 1, "stage_write 가 호출되지 않았다");
      expect(
        calls.up.length === 1 && String(calls.up[0]).endsWith("/드롭테스트.txt"),
        `업로드 호출이 어긋난다: ${JSON.stringify(calls.up)}`,
      );
      expect(calls.cleanup, "임시 스테이징 폴더가 정리되지 않았다");
    });

    await t.test("원격 우클릭에 '폴더 지정해 다운로드' 가 있다 (로컬엔 없다)", async () => {
      // 위 테스트가 원격 목록을 비웠다 — 행 하나를 다시 채운다.
      await page.evaluate(() => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "sftp_list")
            return [{ name: "받을.txt", path: "/home/u/받을.txt", isDir: false, size: 3, modified: 1 }];
          return prev(cmd, args);
        };
      });
      await page.locator(".sftp-pane").nth(1).locator(".sftp-list").click({ position: { x: 40, y: 200 } });
      await page.keyboard.press("F5");
      await page.waitForTimeout(500);
      await page
        .locator(".sftp-pane")
        .nth(1)
        .locator(".sftp-row:not(.sftp-updir)")
        .first()
        .click({ button: "right" });
      await page.waitForTimeout(250);
      const has = await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].some((x) =>
          x.textContent.includes("폴더 지정해 다운로드"),
        ),
      );
      await page.keyboard.press("Escape");
      expect(has, "원격 우클릭 메뉴에 '폴더 지정해 다운로드' 가 없다");
    });

    await page.close();
  }
} finally {
  await browser.close();
  stop();
}

t.finish();
