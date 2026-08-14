// 세션 목록의 행 렌더 — '최근 접속' 섹션과 세션 행. sidebar.ts 에서 분리(0.67.0).
// 로직 변경 없음. Sidebar 의 비공개 멤버는 밖에서 볼 수 없으므로, 필요한 것만 담은
// 컨텍스트(RowCtx)를 렌더 시점에 만들어 넘긴다.

import type { SessionInfo } from "./types";
import { sessionColorCss } from "./types";
import { showContextMenu, type MenuItem } from "./contextmenu";
import { applyIcon } from "./icons";
import {
  DRAG_TYPE,
  kindIcon,
  detailText,
  rowTooltip,
  type SidebarCallbacks,
} from "./sidebar";

/** 행 렌더가 필요로 하는 것만 추린 통로. Sidebar 가 렌더 때마다 만들어 넘긴다. */
export interface RowCtx {
  cb: SidebarCallbacks;
  tree: HTMLElement;
  sessions: SessionInfo[];
  recentLimit: number;
  showDetail: boolean;
  select: (row: HTMLElement) => void;
  serviceItems: (s: SessionInfo) => MenuItem[];
  registerNav: (row: HTMLElement, key: string, activate: () => void) => void;
  paintSftpChip: (chip: HTMLElement, s: SessionInfo) => boolean;
}

/** 상단 '최근 접속' 섹션 — 접속 이력이 있는 세션 최근 10개, 클릭 시 바로 접속. */
export function renderRecent(ctx: RowCtx): void {
  if (ctx.recentLimit <= 0) return; // 0 = 최근 접속 섹션 숨김
  const recent = ctx.sessions
    .filter((s) => s.lastConnectedUtc > 0)
    .sort((a, b) => b.lastConnectedUtc - a.lastConnectedUtc)
    .slice(0, ctx.recentLimit);
  if (recent.length === 0) return;

  const head = document.createElement("div");
  head.className = "recent-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = "최근 접속";
  const clearAll = document.createElement("button");
  clearAll.className = "recent-clear tree-act";
  applyIcon(clearAll, "delete");
  clearAll.title = "최근 기록 전체 삭제";
  clearAll.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.cb.onClearRecent();
  });
  head.append(headLabel, clearAll);
  ctx.tree.appendChild(head);

  for (const s of recent) {
    const row = document.createElement("div");
    row.className = "recent-row";
    row.title = rowTooltip(s);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    applyIcon(icon, kindIcon(s));

    // 구조·클래스를 세션 행(sessionRow)과 똑같이 맞춘다. 예전에는 이름·세부정보·버튼을
    // 행에 나란히 붙였는데, 늘어나는 몫이 세부정보에만 있어서 '세션 세부정보 표시'를 끄면
    // 버튼이 오른쪽 끝이 아니라 이름 옆에 따라붙었다. 세션 행처럼 이름+세부정보를 한 겹
    // 감싸 그 묶음이 늘어나게 하면 세부정보 유무와 무관하게 버튼이 오른쪽에 고정된다.
    // 클래스까지 공유해 두 목록이 다시 어긋나지 않게 한다.
    const main = document.createElement("div");
    main.className = "tree-session-main";
    const name = document.createElement("div");
    name.className = "tree-session-name";
    name.textContent = s.name || s.host;
    const detail = document.createElement("div");
    detail.className = "tree-session-detail";
    detail.textContent = detailText(s);
    main.append(name);
    // '세션 세부정보 표시' 는 최근 접속에도 같이 적용한다 — 세션 행에만 걸려 있어
    // 설정을 꺼도 최근 접속에는 계정@호스트가 그대로 남아 있었다.
    if (ctx.showDetail) main.append(detail);

    const actions = document.createElement("div");
    actions.className = "tree-actions";

    // 세션 행과 같은 기준 — 로컬 셸이거나 SFTP 를 끈 세션에는 노출하지 않는다.
    const sftpAvailable = s.kind === "ssh" && s.enableSftp;
    const sftp = document.createElement("button");
    sftp.className = "tree-act sftp-chip";
    const sftpAlive = ctx.paintSftpChip(sftp, s);
    sftp.style.display = sftpAvailable ? "" : "none";
    sftp.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.cb.onSftp(s);
    });

    // 마우스 오버 시 나타나는 개별 삭제(휴지통) 버튼.
    const del = document.createElement("button");
    del.className = "tree-act";
    applyIcon(del, "delete");
    del.title = "최근 목록에서 삭제";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.cb.onRemoveRecent(s);
    });

    actions.append(sftp, del);
    // 연결이 살아 있으면 호버하지 않아도 칩이 보인다(세션 행과 동일).
    row.classList.toggle("has-sftp", sftpAlive);
    row.append(icon, main, actions);
    row.dataset.navKind = "recent";
    ctx.registerNav(row, `r:${s.id}`, () => ctx.cb.onOpen(s));
    // 세션 행과 같은 규칙 — 단일 클릭은 선택만, 접속은 더블클릭.
    // 한 번 클릭에 바로 붙으면 목록을 훑다가 실수로 접속하게 된다.
    row.addEventListener("click", () => ctx.select(row));
    row.addEventListener("dblclick", () => ctx.cb.onOpen(s));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      ctx.select(row);
      showContextMenu(e.clientX, e.clientY, [
        { label: "연결", accel: "c", action: () => ctx.cb.onOpen(s) },
        ...ctx.serviceItems(s),
        ...(sftpAvailable
          ? [{ label: "SFTP 파일 전송", accel: "f", action: () => ctx.cb.onSftp(s) } as const]
          : []),
        { separator: true },
        {
          label: "최근 목록에서 삭제",
          accel: "d",
          danger: true,
          action: () => ctx.cb.onRemoveRecent(s),
        },
        { label: "최근 기록 전체 삭제", accel: "a", action: () => ctx.cb.onClearRecent() },
      ]);
    });
    ctx.tree.appendChild(row);
  }

  const divider = document.createElement("div");
  divider.className = "recent-divider";
  ctx.tree.appendChild(divider);
}

