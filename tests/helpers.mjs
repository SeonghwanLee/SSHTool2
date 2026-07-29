// UI 회귀 검사 공용 도우미 — vite 기동, 브라우저 준비, Tauri IPC 대역.
//
// 왜 이 파일이 있는가: 같은 종류의 버그가 네 번 재발했다(터미널 viewport 배경, SFTP 칩 색,
// 열 조절 핸들, 설정 경고문 색 — 전부 "구현은 있는데 CSS 특이도/로드 순서에 져서 죽어 있던"
// 부류). 그때마다 일회용 검증 스크립트를 만들어 쓰고 버렸는데, 그 비용을 한 번만 치르고
// `npm run check:ui` 로 언제든 다시 돌리기 위해 상설화한다.
//
// 브라우저는 playwright-core + 로컬 Chromium/Chrome 을 쓴다. 채널 다운로드를 강제하지 않고,
// 못 찾으면 명확한 안내와 함께 실패한다(조용히 통과로 위장하지 않는다).

import { chromium } from "playwright-core";
import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PORT = 5199;
const BASE = `http://localhost:${PORT}`;

/**
 * vite 가 살아 있는지 — IPv4/IPv6 양쪽을 다 본다. vite 는 환경에 따라 ::1 에만 붙는데,
 * Node 의 fetch("localhost")는 IPv4 로 가서 살아 있는 서버를 못 보고 지나친다
 * (그 뒤 spawn 이 '포트 사용 중'으로 죽는다 — 실제로 겪었다).
 */
async function viteAlive() {
  for (const host of [`http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`]) {
    const ok = await fetch(host, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

/** 설치돼 있는 Chromium/Chrome 실행 파일을 찾는다. */
export function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  // playwright 캐시(ms-playwright)의 아무 chromium 이나.
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache)) {
      if (!d.startsWith("chromium")) continue;
      for (const cand of [
        path.join(cache, d, "chrome-linux64", "chrome"),
        path.join(cache, d, "chrome-linux", "chrome"),
        path.join(cache, d, "chrome-win", "chrome.exe"),
      ]) {
        if (existsSync(cand)) return cand;
      }
    }
  }
  for (const cand of [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ]) {
    if (existsSync(cand)) return cand;
  }
  throw new Error(
    "Chromium 을 찾지 못했습니다. CHROME 환경변수로 실행 파일 경로를 지정하세요.\n" +
      "예) CHROME=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome npm run check:ui",
  );
}

/** 이미 떠 있으면 재사용, 아니면 vite 를 띄운다. 반환된 stop() 은 우리가 띄운 경우에만 죽인다. */
export async function ensureVite() {
  if (await viteAlive()) return { stop: () => {} };

  const child = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
    detached: true,
  });
  // 준비될 때까지 폴링 — 고정 sleep 은 머신에 따라 모자라거나 낭비다.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await viteAlive()) {
      return {
        stop: () => {
          try {
            process.kill(-child.pid, "SIGTERM"); // detached 그룹째
          } catch {
            try {
              child.kill("SIGTERM");
            } catch {}
          }
        },
      };
    }
  }
  throw new Error("vite 가 20초 안에 뜨지 않았습니다.");
}

/**
 * Tauri IPC 대역 — 브라우저에는 네이티브가 없어 앱 초기화가 멈추므로 최소한을 흉내낸다.
 * 세션·설정 등은 테스트가 overrides 로 주입한다.
 */
export function tauriStub(overrides = {}) {
  return `
    (() => {
      let n = 0;
      const overrides = ${JSON.stringify(overrides)};
      window.__ipc = []; // 테스트가 호출 내역을 들여다볼 수 있게 남긴다
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback(cb) { const id = ++n; window["_" + id] = cb; return id; },
        async invoke(cmd, args) {
          window.__ipc.push([cmd, args]);
          if (cmd in overrides) return overrides[cmd];
          switch (cmd) {
            case "sessions_load": return [];
            case "settings_load": return {};
            case "vault_status": return { exists: false, unlocked: true };
            case "local_roots": return ["C:\\\\"];
            case "local_default_dir": return "C:\\\\작업";
            case "local_parent": return "C:\\\\";
            case "local_list": case "sftp_list": return [];
            case "sftp_connect": return "sftp-test";
            case "sftp_canonicalize": return "/home/u";
            case "ssh_probe": return "password";
            case "ssh_connect": return "live-" + (++window.__lid || (window.__lid = 1));
            default: return null;
          }
        },
      };
    })();
  `;
}

/** 페이지를 연다. app=true 면 앱 본체(/), 아니면 지정 경로. */
export async function openPage(browser, { stub = {}, url = "/" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("  [pageerror]", String(e).slice(0, 160)));
  await page.addInitScript(tauriStub(stub));
  await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  return page;
}

/** 아주 작은 테스트 러너 — 의존성을 늘리지 않으려고 직접 만든다. */
export function makeRunner() {
  const results = [];
  return {
    async test(name, fn) {
      try {
        await fn();
        results.push([name, null]);
        console.log(`  ✓ ${name}`);
      } catch (e) {
        results.push([name, e]);
        console.error(`  ✗ ${name}\n    ${String(e?.message ?? e).split("\n")[0]}`);
      }
    },
    finish() {
      const failed = results.filter(([, e]) => e);
      console.log(`\n${results.length - failed.length}/${results.length} 통과`);
      if (failed.length) process.exitCode = 1;
    },
  };
}

export function expect(cond, message) {
  if (!cond) throw new Error(message);
}

export { chromium };
