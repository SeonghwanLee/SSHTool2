// SFTP 전송 큐(0.75.0) — 이번 묶음에서 무엇이 끝났고 무엇이 남았는지, 무엇이 실패했는지.
//
// 왜 필요한가: 진행 스트립은 "지금 이 파일"만 보여 준다. 파일 수십 개를 보내면 중간에
// 몇 개가 조용히 실패해도(권한·링크·이름 문제) 끝나고 나서 "3개 실패" 한 줄만 남았다.
// 무엇이 실패했는지 알 수 없으니 다시 시도할 수도 없었다.
//
// 순서 바꾸기(끌어서 재정렬)는 넣지 않는다 — 큐는 위에서부터 그대로 소비되는 중이라,
// 진행 중인 목록을 흔들면 어디까지 갔는지가 흐려진다. 실패분 재시도로 충분하다.

import { applyIcon } from "./icons";
import { fmtSize } from "./sftpcommon";

export type QueueState = "wait" | "run" | "done" | "fail" | "skip";

export interface QueueEntry {
  /** 소스 경로 — 같은 항목을 두 번 넣지 않기 위한 키. */
  key: string;
  name: string;
  size: number;
  /** up = 로컬→원격, down = 원격→로컬. */
  dir: "up" | "down";
  srcPath: string;
  destDir: string;
  state: QueueState;
  note?: string;
}

export interface QueueApi {
  root: HTMLElement;
  /** 새 묶음 시작. 큐는 이어지므로 지우지 않는다 — 끝난 항목만 오래된 순으로 정리한다. */
  begin(): void;
  /** 없으면 대기 상태로 넣는다(이미 있으면 그대로 둔다). */
  ensure(e: Omit<QueueEntry, "state">): void;
  setState(key: string, state: QueueState, note?: string): void;
  failedItems(): QueueEntry[];
  /** 실패분 다시 시도 버튼이 부를 함수. */
  setRetry(fn: (items: QueueEntry[]) => void): void;
  /** 이 항목이 취소됐는가 — 전송 직전과 실패 처리에서 본다. */
  isCancelled(key: string): boolean;
  /** 전송 중인 항목을 끊는 방법(창이 넣어 준다). 대기 중인 항목은 큐가 알아서 뺀다. */
  setCancelRunning(fn: () => void): void;
  /**
   * 남은 대기 항목을 한꺼번에 취소할 때 창이 할 일 — 지금 도는 묶음의 남은 차례도
   * 멈춰야 한다(큐에 아직 오르지 않은 폴더 하위 파일까지 포함).
   */
  setCancelWaiting(fn: () => void): void;
}

/** 목록에 남겨 두는 최대 줄 수 — 끝난 것부터 오래된 순으로 지운다. */
const MAX_ROWS = 200;

const STATE_TEXT: Record<QueueState, string> = {
  wait: "대기",
  run: "전송 중",
  done: "완료",
  fail: "실패",
  skip: "건너뜀",
};

/**
 * 세션별 큐 패널. 창을 접었다 다시 열어도 **같은 목록**을 보게 한다 — 전송은 창과
 * 무관하게 이어지는데 목록만 새로 비면 "전송이 끊겼다"로 읽힌다(실기 보고).
 */
const panels = new Map<string, QueueApi>();
export function queuePanelFor(sessionId: string): QueueApi {
  let q = panels.get(sessionId);
  if (!q) {
    q = createQueuePanel();
    panels.set(sessionId, q);
  }
  return q;
}
/** 연결을 끊을 때 함께 버린다(그 세션의 큐는 의미가 없어진다). */
export function dropQueuePanel(sessionId: string): void {
  panels.delete(sessionId);
}

