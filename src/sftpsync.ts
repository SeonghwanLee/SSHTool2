// 폴더 비교 · 동기화(0.74.0) — 지금 보고 있는 로컬 폴더와 원격 폴더를 재귀로 견주고,
// 고른 항목만 한 방향으로 보낸다.
//
// 설계에서 정한 것 두 가지:
//
// 1) **한 방향만.** 양방향 자동 병합은 어느 쪽이 최신인지 시각만으로 판정해야 하는데,
//    서버와 PC 의 시계·타임존·파일시스템 해상도가 제각각이라 오판이 조용히 덮어쓰기로
//    이어진다. 방향은 사람이 고른다.
// 2) **지우지 않는다.** "대상에만 있는 것 삭제"는 다른 클라이언트에 있는 기능이지만,
//    한 번의 오조작이 서버 파일을 지운다. 여기서는 만들고 덮어쓸 뿐이다.
//
// 판정 기준은 크기다. 수정시각은 참고로만 보여 준다 — 전송하면 시각이 그대로 보존되지
// 않는 서버가 많아, 시각 차이로 '다름'을 매기면 매번 전부 다르다고 나온다.

import { localList, sftpList } from "./ipc";
import { openModal } from "./dialogs";
import { joinPath, fmtSize, type Entry, type Side } from "./sftpcommon";

export interface SyncCtx {
  getSftpId: () => string | null;
  localDir: () => string;
  remoteDir: () => string;
  setStatus: (m: string) => void;
  /** 계획대로 보낸다. 반환은 보낸/실패 개수. */
  run: (
    from: Side,
    plan: { entry: Entry; destDir: string }[],
    makeDirs: string[],
  ) => Promise<{ sent: number; failed: number }>;
  /** 전송이 끝난 뒤 양쪽 목록을 다시 읽는다. */
  refresh: () => Promise<void>;
}

type State = "localOnly" | "remoteOnly" | "diff" | "same";

interface Row {
  /** 비교 시작 폴더 기준 상대 경로("conf/httpd.conf"). */
  rel: string;
  isDir: boolean;
  local: Entry | null;
  remote: Entry | null;
  state: State;
}

/** 한 번에 훑을 항목 수 상한 — 이보다 크면 멈추고 알린다(무한정 도는 것보다 낫다). */
const MAX_ENTRIES = 20000;

const stateText: Record<State, string> = {
  localOnly: "로컬에만",
  remoteOnly: "원격에만",
  diff: "크기 다름",
  same: "같음",
};

/** 이 방향으로 보낼 만한 항목인가(기본 체크 대상). */
const isCandidate = (r: Row, from: Side): boolean =>
  r.state === "diff" || r.state === (from === "local" ? "localOnly" : "remoteOnly");

/**
 * 두 폴더를 재귀로 견준다. 한쪽에만 있는 폴더는 통째로 한 항목으로 잡고 더 내려가지
 * 않는다 — 어차피 통째로 옮기게 되고, 수천 개 하위 항목을 목록에 늘어놓을 이유가 없다.
 */
async function compare(
  ctx: SyncCtx,
  localDir: string,
  remoteDir: string,
  rel: string,
  out: Row[],
  cancelled: () => boolean,
): Promise<void> {
  if (cancelled() || out.length >= MAX_ENTRIES) return;
  const id = ctx.getSftpId();
  if (!id) return;
  const [ls, rs] = await Promise.all([
    localList(localDir).catch(() => [] as Entry[]),
    sftpList(id, remoteDir).catch(() => [] as Entry[]),
  ]);
  const skip = (e: Entry): boolean => e.name === "." || e.name === "..";
  const lmap = new Map(ls.filter((e) => !skip(e)).map((e) => [e.name, e]));
  const rmap = new Map(rs.filter((e) => !skip(e)).map((e) => [e.name, e]));
  const names = [...new Set([...lmap.keys(), ...rmap.keys()])].sort((a, b) =>
    a.localeCompare(b, "ko"),
  );

  for (const name of names) {
    if (cancelled() || out.length >= MAX_ENTRIES) return;
    const l = lmap.get(name) ?? null;
    const r = rmap.get(name) ?? null;
    const childRel = rel ? `${rel}/${name}` : name;

    if (l && r && l.isDir && r.isDir) {
      // 양쪽 다 폴더 — 목록에는 넣지 않고 안으로 들어간다(폴더 자체는 옮길 것이 없다).
      await compare(ctx, joinPath(localDir, name), joinPath(remoteDir, name), childRel, out, cancelled);
      continue;
    }
    if (l && r && !l.isDir && !r.isDir) {
      out.push({
        rel: childRel,
        isDir: false,
        local: l,
        remote: r,
        state: l.size === r.size ? "same" : "diff",
      });
      continue;
    }
    if (l && r) {
      // 한쪽은 파일, 한쪽은 폴더 — 자동으로 처리하면 위험하다. '다름'으로 보이기만 한다.
      out.push({ rel: childRel, isDir: false, local: l, remote: r, state: "diff" });
      continue;
    }
    out.push({
      rel: childRel,
      isDir: (l ?? r)!.isDir,
      local: l,
      remote: r,
      state: l ? "localOnly" : "remoteOnly",
    });
  }
}

