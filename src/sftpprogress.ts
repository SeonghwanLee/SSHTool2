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

/**
 * 남은 시간 표기.
 *
 * 값이 클수록 굵게 끊는다 — 40분 넘게 남은 전송에서 "46분 10초"의 10초는 아무 뜻이
 * 없고, 추정이 조금만 흔들려도 그 자리가 계속 바뀌어 눈만 어지럽다(0.76.5 실사용).
 * 자릿수를 줄이면 같은 흔들림이 표시에 아예 나타나지 않는다.
 */
function fmtEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec > 24 * 3600) return "남은 시간 계산 중";
  if (sec < 15) return "곧 완료";
  if (sec < 60) return `약 ${Math.round(sec / 10) * 10}초 남음`;
  const min = sec / 60;
  if (min < 10) return `약 ${Math.max(1, Math.round(min))}분 남음`;
  if (min < 60) return `약 ${Math.round(min / 5) * 5}분 남음`; // 5분 단위
  const h = Math.floor(min / 60);
  const m = Math.round((min % 60) / 10) * 10; // 10분 단위
  if (m >= 60) return `약 ${h + 1}시간 남음`;
  return m > 0 ? `약 ${h}시간 ${m}분 남음` : `약 ${h}시간 남음`;
}

export function createProgressStrip(
  xfer: TransferState,
  defaultKbps = 0,
  /** 취소 버튼이 할 일. 주지 않으면 지금 파일만 끊는다(예전 동작). */
  onCancel?: () => void,
): ProgressStrip {
  // ── 전송 진행 스트립 ──
  const strip = document.createElement("div");
  // 스트립은 **늘 자리에 있는다**(0.91.0). 예전에는 전송 중에만 보였는데, 나타났다
  // 사라질 때마다 그 높이만큼 목록이 밀려 화면이 들썩였다. 또 속도 제한 고르기가 이 줄에
  // 있어서, 전송이 없을 때는 아예 손댈 수가 없었다 — 정작 "다음 전송은 느리게" 를 미리
  // 정해 두고 싶은 순간에 막혀 있던 셈이다.
  strip.className = "sftp-progress";
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
  // 처음에는 표본 두 개의 차이를 지수이동평균으로 골랐는데, 실사용에서 여전히
  // 어지러웠다 — 0.9초 사이에 "43분 → 46분 10초 → 45분 30초"까지 흔들렸다.
  // 원인이 셋이었다: ① 조각 도착 간격이 들쭉날쭉해 순간 속도가 크게 튀고,
  // ② 글자를 진행 이벤트마다(초당 여러 번) 다시 쓰고, ③ 40분짜리 추정에 10초
  // 자리까지 보여 줬다. 셋을 각각 막는다 —
  //   ① 최근 몇 초 구간으로 속도를 잰다(구간 평균)
  //   ② 글자는 1초에 한 번만 고쳐 쓴다(막대·퍼센트는 그대로 매번)
  //   ③ 남은 시간은 크기에 따라 굵게 끊는다(fmtEta)
  // 속도와 남은 시간은 필요한 성질이 다르다. 속도는 "지금 얼마나 나오나"라서 최근
  // 몇 초를 봐야 쓸모가 있고, 남은 시간은 조금만 흔들려도 눈에 거슬리니 훨씬 긴
  // 구간으로 재야 한다. 그래서 표본은 한 벌만 쌓고 구간을 둘로 나눠 본다.
  const SPEED_MS = 8000; // 속도 표시용 구간 — 상한을 바꿨을 때 반영이 늦지 않을 만큼만 길게
  const ETA_MS = 60000; // 남은 시간용 구간 — 1분 평균이면 5분 단위 표시가 거의 안 흔들린다
  const TEXT_MS = 1000; // 글자 갱신 주기
  const STALE_MS = 15000; // 이만큼 소식이 없으면 이어 온 표본은 버린다
  /** 최근 진행 표본(시각, 누적 바이트). */
  let marks: { t: number; done: number }[] = [];
  let lastDone = 0;
  let lastTotal = 0;
  let lastTextAt = 0;
  let shownEta = 0; // 마지막으로 표시한 남은 시간(초) — 경계에서 오락가락하지 않게 붙잡는다
  let overall = ""; // "3/10" 같은 전체 진행

  const showProgress = (name: string, done: number, total: number) => {
    strip.classList.remove("idle");
    cancelBtn.disabled = false;
    // 전체 진행("3/10")은 정보 칸으로 보낸다 — 파일명 칸은 파일명만 담아야 폭이 고정된
    // 상태에서 이름이 덜 잘린다.
    pName.textContent = name;
    pName.title = name;
    const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    fill.style.width = `${ratio}%`;
    pct.textContent = `${ratio}%`;

    // 진행량이 뒤로 가거나 총량이 바뀌면 새 전송이다 — 표본을 이어 쓰면 안 된다.
    // 파일 이름이 아니라 진행량으로 판단해야 묶음 전송(여러 파일)에서 파일이 바뀔
    // 때마다 남은 시간이 사라지지 않는다.
    const now = performance.now();
    const last = marks[marks.length - 1];
    if (done < lastDone || total !== lastTotal || (last && now - last.t > STALE_MS)) {
      marks = [];
      shownEta = 0;
      lastTextAt = 0; // 새 전송의 첫 표시는 기다리지 않는다
    }
    lastDone = done;
    lastTotal = total;

    // 같은 진행량이 두 번 들어오는 경우가 있다(진행 이벤트와 배경 상태가 같은 값을
    // 알린다) — 표본으로 쌓으면 구간만 늘어나고 속도가 낮게 잡힌다.
    // 위에서 비웠을 수 있으므로 **다시 읽는다** — 옛 값으로 판단하면 첫 표본을 건너뛰어
    // 표본이 하나도 없는 채로 아래 계산에 들어간다(전송을 통째로 죽였다).
    const prev = marks[marks.length - 1];
    if (!prev || done !== prev.done) marks.push({ t: now, done });
    if (marks.length === 0) return; // 넣을 것이 없으면 계산할 것도 없다
    // 구간 밖은 버리되, 구간을 재려면 앞쪽 표본 하나는 남겨 둔다.
    while (marks.length > 2 && now - marks[1].t > ETA_MS) marks.shift();

    if (now - lastTextAt < TEXT_MS) return; // 글자는 초당 한 번만 — 눈이 따라올 수 있게
    lastTextAt = now;

    /** from 밀리초 안의 표본으로 잰 속도(B/s)와 그 구간 길이. */
    const rateOver = (windowMs: number): { bps: number; span: number } => {
      const newest = marks[marks.length - 1];
      if (!newest) return { bps: 0, span: 0 };
      let i = 0;
      while (i < marks.length - 2 && newest.t - marks[i + 1].t > windowMs) i++;
      const span = newest.t - marks[i].t;
      return { bps: span > 0 ? ((newest.done - marks[i].done) / span) * 1000 : 0, span };
    };

    const quick = rateOver(SPEED_MS);
    const slow = rateOver(ETA_MS);
    const speed = quick.bps > 0 ? ` · ${fmtSize(quick.bps)}/s` : "";
    // 구간이 짧으면 추정이 크게 빗나간다 — 몇 초쯤 모인 뒤부터 내보인다.
    let eta = "";
    if (slow.span >= 3000 && slow.bps > 0 && total > done) {
      const sec = (total - done) / slow.bps;
      // 추정이 표시 구간의 경계에 걸쳐 있으면 1분 평균으로도 "35분↔40분"을 오간다.
      // 눈에 띌 만큼 달라졌을 때만 바꿔 단다 — 전송이 진행되면 자연히 줄어드므로
      // 붙잡혀 있는 일은 없다.
      if (shownEta === 0 || Math.abs(sec - shownEta) > Math.max(20, shownEta * 0.15)) {
        shownEta = sec;
      }
      eta = ` · ${fmtEta(shownEta)}`;
    }
    pInfo.textContent =
      (overall ? `${overall} · ` : "") +
      (total > 0 ? `${fmtSize(done)} / ${fmtSize(total)}` : fmtSize(done)) +
      speed +
      eta;
  };
  const setOverall = (o: string) => {
    overall = o;
  };
  /**
   * 전송이 끝났을 때 — 줄을 감추지 않고 **쉬는 모습**으로 되돌린다.
   * (이름은 예전 그대로 둔다. 부르는 쪽이 여러 군데라 뜻만 바꾼다.)
   */
  const hideProgress = () => {
    strip.classList.add("idle");
    pName.textContent = "전송 중인 항목 없음";
    pName.title = "";
    fill.style.width = "0%";
    pct.textContent = "";
    pInfo.textContent = "";
    cancelBtn.disabled = true; // 끊을 것이 없다
    marks = [];
    lastDone = 0;
    lastTotal = 0;
    shownEta = 0;
  };
  hideProgress(); // 처음에는 쉬는 모습으로 시작

  return { strip, showProgress, setOverall, hideProgress };
}
