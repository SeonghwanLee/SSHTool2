// SFTP 창의 크기 조절 손잡이(네 변 + 네 모서리). sftpui.ts 에서 분리(0.67.0).
// 로직 변경 없음 — 최대화 해제만 콜백으로 받는다(버튼 아이콘은 창 본체가 쥐고 있다).

export function attachResizeHandles(
  panel: HTMLElement,
  isMaximized: () => boolean,
  clearMaximized: () => void,
): void {
  // ── 크기 조절 손잡이 ──
  //
  // 창처럼 네 변과 네 모서리에서 모두 잡을 수 있게 한다. 우하단 한 곳뿐이면 창을 키우려고
  // 매번 그 구석까지 커서를 옮겨야 한다.
  //
  // CSS `resize: both` 는 쓸 수 없다. 이 패널은 오버레이의 flex 로 가운데 정렬돼 있어,
  // 끄는 동안 커지는 만큼 다시 가운데로 밀린다 — 잡고 있던 모서리가 커서에서 도망간다.
  // 드래그를 시작할 때 패널을 지금 자리에 고정(position: fixed)한 뒤 변을 움직인다.
  // 기준점이 움직이지 않으므로 잡은 자리가 커서를 그대로 따라온다.
  const EDGES: { dir: string; cursor: string }[] = [
    { dir: "n", cursor: "ns-resize" },
    { dir: "s", cursor: "ns-resize" },
    { dir: "e", cursor: "ew-resize" },
    { dir: "w", cursor: "ew-resize" },
    { dir: "ne", cursor: "nesw-resize" },
    { dir: "nw", cursor: "nwse-resize" },
    { dir: "se", cursor: "nwse-resize" },
    { dir: "sw", cursor: "nesw-resize" },
  ];

  for (const { dir, cursor } of EDGES) {
    const handle = document.createElement("div");
    handle.className = `sftp-rs sftp-rs-${dir}`;
    if (dir === "se") handle.title = "끌어서 창 크기 조절";
    panel.appendChild(handle);

    handle.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const r = panel.getBoundingClientRect();
      // 재정렬을 끊기 위해 현재 위치·크기에 못 박는다.
      panel.style.position = "fixed";
      panel.style.margin = "0";
      panel.style.left = `${r.left}px`;
      panel.style.top = `${r.top}px`;
      panel.style.width = `${r.width}px`;
      panel.style.height = `${r.height}px`;

      const cs = getComputedStyle(panel);
      const minW = parseFloat(cs.minWidth) || 400;
      const minH = parseFloat(cs.minHeight) || 300;
      const startX = down.clientX;
      const startY = down.clientY;
      const right = r.right;
      const bottom = r.bottom;

      const onMove = (m: MouseEvent) => {
        const dx = m.clientX - startX;
        const dy = m.clientY - startY;
        // 각 변을 따로 움직인다. 화면 밖으로는 못 나가게 막는다 — 넘기면 헤더의 닫기
        // 버튼에 닿지 못하는 창이 된다.
        if (dir.includes("e")) {
          const w = Math.min(window.innerWidth - r.left - 4, Math.max(minW, r.width + dx));
          panel.style.width = `${w}px`;
        }
        if (dir.includes("w")) {
          const left = Math.max(4, Math.min(right - minW, r.left + dx));
          panel.style.left = `${left}px`;
          panel.style.width = `${right - left}px`;
        }
        if (dir.includes("s")) {
          const h = Math.min(window.innerHeight - r.top - 4, Math.max(minH, r.height + dy));
          panel.style.height = `${h}px`;
        }
        if (dir.includes("n")) {
          const top = Math.max(4, Math.min(bottom - minH, r.top + dy));
          panel.style.top = `${top}px`;
          panel.style.height = `${bottom - top}px`;
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.classList.remove("sftp-resizing");
      };
      // 손잡이로 크기를 바꾸면 최대화 상태를 푼다 — '이전 크기'라고 적힌 채 크기가
      // 최대화가 아니면 버튼이 거짓말을 하게 된다.
      if (isMaximized()) clearMaximized();
      // 드래그 중에는 커서를 고정한다. 손잡이를 잠깐 벗어나도 모양이 바뀌지 않게.
      document.body.style.cursor = cursor;
      document.body.classList.add("sftp-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

}
