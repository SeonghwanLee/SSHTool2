// 동시 명령 창 — 여러 세션에 같은 입력을 보내는 하단 바(대상: 전체/활성/선택).
// main.ts 에서 분리(0.63.0 정지작업). 로직 변경 없음.

import type { TabManager } from "./tabs";

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};

export function wireCommandBar(tabs: TabManager): void {
  const bar = $("cmdbar");
  const toggle = $("cmd-toggle");
  const input = $<HTMLInputElement>("cmd-input");
  const mode = $<HTMLSelectElement>("cmd-mode");
  const pickBtn = $("cmd-pick");
  const picker = $("cmd-picker");
  const send = $("cmd-send");
  const status = $("cmd-status");

  /**
   * '선택한 세션' 모드의 대상 탭 키. 탭이 닫히면 유령 키가 남으므로 갱신 때마다 걸러낸다.
   * 세션 id 가 아니라 탭 키로 잡는다 — 같은 세션을 두 탭으로 열어 두면 둘은 별개다.
   */
  let picked = new Set<string>();

  toggle.addEventListener("click", () => {
    bar.classList.toggle("hidden");
    toggle.classList.toggle("active", !bar.classList.contains("hidden"));
    if (bar.classList.contains("hidden")) {
      togglePicker(false);
      tabs.markBroadcast(null);
      return;
    }
    updateCount();
    input.focus();
  });

  const history: string[] = [];
  let histIdx = -1;

  /** 지금 명령이 나갈 탭 키 집합. 전체·활성 모드에서는 null(따로 겨누지 않음). */
  const targetKeys = (): ReadonlySet<string> | null =>
    mode.value === "pick" ? picked : null;

  const updateCount = () => {
    picked = tabs.pruneKeys(picked);
    pickBtn.classList.toggle("hidden", mode.value !== "pick");
    if (mode.value === "all") status.textContent = `대상 ${tabs.connectedCount()}개 세션`;
    else if (mode.value === "active") status.textContent = "활성 세션";
    else status.textContent = picked.size > 0 ? `대상 ${picked.size}개 세션` : "대상을 고르세요";
    // 창이 열려 있을 때만 탭바를 물들인다 — 닫아 두고 강조만 남으면 영문을 모른다.
    const open = !bar.classList.contains("hidden");
    tabs.markBroadcast(open && mode.value === "pick" ? picked : null);
    if (!picker.classList.contains("hidden")) drawPicker();
  };

  /** 대상 고르기 패널 — 접속 중인 탭을 체크박스로 나열한다. */
  const drawPicker = () => {
    picker.innerHTML = "";
    const targets = tabs.broadcastTargets();
    if (targets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cmd-pick-empty";
      empty.textContent = "접속된 세션이 없습니다.";
      picker.appendChild(empty);
      return;
    }
    for (const t of targets) {
      const row = document.createElement("label");
      row.className = "cmd-pick-row" + (t.locked ? " locked" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = picked.has(t.key);
      // 잠긴 탭은 고를 수 있게 두되 어차피 전송에서 빠진다는 걸 밝힌다 — 목록에서 빼 버리면
      // 왜 그 세션엔 안 갔는지 알 수 없다.
      cb.disabled = t.locked;
      cb.addEventListener("change", () => {
        if (cb.checked) picked.add(t.key);
        else picked.delete(t.key);
        updateCount();
      });
      const name = document.createElement("span");
      name.textContent = t.label + (t.locked ? " (잠김 — 전송되지 않음)" : "");
      row.append(cb, name);
      picker.appendChild(row);
    }
    const foot = document.createElement("div");
    foot.className = "cmd-pick-foot";
    const mkFoot = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    foot.append(
      mkFoot("모두 선택", () => {
        for (const t of targets) if (!t.locked) picked.add(t.key);
        updateCount();
      }),
      mkFoot("모두 해제", () => {
        picked.clear();
        updateCount();
      }),
    );
    picker.appendChild(foot);
  };

  const togglePicker = (open: boolean) => {
    picker.classList.toggle("hidden", !open);
    if (open) drawPicker();
  };

  mode.addEventListener("change", () => {
    if (mode.value !== "pick") togglePicker(false);
    updateCount();
    // 모드를 바꾸자마자 고를 수 있게 — 한 번 더 누르게 하지 않는다.
    if (mode.value === "pick") togglePicker(true);
  });
  pickBtn.addEventListener("click", () => togglePicker(picker.classList.contains("hidden")));
  // 창 밖을 누르면 닫힌다. 명령 입력줄 자체는 예외 — 고르자마자 바로 치는 흐름이 자연스럽다.
  document.addEventListener("mousedown", (e) => {
    if (picker.classList.contains("hidden")) return;
    const t = e.target as Node;
    if (picker.contains(t) || pickBtn.contains(t) || input.contains(t)) return;
    togglePicker(false);
  });

  // 창을 켜 둔 채 세션이 열리거나 닫혀도 대상 개수가 따라가야 한다.
  tabs.onTabsChanged(() => {
    if (!bar.classList.contains("hidden")) updateCount();
  });

  const run = async () => {
    const line = input.value;
    if (!line) return;
    history.push(line);
    histIdx = history.length;
    // 실행 키는 CR — 키보드 Enter 가 보내는 그 바이트다. LF 는 원격 셸에서만 우연히
    // 통하고 로컬 PowerShell(ConPTY)에서는 텍스트만 붙고 실행되지 않는다
    // (시작 명령 경로와 같은 수정 — 진단 0.62.0에서 이 경로만 남은 것을 확인).
    const bytes = new TextEncoder().encode(line + "\r");
    if (mode.value === "active") {
      const r = tabs.sendActive(bytes);
      status.textContent =
        r === "sent" ? "활성 세션 전송" : r === "locked" ? "활성 세션이 잠겨 있음" : "활성 세션 없음";
    } else {
      const keys = targetKeys();
      if (keys && keys.size === 0) {
        status.textContent = "대상을 고르세요";
        return;
      }
      const { sent, locked, failed } = await tabs.broadcast(bytes, keys ?? undefined);
      // 잠겨서 빠졌거나 실패한 세션은 반드시 밝힌다 — 보냈다고 믿고 넘어가는 것이
      // 가장 위험하다(9대만 들어갔는데 10대 성공으로 보이면 안 된다).
      status.textContent =
        sent > 0 || failed.length > 0
          ? `${sent}개 세션 전송` +
            (failed.length > 0 ? ` · 실패 ${failed.length}개(${failed.join(", ")})` : "") +
            (locked > 0 ? ` · 잠김 ${locked}개 제외` : "")
          : locked > 0
            ? `모두 잠겨 있어 보내지 않음 (${locked}개)`
            : "접속된 세션 없음";
    }
    input.value = "";
    input.focus();
  };

  send.addEventListener("click", () => void run());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histIdx > 0) input.value = history[--histIdx];
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx < history.length - 1) input.value = history[++histIdx];
      else {
        histIdx = history.length;
        input.value = "";
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      bar.classList.add("hidden");
      toggle.classList.remove("active");
      togglePicker(false);
      tabs.markBroadcast(null);
    }
  });
}

/**
 * 업데이트 확인 실패가 '인터넷이 안 되는' 쪽으로 보이는가.
 *
 * 프록시·매니페스트 미발행·일시 오류까지 내부망으로 단정하면, 잠깐 끊긴 것뿐인 PC 에
 * 오프라인 모드를 권하게 된다. 연결 자체가 성립하지 않은 경우만 고른다.
 */
