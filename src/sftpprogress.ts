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

/** 남은 시간 표기. 초 단위로 떨리지 않게 굵게 반올림한다. */
function fmtEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec > 24 * 3600) return "남은 시간 계산 중";
  if (sec < 10) return "곧 완료";
  if (sec < 60) return `약 ${Math.round(sec / 5) * 5}초 남음`;
  const m = Math.floor(sec / 60);
  if (m < 60) {
    const s = Math.round((sec % 60) / 10) * 10;
    return s > 0 && s < 60 ? `약 ${m}분 ${s}초 남음` : `약 ${m + (s >= 60 ? 1 : 0)}분 남음`;
  }
  return `약 ${Math.floor(m / 60)}시간 ${m % 60}분 남음`;
}

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

  // 전송 속도·남은 시간 계산용.
  //
  // 순간 속도(직전 두 표본의 차이)를 그대로 쓰면 조각 하나가 늦게 도착할 때마다 값이
  // 요동친다. 속도만 보여 줄 때는 눈에 거슬리는 정도였지만, 남은 시간까지 그 값으로
  // 내면 "3초 → 2분 → 8초"처럼 튀어 쓸모가 없다. 그래서 지수이동평균으로 고른다.
  let lastDone = 0;
  let lastAt = 0;
  let lastTotal = 0;
  let bpsAvg = 0; // 지수이동평균 속도(B/s)
  let samples = 0;
  let overall = ""; // "3/10" 같은 전체 진행
  const SMOOTH = 0.3; // 새 표본 반영 비율 — 낮을수록 안정적이고 반응이 느리다

  const showProgress = (name: string, done: number, total: number) => {
    strip.classList.remove("hidden");
    pName.textContent = overall ? `${name}  (${overall})` : name;
    const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    fill.style.width = `${ratio}%`;
    pct.textContent = `${ratio}%`;

    // 진행량이 뒤로 가거나 총량이 바뀌면 새 전송이다 — 평균을 이어 쓰면 안 된다.
    // 파일 이름이 아니라 진행량으로 판단해야 묶음 전송(여러 파일)에서 파일이 바뀔
    // 때마다 남은 시간이 사라지지 않는다.
    const now = performance.now();
    if (done < lastDone || total !== lastTotal) {
      bpsAvg = 0;
      samples = 0;
      lastAt = 0;
    }
    // 같은 진행량이 두 번 들어오는 경우가 있다(진행 이벤트와 배경 상태가 같은 값을
    // 알린다) — 속도를 0 으로 끌어내리므로 표시만 갱신하고 계산에서는 뺀다.
    if (lastAt > 0 && now > lastAt && done !== lastDone) {
      const bps = ((done - lastDone) / (now - lastAt)) * 1000;
      if (bps >= 0) {
        bpsAvg = samples === 0 ? bps : bpsAvg * (1 - SMOOTH) + bps * SMOOTH;
        samples++;
      }
    }
    lastDone = done;
    lastAt = now;
    lastTotal = total;

    const speed = bpsAvg > 0 ? ` · ${fmtSize(bpsAvg)}/s` : "";
    // 표본이 한둘일 때의 추정은 크게 빗나간다 — 몇 번 모인 뒤부터 내보인다.
    const eta =
      samples >= 3 && bpsAvg > 0 && total > done ? ` · ${fmtEta((total - done) / bpsAvg)}` : "";
    pInfo.textContent =
      (total > 0 ? `${fmtSize(done)} / ${fmtSize(total)}` : fmtSize(done)) + speed + eta;
  };
  const setOverall = (o: string) => {
    overall = o;
  };
  const hideProgress = () => strip.classList.add("hidden");

  return { strip, showProgress, setOverall, hideProgress };
}