export function createQueuePanel(): QueueApi {
  const root = document.createElement("div");
  root.className = "sftp-queue";

  const head = document.createElement("div");
  head.className = "queue-head";
  const toggle = document.createElement("button");
  toggle.className = "queue-toggle";
  applyIcon(toggle, "chevronDown");
  toggle.title = "전송 큐 접기/펼치기";
  const label = document.createElement("span");
  label.className = "queue-label";
  label.textContent = "전송 큐";
  const counts = document.createElement("span");
  counts.className = "queue-counts";
  const retryBtn = document.createElement("button");
  retryBtn.className = "sftp-btn queue-retry";
  retryBtn.textContent = "실패 다시 시도";
  retryBtn.style.display = "none";
  // 100개를 걸어 놓고 50개째에 그만두고 싶을 때 — 남은 대기를 한 번에 뺀다.
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "sftp-btn queue-cancel-wait";
  cancelBtn.textContent = "대기 모두 취소";
  cancelBtn.style.display = "none";
  const clearBtn = document.createElement("button");
  clearBtn.className = "sftp-btn queue-clear";
  clearBtn.textContent = "끝난 항목 지우기";
  head.append(toggle, label, counts, retryBtn, cancelBtn, clearBtn);

  const list = document.createElement("div");
  list.className = "queue-list";
  root.append(head, list);

  const items: QueueEntry[] = [];
  const byKey = new Map<string, QueueEntry>();
  /** 사용자가 취소한 항목 — 차례가 와도 보내지 않는다. */
  const cancelled = new Set<string>();
  let retry: (items: QueueEntry[]) => void = () => {};
  let cancelRunning: () => void = () => {};
  let cancelWaiting: () => void = () => {};
  let collapsed = false;
  /**
   * 줄 하나하나의 DOM — 한 줄이 바뀔 때 그 줄만 갈아 끼우기 위한 것(0.84.0).
   *
   * 예전에는 상태가 바뀔 때마다 목록을 통째로 지우고 다시 그렸다. 파일 N 개를 보내면
   * 넣을 때 N 번, 시작·끝날 때 다시 2N 번 — 매번 N 줄을 새로 만드니 **N² 에 비례하는**
   * DOM 작업이 된다. 폴더째 끌어다 놓아 파일이 수천 개면 창이 멎은 것처럼 굳었다.
   * (덜어 내기는 묶음을 시작할 때만 하므로 한 묶음 안에서는 목록이 계속 자란다.)
   */
  const rowEls = new Map<string, HTMLElement>();

  const rowOf = (e: QueueEntry): HTMLElement => {
    const row = document.createElement("div");
    row.className = `queue-row q-${e.state}`;
    const st = document.createElement("span");
    st.className = "queue-state";
    st.textContent = STATE_TEXT[e.state];
    const dir = document.createElement("span");
    dir.className = "queue-dir";
    dir.textContent = e.dir === "up" ? "올림" : "받음";
    const name = document.createElement("span");
    name.className = "queue-name";
    name.textContent = e.name;
    name.title = `${e.srcPath}  →  ${e.destDir}`;
    const size = document.createElement("span");
    size.className = "queue-size";
    size.textContent = e.size > 0 ? fmtSize(e.size) : "";
    row.append(st, dir, name, size);
    // 아직 안 끝난 항목만 끊을 수 있다. 전송 중이면 그 파일만 끊고 다음으로 넘어간다.
    if (e.state === "wait" || e.state === "run") {
      const x = document.createElement("button");
      x.className = "queue-x";
      x.textContent = "×";
      x.title = e.state === "run" ? "이 파일 전송 중단" : "대기에서 빼기";
      x.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        cancelled.add(e.key);
        if (e.state === "run") {
          cancelRunning(); // 백엔드 전송을 끊는다 — 결과 표시는 전송 쪽이 맡는다
        } else {
          e.state = "skip";
          e.note = "취소됨";
          repaintRow(e);
          scheduleSummary();
        }
      });
      row.appendChild(x);
    }
    if (e.note) {
      const note = document.createElement("span");
      note.className = "queue-note";
      note.textContent = e.note;
      note.title = e.note;
      row.appendChild(note);
    }
    return row;
  };

  /**
   * 머리말 숫자·버튼만 다시 계산한다. 줄마다 부르면 항목 수만큼 도는 셈이라 한 프레임에
   * 한 번으로 묶는다(scheduleSummary).
   */
  const summary = (): void => {
    const n = (s: QueueState): number => items.filter((x) => x.state === s).length;
    const failed = n("fail");
    counts.textContent = items.length
      ? `대기 ${n("wait")} · 완료 ${n("done")}` +
        (failed ? ` · 실패 ${failed}` : "") +
        (n("skip") ? ` · 건너뜀 ${n("skip")}` : "")
      : "";
    retryBtn.style.display = failed > 0 ? "" : "none";
    cancelBtn.style.display = n("wait") > 0 ? "" : "none";
    // 전송 중인 줄이 보이게 따라간다 — 목록이 길어지면 어디가 도는지 알 수 없다.
    list.querySelector(".queue-row.q-run")?.scrollIntoView({ block: "nearest" });
  };

  let summaryPending = 0;
  const scheduleSummary = (): void => {
    if (summaryPending) return;
    summaryPending = requestAnimationFrame(() => {
      summaryPending = 0;
      summary();
    });
  };

  /** 목록 전체를 다시 만든다 — 줄이 통째로 사라지거나 순서가 바뀔 때만 부른다. */
  const draw = (): void => {
    list.innerHTML = "";
    rowEls.clear();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "queue-empty";
      empty.textContent = "전송할 항목이 없습니다 — 파일을 끌어다 놓거나 우클릭해 보내면 여기에 줄을 섭니다.";
      list.appendChild(empty);
    }
    for (const e of items) {
      const row = rowOf(e);
      rowEls.set(e.key, row);
      list.appendChild(row);
    }
    summary();
  };

  /** 그 줄 하나만 갈아 끼운다. 줄을 못 찾으면(전체 재구성 전) 조용히 넘어간다. */
  const repaintRow = (e: QueueEntry): void => {
    const old = rowEls.get(e.key);
    if (!old) return;
    const row = rowOf(e);
    rowEls.set(e.key, row);
    old.replaceWith(row);
  };

  const toggleFold = (): void => {
    collapsed = !collapsed;
    root.classList.toggle("collapsed", collapsed);
  };
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFold();
  });
  // 셰브론은 작다 — 머리말 어디를 눌러도 접히고 펴지게 한다(버튼 자리는 제외).
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    toggleFold();
  });
  retryBtn.addEventListener("click", () => {
    const failed = items.filter((x) => x.state === "fail");
    if (failed.length) retry(failed);
  });
  cancelBtn.addEventListener("click", () => {
    // 대기 중인 것만 뺀다 — 지금 전송 중인 파일은 건드리지 않는다(그건 행의 × 로).
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].state !== "wait") continue;
      cancelled.add(items[i].key); // 차례가 와도 보내지 않도록 표시하고
      byKey.delete(items[i].key); // 목록에서도 뺀다(남은 것도 지울 수 있어야 한다)
      items.splice(i, 1);
    }
    // 큐에 아직 오르지 않은 것(폴더 하위 파일 등)까지 멈추려면 묶음 자체를 세워야 한다.
    cancelWaiting();
    draw();
  });
  clearBtn.addEventListener("click", () => {
    // 끝난 것을 치운다 — 완료·건너뜀·실패. 대기·전송 중은 남긴다(진행이 안 보이게 된다).
    for (let i = items.length - 1; i >= 0; i--) {
      const st = items[i].state;
      if (st === "done" || st === "skip" || st === "fail") {
        byKey.delete(items[i].key);
        cancelled.delete(items[i].key);
        items.splice(i, 1);
      }
    }
    draw();
  });

  return {
    root,
    begin() {
      // 큐는 이어진다(0.75.0) — 전송 중에 새로 넣은 것이 앞의 목록을 지우면 안 된다.
      // 목록이 무한정 자라지 않게 끝난 항목만 오래된 순으로 덜어 낸다.
      while (items.length > MAX_ROWS) {
        const i = items.findIndex(
          (x) => x.state === "done" || x.state === "skip" || x.state === "fail",
        );
        if (i < 0) break;
        byKey.delete(items[i].key);
        cancelled.delete(items[i].key);
        items.splice(i, 1);
      }
      draw();
    },
    ensure(e) {
      cancelled.delete(e.key); // 다시 넣는 것은 새 요청이다(재시도 포함)
      if (byKey.has(e.key)) return;
      const entry: QueueEntry = { ...e, state: "wait" };
      byKey.set(e.key, entry);
      items.push(entry);
      // 첫 줄이면 '비었습니다' 안내를 치워야 하니 전체를 다시 그린다. 그 뒤로는 덧붙이기만.
      if (items.length === 1) {
        draw();
        return;
      }
      const row = rowOf(entry);
      rowEls.set(entry.key, row);
      list.appendChild(row);
      scheduleSummary();
    },
    setState(key, state, note) {
      const e = byKey.get(key);
      if (!e) return;
      e.state = state;
      e.note = note;
      repaintRow(e);
      scheduleSummary();
    },
    failedItems: () => items.filter((x) => x.state === "fail"),
    setRetry(fn) {
      retry = fn;
    },
    isCancelled: (key) => cancelled.has(key),
    setCancelRunning(fn) {
      cancelRunning = fn;
    },
    setCancelWaiting(fn) {
      cancelWaiting = fn;
    },
  };
}