export function sessionRow(ctx: RowCtx, s: SessionInfo, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "tree-session";
  // 색 태그(0.67.0) — 운영/개발을 목록에서 눈으로 가른다.
  const tagCss = sessionColorCss(s.color);
  if (tagCss) {
    row.classList.add("has-color");
    row.style.setProperty("--session-color", tagCss);
  }
  row.style.paddingLeft = `${8 + depth * 14}px`;

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  applyIcon(icon, kindIcon(s));

  const main = document.createElement("div");
  main.className = "tree-session-main";
  const name = document.createElement("div");
  name.className = "tree-session-name";
  name.textContent = s.name || s.host;
  const detail = document.createElement("div");
  detail.className = "tree-session-detail";
  detail.textContent = detailText(s);
  main.append(name);
  if (ctx.showDetail) main.append(detail);

  const actions = document.createElement("div");
  actions.className = "tree-actions";
  actions.draggable = false; // 버튼 위에서 행 드래그가 시작되지 않게
  // 로컬 셸 세션에는 SFTP 가 없다(로컬 파일은 탐색기로 접근).
  const sftp = document.createElement("button");
  sftp.className = "tree-act";
  sftp.style.display = s.kind === "ssh" && s.enableSftp ? "" : "none";
  sftp.title = "SFTP 파일 전송";
  sftp.classList.add("sftp-chip");
  const sftpAlive = ctx.paintSftpChip(sftp, s);
  sftp.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.cb.onSftp(s);
  });
  const edit = document.createElement("button");
  edit.className = "tree-act";
  edit.title = "편집";
  applyIcon(edit, "edit");
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.cb.onEdit(s);
  });
  const del = document.createElement("button");
  del.className = "tree-act";
  del.title = "삭제";
  applyIcon(del, "delete");
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.cb.onDelete(s);
  });
  actions.append(sftp, edit, del);

  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData(DRAG_TYPE, s.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    // 행의 위/아래 절반에 따라 삽입 위치를 표시(WPF 0.6.2 삽입선).
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    row.classList.toggle("drop-before", before);
    row.classList.toggle("drop-after", !before);
  });
  row.addEventListener("dragleave", (e) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !row.contains(to)) row.classList.remove("drop-before", "drop-after");
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    // 클래스는 dragleave 로 지워질 수 있으므로 좌표에서 다시 계산한다.
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    row.classList.remove("drop-before", "drop-after");
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    if (id && id !== s.id) {
      ctx.cb.onDropSession(id, { kind: "session", id: s.id, before });
    }
  });

  row.title = rowTooltip(s);
  row.append(icon, main, actions);
  row.classList.toggle("has-sftp", sftpAlive);
  row.dataset.sessionId = s.id; // 어느 세션의 행인지 — 진행률 갱신·검사에서 행을 짚는다
  row.dataset.navKind = "session";
  row.dataset.navDepth = String(depth);
  ctx.registerNav(row, `s:${s.id}`, () => ctx.cb.onOpen(s));
  // 키보드로 옮겨 다닐 때도 마우스 클릭과 같은 선택 하이라이트를 남긴다.
  row.addEventListener("focus", () => ctx.select(row));
  // 더블클릭 = 접속(단일 클릭 중복·오접속 방지). 선택 하이라이트만 단일 클릭.
  row.addEventListener("dblclick", () => ctx.cb.onOpen(s));
  row.addEventListener("click", () => ctx.select(row));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctx.select(row);
    showContextMenu(e.clientX, e.clientY, [
      { label: "연결", accel: "c", action: () => ctx.cb.onOpen(s) },
      ...ctx.serviceItems(s),
      ...(s.kind !== "ssh" || !s.enableSftp
        ? []
        : [
            { label: "SFTP 파일 전송", accel: "f", action: () => ctx.cb.onSftp(s) } as const,
          ]),
      { separator: true },
      { label: "편집", accel: "e", action: () => ctx.cb.onEdit(s) },
      { label: "복제", accel: "u", action: () => ctx.cb.onDuplicate(s) },
      { label: "폴더 이동", accel: "m", action: () => ctx.cb.onMove(s) },
      { label: "이름 변경", accel: "r", action: () => ctx.cb.onRename(s) },
      { separator: true },
      { label: "위로", accel: "k", action: () => ctx.cb.onReorder(s, -1) },
      { label: "아래로", accel: "j", action: () => ctx.cb.onReorder(s, 1) },
      { separator: true },
      { label: "새 폴더", accel: "n", action: () => ctx.cb.onNewFolder(s.folder) },
      { label: "삭제", accel: "d", danger: true, action: () => ctx.cb.onDelete(s) },
      { label: "세션 일괄 삭제…", accel: "b", danger: true, action: () => ctx.cb.onBulkDelete() },
    ]);
  });
  return row;
}
