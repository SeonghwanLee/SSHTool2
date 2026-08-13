// SFTP 전송 진행 스트립 — 파일명·진행 막대·전송률·전체 진행(3/10)·취소 버튼.
// sftpui.ts 에서 분리(0.67.0). 로직 변경 없음.

import { sftpCancel, sftpSetRateLimit } from "./ipc";
import { applyIcon } from "./icons";
import { fmtSize, type TransferState } from "./sftpcommon";

export interface ProgressStrip {
  strip: HTMLElement;
  showProgress: (name: string, done: number, total: number) => void;
  setOverall: (o: string) => void;
  hideProgress: () => void;
}

/** 속도 상한 고르개의 후보(KB/s). 0 = 무제한. */
const RATE_CHOICES: { label: string; kbps: number }[] = [
  { label: "무제한", kbps: 0 },
  { label: "200 KB/s", kbps: 200 },
  { label: "500 KB/s", kbps: 500 },
  { label: "1 MB/s", kbps: 1024 },
  { label: "5 MB/s", kbps: 5 * 1024 },
  { label: "10 MB/s", kbps: 10 * 1024 },
];

export function createProgressStrip(
  xfer: TransferState,
  defaultKbps = 0,
  /** 취소 버튼이 할 일. 주지 않으면 지금 파일만 끊는다(예전 동작). */
  onCancel?: () => void,
): ProgressStrip {
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
    if (onCancel) {
      onCancel();
      return;
    }
    xfer.cancelled = true;
    if (xfer.current) void sftpCancel(xfer.current);
  });
  // 속도 상한 — 전송이 보이는 자리에서 바로 바꾼다. "지금 이 전송이 회선을 다 먹으니
  // 줄이자"가 실제 상황이라 설정 창을 오가는 동선으로는 늦다. 여기서 바꾼 값은
  // 설정에 저장하지 않는다(급해서 줄인 값이 다음 주까지 따라다니지 않게).
  const rateSel = document.createElement("select");
  rateSel.className = "prog-rate";
  rateSel.title = "전송 속도 제한 — 지금 전송에 바로 적용됩니다(설정에는 저장하지 않음)";
  // 설정의 기본값이 후보에 없으면 그 값도 후보에 넣어 준다(직접 입력한 수치 보존).
  const choices = RATE_CHOICES.some((c) => c.kbps === defaultKbps)
    ? RATE_CHOICES
    : [...RATE_CHOICES, { label: `${defaultKbps} KB/s`, kbps: defaultKbps }].sort(
        (a, b) => a.kbps - b.kbps,
      );
  for (const c of choices) {
    const o = document.createElement("option");
    o.value = String(c.kbps);
    o.textContent = c.label;
    o.selected = c.kbps === defaultKbps;
    rateSel.appendChild(o);
  }
  rateSel.addEventListener("change", () => {
    void sftpSetRateLimit(Number(rateSel.value));
  });

  strip.append(pName, bar, pInfo, rateSel, cancelBtn);

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