/** rel 의 부모 경로(없으면 ""). */
const parentRel = (rel: string): string => {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
};

export function openSyncDialog(ctx: SyncCtx): void {
  if (!ctx.getSftpId()) {
    ctx.setStatus("원격에 접속되지 않았습니다.");
    return;
  }
  const localRoot = ctx.localDir();
  const remoteRoot = ctx.remoteDir();

  let rows: Row[] = [];
  let from: Side = "local";
  let hideSame = true;
  let scanning = true;
  let cancelled = false;
  const checked = new Set<string>();

  openModal(
    (close) => {
      const card = document.createElement("div");
      card.className = "sync-card";
      const title = document.createElement("h3");
      title.textContent = "폴더 비교 · 동기화";

      const paths = document.createElement("div");
      paths.className = "sync-paths";
      const lp = document.createElement("div");
      lp.textContent = `로컬: ${localRoot}`;
      const rp = document.createElement("div");
      rp.textContent = `원격: ${remoteRoot}`;
      paths.append(lp, rp);

      // 방향 — 라디오 두 개. 무엇을 어디로 덮는지가 이 창에서 가장 중요한 선택이다.
      const dirRow = document.createElement("div");
      dirRow.className = "sync-dir";
      const mkDir = (label: string, value: Side): HTMLLabelElement => {
        const lab = document.createElement("label");
        lab.className = "kind-radio";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "sync-dir";
        input.value = value;
        input.checked = from === value;
        input.addEventListener("change", () => {
          if (!input.checked) return;
          from = value;
          resetChecks();
          draw();
        });
        const span = document.createElement("span");
        span.textContent = label;
        lab.append(input, span);
        return lab;
      };
      dirRow.append(mkDir("로컬 → 원격 (올리기)", "local"), mkDir("원격 → 로컬 (내려받기)", "remote"));

      const opts = document.createElement("div");
      opts.className = "sync-opts";
      const sameRow = document.createElement("label");
      sameRow.className = "check-row";
      const sameChk = document.createElement("input");
      sameChk.type = "checkbox";
      sameChk.checked = hideSame;
      sameChk.addEventListener("change", () => {
        hideSame = sameChk.checked;
        draw();
      });
      const sameText = document.createElement("span");
      sameText.textContent = "같은 항목 숨기기";
      sameRow.append(sameChk, sameText);
      opts.append(sameRow);

      const list = document.createElement("div");
      list.className = "sync-list";
      const summary = document.createElement("div");
      summary.className = "sync-summary";
      const note = document.createElement("div");
      note.className = "sync-note";
      note.textContent =
        "대상에만 있는 파일은 지우지 않습니다 — 고른 항목을 만들고 덮어쓰기만 합니다.";

      const buttons = document.createElement("div");
      buttons.className = "modal-buttons";
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "닫기";
      closeBtn.addEventListener("click", () => {
        cancelled = true;
        close();
      });
      const sendBtn = document.createElement("button");
      sendBtn.className = "btn-accent";
      sendBtn.textContent = "선택한 항목 전송";
      sendBtn.disabled = true;
      sendBtn.addEventListener("click", () => {
        cancelled = true; // 진행 중 검사가 있으면 멈춘다
        close();
        void send();
      });
      buttons.append(closeBtn, sendBtn);

      const resetChecks = (): void => {
        checked.clear();
        for (const r of rows) if (isCandidate(r, from)) checked.add(r.rel);
      };

      const draw = (): void => {
        list.innerHTML = "";
        const shown = rows.filter((r) => !(hideSame && r.state === "same"));
        for (const r of shown) {
          const row = document.createElement("label");
          row.className = `sync-row state-${r.state}`;
          const chk = document.createElement("input");
          chk.type = "checkbox";
          chk.checked = checked.has(r.rel);
          // 방향에 맞지 않는 항목(대상에만 있는 것)은 보낼 것이 없다.
          chk.disabled = r.state === (from === "local" ? "remoteOnly" : "localOnly");
          chk.addEventListener("change", () => {
            if (chk.checked) checked.add(r.rel);
            else checked.delete(r.rel);
            updateSummary();
          });
          const name = document.createElement("span");
          name.className = "sync-name";
          name.textContent = r.rel + (r.isDir ? "/" : "");
          const st = document.createElement("span");
          st.className = "sync-state";
          st.textContent = stateText[r.state];
          const size = document.createElement("span");
          size.className = "sync-size";
          size.textContent = r.isDir
            ? ""
            : `${r.local ? fmtSize(r.local.size) : "-"} / ${r.remote ? fmtSize(r.remote.size) : "-"}`;
          row.append(chk, name, st, size);
          list.appendChild(row);
        }
        if (shown.length === 0) {
          const empty = document.createElement("div");
          empty.className = "sync-empty";
          empty.textContent = scanning ? "비교하는 중…" : "차이가 없습니다.";
          list.appendChild(empty);
        }
        updateSummary();
      };

      const updateSummary = (): void => {
        const n = rows.filter((r) => checked.has(r.rel)).length;
        const bytes = rows
          .filter((r) => checked.has(r.rel) && !r.isDir)
          .reduce((s, r) => s + ((from === "local" ? r.local?.size : r.remote?.size) ?? 0), 0);
        summary.textContent = scanning
          ? `비교하는 중… ${rows.length}개 확인`
          : `${rows.length}개 비교 · 선택 ${n}개 (${fmtSize(bytes)})`;
        sendBtn.disabled = scanning || n === 0;
      };

      const send = async (): Promise<void> => {
        const picked = rows.filter((r) => checked.has(r.rel));
        if (picked.length === 0) return;
        const srcRoot = from === "local" ? localRoot : remoteRoot;
        const dstRoot = from === "local" ? remoteRoot : localRoot;
        // 대상 폴더는 상위부터 만든다 — 하위를 먼저 만들면 부모가 없어 실패한다.
        const dirs = [...new Set(picked.map((r) => parentRel(r.rel)).filter(Boolean))].sort(
          (a, b) => a.length - b.length,
        );
        const plan = picked.map((r) => ({
          entry: {
            name: r.rel.slice(parentRel(r.rel) ? parentRel(r.rel).length + 1 : 0),
            path: joinPath(srcRoot, r.rel),
            isDir: r.isDir,
            size: (from === "local" ? r.local?.size : r.remote?.size) ?? 0,
            modified: 0,
          } as Entry,
          destDir: parentRel(r.rel) ? joinPath(dstRoot, parentRel(r.rel)) : dstRoot,
        }));
        ctx.setStatus(`동기화 시작 — ${plan.length}개`);
        const { sent, failed } = await ctx.run(
          from,
          plan,
          dirs.map((d) => joinPath(dstRoot, d)),
        );
        ctx.setStatus(
          failed > 0 ? `동기화 완료 — ${sent}개 전송, ${failed}개 실패` : `동기화 완료 — ${sent}개 전송`,
        );
        await ctx.refresh();
      };

      card.append(title, paths, dirRow, opts, list, summary, note, buttons);

      // 비교는 창을 띄운 뒤에 시작한다 — 큰 폴더에서 창이 늦게 뜨면 멈춘 것처럼 보인다.
      void (async () => {
        const acc: Row[] = [];
        await compare(ctx, localRoot, remoteRoot, "", acc, () => cancelled);
        if (cancelled) return;
        rows = acc;
        scanning = false;
        resetChecks();
        draw();
        if (rows.length >= MAX_ENTRIES) {
          ctx.setStatus(`항목이 너무 많아 ${MAX_ENTRIES}개까지만 비교했습니다.`);
        }
      })();

      draw();
      return card;
    },
    () => {
      cancelled = true;
    },
  );
}
