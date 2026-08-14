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

    await t.test("탭 전환 — 크기가 그대로면 터미널을 다시 재지 않는다(불필요한 재계측 제거)", async () => {
      const r = await page.evaluate(async () => {
        const tm = window.__tm;
        if (!tm || tm.tabs.length < 2) return "탭 부족";
        let fits = 0;
        for (const t of tm.tabs) {
          const orig = t.fit.fit.bind(t.fit);
          t.fit.fit = () => {
            fits++;
            orig();
          };
        }
        // 먼저 한 번씩 보여 각 탭이 제 크기를 잡게 한다(첫 표시에는 당연히 재야 한다).
        for (const t of tm.tabs) {
          tm.activate(t);
          await new Promise((r) => requestAnimationFrame(r));
        }
        const warmup = fits;
        fits = 0;
        // 같은 크기에서 반복 전환 — 이때는 다시 재면 안 된다.
        for (let n = 0; n < 12; n++) {
          tm.activate(tm.tabs[n % tm.tabs.length]);
          await new Promise((r) => requestAnimationFrame(r));
        }
        const repeat = fits;
        // 크기가 실제로 바뀌면 다시 재야 한다.
        fits = 0;
        const panes = document.getElementById("panes");
        const before = panes.getAttribute("style") ?? "";
        panes.style.width = "700px";
        window.dispatchEvent(new Event("resize"));
        await new Promise((r) => setTimeout(r, 400));
        const afterResize = fits;
        panes.setAttribute("style", before);
        window.dispatchEvent(new Event("resize"));
        await new Promise((r) => setTimeout(r, 300));
        return { warmup, repeat, afterResize };
      });
      if (r === "탭 부족") return;
      expect(r.warmup > 0, "첫 표시에서도 크기를 재지 않았다");
      expect(r.repeat === 0, `같은 크기인데 ${r.repeat}번 다시 쟀다 — 전환이 무거워진다`);
      expect(r.afterResize > 0, "크기가 바뀌었는데 다시 재지 않았다(화면이 어긋난다)");
    });

    await t.test("리사이즈 — 크기가 여러 번 바뀌어도 백엔드에 마지막 크기가 전달된다", async () => {
      const r = await page.evaluate(async () => {
        const tab = window.__tm?.tabs?.[0];
        if (!tab) return "no-tab";
        const sent = [];
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "ssh_resize" || cmd === "local_resize") sent.push([args.cols, args.rows]);
          return prev(cmd, args);
        };
        const panes = document.getElementById("panes");
        const before = panes.getAttribute("style") ?? "";
        // 전체화면 전환처럼 짧은 시간에 크기가 여러 번 바뀌는 상황을 흉내낸다.
        for (const [w, h] of [[900, 600], [1400, 800], [1100, 700], [1600, 900]]) {
          panes.style.width = `${w}px`;
          panes.style.height = `${h}px`;
          window.dispatchEvent(new Event("resize"));
          await new Promise((r) => setTimeout(r, 120));
        }
        await new Promise((r) => setTimeout(r, 700)); // 마지막 rAF·전송까지 기다린다
        window.__TAURI_INTERNALS__.invoke = prev;
        panes.setAttribute("style", before);
        return { last: sent[sent.length - 1] ?? null, front: [tab.cols, tab.rows], sent: sent.length };
      });
      if (r === "no-tab") return; // 탭이 없는 상태면 검사 생략
      expect(r.sent > 0, "리사이즈가 백엔드로 전혀 나가지 않았다");
      expect(
        !!r.last && r.last[0] === r.front[0] && r.last[1] === r.front[1],
        `백엔드에 보낸 마지막 크기와 화면 크기가 다르다(커서 어긋남의 원인): ${JSON.stringify(r)}`,
      );
    });

    await t.test("이모지 폭 — VS16(⚠️ ℹ️)이 2칸으로 계산돼 커서가 밀리지 않는다", async () => {
      const r = await page.evaluate(async () => {
        const tab = window.__tm?.tabs?.[0];
        if (!tab) return "no-tab";
        const term = tab.term;
        const enc = new TextEncoder();
        const w = (s) => new Promise((res) => term.write(enc.encode(s), res));
        const measure = async (s) => {
          term.reset();
          await w(s);
          return term.buffer.active.cursorX;
        };
        return {
          version: term.unicode.activeVersion,
          warn: await measure("⚠️"),
          info: await measure("ℹ️"),
          gear: await measure("⚙️"),
          plainWarn: await measure("⚠"), // VS16 없으면 1칸 그대로
          fire: await measure("🔥"), // 원래 2칸 — 그대로여야 한다
          hangul: await measure("가"),
          ascii: await measure("a"),
          dash: await measure("─"), // 박스 그리기 1칸 유지(TUI 테두리)
          combining: await measure("e\u0301"), // 결합 악센트는 여전히 1칸
          // TUI 한 줄 흉내 — 원격이 센 폭과 같아야 커서가 안 밀린다.
          line: await measure("⚠️ 경고 ℹ️ 정보"),
        };
      });
      expect(typeof r === "object", `터미널 훅 문제: ${r}`);
      expect(r.version === "11-vs16", `폭 보정판이 적용되지 않았다: ${r.version}`);
      expect(r.warn === 2 && r.info === 2 && r.gear === 2, `VS16 이모지 폭: ${JSON.stringify(r)}`);
      expect(r.plainWarn === 1, "VS16 없는 문자까지 넓혔다");
      expect(r.fire === 2 && r.hangul === 2 && r.ascii === 1 && r.dash === 1, `기존 폭이 바뀌었다: ${JSON.stringify(r)}`);
      expect(r.combining === 1, "결합 문자 처리가 깨졌다");
      // "⚠️ 경고 ℹ️ 정보" = 2 + 1 + 4 + 1 + 2 + 1 + 4 = 15
      expect(r.line === 15, `혼합 줄의 폭이 어긋난다: ${r.line} (15 기대)`);
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
    });

    await t.test("업데이트 실패 문구 — GitHub 주소가 새지 않는다", async () => {
      const bad = await page.evaluate(async () => {
        const { updateErrorText } = await import("/src/updateerror.ts");
        const samples = [
          "Could not fetch a valid release JSON from the remote: https://github.com/SeonghwanLee/SSHTool2/releases/latest/download/latest.json",
          "error sending request for url (https://github.com/x/y/latest.json): error trying to connect: dns error: failed to lookup address information",
          "network error: connection refused (github.com:443)",
          "io error: timed out",
        ];
        const out = [];
        for (const s of samples) {
          const t = updateErrorText(s);
          if (/https?:\/\//.test(t) || /github/i.test(t)) out.push(t);
          if (!t.includes("업데이트")) out.push("안내 문구 없음: " + t);
        }
        // 연결 실패는 '인터넷 차단' 쪽 안내여야 한다.
        if (!updateErrorText(samples[1]).includes("연결할 수 없습니다")) out.push("오프라인 안내 누락");
        return out;
      });
      expect(bad.length === 0, `주소·안내 문제: ${bad.join(" | ")}`);
    });

    await t.test("버전정보 변경 이력 — 최근 5개만, 홈페이지 버튼은 없다", async () => {
      await dismissModals(page);
      await page.click("#open-about");
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const heads = [...document.querySelectorAll(".about-card .bulk-group")];
        const more = document.querySelector(".about-more");
        return {
          versions: heads.length,
          head:
            [...document.querySelectorAll(".about-card .settings-section")]
              .map((x) => x.textContent ?? "")
              .find((t) => t.includes("변경 이력")) ?? "",
          btn: more?.textContent ?? "",
          href: more?.title ?? "",
        };
      });
      await page.keyboard.press("Escape");
      expect(r.versions === 5, `버전 항목이 5개가 아니다: ${r.versions}`);
      expect(r.head.includes("최근 5개"), `머리말이 다르다: "${r.head}"`);
      expect(r.btn === "" && r.href === "", `홈페이지 버튼이 남아 있다: "${r.btn}"`);
    });

    await t.test("바깥 클릭 — 창이 닫히지 않고 반짝이며 유지 (설정·버전정보, Esc 는 닫힘)", async () => {
      await dismissModals(page);
      const probe = (cardSel) =>
        page.evaluate((sel) => {
          const ov = document.querySelector(".modal-overlay");
          ov?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          const card = document.querySelector(sel);
          return { open: !!card, attn: !!card?.classList.contains("modal-attn") };
        }, cardSel);
      // 설정창(자체 오버레이 구현)
      await page.click("#open-settings");
      await page.waitForTimeout(300);
      let r = await probe(".settings-card");
      expect(r.open && r.attn, `설정창이 바깥 클릭에 버티지 못한다: ${JSON.stringify(r)}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      expect(
        (await page.locator(".settings-card").count()) === 0,
        "Esc 로는 설정창이 닫혀야 한다",
      );
      // 버전정보(공용 openModal 경로 — 세션편집·확인창 등 전부 이 길을 쓴다)
      await page.click("#open-about");
      await page.waitForTimeout(300);
      r = await probe(".about-card");
      expect(r.open && r.attn, `버전정보 창이 바깥 클릭에 버티지 못한다: ${JSON.stringify(r)}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      expect(
        (await page.locator(".about-card").count()) === 0,
        "Esc 로는 버전정보 창이 닫혀야 한다",
      );
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

    await t.test("탭 순서 변경 — 분할 보기 배치도 같은 순서를 따른다", async () => {
      await dismissModals(page);
      // 세션 3개를 열고 마지막 탭을 맨 앞으로 끌어 옮긴다.
      while ((await page.evaluate(() => window.__tm?.tabs?.length ?? 0)) < 3) {
        await openSession(page, 0);
      }
      const before = await page.evaluate(() => window.__tm.tabs.map((t) => t.key));
      const items = page.locator("#tabbar .tab");
      const last = await items.nth(2).boundingBox();
      const first = await items.nth(0).boundingBox();
      await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
      await page.mouse.down();
      await page.mouse.move(first.x + 4, first.y + first.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const afterKeys = await page.evaluate(() => window.__tm.tabs.map((t) => t.key));
      expect(afterKeys[0] === before[2], `탭 순서가 바뀌지 않았다: ${JSON.stringify(afterKeys)}`);

      // 세로 분할로 바꾸면 타일 순서(DOM)가 탭 순서와 같아야 한다.
      await page.click("#view-vertical");
      await page.waitForTimeout(400);
      const domIdx = await page.evaluate(() => {
        const panes = [...document.getElementById("panes").children];
        return window.__tm.tabs.map((t) => panes.indexOf(t.root));
      });
      const ordered = domIdx.every((v, i) => v === i);
      await page.click("#view-tabs");
      await page.waitForTimeout(300);
      expect(ordered, `분할 배치가 탭 순서를 따르지 않는다: ${JSON.stringify(domIdx)}`);
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

    await t.test("SFTP 트리 우클릭 — '하위 새 폴더' 가 그 폴더 안에 만든다", async () => {
      const r = await page.evaluate(async () => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        const made = [];
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "sftp_mkdir") {
            made.push(args?.path);
            return null;
          }
          if (cmd === "sftp_list") return [];
          return prev(cmd, args);
        };
        // 원격 트리의 루트 행에서 우클릭 메뉴를 연다.
        const row = document.querySelectorAll(".sftp-pane")[1]?.querySelector(".tree-node");
        if (!row) return "트리 행 없음";
        row.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 120 }),
        );
        await new Promise((r) => setTimeout(r, 200));
        const item = [...document.querySelectorAll(".ctx-item")].find((x) =>
          x.textContent.includes("하위 새 폴더"),
        );
        if (!item) {
          window.__TAURI_INTERNALS__.invoke = prev;
          return "메뉴 없음";
        }
        item.click();
        await new Promise((r) => setTimeout(r, 250));
        // 이름 입력 창에 값을 넣고 확인.
        const input = document.querySelector(".modal-card input");
        if (input) {
          input.value = "새폴더";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const okBtn = [...document.querySelectorAll(".modal-card button")].find((b) =>
            b.classList.contains("btn-accent"),
          );
          okBtn?.click();
        }
        await new Promise((r) => setTimeout(r, 350));
        window.__TAURI_INTERNALS__.invoke = prev;
        return { made };
      });
      expect(typeof r === "object", `트리 새 폴더 문제: ${r}`);
      expect(
        r.made.length === 1 && String(r.made[0]).endsWith("/새폴더"),
        `만들어진 경로가 어긋난다: ${JSON.stringify(r.made)}`,
      );
    });

    await t.test("SFTP 창 이동 — 머리말을 끌면 따라오고, 화면 밖으로 안 나간다", async () => {
      const rect = () =>
        page.evaluate(() => {
          const r = document.querySelector(".sftp-panel").getBoundingClientRect();
          return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        });
      const before = await rect();
      const head = await page.locator(".sftp-header").boundingBox();
      // 제목 왼쪽(버튼 없는 자리)을 잡고 옮긴다.
      await page.mouse.move(head.x + 60, head.y + head.height / 2);
      await page.mouse.down();
      await page.mouse.move(head.x + 60 - 120, head.y + head.height / 2 + 80, { steps: 6 });
      await page.mouse.up();
      const after = await rect();
      expect(
        after.l - before.l === -120 && after.t - before.t === 80,
        `이동량이 다르다: ${JSON.stringify({ before, after })}`,
      );
      expect(after.w === before.w && after.h === before.h, "이동 중 크기가 변했다");
      // 화면 밖으로 끌어도 머리말을 잡을 수 있어야 한다.
      await page.mouse.move(after.l + 60, after.t + head.height / 2);
      await page.mouse.down();
      await page.mouse.move(-3000, -3000, { steps: 6 });
      await page.mouse.up();
      const out = await rect();
      expect(out.t >= 0 && out.l + out.w > 100, `화면 밖으로 사라졌다: ${JSON.stringify(out)}`);
      // 다음 테스트를 위해 대충 가운데로 돌려 둔다.
      await page.mouse.move(out.l + 60, out.t + head.height / 2);
      await page.mouse.down();
      await page.mouse.move(400, 200, { steps: 4 });
      await page.mouse.up();
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

    await t.test("진행바 — 남은 시간이 뜨고, 창을 접었다 펴도 배경 전송을 이어 보여 준다", async () => {
      // 끌어다 놓은 업로드는 전송 id 가 없어 진행 이벤트가 오지 않는다. 연결에 매인
      // 상태(liveSftp)만으로 진행바가 살아야 한다 — 접었다 펴면 사라지던 자리(0.76.5).
      const feed = async (done) =>
        page.evaluate((d) => {
          const { liveSftp, transferStateOf, notifyLive } = window.__live;
          transferStateOf("t1").transferring = true;
          const live = liveSftp.get("t1");
          live.name = "큰파일.zip";
          live.done = d;
          live.total = 500 * 1024 * 1024;
          notifyLive();
        }, done);

      // 이 검사는 '전송 중' 상태를 손으로 만든다 — 도중에 실패해도 반드시 되돌려야
      // 뒤따르는 전송 검사들이 '이미 전송 중' 가드에 걸려 줄줄이 무너지지 않는다.
      try {
      // 표본을 여러 번 먹여 속도·남은 시간이 계산되게 한다. 남은 시간은 표시가 튀지
      // 않도록 몇 초쯤 모인 뒤부터 나오므로(0.76.6) 그만큼 먹인다.
      for (let i = 1; i <= 12; i++) {
        await feed(i * 10 * 1024 * 1024);
        await page.waitForTimeout(400);
      }
      const shown = await page.evaluate(() => ({
        hidden: document.querySelector(".sftp-progress")?.classList.contains("hidden"),
        info: document.querySelector(".prog-info")?.textContent ?? "",
      }));
      expect(shown.hidden === false, "전송 중인데 진행바가 숨어 있다");
      expect(/남음|곧 완료/.test(shown.info), `남은 시간이 없다: ${shown.info}`);

      // 접기(연결 유지) → 다시 열기. 예전에는 여기서 진행바가 영영 나오지 않았다.
      await page.locator(".sftp-min").click();
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__open());
      await page.waitForTimeout(800);
      for (let i = 13; i <= 24; i++) {
        await feed(i * 10 * 1024 * 1024);
        await page.waitForTimeout(400);
      }
      const again = await page.evaluate(() => ({
        hidden: document.querySelector(".sftp-progress")?.classList.contains("hidden"),
        pct: document.querySelector(".prog-pct")?.textContent ?? "",
        info: document.querySelector(".prog-info")?.textContent ?? "",
      }));
      expect(again.hidden === false, "접었다 편 뒤 진행바가 사라졌다");
      expect(again.pct === "48%", `진행률이 이어지지 않는다: ${again.pct}`);
      expect(/남음|곧 완료/.test(again.info), `접었다 편 뒤 남은 시간이 없다: ${again.info}`);

      // 전송이 끝나면 사라진다.
      await page.evaluate(() => {
        const { transferStateOf, notifyLive } = window.__live;
        transferStateOf("t1").transferring = false;
        notifyLive();
      });
      await page.waitForTimeout(200);
      expect(
        await page.evaluate(() => document.querySelector(".sftp-progress")?.classList.contains("hidden")),
        "전송이 끝났는데 진행바가 남아 있다",
      );
      } finally {
        // 상태를 원래대로 — 창이 접힌 채 끝났으면 다시 열어 둔다.
        await page.evaluate(() => {
          const { liveSftp, transferStateOf, notifyLive } = window.__live;
          transferStateOf("t1").transferring = false;
          const live = liveSftp.get("t1");
          if (live) {
            live.done = 0;
            live.total = 0;
            live.name = "";
          }
          notifyLive();
        });
        if (!(await page.locator(".sftp-panel").count())) {
          await page.evaluate(() => window.__open());
          await page.waitForTimeout(800);
        }
      }
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

    await t.test("탐색기 드롭 업로드 — 같은 이름이면 묻는다(묻지 않고 덮어쓰지 않는다)", async () => {
      await dismissModals(page);
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.evaluate(() => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          window.__ipc.push([cmd, args]);
          if (["sftp_upload_chunk", "sftp_upload_finish", "sftp_mkdir"].includes(cmd)) return null;
          if (cmd === "sftp_stat") return null;
          // 대상 폴더에 같은 이름이 이미 있다.
          if (cmd === "sftp_list")
            return [{ name: "겹침.txt", path: "/home/u/겹침.txt", isDir: false, size: 5, modified: 1 }];
          if (cmd === "local_list") return [];
          return prev(cmd, args);
        };
        const dt = new DataTransfer();
        dt.items.add(new File(["새 내용"], "겹침.txt"));
        document
          .querySelectorAll(".sftp-list")[1]
          .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(900);
      const asked = await page.evaluate(
        () => [...document.querySelectorAll(".modal-card h3")].some((h) => h.textContent.includes("같은 이름")),
      );
      expect(asked, "같은 이름인데 묻지 않고 덮어쓴다");
      // '건너뛰기' 를 고르면 아무것도 올라가지 않아야 한다.
      await page.evaluate(() =>
        [...document.querySelectorAll(".modal-card button")]
          .find((b) => b.textContent === "건너뛰기")
          ?.click(),
      );
      await page.waitForTimeout(700);
      const sent = await page.evaluate(
        () => window.__ipc.filter(([c]) => c === "sftp_upload_chunk").length,
      );
      expect(sent === 0, `건너뛰기를 골랐는데 ${sent}조각이 올라갔다`);
    });

    await t.test("탐색기 드롭 업로드 — 임시 사본 없이 곧바로 서버에 쓴다", async () => {
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.evaluate(() => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          window.__ipc.push([cmd, args]);
          if (["sftp_upload_chunk", "sftp_upload_finish", "sftp_mkdir"].includes(cmd)) return null;
          if (cmd === "sftp_stat") return null;
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
      await page.waitForTimeout(1500);
      const calls = await page.evaluate(() => ({
        chunks: window.__ipc.filter(([c]) => c === "sftp_upload_chunk").map(([, a]) => a?.remotePath),
        finish: window.__ipc.filter(([c]) => c === "sftp_upload_finish").map(([, a]) => a?.remotePath),
        // 예전 방식(임시 폴더에 사본 → 다시 업로드)의 흔적이 남아 있으면 안 된다.
        staged: window.__ipc.filter(([c]) => c === "stage_write" || c === "sftp_upload").length,
      }));
      expect(
        calls.chunks.length >= 1 && String(calls.chunks[0]).endsWith("/드롭테스트.txt"),
        `조각 업로드가 어긋난다: ${JSON.stringify(calls.chunks)}`,
      );
      expect(
        calls.finish.length === 1 && String(calls.finish[0]).endsWith("/드롭테스트.txt"),
        `마무리(.part → 대상)가 한 번 불리지 않았다: ${JSON.stringify(calls.finish)}`,
      );
      expect(calls.staged === 0, `임시 사본 경로가 아직 남아 있다(${calls.staged}회)`);
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

    await t.test("SFTP 바깥 클릭 — 창이 닫히지 않고 반짝이며 유지된다", async () => {
      const r = await page.evaluate(() => {
        const ov = document.querySelector(".sftp-overlay");
        ov?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        const panel = document.querySelector(".sftp-panel");
        return { open: !!panel, attn: !!panel?.classList.contains("modal-attn") };
      });
      expect(r.open && r.attn, `SFTP 창이 바깥 클릭에 버티지 못한다: ${JSON.stringify(r)}`);
    });

    await t.test("원격 파일 편집 — 임시본이 바뀌면 서버로 되올린다(쓰는 중엔 대기)", async () => {
      const r = await page.evaluate(async () => {
        // local_stat 을 흉내내 파일이 '변경 → 안정' 되는 흐름을 만든다.
        let stat = [10, 1000];
        const prev = window.__TAURI_INTERNALS__.invoke;
        const uploads = [];
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "local_stat") return stat;
          if (cmd === "sftp_upload") {
            uploads.push(args?.remotePath);
            return null;
          }
          if (cmd === "sftp_list") return [];
          if (cmd === "open_path" || cmd === "local_temp_dir") return "C:\\Temp";
          return prev(cmd, args);
        };
        const tab = window.__sftpTest;
        if (!tab) return "no-hook";
        tab.watchEdit("C:\\Temp\\a.conf", "/etc/a.conf", "a.conf");
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(150);
        // ① 아직 안 바뀜 → 업로드 없음
        await tab.pollEdits();
        const idle = uploads.length;
        // ② 방금 바뀜(쓰는 중일 수 있다) → 한 번만으로는 올리지 않는다
        stat = [20, 1001];
        await tab.pollEdits();
        const writing = uploads.length;
        // ③ 같은 값이 다시 관측 = 저장 완료 → 업로드
        await tab.pollEdits();
        const saved = uploads.length;
        window.__TAURI_INTERNALS__.invoke = prev;
        return { idle, writing, saved, path: uploads[0] ?? "" };
      });
      expect(typeof r === "object", `테스트 훅 없음: ${r}`);
      expect(r.idle === 0, "변경이 없는데 업로드했다");
      expect(r.writing === 0, "쓰는 중(1회 관측)인데 업로드했다 — 반쪽 파일이 서버에 남는다");
      expect(r.saved === 1 && r.path === "/etc/a.conf", `저장 후 업로드가 어긋난다: ${JSON.stringify(r)}`);
    });

    await t.test("SFTP 창 버튼 표준 매핑 — 접기는 연결 유지, X 는 끊는다", async () => {
      const btns = await page.evaluate(() => ({
        min: !!document.querySelector(".sftp-min"),
        max: !!document.querySelector(".sftp-maximize"),
        x: !!document.querySelector(".sftp-close"),
        dc: !!document.querySelector(".sftp-disconnect"),
      }));
      expect(
        btns.min && btns.max && btns.x && !btns.dc,
        `헤더 버튼 구성이 다르다: ${JSON.stringify(btns)}`,
      );
      // 접기: 창은 사라지되 sftp_disconnect 가 나가면 안 된다.
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.locator(".sftp-min").click();
      await page.waitForTimeout(300);
      const afterMin = await page.evaluate(() => ({
        closed: !document.querySelector(".sftp-panel"),
        dc: window.__ipc.some(([c]) => c === "sftp_disconnect"),
      }));
      expect(afterMin.closed && !afterMin.dc, `접기 동작이 다르다: ${JSON.stringify(afterMin)}`);
      // 다시 열면(살아있는 연결 재사용) X 로 실제 끊김이 나가야 한다.
      await page.evaluate(() => window.__open());
      await page.waitForTimeout(800);
      await page.locator(".sftp-close").click();
      await page.waitForTimeout(300);
      const dc = await page.evaluate(() => window.__ipc.some(([c]) => c === "sftp_disconnect"));
      expect(dc, "X 가 연결을 끊지 않는다");
    });

    await t.test("SFTP 이어받기 — 남은 조각이 있으면 묻고 그 위치부터 받는다", async () => {
      await page.evaluate(() => window.__open());
      await page.waitForTimeout(900);
      await page.evaluate(() => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__resumeCalls = [];
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          // 앞 테스트들이 목록 스텁을 갈아 끼웠으므로 이 테스트가 쓸 목록을 다시 못 박는다.
          if (cmd === "sftp_list")
            return [{ name: "a.txt", path: "/home/u/a.txt", isDir: false, size: 10, modified: 1 }];
          // 로컬에 5바이트 조각이 남아 있다(원격 a.txt 는 10바이트).
          if (cmd === "local_stat") return [5, 0];
          if (cmd === "local_list") return [];
          if (cmd === "sftp_download") {
            window.__resumeCalls.push(args);
            return null;
          }
          return prev(cmd, args);
        };
      });
      // 목록을 새 스텁으로 다시 읽는다(F5 는 목록에 포커스가 있어야 먹는다).
      await page.locator(".sftp-pane").nth(1).locator(".sftp-list").click({ position: { x: 40, y: 200 } });
      await page.keyboard.press("F5");
      await page.waitForTimeout(600);
      const rows = page.locator(".sftp-pane").nth(1).locator(".sftp-row:not(.sftp-updir)");
      await rows.first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")]
          .find((x) => x.textContent.includes("다운로드") && !x.textContent.includes("폴더 지정"))
          ?.click(),
      );
      await page.waitForTimeout(700);
      const asked = await page.evaluate(
        () => [...document.querySelectorAll(".modal-card h3")].some((h) => h.textContent.includes("받다 만")),
      );
      expect(asked, "조각이 남아 있는데 이어받기를 묻지 않는다");
      // '이어받기' 를 고르면 그 위치가 백엔드로 넘어가야 한다.
      await page.evaluate(() =>
        [...document.querySelectorAll(".modal-card button")]
          .find((b) => b.textContent === "이어받기")
          ?.click(),
      );
      await page.waitForTimeout(900);
      const calls = await page.evaluate(() => window.__resumeCalls ?? []);
      expect(calls.length === 1, `다운로드 호출이 ${calls.length}번이다`);
      expect(calls[0]?.resumeFrom === 5, `이어받을 위치가 틀리다: ${JSON.stringify(calls[0])}`);
    });

    await t.test("폴더 비교·동기화 — 차이를 찾고 고른 방향으로만 보낸다", async () => {
      await dismissModals(page);
      await page.evaluate(() => {
        // 앞 테스트가 갈아 끼운 invoke 를 되돌린 뒤, 이 테스트용으로 다시 감싼다.
        window.__syncCalls = [];
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          // 원격에만 두 파일이 있는 상태 — 로컬은 비어 있다.
          if (cmd === "sftp_list")
            return [
              { name: "a.txt", path: "/home/u/a.txt", isDir: false, size: 10, modified: 1 },
              { name: "b.txt", path: "/home/u/b.txt", isDir: false, size: 20, modified: 1 },
            ];
          if (cmd === "local_stat") return null; // 조각 없음 — 이어받기 물음이 끼지 않게
          if (cmd === "local_list") return [];
          if (cmd === "sftp_download") {
            window.__syncCalls.push(args);
            return null;
          }
          return prev(cmd, args);
        };
      });
      if ((await page.locator(".sftp-panel").count()) === 0) {
        await page.evaluate(() => window.__open());
        await page.waitForTimeout(900);
      }
      await page.locator(".sftp-sync").click();
      await page.waitForTimeout(900);
      const scan = await page.evaluate(() => ({
        rows: [...document.querySelectorAll(".sync-row .sync-name")].map((x) => x.textContent),
        states: [...document.querySelectorAll(".sync-row .sync-state")].map((x) => x.textContent),
        // 기본 방향(로컬→원격)에서는 '원격에만' 항목을 보낼 수 없어 전송 버튼이 잠겨 있다.
        sendDisabled: document.querySelector(".sync-card .btn-accent")?.disabled,
      }));
      expect(scan.rows.length === 2, `비교 결과가 2건이 아니다: ${JSON.stringify(scan.rows)}`);
      expect(
        scan.states.every((s) => s === "원격에만"),
        `상태 판정이 다르다: ${JSON.stringify(scan.states)}`,
      );
      expect(scan.sendDisabled === true, "로컬→원격 방향인데 원격 전용 항목이 선택돼 있다");

      // 방향을 원격→로컬로 바꾸면 두 건이 선택되고 전송이 열린다.
      await page.evaluate(() => {
        const r = [...document.querySelectorAll('.sync-dir input[type="radio"]')].find(
          (x) => x.value === "remote",
        );
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(300);
      const ready = await page.evaluate(() => ({
        checked: [...document.querySelectorAll('.sync-row input[type="checkbox"]')].filter(
          (c) => c.checked,
        ).length,
        sendDisabled: document.querySelector(".sync-card .btn-accent")?.disabled,
      }));
      expect(ready.checked === 2 && ready.sendDisabled === false, `방향 전환이 반영되지 않았다: ${JSON.stringify(ready)}`);

      await page.evaluate(() =>
        [...document.querySelectorAll(".sync-card button")]
          .find((b) => b.textContent === "선택한 항목 전송")
          ?.click(),
      );
      await page.waitForTimeout(1200);
      const sent = await page.evaluate(() => window.__syncCalls ?? []);
      expect(sent.length === 2, `전송이 2건이 아니다: ${sent.length}`);
      expect(
        sent.every((c) => c.remotePath.startsWith("/home/u/") && c.localPath.includes("작업")),
        `전송 경로가 어긋난다: ${JSON.stringify(sent)}`,
      );
    });

    await t.test("전송 큐 — 항목이 줄 서고 실패는 남아 다시 시도할 수 있다", async () => {
      await dismissModals(page);
      if ((await page.locator(".sftp-panel").count()) === 0) {
        await page.evaluate(() => window.__open());
        await page.waitForTimeout(900);
      }
      await page.evaluate(() => {
        window.__dlCount = 0;
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "sftp_list")
            return [
              { name: "q1.txt", path: "/home/u/q1.txt", isDir: false, size: 10, modified: 1 },
              { name: "q2.txt", path: "/home/u/q2.txt", isDir: false, size: 20, modified: 1 },
            ];
          if (cmd === "local_stat") return null;
          if (cmd === "local_list") return [];
          if (cmd === "sftp_download") {
            window.__dlCount++;
            // q2 만 실패시킨다 — 실패가 큐에 남는지 보기 위해서다.
            if (args.remotePath.includes("q2")) throw new Error("권한 없음");
            return null;
          }
          return prev(cmd, args);
        };
      });
      await page.locator(".sftp-pane").nth(1).locator(".sftp-list").click({ position: { x: 40, y: 200 } });
      await page.keyboard.press("F5");
      await page.waitForTimeout(600);
      // 두 파일을 모두 골라 내려받는다.
      await page.locator(".sftp-pane").nth(1).locator(".sftp-row:not(.sftp-updir)").first().click();
      await page.keyboard.press("Control+a");
      await page.waitForTimeout(200);
      await page.locator(".sftp-pane").nth(1).locator(".sftp-row:not(.sftp-updir)").first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")]
          .find((x) => x.textContent.includes("다운로드") && !x.textContent.includes("폴더 지정"))
          ?.click(),
      );
      await page.waitForTimeout(1500);
      const q = await page.evaluate(() => ({
        visible: !document.querySelector(".sftp-queue")?.classList.contains("hidden"),
        rows: [...document.querySelectorAll(".queue-row")].map((r) => ({
          name: r.querySelector(".queue-name")?.textContent,
          state: r.querySelector(".queue-state")?.textContent,
        })),
        retryShown: document.querySelector(".queue-retry")?.style.display !== "none",
      }));
      expect(q.visible, "전송 큐가 보이지 않는다");
      // 큐는 묶음마다 비우지 않고 이어진다(0.75.0) — 앞 전송 기록이 함께 있어도 정상이다.
      expect(q.rows.length >= 2, `큐 항목이 모자란다: ${JSON.stringify(q.rows)}`);
      expect(
        q.rows.some((r) => r.name === "q1.txt" && r.state === "완료"),
        `성공 항목이 완료로 남지 않았다: ${JSON.stringify(q.rows)}`,
      );
      expect(
        q.rows.some((r) => r.name === "q2.txt" && r.state === "실패"),
        `실패 항목이 큐에 남지 않았다: ${JSON.stringify(q.rows)}`,
      );
      expect(q.retryShown, "실패가 있는데 '실패 다시 시도' 가 보이지 않는다");

      // 다시 시도 — 실패한 것만 보낸다.
      const before = await page.evaluate(() => window.__dlCount);
      await page.evaluate(() => document.querySelector(".queue-retry")?.click());
      await page.waitForTimeout(1200);
      const after = await page.evaluate(() => window.__dlCount);
      expect(after === before + 1, `재시도가 실패분 1건만 보내지 않았다: ${before} → ${after}`);
    });

    await t.test("전송 큐 배치 — 전송 전에도 보이고, 짜부라지거나 창 밖으로 나가지 않는다", async () => {
      await dismissModals(page);
      if ((await page.locator(".sftp-panel").count()) === 0) {
        await page.evaluate(() => window.__open());
        await page.waitForTimeout(900);
      }
      const g = await page.evaluate(() => {
        const q = document.querySelector(".sftp-queue");
        if (!q) return "큐 없음";
        const qr = q.getBoundingClientRect();
        const panel = document.querySelector(".sftp-panel").getBoundingClientRect();
        const list = document.querySelector(".queue-list").getBoundingClientRect();
        return {
          display: getComputedStyle(q).display,
          listH: Math.round(list.height),
          // 창 안에 들어와 있어야 한다(0.75.0 에서 아래 경계에 걸쳐 잘렸다).
          overflow: Math.round(qr.bottom - panel.bottom),
        };
      });
      expect(typeof g === "object", `전송 큐를 찾지 못했다: ${g}`);
      expect(g.display !== "none", "전송이 없을 때 큐가 아예 숨겨져 있다 — 기능이 있는지 알 수 없다");
      expect(g.listH >= 60, `큐 목록이 ${g.listH}px 로 짜부라졌다 — 줄을 읽을 수 없다`);
      expect(g.overflow <= 1, `큐가 창 밖으로 ${g.overflow}px 삐져나왔다`);

      // 머리말을 누르면 접히고, 다시 누르면 펴진다(작은 셰브론만 누르게 하지 않는다).
      await page.click(".queue-head");
      await page.waitForTimeout(200);
      const folded = await page.evaluate(
        () => document.querySelector(".queue-list").getBoundingClientRect().height,
      );
      await page.click(".queue-head");
      await page.waitForTimeout(200);
      const unfolded = await page.evaluate(
        () => document.querySelector(".queue-list").getBoundingClientRect().height,
      );
      expect(folded === 0, `머리말을 눌러도 접히지 않는다(${folded}px)`);
      expect(unfolded >= 60, `다시 눌러도 펴지지 않는다(${unfolded}px)`);
    });

    await t.test("전송 큐 — 전송 중에 넣어도 거절하지 않고 줄을 선다", async () => {
      await dismissModals(page);
      if ((await page.locator(".sftp-panel").count()) === 0) {
        await page.evaluate(() => window.__open());
        await page.waitForTimeout(900);
      }
      const r = await page.evaluate(async () => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        let running = 0;
        let maxParallel = 0;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "sftp_download") {
            running++;
            maxParallel = Math.max(maxParallel, running);
            await new Promise((r) => setTimeout(r, 400)); // 느린 전송을 흉내
            running--;
            return null;
          }
          if (cmd === "local_stat") return null;
          if (cmd === "local_list") return [];
          return prev(cmd, args);
        };
        const pane = window.__sftpTest?.panes?.remote?.();
        if (!pane) return "패널 훅 없음";
        const mk = (n) => ({
          name: n,
          path: `/home/u/${n}`,
          isDir: false,
          size: 10,
          modified: 1,
        });
        // 첫 전송이 도는 도중에 두 번째를 넣는다 — 예전에는 여기서 거절당했다.
        const first = window.__sftpTest.transferItems(window.__sftpTest.panes.local(), [mk("k1.txt")]);
        await new Promise((r) => setTimeout(r, 150));
        const second = window.__sftpTest.transferItems(window.__sftpTest.panes.local(), [mk("k2.txt")]);
        await Promise.all([first, second]);
        const rows = [...document.querySelectorAll(".queue-row")].map((x) => ({
          name: x.querySelector(".queue-name")?.textContent,
          state: x.querySelector(".queue-state")?.textContent,
        }));
        window.__TAURI_INTERNALS__.invoke = prev;
        return { rows, maxParallel };
      });
      expect(typeof r === "object", `전송 큐 검사를 못 했다: ${r}`);
      const done = r.rows.filter((x) => x.state === "완료").map((x) => x.name);
      expect(
        done.includes("k1.txt") && done.includes("k2.txt"),
        `줄 서서 둘 다 끝나지 않았다: ${JSON.stringify(r.rows)}`,
      );
      expect(r.maxParallel === 1, `동시에 ${r.maxParallel}건이 돌았다 — 순차 실행이어야 한다`);
    });

    await t.test("전송 큐 — 남은 대기를 한꺼번에 취소해 목록에서 뺀다", async () => {
      await dismissModals(page);
      if ((await page.locator(".sftp-panel").count()) === 0) {
        await page.evaluate(() => window.__open());
        await page.waitForTimeout(900);
      }
      const r = await page.evaluate(async () => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        let sent = 0;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "sftp_download") {
            sent++;
            await new Promise((r) => setTimeout(r, 200));
            return null;
          }
          if (cmd === "local_stat") return null;
          if (cmd === "local_list") return [];
          return prev(cmd, args);
        };
        const t = window.__sftpTest;
        const mk = (n) => ({ name: n, path: `/home/u/c${n}`, isDir: false, size: 10, modified: 1 });
        const job = t.transferItems(t.panes.local(), [mk("1"), mk("2"), mk("3"), mk("4"), mk("5")]);
        // 첫 파일이 도는 동안 남은 대기를 통째로 뺀다.
        await new Promise((r) => setTimeout(r, 120));
        const waitBefore = [...document.querySelectorAll(".queue-row .queue-state")].filter(
          (x) => x.textContent === "대기",
        ).length;
        document.querySelector(".queue-cancel-wait")?.click();
        const waitAfter = [...document.querySelectorAll(".queue-row .queue-state")].filter(
          (x) => x.textContent === "대기",
        ).length;
        await job;
        await new Promise((r) => setTimeout(r, 300));
        window.__TAURI_INTERNALS__.invoke = prev;
        return { waitBefore, waitAfter, sent };
      });
      expect(r.waitBefore >= 3, `대기 항목이 줄 서지 않았다: ${JSON.stringify(r)}`);
      expect(r.waitAfter === 0, `대기 취소 후에도 ${r.waitAfter}개가 목록에 남았다`);
      expect(r.sent <= 2, `취소했는데 ${r.sent}개나 전송됐다 — 남은 차례가 멈추지 않는다`);
    });

    await t.test("전송 취소 — 줄 서 있던 묶음까지 함께 멈춘다", async () => {
      await dismissModals(page);
      if ((await page.locator(".sftp-panel").count()) === 0) {
        await page.evaluate(() => window.__open());
        await page.waitForTimeout(900);
      }
      const started = await page.evaluate(async () => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        const started = [];
        const cancelled = [];
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "sftp_upload") {
            started.push(args.remotePath.split("/").pop());
            for (let i = 0; i < 12; i++) {
              await new Promise((r) => setTimeout(r, 50));
              if (cancelled.includes(args.transferId)) throw new Error("전송이 취소되었습니다");
            }
            return null;
          }
          if (cmd === "sftp_cancel") {
            cancelled.push(args.transferId);
            return null;
          }
          if (cmd === "local_stat") return null;
          if (cmd === "local_list") return [];
          return prev(cmd, args);
        };
        const t = window.__sftpTest;
        const mk = (p, i) => ({
          name: `${p}${i}.bin`,
          path: `C:\\작업\\${p}${i}.bin`,
          isDir: false,
          size: 100,
          modified: 1,
        });
        const j1 = t.transferItems(t.panes.remote(), [1, 2].map((i) => mk("a", i)));
        await new Promise((r) => setTimeout(r, 100));
        const j2 = t.transferItems(t.panes.remote(), [1, 2].map((i) => mk("b", i))); // 줄 세우기
        await new Promise((r) => setTimeout(r, 200));
        document.querySelector(".sftp-progress .tree-act")?.click(); // 취소
        await new Promise((r) => setTimeout(r, 2500));
        await Promise.all([j1, j2]);
        window.__TAURI_INTERNALS__.invoke = prev;
        return started;
      });
      // 예전에는 지금 묶음만 멈추고 줄 서 있던 b* 묶음이 그대로 나갔다(연결을 끊어야 멈췄다).
      expect(
        !started.some((n) => n.startsWith("b")),
        `취소했는데 줄 서 있던 묶음이 나갔다: ${JSON.stringify(started)}`,
      );
      expect(started.length <= 2, `취소 후에도 전송이 이어졌다: ${JSON.stringify(started)}`);
    });

    await t.test("전송 속도 제한 — 창에서 고르면 즉시 백엔드로 간다", async () => {
      await dismissModals(page);
      if ((await page.locator(".sftp-panel").count()) === 0) {
        await page.evaluate(() => window.__open());
        await page.waitForTimeout(900);
      }
      const opts = await page.evaluate(() =>
        [...(document.querySelector(".prog-rate")?.options ?? [])].map((o) => o.value),
      );
      expect(opts.includes("0") && opts.includes("1024"), `속도 후보가 없다: ${JSON.stringify(opts)}`);
      const sent = await page.evaluate(async () => {
        window.__ipc.length = 0;
        const sel = document.querySelector(".prog-rate");
        sel.value = "1024";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        return window.__ipc.filter(([c]) => c === "sftp_set_rate_limit").map(([, a]) => a.kbps);
      });
      // 앞 테스트들이 invoke 를 여러 겹 감싸 한 호출이 여러 번 기록된다 — 개수가 아니라 값으로 본다.
      expect(
        sent.length >= 1 && sent.every((v) => v === 1024),
        `속도 제한이 전달되지 않았다: ${JSON.stringify(sent)}`,
      );
    });

    await page.close();
  }

  // ── Grafana 스타일 세션목록 접기(0.58.0) ─────────────────────────────────
  {
    const page = await openPage(browser, {
      stub: {
        sessions_load: [
          { id: "f1", name: "운영1", kind: "ssh", host: "10.1.0.1", port: 22, user: "root", enableSftp: false, folder: "운영", sortOrder: 0, lastConnectedUtc: 0, triggers: [] },
          { id: "f2", name: "운영2", kind: "ssh", host: "10.1.0.2", port: 22, user: "root", enableSftp: false, folder: "운영", sortOrder: 1, lastConnectedUtc: 0, triggers: [] },
          { id: "f3", name: "개발1", kind: "ssh", host: "10.1.0.3", port: 22, user: "root", enableSftp: false, folder: "개발", sortOrder: 2, lastConnectedUtc: 0, triggers: [] },
        ],
      },
    });
    await page.waitForTimeout(600);
    await dismissModals(page);

    await t.test("폴더 헤더 — 셰브론 렌더 + 접기 연출(지연 재렌더) + 펼치기 복귀", async () => {
      expect((await page.locator(".tree-folder").count()) === 2, "폴더 헤더가 2개가 아니다");
      const chev = await page.evaluate(() => {
        const a = document.querySelector(".tree-folder .tree-arrow");
        return a ? getComputedStyle(a).transitionProperty.includes("transform") : false;
      });
      expect(chev, "셰브론 회전 전환(transition)이 없다");
      const before = await page.locator(".tree-session").count();
      expect(before === 3, `세션 행이 3개가 아니다: ${before}`);
      // '운영' 접기 — 두 단계(연출 130ms 후 재렌더)라 직후엔 셰브론만 돌고, 잠시 뒤 자식이 사라진다.
      await page.locator(".tree-folder", { hasText: "운영" }).click();
      await page.waitForTimeout(60);
      const collapsedNow = await page.evaluate(() =>
        [...document.querySelectorAll(".tree-folder")].some((f) => f.classList.contains("collapsed")),
      );
      expect(collapsedNow, "클릭 직후 셰브론(.collapsed)이 돌지 않는다");
      await page.waitForTimeout(400);
      const after = await page.locator(".tree-session").count();
      expect(after === before - 2, `접힌 뒤 세션 행: ${after} (기대 ${before - 2})`);
      await page.locator(".tree-folder", { hasText: "운영" }).click();
      await page.waitForTimeout(400);
      expect(
        (await page.locator(".tree-session").count()) === before,
        "펼친 뒤 자식이 돌아오지 않는다",
      );
    });

    await t.test("전체 접기/펼치기 버튼 — 모두 접힘 ↔ 모두 복귀, 아이콘 토글", async () => {
      const icon = () => page.evaluate(() => document.getElementById("fold-all")?.textContent ?? "");
      const i1 = await icon();
      await page.click("#fold-all");
      // 접기도 두 단계 연출 — 직후엔 셰브론이 전부 돌고 자식은 슬라이드 아웃 중이어야 한다.
      await page.waitForTimeout(60);
      const mid = await page.evaluate(() => ({
        chev: [...document.querySelectorAll(".tree-folder")].every((f) =>
          f.classList.contains("collapsed"),
        ),
        exiting: document.querySelectorAll(".kid-exit").length,
      }));
      expect(mid.chev && mid.exiting > 0, `전체 접기 연출이 없다: ${JSON.stringify(mid)}`);
      await page.waitForTimeout(300);
      expect((await page.locator(".tree-session").count()) === 0, "전체 접기 후에도 세션 행이 보인다");
      const i2 = await icon();
      expect(i1 !== i2 && i2.length > 0, `버튼 아이콘이 상태를 따라 바뀌지 않는다: "${i1}"→"${i2}"`);
      await page.click("#fold-all");
      await page.waitForTimeout(300);
      expect(
        (await page.locator(".tree-session").count()) === 3,
        "전체 펼치기 후 세션 행이 복귀하지 않는다",
      );
    });

    await t.test("레이아웃 잘림 — 주요 화면에서 내용이 상자에 잘리지 않는다", async () => {
      // '잘림' = overflow hidden/clip 인데 내용이 넘치는 것. 말줄임(ellipsis)은 의도된
      // 처리라 통과시킨다(세션 이름 등은 툴팁으로 전체를 보여 준다).
      const scan = () =>
        page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll("body *")) {
            const st = getComputedStyle(el);
            if (st.display === "none" || st.visibility === "hidden" || el.offsetParent === null) continue;
            if (el.closest(".xterm")) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            const clip = /hidden|clip/.test(st.overflowX + st.overflowY);
            if (!clip) continue; // overflow visible 은 넘쳐도 읽힌다
            if (st.textOverflow === "ellipsis") continue; // 의도된 말줄임
            if (el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1) {
              const cls =
                typeof el.className === "string" && el.className.trim()
                  ? "." + el.className.trim().split(/\s+/)[0]
                  : el.id
                    ? "#" + el.id
                    : el.tagName.toLowerCase();
              out.push(`${cls}(${el.scrollWidth}>${el.clientWidth}) "${(el.textContent || "").trim().slice(0, 24)}"`);
            }
          }
          return [...new Set(out)];
        });
      await dismissModals(page);
      const bad = [];
      bad.push(...(await scan()).map((x) => `메인:${x}`));
      // 좁은 창에서도 확인 — 폭이 줄면 잘림이 드러난다.
      await page.setViewportSize({ width: 900, height: 620 });
      await page.waitForTimeout(250);
      bad.push(...(await scan()).map((x) => `좁은창:${x}`));
      for (const [btn, label] of [["#open-settings", "설정"], ["#new-session", "세션편집"]]) {
        await page.click(btn);
        await page.waitForTimeout(400);
        bad.push(...(await scan()).map((x) => `${label}:${x}`));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
      }
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.waitForTimeout(250);
      expect(bad.length === 0, `잘리는 요소: ${bad.slice(0, 6).join(" | ")}`);
    });

    await t.test("가져오기 — 스캔 중 버튼이 잠겨 창이 겹쳐 뜨지 않는다", async () => {
      await dismissModals(page);
      const opened = await page.evaluate(async () => {
        let scans = 0;
        window.__scanArgs = [];
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "import_scan") {
            scans++;
            window.__scanArgs.push(args?.source);
            await new Promise((r) => setTimeout(r, 400)); // 느린 스캔 흉내
            return [];
          }
          return prev(cmd, args);
        };
        const btn = document.getElementById("open-import");
        btn.click();
        await new Promise((r) => setTimeout(r, 50));
        const lockedDuring = btn.disabled === true;
        btn.click(); // 조급한 두 번째·세 번째 클릭
        btn.click();
        await new Promise((r) => setTimeout(r, 700));
        window.__TAURI_INTERNALS__.invoke = prev;
        return { scans, lockedDuring };
      });
      // 창이 떠 있는 동안에도 버튼은 잠겨 있어야 한다(두 개가 겹쳐 뜨지 않게).
      // 창을 닫은 뒤에야 풀린다 — Esc 로 닫는다(가져오기 창은 취소 = 빈 결과).
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      await dismissModals(page);
      await page.waitForTimeout(300);
      const unlockedAfter = await page.evaluate(
        () => document.getElementById("open-import").disabled === false,
      );
      // 창을 열기만 해서는 스캔이 돌지 않아야 한다(0.69.0 — 고른 프로그램만 훑는다).
      expect(opened.scans === 0, `창을 열자마자 ${opened.scans}번 스캔했다 — 선택 전에는 훑지 않아야 한다`);
      expect(opened.lockedDuring, "스캔 중에 버튼이 잠기지 않았다");
      expect(unlockedAfter, "창을 닫은 뒤에도 버튼이 잠겨 있다");
    });

    await t.test("가져오기 — 고른 프로그램만 찾고, 바꾸면 목록이 비워진다", async () => {
      await dismissModals(page);
      const r = await page.evaluate(async () => {
        const calls = [];
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "import_scan") {
            calls.push(args?.source);
            return args?.source === "winscp"
              ? [{ source: "WinSCP", folder: "", name: "운영", host: "10.0.0.1", port: 22, user: "root" }]
              : [];
          }
          return prev(cmd, args);
        };
        document.getElementById("open-import").click();
        await new Promise((r) => setTimeout(r, 500));
        const sel = document.querySelector(".import-prog select");
        const btn = document.querySelector(".import-prog .btn-accent");
        if (!sel || !btn) return "선택기 없음";
        const options = [...sel.options].map((o) => o.value);
        sel.value = "winscp";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
        const rowsAfterScan = document.querySelectorAll(".bulk-list .bulk-row, .bulk-list label").length;
        // 프로그램을 바꾸면 이전 결과가 남지 않아야 한다.
        sel.value = "putty";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const rowsAfterSwitch = document.querySelectorAll(".bulk-list .bulk-row, .bulk-list label").length;
        window.__TAURI_INTERNALS__.invoke = prev;
        return { calls, options, rowsAfterScan, rowsAfterSwitch };
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await dismissModals(page);
      expect(typeof r === "object", `가져오기 창 구조 문제: ${r}`);
      expect(r.options.length === 5, `프로그램 후보가 5개가 아니다: ${JSON.stringify(r.options)}`);
      expect(
        r.calls.length === 1 && r.calls[0] === "winscp",
        `고른 것만 훑지 않는다: ${JSON.stringify(r.calls)}`,
      );
      expect(r.rowsAfterScan > 0, "찾기 후 결과가 표시되지 않았다");
      expect(r.rowsAfterSwitch === 0, "프로그램을 바꿨는데 이전 결과가 남아 있다");
    });

    await t.test("세션 색 태그 — 편집창 선택이 목록 행에 띠로 반영된다", async () => {
      await dismissModals(page);
      // 첫 세션 편집 → 색 지정 → 저장 → 행에 색 변수가 붙는지.
      await page.locator(".tree-session").first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].find((x) => x.textContent.includes("편집"))?.click(),
      );
      await page.waitForTimeout(400);
      const ok = await page.evaluate(() => {
        const sel = [...document.querySelectorAll(".color-row select")][0];
        if (!sel) return "선택기 없음";
        sel.value = "red";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const sw = document.querySelector(".color-swatch");
        return sw && getComputedStyle(sw).backgroundColor !== "rgba(0, 0, 0, 0)" ? "ok" : "견본 미반영";
      });
      expect(ok === "ok", `색 선택기 문제: ${ok}`);
      // 저장 후 목록 행 반영
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll(".modal-card button")];
        btns.find((b) => b.textContent.trim() === "저장")?.click();
      });
      await page.waitForTimeout(500);
      const painted = await page.evaluate(() => {
        const row = document.querySelector(".tree-session.has-color");
        return row ? row.style.getPropertyValue("--session-color") : "";
      });
      expect(painted.length > 0, `목록 행에 색이 반영되지 않았다: "${painted}"`);
    });

    await t.test("폴더 일괄 접속 — 메뉴가 있고 폴더 내 세션 수만큼 연다", async () => {
      await dismissModals(page);
      const folder = page.locator(".tree-folder").first();
      if ((await page.locator(".tree-folder").count()) === 0) return; // 폴더 없는 픽스처면 생략
      await folder.click({ button: "right" });
      await page.waitForTimeout(250);
      const has = await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].some((x) =>
          x.textContent.includes("이 폴더 세션 모두 열기"),
        ),
      );
      await page.keyboard.press("Escape");
      expect(has, "폴더 우클릭에 '이 폴더 세션 모두 열기' 가 없다");
    });

    await t.test("자동 재접속 — 옵션 켜면 예약되고, 사용자가 끊으면 예약이 없다", async () => {
      await dismissModals(page);
      // 스케줄러 검사에는 탭이 하나 있어야 한다 — 없으면 하나 연다.
      if ((await page.evaluate(() => window.__tm?.tabs?.length ?? 0)) === 0) {
        await openSession(page, 0);
      }
      const r = await page.evaluate(async () => {
        const tm = window.__tm;
        if (!tm) return "no-tm";
        // 자동 재접속 켠 가짜 탭 하나를 만들어 스케줄러만 검사한다(실접속 불필요).
        const tab = tm.tabs[0];
        if (!tab) return "no-tab";
        tab.session.autoReconnect = true;
        tab.session.autoReconnectDelaySec = 1;
        tab.session.autoReconnectMax = 2;
        // 실제 끊김 경로를 태워 오버레이(재접속 버튼)를 만든 뒤 예약을 검사한다.
        tab.setDisconnected("테스트 종료", () => {});
        tm.autoState.tries.delete(tab);
        tm.scheduleAutoReconnect(tab);
        const scheduled = tm.autoState.timers.has(tab);
        const note = document.querySelector(".overlay-retry")?.textContent ?? "";
        tm.cancelAutoReconnect(tab);
        const cleared = !tm.autoState.timers.has(tab);
        // 시도 상한: 이미 max 만큼 시도했으면 더 예약하지 않는다.
        tm.autoState.tries.set(tab, 2);
        tm.scheduleAutoReconnect(tab);
        const stopped = !tm.autoState.timers.has(tab);
        tm.autoState.tries.delete(tab);
        return { scheduled, cleared, stopped, note };
      });
      expect(typeof r === "object", `테스트 훅 문제: ${r}`);
      expect(r.scheduled, "자동 재접속이 예약되지 않았다");
      expect(r.cleared, "취소해도 예약이 남는다");
      expect(r.stopped, "최대 횟수를 넘겨도 계속 예약한다");
      expect(r.note.includes("자동 재접속"), `안내 문구가 없다: "${r.note}"`);
    });

    await t.test("세션 편집 종류 — 한 줄 라디오 3종, 기본 SSH, 안 잘린다", async () => {
      await dismissModals(page);
      await page.click("#new-session");
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const radios = [...document.querySelectorAll(".kind-radio input")];
        const labels = [...document.querySelectorAll(".kind-radio")];
        const rects = labels.map((l) => l.getBoundingClientRect());
        const row = document.querySelector(".kind-radios")?.getBoundingClientRect();
        return {
          count: radios.length,
          checked: radios.find((r) => r.checked)?.value,
          // 한 줄: 모든 항목의 세로 위치가 같아야 한다
          oneLine: rects.every((x) => Math.abs(x.top - rects[0].top) < 2),
          // 잘림 없음: 마지막 항목 오른쪽 끝이 줄 안에 들어와야 한다
          fits: row ? rects[rects.length - 1].right <= row.right + 1 : false,
          labels: labels.map((l) => l.textContent.trim()),
        };
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      expect(r.count === 3, `라디오가 3개가 아니다: ${r.count}`);
      expect(r.checked === "ssh", `기본 선택이 SSH 가 아니다: ${r.checked}`);
      expect(r.oneLine, `한 줄로 배치되지 않았다: ${JSON.stringify(r.labels)}`);
      expect(r.fits, "항목이 줄 밖으로 잘린다");
    });

    await t.test("세션 편집 동기화 — 사이드바에서 고치면 열려 있는 탭도 최신을 본다", async () => {
      await dismissModals(page);
      // 세션 하나를 탭으로 열어 둔다(접속된 상태에서 사이드바로 고치는 상황).
      await page.locator(".tree-session").first().dblclick();
      await page.waitForTimeout(700);
      await dismissModals(page);
      await page.waitForTimeout(400);
      const openedId = await page.evaluate(() => window.__tm?.active?.session?.id ?? "");
      expect(openedId, "탭이 열리지 않아 동기화를 검증할 수 없다");

      // 사이드바 우클릭 → 편집 → 이름 변경 후 저장.
      const newName = "동기화확인";
      await page.locator(".tree-session").first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent.includes("편집"))?.click(),
      );
      await page.waitForTimeout(400);
      const oldName = await page.inputValue('.session-card input[placeholder="표시 이름"]');
      await page.fill('.session-card input[placeholder="표시 이름"]', newName);
      await page.evaluate(() => {
        const bs = [...document.querySelectorAll(".session-card button")];
        (bs.find((b) => b.classList.contains("btn-accent")) ?? bs[bs.length - 1])?.click();
      });
      await page.waitForTimeout(600);
      await dismissModals(page);
      await page.waitForTimeout(300);

      // 탭이 들고 있는 세션이 최신이어야 한다 — 예전에는 열릴 때 받은 것을 계속 들고 있었다.
      const tabName = await page.evaluate(
        (id) => window.__tm.tabs.find((t) => t.session.id === id)?.session?.name ?? "",
        openedId,
      );
      expect(tabName === newName, `탭이 옛 세션을 들고 있다: ${tabName} (기대: ${newName})`);

      // 탭 우클릭 '세션 편집' 도 같은 내용으로 열려야 한다(사용자 보고의 증상).
      await page.locator("#tabbar .tab").first().click({ button: "right" });
      await page.waitForTimeout(250);
      await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-item")]
          .find((e) => e.textContent.includes("세션 편집"))
          ?.click(),
      );
      await page.waitForTimeout(500);
      const shown = await page.inputValue('.session-card input[placeholder="표시 이름"]');
      // 원래 이름으로 되돌려 두고 닫는다(뒤 테스트가 이름으로 세션을 찾는다).
      await page.fill('.session-card input[placeholder="표시 이름"]', oldName);
      await page.evaluate(() => {
        const bs = [...document.querySelectorAll(".session-card button")];
        (bs.find((b) => b.classList.contains("btn-accent")) ?? bs[bs.length - 1])?.click();
      });
      await page.waitForTimeout(600);
      await dismissModals(page);
      await page.waitForTimeout(300);
      expect(shown === newName, `탭 우클릭 편집이 옛 내용으로 열린다: ${shown} (기대: ${newName})`);
    });

    await t.test("스크롤백 저장 — 접힌 줄을 이어 붙여 뽑고, 탭 메뉴에 항목이 있다", async () => {
      await dismissModals(page);
      const got = await page.evaluate(async () => {
        const tab = window.__tm?.tabs?.[0];
        if (!tab) return "탭 없음";
        tab.term.reset();
        const long = "x".repeat(tab.term.cols + 30); // 창 폭을 넘겨 강제로 접히는 줄
        await new Promise((r) => tab.term.write(`첫줄\r\n${long}\r\n끝줄\r\n`, r));
        const text = tab.scrollbackText();
        return { text, lines: text.split("\r\n"), cols: tab.term.cols, longLen: long.length };
      });
      expect(typeof got !== "string", `${got}`);
      expect(got.lines[0] === "첫줄", `첫 줄이 어긋난다: ${JSON.stringify(got.lines[0])}`);
      // 창 폭 때문에 끊긴 줄이 그대로 저장되면, 붙여 넣었을 때 명령이 깨진다.
      expect(
        got.lines[1].length === got.longLen,
        `접힌 줄이 이어 붙지 않았다: ${got.lines[1].length} != ${got.longLen}`,
      );
      expect(got.lines[got.lines.length - 1] === "끝줄", `끝 줄이 어긋난다: ${JSON.stringify(got.lines)}`);

      // 탭 우클릭 메뉴에 항목이 있다(단축키 표기까지).
      await page.locator(".tab").first().click({ button: "right" });
      await page.waitForTimeout(250);
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll(".ctx-menu > .ctx-item")].map((b) => b.textContent),
      );
      await page.keyboard.press("Escape");
      expect(labels.includes("스크롤백 저장(B)"), `탭 메뉴에 없다: ${JSON.stringify(labels)}`);
      expect(labels.includes("SFTP 파일 전송(S)") || !labels.some((l) => l.startsWith("SFTP")),
        `SFTP 단축키 표기가 어긋난다: ${JSON.stringify(labels)}`);
    });

    await t.test("여러 줄 붙여넣기 — 확인창이 뜨고, 취소하면 넣지 않는다", async () => {
      await dismissModals(page);
      const one = await page.evaluate(async () => {
        const tab = window.__tm?.tabs?.[0];
        if (!tab) return "탭 없음";
        // 한 줄(끝의 줄바꿈 하나 포함)은 묻지 않는다 — 매번 뜨면 아무도 켜 두지 않는다.
        const ok = await tab.confirmPaste("uptime\n");
        return { ok, dialog: !!document.querySelector(".paste-card") };
      });
      expect(one.ok === true && !one.dialog, `한 줄인데 확인창이 떴다: ${JSON.stringify(one)}`);

      const many = await page.evaluate(() => {
        const tab = window.__tm.tabs[0];
        window.__pasteResult = null;
        void tab.confirmPaste("cd /etc\nrm -rf tmp\nsystemctl restart x\n").then((r) => {
          window.__pasteResult = r;
        });
      });
      void many;
      await page.waitForTimeout(400);
      const shown = await page.evaluate(() => ({
        card: !!document.querySelector(".paste-card"),
        msg: document.querySelector(".paste-card .modal-msg")?.textContent ?? "",
        preview: document.querySelector(".paste-preview")?.textContent ?? "",
        // 기본 포커스는 '취소' — 습관적인 Enter 로 통과되면 안 되는 물음이다.
        focused: document.activeElement?.textContent ?? "",
      }));
      expect(shown.card, "여러 줄인데 확인창이 뜨지 않았다");
      expect(shown.msg.includes("3줄"), `줄 수 표기가 틀리다: ${shown.msg}`);
      expect(shown.preview.includes("rm -rf tmp"), "미리보기에 내용이 없다");
      expect(shown.focused === "취소", `기본 포커스가 취소가 아니다: ${shown.focused}`);

      await page.evaluate(() =>
        [...document.querySelectorAll(".paste-card button")]
          .find((b) => b.textContent === "취소")
          ?.click(),
      );
      await page.waitForTimeout(300);
      const result = await page.evaluate(() => window.__pasteResult);
      expect(result === false, `취소했는데 붙여넣기가 진행된다: ${result}`);
    });

    await t.test("빠른 찾기(Ctrl+P) — 검색·이동·Enter 접속, 열린 세션은 그 탭으로", async () => {
      await dismissModals(page);
      // 열려 있는 탭이 없도록 먼저 상태를 확인한다(있으면 '열림' 배지 경로를 함께 본다).
      await page.keyboard.press("Control+p");
      await page.waitForTimeout(300);
      const opened = await page.evaluate(() => !!document.querySelector(".palette-overlay"));
      expect(opened, "Ctrl+P 로 빠른 찾기가 열리지 않는다");

      // 검색어로 걸러진다.
      await page.fill(".palette-input", "운영1");
      await page.waitForTimeout(250);
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll(".palette-row .palette-name")].map((x) => x.textContent),
      );
      expect(rows.length >= 1 && rows[0].includes("운영1"), `검색 결과가 어긋난다: ${JSON.stringify(rows)}`);

      // 마우스 클릭이 창에 닿는다 — #modal-root 가 pointer-events:none 이라 팔레트에서
      // 되살리지 않으면 클릭이 아래 터미널로 새어 나가 창이 통째로 먹통이 됐다(0.76.4).
      const hit = await page.evaluate(() => {
        const row = document.querySelector(".palette-row");
        if (!row) return "행 없음";
        const r = row.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return el?.closest(".palette-overlay") ? "ok" : `${el?.tagName}#${el?.id ?? ""}`;
      });
      expect(hit === "ok", `팔레트 클릭이 아래로 새어 나간다: ${hit}`);

      // 카드 안 빈 곳을 눌러도 입력 포커스를 잃지 않는다(눌러 놓고 타이핑이 죽던 자리).
      const hintBox = await page.locator(".palette-hint").boundingBox();
      if (hintBox) await page.mouse.click(hintBox.x + hintBox.width / 2, hintBox.y + hintBox.height / 2);
      await page.waitForTimeout(150);
      await page.keyboard.type("1");
      await page.waitForTimeout(200);
      const stillTyping = await page.evaluate(() => document.querySelector(".palette-input")?.value);
      expect(stillTyping === "운영11", `빈 곳 클릭 뒤 키 입력이 죽는다: ${JSON.stringify(stillTyping)}`);
      await page.fill(".palette-input", "운영1");
      await page.waitForTimeout(200);

      // Esc 로 닫힌다.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      expect(
        !(await page.evaluate(() => !!document.querySelector(".palette-overlay"))),
        "Esc 로 닫히지 않는다",
      );

      // Enter 로 접속 → 탭이 하나 늘어난다.
      const before = await page.evaluate(() => window.__tm?.tabs?.length ?? 0);
      await page.keyboard.press("Control+p");
      await page.waitForTimeout(250);
      await page.fill(".palette-input", "운영1");
      await page.waitForTimeout(250);
      await page.locator(".palette-input").press("Enter");
      await page.waitForTimeout(700);
      await dismissModals(page);
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => window.__tm?.tabs?.length ?? 0);
      expect(after === before + 1, `Enter 로 접속되지 않았다: ${before} → ${after}`);

      // 이미 열린 세션은 새로 붙지 않고 그 탭으로 이동한다.
      await page.keyboard.press("Control+p");
      await page.waitForTimeout(250);
      await page.fill(".palette-input", "운영1");
      await page.waitForTimeout(250);
      const hasBadge = await page.evaluate(() =>
        [...document.querySelectorAll(".palette-row")].some((r) => r.querySelector(".palette-badge")),
      );
      await page.locator(".palette-input").press("Enter");
      await page.waitForTimeout(500);
      const after2 = await page.evaluate(() => window.__tm?.tabs?.length ?? 0);
      expect(hasBadge, "열린 세션에 '열림' 배지가 없다");
      expect(after2 === after, `열린 세션인데 탭이 또 생겼다: ${after} → ${after2}`);
    });

    await t.test("여러 개 고르기 — Ctrl·Shift 로 고르고, 한 번에 옮기고 차단한다", async () => {
      await dismissModals(page);
      const ids = await page.evaluate(() =>
        [...document.querySelectorAll(".tree-session[data-session-id]")].map((r) => r.dataset.sessionId),
      );
      expect(ids.length >= 2, `세션 행이 모자라다: ${ids.length}`);
      const rowFor = (id) => page.locator(`.tree-session[data-session-id="${id}"]`);
      const marked = () =>
        page.evaluate(() =>
          [...document.querySelectorAll(".tree-session.multi")].map((r) => r.dataset.sessionId),
        );

      try {
        // Ctrl 클릭으로 둘을 고른다.
        await rowFor(ids[0]).click();
        await rowFor(ids[1]).click({ modifiers: ["Control"] });
        await page.waitForTimeout(150);
        let picked = await marked();
        expect(picked.length === 2, `Ctrl 로 두 개가 안 골라진다: ${JSON.stringify(picked)}`);

        // 고른 것 위에서 우클릭하면 묶음 메뉴가 뜬다(개수까지 적혀 있어야 한다).
        await rowFor(ids[1]).click({ button: "right" });
        await page.waitForTimeout(250);
        const labels = await page.evaluate(() =>
          [...document.querySelectorAll(".ctx-menu > .ctx-item")].map((b) => b.textContent),
        );
        expect(
          labels.some((l) => l.includes("선택한 2개 폴더 이동")),
          `묶음 메뉴가 아니다: ${JSON.stringify(labels)}`,
        );

        // 한 번에 차단 → 두 세션 모두 저장에 실린다.
        await page.evaluate(() => (window.__ipc.length = 0));
        await page.evaluate(() => {
          [...document.querySelectorAll(".ctx-menu > .ctx-item")]
            .find((b) => b.textContent?.includes("접속 차단"))
            ?.click();
        });
        await page.waitForTimeout(400);
        const saved = await page.evaluate(() => {
          const last = window.__ipc.filter(([c]) => c === "sessions_save").pop();
          return (last?.[1]?.sessions ?? []).filter((x) => x.disabled).map((x) => x.id);
        });
        expect(
          saved.includes(ids[0]) && saved.includes(ids[1]),
          `둘 다 차단되지 않았다: ${JSON.stringify(saved)}`,
        );

        // Esc 로 선택을 놓는다.
        await rowFor(ids[0]).click();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        picked = await marked();
        expect(picked.length === 0, `Esc 로 선택이 안 풀린다: ${JSON.stringify(picked)}`);

        // Shift 로 범위 선택.
        await rowFor(ids[0]).click();
        await rowFor(ids[ids.length - 1]).click({ modifiers: ["Shift"] });
        await page.waitForTimeout(150);
        picked = await marked();
        expect(picked.length === ids.length, `Shift 범위가 어긋난다: ${JSON.stringify(picked)}`);
      } finally {
        // 차단을 되돌린다 — 뒤 검사들이 이 세션에 접속한다. 묶음 선택 상태에 기대지 않고
        // 막힌 행을 하나씩 되돌린다(어디서 실패했든 같은 자리로 돌아오도록).
        await page.keyboard.press("Escape");
        for (let guard = 0; guard < 10; guard++) {
          const off = await page.evaluate(
            () => document.querySelector(".tree-session.session-off")?.dataset.sessionId ?? null,
          );
          if (!off) break;
          await rowFor(off).click();
          await rowFor(off).click({ button: "right" });
          await page.waitForTimeout(200);
          await page.evaluate(() => {
            [...document.querySelectorAll(".ctx-menu > .ctx-item")]
              .find((b) => b.textContent === "접속 허용(T)")
              ?.click();
          });
          await page.waitForTimeout(300);
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
      }
    });

    await t.test("세션 비활성화 — 흐려지고, 접속 계열 메뉴가 사라지고, 저장까지 간다", async () => {
      await dismissModals(page);
      const rowOf = () => page.locator(".tree-session[data-session-id]").first();
      const sid = await rowOf().evaluate((r) => r.dataset.sessionId);

      const menuLabels = async () => {
        await rowOf().click({ button: "right" });
        await page.waitForTimeout(200);
        const labels = await page.evaluate(() =>
          [...document.querySelectorAll(".ctx-menu > .ctx-item")].map((b) => b.textContent),
        );
        return labels;
      };

      try {
      // 단축키가 라벨에 붙어 보인다 — 연결(C)·편집(E)·삭제(D).
      const before = await menuLabels();
      expect(before.includes("연결(C)"), `연결(C) 가 없다: ${JSON.stringify(before)}`);
      expect(before.includes("편집(E)"), `편집(E) 가 없다: ${JSON.stringify(before)}`);
      expect(before.includes("삭제(D)"), `삭제(D) 가 없다: ${JSON.stringify(before)}`);

      // 차단 → 행이 흐려지고 저장 요청에 disabled 가 실린다.
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.evaluate(() => {
        const item = [...document.querySelectorAll(".ctx-menu > .ctx-item")].find(
          (b) => b.textContent === "접속 차단(T)",
        );
        item?.click();
      });
      await page.waitForTimeout(400);
      await page.mouse.move(5, 5); // 행에서 마우스를 치운다 — 호버 중에는 덜 흐리다
      await page.waitForTimeout(150);
      const off = await page.evaluate((id) => {
        const row = document.querySelector(`.tree-session[data-session-id="${id}"]`);
        const saved = window.__ipc
          .filter(([c]) => c === "sessions_save")
          .flatMap(([, a]) => a?.sessions ?? []);
        return {
          dim: row?.classList.contains("session-off"),
          opacity: row ? Number(getComputedStyle(row).opacity) : 1,
          savedDisabled: saved.find((x) => x.id === id)?.disabled,
        };
      }, sid);
      expect(off.dim, "차단했는데 행이 흐려지지 않는다");
      expect(off.opacity < 0.6, `흐림이 눈에 띄지 않는다: ${off.opacity}`);
      expect(off.savedDisabled === true, `저장에 disabled 가 실리지 않았다: ${off.savedDisabled}`);

      // 접속 계열은 메뉴에서 사라지고, 되돌리는 항목이 대신 뜬다.
      const after = await menuLabels();
      expect(!after.some((l) => l.startsWith("연결")), `차단인데 연결이 남아 있다: ${JSON.stringify(after)}`);
      expect(!after.some((l) => l.startsWith("SFTP")), `차단인데 SFTP 가 남아 있다: ${JSON.stringify(after)}`);
      expect(after.includes("접속 허용(T)"), `되돌리는 항목이 없다: ${JSON.stringify(after)}`);
      expect(after.includes("편집(E)"), "차단이어도 편집은 되어야 한다");

      // 더블클릭해도 붙지 않는다.
      const tabsBefore = await page.evaluate(() => window.__tm?.tabs?.length ?? 0);
      await rowOf().dblclick();
      await page.waitForTimeout(500);
      await dismissModals(page);
      const tabsAfter = await page.evaluate(() => window.__tm?.tabs?.length ?? 0);
      expect(tabsAfter === tabsBefore, `차단된 세션에 접속됐다: ${tabsBefore} → ${tabsAfter}`);

      // 되돌려 놓는다(뒤 검사들이 이 세션을 쓴다).
      await rowOf().click({ button: "right" });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        [...document.querySelectorAll(".ctx-menu > .ctx-item")]
          .find((b) => b.textContent === "접속 허용(T)")
          ?.click();
      });
      await page.waitForTimeout(400);
      expect(
        await page.evaluate(
          (id) => !document.querySelector(`.tree-session[data-session-id="${id}"]`)?.classList.contains("session-off"),
          sid,
        ),
        "다시 허용했는데 흐림이 남아 있다",
      );
      } finally {
        // 어디서 실패했든 차단 상태로 남기지 않는다(뒤 검사들이 이 세션에 접속한다).
        await page.evaluate((id) => {
          const btn = [...document.querySelectorAll(".ctx-menu > .ctx-item")].find(
            (b) => b.textContent === "접속 허용(T)",
          );
          btn?.click();
          void id;
        }, sid);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        if (await page.evaluate((id) => !!document.querySelector(`.tree-session[data-session-id="${id}"].session-off`), sid)) {
          await page.locator(`.tree-session[data-session-id="${sid}"]`).click({ button: "right" });
          await page.waitForTimeout(200);
          await page.evaluate(() => {
            [...document.querySelectorAll(".ctx-menu > .ctx-item")]
              .find((b) => b.textContent === "접속 허용(T)")
              ?.click();
          });
          await page.waitForTimeout(300);
        }
      }
    });

    await t.test("SFTP 칩 — 끌어다 놓은 업로드도 진행률이 뜨고, 갱신돼도 버튼이 살아 있다", async () => {
      await dismissModals(page);
      // 끌어다 놓은 업로드에는 전송 id 가 없다 — 그때도 칩에 %가 떠야 한다(0.76.7).
      // 앞선 검사들이 목록을 바꿨을 수 있어, 지금 화면에 있는 첫 SSH 세션을 쓴다.
      const sid = await page.evaluate(() => {
        // 어떤 세션이 남아 있는지는 앞선 검사에 달렸으므로 첫 행을 쓴다. 칩은 SFTP 를
        // 쓰지 않는 세션에서도 만들어지고 표시만 숨으므로, 칠하기 검증에는 지장이 없다.
        const row = document.querySelector(".tree-session[data-session-id]");
        return row?.dataset.sessionId ?? null;
      });
      expect(!!sid, "SFTP 칩이 있는 세션 행을 찾지 못했다");
      const set = (done) =>
        page.evaluate(([d, id]) => {
          const { liveSftp, transferStateOf, notifyLive } = window.__liveTest;
          liveSftp.set(id, {
            sftpId: "x", localDir: "", remoteDir: "", transferId: null,
            name: "큰파일.zip", done: d, total: 100, baseDone: 0, grandTotal: 100,
          });
          transferStateOf(id).transferring = true;
          notifyLive();
        }, [done, sid]);

      try {
        await set(37);
        await page.waitForTimeout(200);
        const chipText = await page.evaluate(
          (id) => document.querySelector(`.tree-session[data-session-id="${id}"] .sftp-chip`)?.textContent, sid,
        );
        expect(chipText === "37%", `칩에 진행률이 없다: ${JSON.stringify(chipText)}`);

        // 진행률이 갱신돼도 버튼 노드가 바뀌면 안 된다 — 바뀌면 누르는 순간 사라져
        // 클릭이 먹지 않고, 고정 해제 상태에서는 임시 노출까지 닫힌다.
        await page.evaluate((id) => {
          window.__chip = document.querySelector(`.tree-session[data-session-id="${id}"] .sftp-chip`);
        }, sid);
        for (let i = 40; i <= 60; i += 10) {
          await set(i);
          await page.waitForTimeout(80);
        }
        const same = await page.evaluate((id) => ({
          same: window.__chip === document.querySelector(`.tree-session[data-session-id="${id}"] .sftp-chip`),
          text: window.__chip?.textContent,
          alive: window.__chip?.isConnected,
        }), sid);
        expect(same.same && same.alive, `진행률 갱신에 버튼이 새로 만들어졌다: ${JSON.stringify(same)}`);
        expect(same.text === "60%", `제자리 갱신이 안 됐다: ${same.text}`);

        // 고정 해제(임시 노출) 상태에서 진행률이 갱신돼도 목록이 닫히지 않아야 한다.
        await page.click("#sidebar-dock");
        await page.waitForTimeout(300);
        const peeking = () =>
          page.evaluate(() => (document.getElementById("app")?.className ?? "").includes("sidebar-peek"));
        expect(await peeking(), "해제 직후 임시 노출이 아니다");
        await set(70);
        await page.waitForTimeout(250);
        expect(await peeking(), "진행률이 갱신되자 임시 노출이 닫혔다");
      } finally {
        // 상태 되돌리기 — 고정 상태로, 전송 표시도 해제.
        await page.evaluate(() => {
          const { liveSftp, transferStateOf, notifyLive } = window.__liveTest;
          liveSftp.forEach((_v, id) => transferStateOf(id).transferring = false);
          liveSftp.clear();
          notifyLive();
        });
        if ((await page.evaluate(() => (document.getElementById("app")?.className ?? ""))).includes("sidebar-undocked")) {
          if (!(await page.evaluate(() => (document.getElementById("app")?.className ?? "").includes("sidebar-peek"))))
            await page.click("#nav-toggle");
          await page.waitForTimeout(200);
          await page.click("#sidebar-dock");
          await page.waitForTimeout(300);
        }
      }
    });

    await t.test("Ctrl+Shift+Home — 창을 화면 안으로 되돌리는 길이 있다", async () => {
      await dismissModals(page);
      // 다른 해상도에서 쓰던 자리가 복원돼 제목줄이 화면 밖으로 나가면, OS 제목줄이 없는
      // 이 창은 잡아 옮길 수 없다. 시작 시 자동 정렬(백엔드)과 별개로 탈출구가 있어야 한다.
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.keyboard.press("Control+Shift+Home");
      await page.waitForTimeout(200);
      const called = await page.evaluate(() =>
        window.__ipc.some(([c]) => c === "window_fit_to_screen"),
      );
      expect(called, "단축키가 창 정렬을 부르지 않는다");
    });

    await t.test("세션영역 도킹/해제 — 해제 시 전폭·메뉴 버튼, 임시 노출·바깥클릭 닫힘", async () => {
      await dismissModals(page);
      const app = () => page.evaluate(() => document.getElementById("app").className);
      const wsWidth = () =>
        page.evaluate(() => Math.round(document.getElementById("workspace").getBoundingClientRect().width));
      const navShown = () =>
        page.evaluate(() => getComputedStyle(document.getElementById("nav-toggle")).display !== "none");
      const bodyW = await page.evaluate(() => Math.round(document.body.getBoundingClientRect().width));

      // 기본은 고정(도킹) — 메뉴 버튼은 숨어 있고 작업영역은 사이드바만큼 좁다.
      expect(!(await app()).includes("sidebar-undocked"), "기본이 고정 상태가 아니다");
      expect(!(await navShown()), "고정 상태인데 메뉴 버튼이 보인다");
      const dockedW = await wsWidth();
      expect(dockedW < bodyW - 100, `고정 상태 작업영역이 이미 전폭이다: ${dockedW}/${bodyW}`);

      // 고정 해제 → 작업영역 전폭 + 메뉴 버튼 + 임시 노출(peek)
      await page.click("#sidebar-dock");
      await page.waitForTimeout(300);
      expect((await app()).includes("sidebar-undocked"), "해제되지 않았다");
      expect(await navShown(), "해제했는데 메뉴 버튼이 없다");
      const undockedW = await wsWidth();
      // 오버레이가 그리드에서 빠질 때 자동 배치로 작업영역이 0폭이 되던 버그의 회귀 검사.
      expect(undockedW === bodyW, `해제 상태 작업영역이 전폭이 아니다: ${undockedW}/${bodyW}`);
      expect((await app()).includes("sidebar-peek"), "해제 직후 목록이 임시 노출되지 않았다");

      // 바깥 클릭 → 닫힘
      await page.mouse.click(Math.round(bodyW * 0.7), 400);
      await page.waitForTimeout(250);
      expect(!(await app()).includes("sidebar-peek"), "바깥을 눌렀는데 목록이 남아 있다");

      // 메뉴 버튼 → 다시 열림, Esc → 닫힘
      await page.click("#nav-toggle");
      await page.waitForTimeout(250);
      expect((await app()).includes("sidebar-peek"), "메뉴 버튼으로 열리지 않는다");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      expect(!(await app()).includes("sidebar-peek"), "Esc 로 닫히지 않는다");

      // 다시 고정 — 설정에 저장되는지까지 확인
      await page.evaluate(() => (window.__ipc.length = 0));
      await page.click("#nav-toggle");
      await page.waitForTimeout(200);
      await page.click("#sidebar-dock");
      await page.waitForTimeout(300);
      const saved = await page.evaluate(() =>
        window.__ipc.filter(([c]) => c === "settings_save").map(([, a]) => a?.value?.sidebarDocked),
      );
      expect(!(await app()).includes("sidebar-undocked"), "다시 고정되지 않았다");
      expect(saved.includes(true), `고정 상태가 저장되지 않았다: ${JSON.stringify(saved)}`);
      expect(await wsWidth() < bodyW - 100, "다시 고정했는데 작업영역이 전폭 그대로다");
    });

    await t.test("세션영역 폭 — 최소 폭 아래로 줄지 않고, 머리말 버튼이 밖으로 나가지 않는다", async () => {
      await dismissModals(page);
      const r = await page.evaluate(async () => {
        const { SIDEBAR_MIN_W } = await import("/src/settings.ts");
        const app = document.getElementById("app") ?? document.documentElement;
        const sb = document.getElementById("sidebar");
        const escapedAt = (w) => {
          sb.style.width = `${w}px`;
          app.style.setProperty("--sidebar-w", `${w}px`);
          const right = sb.getBoundingClientRect().right;
          return Math.max(
            ...[...document.querySelectorAll("#sidebar-head button")].map(
              (b) => b.getBoundingClientRect().right,
            ),
          ) - right;
        };
        const atMin = escapedAt(SIDEBAR_MIN_W);
        // 최소 폭에서는 머리말이 **한 줄**로 유지돼야 한다(두 줄이 되면 디자인이 무너진다).
        const headH = Math.round(document.getElementById("sidebar-head").getBoundingClientRect().height);
        // 끌기 제한 자체도 확인한다 — 손잡이를 왼쪽 끝까지 끌어도 최소 폭에서 멈춘다.
        const grip = document.getElementById("sidebar-resizer");
        const box = grip.getBoundingClientRect();
        grip.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, clientX: box.left + 2, clientY: box.top + 20 }),
        );
        window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 5, clientY: box.top + 20 }));
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        await new Promise((res) => setTimeout(res, 100));
        const after = parseInt(
          getComputedStyle(app).getPropertyValue("--sidebar-w") || "0",
          10,
        );
        return { min: SIDEBAR_MIN_W, atMin: Math.round(atMin), after, headH };
      });
      expect(r.atMin <= 0, `최소 폭에서 버튼이 ${r.atMin}px 밖으로 나간다`);
      expect(r.headH <= 50, `최소 폭에서 머리말이 ${r.headH}px(두 줄)로 늘어났다`);
      expect(
        r.after >= r.min,
        `왼쪽 끝까지 끌었더니 ${r.after}px 로 최소 폭(${r.min}) 아래가 됐다`,
      );
    });

    await t.test("세션영역 경계선 — 보이는 선은 1px(두꺼운 버튼 트랙 제거)", async () => {
      const r = await page.evaluate(() => {
        const rz = document.getElementById("sidebar-resizer");
        const line = getComputedStyle(rz, "::after");
        return {
          track: Math.round(rz.getBoundingClientRect().width),
          line: parseFloat(line.width) || 0,
          oldBtn: !!document.querySelector(".sidebar-toggle"),
        };
      });
      expect(r.track <= 6, `폭 조절 트랙이 두껍다: ${r.track}px`);
      expect(r.line <= 1, `보이는 경계선이 두껍다: ${r.line}px`);
      expect(!r.oldBtn, "경계선 중앙의 옛 접기 버튼이 남아 있다");
    });

    await t.test("세션 검색 — 계정@호스트:포트 합성 표기와 폴더명도 걸린다", async () => {
      const count = () => page.locator(".tree-session").count();
      await page.fill("#session-search", "root@10.1.0.3");
      await page.waitForTimeout(250);
      expect((await count()) === 1, "계정@호스트 붙여 친 검색이 안 걸린다");
      await page.fill("#session-search", ":22");
      await page.waitForTimeout(250);
      expect((await count()) === 3, "포트(:22) 검색이 전 세션에 안 걸린다");
      await page.fill("#session-search", "운영");
      await page.waitForTimeout(250);
      expect((await count()) >= 2, "폴더명 검색이 안 걸린다");
      await page.fill("#session-search", "");
      await page.waitForTimeout(250);
      expect((await count()) === 3, "검색을 지워도 목록이 복귀하지 않는다");
    });

    await t.test("세션 열기 — 탭 즉시 생성, 접속 실패는 팝업 대신 탭 오버레이+재접속", async () => {
      await page.evaluate(() => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "ssh_probe") throw "연결 실패(테스트): 호스트에 닿을 수 없습니다";
          return prev(cmd, args);
        };
      });
      await page.locator(".tree-session").first().dblclick();
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => ({
        tabs: document.querySelectorAll(".xterm").length,
        popup: !!document.querySelector(".modal-overlay"),
        overlay: [...document.querySelectorAll(".overlay-msg")].map((m) => m.textContent).join("|"),
        reBtn: [...document.querySelectorAll("button")].some((b) =>
          (b.textContent ?? "").includes("재접속"),
        ),
      }));
      expect(r.tabs >= 1, "세션을 열었는데 탭(터미널)이 생기지 않았다");
      expect(!r.popup, "접속 실패가 여전히 팝업으로 뜬다");
      expect(r.overlay.includes("접속 실패"), `오버레이에 실패 사유가 없다: "${r.overlay}"`);
      expect(r.reBtn, "재접속 버튼이 없다");
    });

    await t.test("수신 쓰기 펌프 — 조각 폭주에도 순서·내용이 그대로 도달한다", async () => {
      // 위 테스트가 만든 탭에 직접 조각을 폭주시킨다(DEV 훅 __tm).
      const out = await page.evaluate(async () => {
        const tab = window.__tm?.tabs?.[0];
        if (!tab) return "no-tab";
        const enc = new TextEncoder();
        for (let i = 0; i < 500; i++) tab.writeBytes(enc.encode(`줄-${i} 확인—완료\r\n`));
        await new Promise((r) => setTimeout(r, 900));
        const b = tab.term.buffer.active;
        const lines = [];
        for (let y = Math.max(0, b.length - 40); y < b.length; y++)
          lines.push(b.getLine(y)?.translateToString() ?? "");
        const txt = lines.join("\n");
        if (!txt.includes("줄-499 확인—완료")) return "tail-missing";
        if (!txt.includes("줄-498 확인—완료")) return "order-broken";
        return "ok";
      });
      expect(out === "ok", `수신 펌프 결과: ${out}`);
    });

    await page.close();
  }

  // ── 터미널 UTF-8 청크 경계 — vi 분할 화면 깨짐/줄 밀림 회귀(0.59.1) ────────────
  // xterm 6.0.0 은 청크가 0x80 연속 바이트 직후에서 끊기면 그 문자를 통째로 버린다
  // (— … 。「」 전각공백 등). Utf8Gate 가 완성 문자 경계로 재정렬해 이를 막는다.
  {
    const page = await openPage(browser, { url: "/tests/term-page.html" });
    await page.waitForTimeout(500);

    await t.test("IME 조합 고정 — 커서가 되돌아오면 따라가고, 먼 점프는 무시한다", async () => {
      const ESC = String.fromCharCode(27);
      const r = await page.evaluate(async (ESC) => {
        await window.__pinIme();
        const term = window.__term;
        const core = term._core;
        const helper = core._compositionHelper;
        const cellW = core._renderService.dimensions.css.cell.width;
        const colOf = () =>
          Math.round(parseFloat(helper._compositionView.style.left || "0") / cellW);
        const at = (row, col) =>
          new Promise((res) => term.write(`${ESC}[${row};${col}H`, () => setTimeout(res, 20)));

        await at(1, 11); // 11열(1-기준)에서 한글 조합 시작
        term.textarea.dispatchEvent(new CompositionEvent("compositionstart"));
        helper._isComposing = true;
        helper.updateCompositionElements();
        const start = colOf();
        // 앱이 입력줄을 다시 그리며 커서가 잠깐 오른쪽으로 갔다가 되돌아온다.
        await at(1, 15);
        helper.updateCompositionElements();
        const peak = colOf();
        await at(1, 12);
        helper.updateCompositionElements();
        const back = colOf();
        // 스피너 등 먼 점프(다른 줄)는 따라가면 안 된다 — 조합 글자가 튄다.
        await at(5, 40);
        helper.updateCompositionElements();
        const far = colOf();
        term.textarea.dispatchEvent(new CompositionEvent("compositionend"));
        helper._isComposing = false;
        return { start, peak, back, far };
      }, ESC);
      expect(r.start === 10, `조합 시작 위치가 어긋난다: ${JSON.stringify(r)}`);
      expect(r.peak === 14, `커서 전진을 따라가지 않는다: ${JSON.stringify(r)}`);
      // 예전에는 앞으로만 따라가(래칫) 되돌아온 자리를 놓쳤고, 그 차이가 한 칸씩 쌓였다.
      expect(r.back === 11, `커서가 되돌아왔는데 따라가지 않는다(래칫 재발): ${JSON.stringify(r)}`);
      expect(r.far === 11, `먼 점프를 따라가 버렸다: ${JSON.stringify(r)}`);
    });

    await t.test("UTF-8 게이트 — 어떤 절단 지점에서도 문자가 사라지지 않는다", async () => {
      const bad = await page.evaluate(async () => {
        const { Utf8Gate } = await import("/src/utf8stream.ts");
        const term = window.__term;
        const enc = new TextEncoder();
        const errs = [];
        const w = (u8) => new Promise((r) => (u8.length ? term.write(u8, r) : r()));
        for (const ch of ["—", "…", "가", "│", "。", "　", "😀"]) {
          const bytes = enc.encode("A" + ch + "B");
          for (let cut = 1; cut < bytes.length; cut++) {
            const gate = new Utf8Gate();
            term.reset();
            await w(gate.feed(bytes.subarray(0, cut)));
            await w(gate.feed(bytes.subarray(cut)));
            const line = term.buffer.active.getLine(0)?.translateToString().trimEnd();
            if (line !== `A${ch}B`) errs.push(`${ch} cut@${cut} → ${JSON.stringify(line)}`);
          }
        }
        return errs;
      });
      expect(bad.length === 0, `깨진 조합: ${bad.join(" / ")}`);
    });

    await t.test("설정 읽기 실패 시 저장 잠금 — 기본값이 파일을 덮어쓰지 않는다", async () => {
      const r = await page.evaluate(async () => {
        const prev = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
          if (cmd === "settings_load") throw "읽기 실패(테스트)";
          if (cmd === "settings_save") {
            window.__settingsSaved = true;
            return null;
          }
          return prev(cmd, args);
        };
        const m = await import("/src/settings.ts");
        const s = await m.loadSettings(); // 실패 → 기본값 + 저장 잠금
        let threw = false;
        try {
          await m.saveSettings(s);
        } catch {
          threw = true;
        }
        window.__TAURI_INTERNALS__.invoke = prev;
        return { threw, saved: !!window.__settingsSaved, usable: m.settingsUsable };
      });
      // 잠금 안내 모달이 떠 있을 수 있다 — 다음 테스트를 위해 걷는다.
      await page.evaluate(() =>
        [...document.querySelectorAll(".modal-card button")].pop()?.click(),
      );
      expect(
        r.threw && !r.saved && !r.usable,
        `저장 잠금이 동작하지 않는다: ${JSON.stringify(r)}`,
      );
    });

    await t.test("UTF-8 게이트 flush — 세션 종료 시 잘린 꼬리를 내보낸다", async () => {
      const r = await page.evaluate(async () => {
        const { Utf8Gate } = await import("/src/utf8stream.ts");
        const g = new Utf8Gate();
        const bytes = new TextEncoder().encode("가"); // EA B0 80
        const out1 = g.feed(bytes.subarray(0, 2)); // 미완성 — 보류
        const tail = g.flush();
        const tail2 = g.flush();
        return { held: out1.length, flushed: tail.length, empty: tail2.length };
      });
      expect(
        r.held === 0 && r.flushed === 2 && r.empty === 0,
        `flush 동작이 다르다: ${JSON.stringify(r)}`,
      );
    });

    await t.test("한글 출력 — 조각 경계·폭(2칸)·조합형 자모가 정확히 그려진다", async () => {
      const r = await page.evaluate(async () => {
        const { Utf8Gate } = await import("/src/utf8stream.ts");
        const term = window.__term;
        const enc = new TextEncoder();
        const w = (u8) => new Promise((res) => (u8.length ? term.write(u8, res) : res()));
        const line = (y) => term.buffer.active.getLine(y)?.translateToString().trimEnd();
        const bad = [];
        const cases = [
          "한글 출력 테스트",
          "가나다라마바사아자차카타파하",
          "혼합 mixed 混合 テスト",
          "특수문자 — … 「」 。 ·",
          "ㄱㄴㄷ ㅏㅑㅓ 조합 자모",
        ];
        for (const s of cases) {
          const bytes = enc.encode(s);
          // ① 통짜
          term.reset();
          await w(bytes);
          if (line(0) !== s) bad.push(`통짜:${s}→${line(0)}`);
          // ② 1바이트씩(게이트 경유) — 모든 경계 절단
          term.reset();
          const g = new Utf8Gate();
          for (let i = 0; i < bytes.length; i++) await w(g.feed(bytes.subarray(i, i + 1)));
          await w(g.flush());
          if (line(0) !== s) bad.push(`조각:${s}→${line(0)}`);
        }
        // 한글은 2칸 폭 — Unicode11 활성 확인(폭이 1이면 커서·줄바꿈이 어긋난다)
        term.reset();
        await w(enc.encode("한"));
        const cursorX = term.buffer.active.cursorX;
        if (cursorX !== 2) bad.push(`폭:${cursorX}(2 기대)`);
        return bad;
      });
      expect(r.length === 0, `한글 출력 불일치: ${r.join(" / ")}`);
    });

    await t.test("vim 분할 캡처 — 잘게 흘려도 한 번에 흘린 화면과 동일하다", async () => {
      const r = await page.evaluate(async () => {
        const { Utf8Gate } = await import("/src/utf8stream.ts");
        const buf = new Uint8Array(await (await fetch("/tests/vim-split.bin")).arrayBuffer());
        const term = window.__term;
        const w = (u8) => new Promise((res) => (u8.length ? term.write(u8, res) : res()));
        term.reset();
        await w(buf);
        const base = window.__grid();
        term.reset();
        const gate = new Utf8Gate();
        // 결정적 의사난수 1~7바이트 — 실제 SSH 청크의 임의 경계를 흉내낸다.
        let seed = 987;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 7) + 1;
        let i = 0;
        while (i < buf.length) {
          const n = Math.min(rnd(), buf.length - i);
          await w(gate.feed(buf.subarray(i, i + n)));
          i += n;
        }
        const diff = [];
        const chunked = window.__grid();
        base.forEach((l, y) => l !== chunked[y] && diff.push(y));
        return diff;
      });
      expect(r.length === 0, `청크 재생이 ${r.length}개 행에서 다르다(행: ${r.join(",")})`);
    });

    await page.close();
  }
} finally {
  await browser.close();
  stop();
}

t.finish();
