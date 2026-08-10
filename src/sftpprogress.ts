// SFTP 전송 진행 스트립 — 파일명·진행 막대·전송률·전체 진행(3/10)·취소 버튼.
// sftpui.ts 에서 분리(0.67.0). 로직 변경 없음.

import { sftpCancel } from "./ipc";
import { applyIcon } from "./icons";
import { fmtSize, type TransferState } from "./sftpcommon";

export interface ProgressStrip {
  strip: HTMLElement;
  showProgress: (name: string, done: number, total: number) => void;
  setOverall: (o: string) => void;
  hideProgress: () => void;
}

export function createProgressStrip(xfer: TransferState): ProgressStrip {
  // ── 전송 진행 스트립 ──
  const strip = document.createElement("div");
  strip.className = "sftp-progress hidden";
  const pName = document.createElement("span");
  pName.className = "prog-name";
  const bar = document.createElement("div");
  bar.className = "prog-bar";
  const fill = document.createElement("div");
  fill.className = "prog-fill";
  const pct = document.createElement("span");
  pct.className = "prog-pct";
  bar.append(fill, pct);
  const pInfo = document.createElement("span");
  pInfo.className = "prog-info";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "tree-act";
  applyIcon(cancelBtn, "cancel");
  cancelBtn.title = "전송 취소";
  cancelBtn.addEventListener("click", () => {
    xfer.cancelled = true;
    if (xfer.current) void sftpCancel(xfer.current);
  });
  strip.append(pName, bar, pInfo, cancelBtn);

  // 전송 속도 계산용(이전 진행 시점).
  let speedName = "";
  let lastDone = 0;
  let lastAt = 0;
  let overall = ""; // "3/10" 같은 전체 진행

  const showProgress = (name: string, done: number, total: number) => {
    strip.classList.remove("hidden");
    pName.textContent = overall ? `${name}  (${overall})` : name;
    const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    fill.style.width = `${ratio}%`;
    pct.textContent = `${ratio}%`;

    // 같은 파일이 진행 중일 때만 속도(MB/s)를 낸다.
    let speed = "";
    const now = performance.now();
    if (name === speedName && now > lastAt) {
      const bps = ((done - lastDone) / (now - lastAt)) * 1000;
      if (bps > 0) speed = ` · ${fmtSize(bps)}/s`;
    }
    // 파일이 바뀌면 현재 진행량을 기준점으로 삼는다(0 으로 두면 첫 샘플 속도가 부풀려짐).
    speedName = name;
    lastDone = done;
    lastAt = now;
    pInfo.textContent = (total > 0 ? `${fmtSize(done)} / ${fmtSize(total)}` : fmtSize(done)) + speed;
  };
  const setOverall = (o: string) => {
    overall = o;
  };
  const hideProgress = () => strip.classList.add("hidden");

  return { strip, showProgress, setOverall, hideProgress };
}
