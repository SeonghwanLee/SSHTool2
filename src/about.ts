// 버전 정보 창 — 배너 + 버전 배지, 변경 이력(최근 5개 + 더보기),
// 업데이트 확인, 진단 정보 복사 (WPF 0.29.1/0.31.3/0.31.5 대응).

import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openModal, confirmDialog } from "./dialogs";
import { CHANGELOG } from "./changelog";
import { openConfigDir } from "./ipc";
import { updateErrorText } from "./updateerror";

const RECENT = 5;

export function aboutDialog(
  liveCount: () => number = () => 0,
  /** 내부망 모드인가 — 켜져 있으면 GitHub 로 나가는 버튼을 감춘다. */
  isOffline: () => boolean = () => false,
): Promise<void> {
  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        card.className = "settings-card about-card";

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

        // ── 정보(제작자·환경) ──
        const info = document.createElement("div");
        info.className = "about-info";
        const rows: [string, string][] = [
          ["제작", "이성환 (relent82@gmail.com)"],
          ["스택", "Tauri v2 (Rust) · xterm.js · WebView2"],
          ["실행 환경", navigator.platform || navigator.userAgent],
        ];
        for (const [k, v] of rows) {
          const row = document.createElement("div");
          row.className = "about-info-row";
          const key = document.createElement("span");
          key.className = "about-info-key";
          key.textContent = k;
          const val = document.createElement("span");
          val.className = "about-info-val";
          val.textContent = v;
          row.append(key, val);
          info.appendChild(row);
        }

        // ── 오픈소스 고지 ──
        const oss = document.createElement("div");
        oss.className = "settings-section";
        oss.textContent = "오픈소스 라이선스";
        const ossBox = document.createElement("div");
        ossBox.className = "about-oss";
        const LICENSES: [string, string, string][] = [
          ["russh · russh-sftp", "Apache-2.0", "순수 Rust SSH/SFTP"],
          ["xterm.js (+addons)", "MIT", "터미널 에뮬레이터"],
          ["Tauri · wry · tao", "MIT / Apache-2.0", "앱 프레임워크"],
          ["tokio", "MIT", "비동기 런타임"],
          ["aes-gcm · pbkdf2 · sha2 (RustCrypto)", "MIT / Apache-2.0", "볼트 암호화"],
          ["encoding_rs", "MIT / Apache-2.0", "문자셋 변환"],
          ["portable-pty", "MIT", "로컬 셸 PTY"],
          ["keyring", "MIT / Apache-2.0", "OS 키체인"],
          ["D2Coding", "OFL 1.1", "내장 글꼴 (Naver)"],
          ["나눔고딕코딩", "OFL 1.1", "내장 글꼴 (Naver)"],
          ["JetBrains Mono", "Apache-2.0", "내장 글꼴"],
          ["IBM Plex Mono", "OFL 1.1", "내장 글꼴"],
          ["Hack", "MIT", "내장 글꼴"],
        ];
        for (const [comp, lic, use] of LICENSES) {
          const row = document.createElement("div");
          row.className = "about-oss-row";
          const c = document.createElement("span");
          c.className = "about-oss-comp";
          c.textContent = comp;
          const l = document.createElement("span");
          l.className = "about-oss-lic";
          l.textContent = lic;
          const u = document.createElement("span");
          u.className = "about-oss-use";
          u.textContent = use;
          row.append(c, l, u);
          ossBox.appendChild(row);
        }

        // ── 변경 이력 ──
        const logHead = document.createElement("div");
        logHead.className = "settings-section";
        // 전체 이력은 홈페이지에서만 본다(0.65.0) — 창에 92개를 쌓아 둘 이유가 없다.
        logHead.textContent = "변경 이력 (최근 5개)";

        const logBox = document.createElement("div");
        logBox.className = "bulk-list";

        const drawLog = () => {
          logBox.innerHTML = "";
          const items = CHANGELOG.slice(0, RECENT);
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
        };

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
              // 접속 중인 세션이 있으면 끊긴다는 걸 사전에 안내한다.
              const live = liveCount();
              if (live > 0) {
                const go = await confirmDialog(
                  `접속 중인 세션 ${live}개가 종료됩니다. 새 버전 ${update.version} 을(를) 지금 설치할까요?`,
                );
                if (!go) {
                  status.textContent = "설치를 취소했습니다.";
                  return;
                }
              }
              status.textContent = `새 버전 ${update.version} 설치 중…`;
              await update.downloadAndInstall();
              await relaunch();
            }
          } catch (e) {
            // 내부망 등 인터넷이 안 되는 환경에서는 조용히 실패하지 않도록 알리되,
            // 배포 서버 주소(GitHub URL)는 화면에 내보내지 않는다(0.66.0).
            status.textContent = updateErrorText(e);
          } finally {
            updateBtn.disabled = false;
            updateBtn.textContent = label;
          }
        });

        // 내부망 모드에서는 눌러도 실패할 버튼을 두지 않는다. 진단 정보 복사는 남긴다 —
        // 외부로 나가지 않고, 문제를 알릴 때 오히려 그때 필요하다.
        if (isOffline()) {
          updateBtn.style.display = "none";
          const note = document.createElement("div");
          note.className = "settings-hint";
          note.textContent =
            "내부망 모드입니다. 업데이트 확인을 감췄습니다 — 설정 > 일반의 '시작 시 업데이트 확인'을 다시 켜면 돌아옵니다.";
          status.parentElement?.insertBefore(note, status);
        }

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

        const folderBtn = document.createElement("button");
        folderBtn.type = "button";
        folderBtn.textContent = "설정 폴더 열기";
        folderBtn.addEventListener("click", async () => {
          try {
            await openConfigDir();
          } catch (e) {
            status.textContent = `폴더 열기 실패: ${String(e)}`;
          }
        });

        actions.append(updateBtn, diagBtn, folderBtn, okBtn);

        const credit = document.createElement("div");
        credit.className = "about-credit";
        credit.textContent = "© 2026 이성환 · SSHTool2 — WPF SSHTool 후속(개인 프로젝트)";

        drawLog();
        card.append(banner, info, oss, ossBox, logHead, logBox, status, actions, credit);
        // 이 창에서 Enter 로 할 일은 '닫기' 뿐이다 — 눌러도 위험하지 않아 미리 잡아 둔다.
        setTimeout(() => okBtn.focus(), 0);
        return card;
      },
      () => resolve(),
    );
  });
}
