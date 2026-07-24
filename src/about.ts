// 버전 정보 창 — 배너 + 버전 배지, 변경 이력(최근 5개 + 더보기),
// 업데이트 확인, 진단 정보 복사 (WPF 0.29.1/0.31.3/0.31.5 대응).

import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openModal } from "./dialogs";
import { CHANGELOG } from "./changelog";

const RECENT = 5;

export function aboutDialog(): Promise<void> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        card.className = "settings-card";

        // ── 배너 ──
        const banner = document.createElement("div");
        banner.className = "about-banner";
        const glyph = document.createElement("div");
        glyph.className = "about-glyph";
        glyph.textContent = ">_";
        const titleBox = document.createElement("div");
        const name = document.createElement("div");
        name.className = "about-name";
        name.textContent = "SSHTool2";
        const badge = document.createElement("span");
        badge.className = "badge badge-embedded about-version";
        badge.textContent = "…";
        void getVersion().then((v) => {
          badge.textContent = `v${v}`;
        });
        const tagline = document.createElement("div");
        tagline.className = "about-tagline";
        tagline.textContent = "SSH · SFTP 클라이언트 — Tauri + xterm.js";
        titleBox.append(name, tagline);
        banner.append(glyph, titleBox, badge);

        // ── 변경 이력 ──
        const logHead = document.createElement("div");
        logHead.className = "settings-section";
        logHead.textContent = `변경 이력 (총 ${CHANGELOG.length}개 버전)`;

        const logBox = document.createElement("div");
        logBox.className = "bulk-list";
        let expanded = false;

        const drawLog = () => {
          logBox.innerHTML = "";
          const items = expanded ? CHANGELOG : CHANGELOG.slice(0, RECENT);
          for (const e of items) {
            const head = document.createElement("div");
            head.className = "bulk-group";
            head.textContent = `v${e.version}  ·  ${e.date}`;
            logBox.appendChild(head);
            for (const n of e.notes) {
              const li = document.createElement("div");
              li.className = "about-note";
              li.textContent = `• ${n}`;
              logBox.appendChild(li);
            }
          }
          more.textContent = expanded ? "최근 5개만 보기" : "더보기";
          more.style.display = CHANGELOG.length > RECENT ? "" : "none";
        };

        const more = document.createElement("button");
        more.type = "button";
        more.className = "sftp-btn";
        more.addEventListener("click", () => {
          expanded = !expanded;
          drawLog();
        });

        // ── 동작 ──
        const status = document.createElement("div");
        status.className = "modal-err";

        const actions = document.createElement("div");
        actions.className = "modal-buttons about-actions";

        const updateBtn = document.createElement("button");
        updateBtn.type = "button";
        updateBtn.textContent = "업데이트 확인";
        updateBtn.addEventListener("click", async () => {
          updateBtn.disabled = true;
          const label = updateBtn.textContent;
          updateBtn.textContent = "확인 중…";
          try {
            const update = await check();
            if (!update) {
              status.textContent = "최신 버전을 사용 중입니다.";
            } else {
              status.textContent = `새 버전 ${update.version} 설치 중…`;
              await update.downloadAndInstall();
              await relaunch();
            }
          } catch (e) {
            // 내부망 등 인터넷이 안 되는 환경에서는 조용히 실패하지 않도록 알린다.
            status.textContent = `업데이트 확인 실패: ${String(e)}`;
          } finally {
            updateBtn.disabled = false;
            updateBtn.textContent = label;
          }
        });

        const diagBtn = document.createElement("button");
        diagBtn.type = "button";
        diagBtn.textContent = "진단 정보 복사";
        diagBtn.addEventListener("click", async () => {
          const info = [
            `SSHTool2 ${badge.textContent}`,
            `UserAgent: ${navigator.userAgent}`,
            `화면: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
            `언어: ${navigator.language}`,
          ].join("\n");
          try {
            await navigator.clipboard.writeText(info);
            status.textContent = "진단 정보를 클립보드에 복사했습니다.";
          } catch {
            status.textContent = "클립보드 복사에 실패했습니다.";
          }
        });

        const okBtn = document.createElement("button");
        okBtn.type = "button";
        okBtn.className = "btn-accent";
        okBtn.textContent = "닫기";
        okBtn.addEventListener("click", () => {
          close();
          resolve();
        });

        actions.append(updateBtn, diagBtn, okBtn);

        const credit = document.createElement("div");
        credit.className = "about-credit";
        credit.textContent = "오픈소스 사용: russh · russh-sftp · xterm.js · Tauri · D2Coding 외";

        drawLog();
        card.append(banner, logHead, logBox, more, status, actions, credit);
        return card;
      },
      () => resolve(),
    );
  });
}
