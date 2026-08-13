// SFTP 전송 — 묶음 전송(폴더 재귀)·총량 측정·탐색기 드롭 업로드·폴더 지정 다운로드.
// sftpui.ts 에서 분리(0.67.0). 로직 변경 없음. 창이 쥐고 있던 상태·표시 함수는
// TransferCtx 로 받는다(클로저를 파일 밖으로 그대로 옮길 수 없기 때문).

import type { SessionInfo } from "./types";
import {
  sftpList,
  sftpUpload,
  sftpDownload,
  sftpMkdir,
  localList,
  localMkdir,
} from "./ipc";
import {
  localStat,
  sftpStat,
  sftpUploadChunk,
  sftpUploadFinish,
  sftpUploadDiscard,
} from "./ipc";
import type { QueueApi } from "./sftpqueue";
import { logLine } from "./debuglog";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  conflictDialog,
  resumeDialog,
  uniqueName,
  type ConflictChoice,
  type ConflictResult,
  type ResumeChoice,
  type ResumeResult,
} from "./conflict";
import {
  joinPath,
  fmtSize,
  liveSftp,
  notifyLive,
  type Entry,
  type Side,
  type TransferState,
} from "./sftpcommon";

/** 전송이 창에서 필요로 하는 것들. 창이 만들어 넘긴다. */
export interface TransferCtx {
  session: SessionInfo;
  xfer: TransferState;
  getSftpId: () => string | null;
  isDisposed: () => boolean;
  setStatus: (m: string) => void;
  showProgress: (name: string, done: number, total: number) => void;
  hideProgress: () => void;
  setOverall: (o: string) => void;
  setTransfer: (id: string | null) => void;
  /** 이번 묶음 전체의 바이트(진행률 계산용). */
  bundle: { total: number; done: number };
  /** 측정하며 읽어 둔 폴더 목록 — 전송이 재사용해 같은 폴더를 두 번 조회하지 않는다. */
  listed: Map<string, Entry[]>;
  /** 이어받기 물음에 "모두 적용"을 고른 경우의 선택. 묶음마다 초기화한다. */
  resumeAll: ResumeChoice | null;
  /** 전송 큐 — 무엇이 남았고 무엇이 실패했는지 보여 준다. */
  queue: QueueApi;
  /**
   * 전송 작업을 줄 세운다(0.75.0). 앞 전송이 끝난 뒤에 돈다 — 전에는 전송 중이면
   * 새 요청을 거절했다("이미 전송 중입니다"). 순차 실행은 그대로다(연결이 하나라
   * 동시에 돌리면 진행률·취소가 뒤엉킨다).
   */
  enqueue: (job: () => Promise<void>) => Promise<void>;
  panes: { local: () => Pane; remote: () => Pane };
}

/** 창의 파일 목록 패널 — 전송이 쓰는 부분만 최소로 본다(순환 참조 회피). */
export interface Pane {
  readonly side: Side;
  path: string;
  other: Pane;
  entries: Entry[];
  hasName(n: string): boolean;
  reload(): Promise<void>;
}

// ── 전송 ──

/**
 * 항목을 실제로 옮긴다. 목록(`entries`)에 없는 것도 옮길 수 있어야 해서 경로가 아니라
 * 항목을 받는다 — 트리에서 고른 폴더는 반대편 목록에 떠 있지 않을 수 있다.
 * destDirOverride 를 주면 dest 패널이 보고 있는 폴더 대신 그 폴더로 보낸다
 * (트리 폴더에 조준한 드롭 업로드, "폴더 지정해 다운로드").
 */
export async function xTransferItems(
  ctx: TransferCtx,
  dest: Pane,
  items: Entry[],
  destDirOverride?: string,
): Promise<void> {
  const src = dest.other;
  if (items.length === 0) return;
  if (!ctx.getSftpId()) {
    ctx.setStatus("원격에 접속되지 않았습니다.");
    return;
  }
  if (ctx.xfer.transferring) {
    ctx.setStatus("이미 전송 중입니다. 끝난 뒤 다시 시도하세요.");
    return;
  }

  ctx.xfer.transferring = true;
  ctx.xfer.cancelled = false;

  const destDir = destDirOverride ?? dest.path;
  // 지정 폴더로 보낼 때는 dest 패널 목록이 그 폴더가 아니므로 충돌 검사용 이름을 따로
  // 읽는다. 읽기에 실패하면 빈 목록으로 진행한다 — 충돌 확인을 못 해도 전송은 멈추지
  // 않는 편이 낫고, 이때 겹친 이름은 덮어써진다.
  let overrideNames: Set<string> | null = null;
  if (destDirOverride !== undefined && destDirOverride !== dest.path) {
    const listed = (await (dest.side === "local"
      ? localList(destDirOverride)
      : sftpList(ctx.getSftpId()!, destDirOverride)
    ).catch(() => [])) as Entry[];
    overrideNames = new Set(listed.map((e) => e.name));
  }
  const hasName = (n: string): boolean =>
    overrideNames ? overrideNames.has(n) : dest.hasName(n);

  // 총량을 먼저 잰다. 폴더는 목록을 훑어야 알 수 있어 잠깐 걸린다 — 그 사이 상태를 밝힌다.
  // 실패하면 0 으로 두고 파일 단위 진행률로 돌아간다(멈추지는 않는다).
  ctx.setStatus("전송할 크기 계산 중…");
  // 수천 파일 폴더에서 측정(전체 목록 순회)이 공짜가 아니다 — 읽은 목록을 담아 두었다가
  // 전송에서 그대로 쓴다. 측정이 실패해 비면 전송이 직접 조회한다(기존 경로).
  ctx.listed = new Map();
  ctx.resumeAll = null; // 이어받기 선택은 이번 묶음에서만 유효하다
  ctx.queue.begin();
  // 최상위 파일은 미리 줄 세운다. 폴더 안은 들어갈 때 한 단계씩 채운다(목록을 그때 읽으므로).
  for (const it of items) {
    if (it.isDir) continue;
    ctx.queue.ensure({
      key: it.path,
      name: it.name,
      size: it.size,
      dir: src.side === "local" ? "up" : "down",
      srcPath: it.path,
      destDir,
    });
  }
  ctx.bundle.total = await measureTotal(ctx, src.side, items, ctx.listed).catch(() => 0);
  ctx.bundle.done = 0;
  setBundle(ctx);
  ctx.setStatus(ctx.bundle.total > 0 ? `전송 시작 (${fmtSize(ctx.bundle.total)})` : "전송 시작");

  let applied: ConflictChoice | null = null;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    if (ctx.xfer.cancelled) break;
    if (items.length > 1) ctx.setOverall(`${i + 1}/${items.length}`);
    const item = items[i];
    let targetName = item.name;

    if (hasName(targetName)) {
      const decision: ConflictResult = applied
        ? { choice: applied, applyToRest: true }
        : await conflictDialog(targetName, items.length - i - 1);
      if (decision.applyToRest) applied = decision.choice;
      if (decision.choice === "cancel") break;
      if (decision.choice === "skip") {
        ctx.queue.setState(item.path, "skip", "같은 이름 — 건너뜀");
        continue;
      }
      if (decision.choice === "rename") {
        targetName = uniqueName(targetName, (c) => hasName(c));
      }
    }

    try {
      await transferOne(ctx, src.side, item, destDir, targetName);
    } catch (e) {
      // 심볼릭 링크·권한 오류 등 한 항목의 실패로 나머지를 중단하지 않는다.
      // 사용자가 그 항목만 끊은 것은 실패가 아니다(큐에 '취소됨'으로 남는다).
      if (!ctx.queue.isCancelled(item.path)) {
        failed++;
        console.error("전송 실패", item.path, e);
      }
    }
  }

  ctx.hideProgress();
  ctx.setOverall("");
  ctx.setTransfer(null);
  ctx.xfer.transferring = false;
  ctx.bundle.total = 0;
  ctx.bundle.done = 0;
  ctx.listed = new Map();
  setBundle(ctx);
  ctx.setStatus(
    ctx.xfer.cancelled
      ? "전송 취소됨"
      : failed > 0
        ? `전송 완료 (${failed}개 실패/건너뜀)`
        : "전송 완료",
  );
  if (!ctx.isDisposed()) await dest.reload();
}

/**
 * 미리 정해진 계획대로 옮긴다 — 폴더 동기화(0.74.0)가 쓴다.
 *
 * `xTransferItems` 와 나누는 이유: 저쪽은 "지금 보고 있는 폴더로" 옮기며 이름이 겹치면
 * 사용자에게 묻는다. 동기화는 어디로 갈지·무엇을 덮을지가 목록에서 이미 정해져 있어
 * 다시 물으면 항목 수만큼 창이 뜬다. 진행률·취소·이어받기는 같은 경로를 그대로 탄다.
 */
export async function xTransferPlan(
  ctx: TransferCtx,
  from: Side,
  plan: { entry: Entry; destDir: string }[],
  /** 미리 만들어 둘 대상 폴더(상위부터 정렬해 넘긴다). */
  makeDirs: string[],
): Promise<{ sent: number; failed: number }> {
  if (plan.length === 0 && makeDirs.length === 0) return { sent: 0, failed: 0 };
  if (!ctx.getSftpId()) {
    ctx.setStatus("원격에 접속되지 않았습니다.");
    return { sent: 0, failed: 0 };
  }
  if (ctx.xfer.transferring) {
    ctx.setStatus("이미 전송 중입니다. 끝난 뒤 다시 시도하세요.");
    return { sent: 0, failed: 0 };
  }

  ctx.xfer.transferring = true;
  ctx.xfer.cancelled = false;
  ctx.listed = new Map();
  ctx.resumeAll = null;
  ctx.queue.begin();
  for (const p of plan) {
    ctx.queue.ensure({
      key: p.entry.path,
      name: p.entry.name,
      size: p.entry.size,
      dir: from === "local" ? "up" : "down",
      srcPath: p.entry.path,
      destDir: p.destDir,
    });
  }
  ctx.bundle.total = plan.reduce((s, p) => s + (p.entry.isDir ? 0 : p.entry.size), 0);
  ctx.bundle.done = 0;
  setBundle(ctx);

  // 대상 폴더를 먼저 만든다(상위부터). 이미 있으면 오류가 나는데 그건 정상이다.
  for (const d of makeDirs) {
    if (ctx.xfer.cancelled) break;
    if (from === "local") await sftpMkdir(ctx.getSftpId()!, d).catch(() => undefined);
    else await localMkdir(d).catch(() => undefined);
  }

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < plan.length; i++) {
    if (ctx.xfer.cancelled) break;
    if (plan.length > 1) ctx.setOverall(`${i + 1}/${plan.length}`);
    const { entry, destDir } = plan[i];
    try {
      await transferOne(ctx, from, entry, destDir, entry.name);
      sent++;
    } catch (e) {
      failed++;
      console.error("동기화 전송 실패", entry.path, e);
    }
  }

  ctx.hideProgress();
  ctx.setOverall("");
  ctx.setTransfer(null);
  ctx.xfer.transferring = false;
  ctx.bundle.total = 0;
  ctx.bundle.done = 0;
  ctx.listed = new Map();
  setBundle(ctx);
  return { sent, failed };
}

/**
 * 옮길 것의 총 바이트를 미리 잰다. 폴더는 목록을 훑어 합산한다.
 * 한 곳이라도 조회에 실패하면 전체를 포기하고 0 을 돌려준다 — 반쪽 총량으로 계산하면
 * 진행률이 100% 를 넘거나 뒤로 가서, 아예 파일 단위로 보여 주는 편이 낫다.
 */
async function measureTotal(
  ctx: TransferCtx,
  from: Side,
  items: Entry[],
  /** 측정하며 읽은 폴더 목록. 전송이 재사용해 같은 폴더를 두 번 조회하지 않는다. */
  listed?: Map<string, Entry[]>,
): Promise<number> {
  let sum = 0;
  for (const item of items) {
    if (ctx.xfer.cancelled) return 0;
    if (!item.isDir) {
      sum += item.size;
      continue;
    }
    const kids = ((await (from === "local"
      ? localList(item.path)
      : sftpList(ctx.getSftpId()!, item.path))) as Entry[]).filter(
      (k) => k.name !== "." && k.name !== "..",
    );
    listed?.set(item.path, kids);
    sum += await measureTotal(ctx, from, kids, listed);
  }
  return sum;
}

/** 묶음 진행 상태를 레지스트리에 반영한다(모달을 닫아도 칩이 전체 진행률을 보여 주도록). */
function setBundle(ctx: TransferCtx): void {
  const live = liveSftp.get(ctx.session.id);
  if (!live) return;
  live.baseDone = ctx.bundle.done;
  live.grandTotal = ctx.bundle.total;
  if (ctx.bundle.total > 0) {
    live.done = Math.min(ctx.bundle.total, ctx.bundle.done);
    live.total = ctx.bundle.total;
  }
  notifyLive();
}

/**
 * 이어받을 위치를 정한다. 반환: 0 = 처음부터, >0 = 그 위치부터, null = 이 파일은 보내지 않음.
 *
 * 조각(`.part`)은 **받는 쪽**에 생긴다 — 업로드면 서버에, 다운로드면 로컬에.
 * 조각이 원본보다 크거나 같으면 남은 것이 옛 파일의 잔해다(원본이 줄었거나 바뀐 경우)
 * — 묻지 않고 처음부터 받는다. 물어봐야 사용자가 판단할 근거가 없다.
 */
async function decideResume(
  ctx: TransferCtx,
  from: Side,
  entry: Entry,
  destPath: string,
): Promise<number | null> {
  const partPath = `${destPath}.part`;
  const id = ctx.getSftpId();
  if (!id) return 0;
  // 조각 조회 실패는 '없음'으로 본다 — 이어받기를 못 할 뿐, 전송은 평소대로 진행한다.
  const st = await (from === "local" ? sftpStat(id, partPath) : localStat(partPath)).catch(
    () => null,
  );
  const part = st?.[0] ?? 0;
  if (part <= 0 || part >= entry.size) return 0;

  const decision = ctx.resumeAll
    ? { choice: ctx.resumeAll, applyToRest: true }
    : await resumeDialog(entry.name, part, entry.size, from === "local" ? "up" : "down");
  if (decision.applyToRest) ctx.resumeAll = decision.choice;
  if (decision.choice === "cancel") {
    ctx.xfer.cancelled = true;
    return null;
  }
  if (decision.choice === "skip") return null;
  return decision.choice === "resume" ? part : 0;
}

/** 파일 하나 또는 폴더 하나(재귀)를 옮긴다. */
async function transferOne(
  ctx: TransferCtx,
  from: Side,
  entry: Entry,
  destDir: string,
  destName: string,
): Promise<void> {
  if (ctx.xfer.cancelled) return;
  const destPath = joinPath(destDir, destName);

  if (!entry.isDir) {
    // 폴더 안에서 들어온 파일은 여기서 처음 큐에 오른다(최상위는 묶음 시작 때 이미 올랐다).
    ctx.queue.ensure({
      key: entry.path,
      name: entry.name,
      size: entry.size,
      dir: from === "local" ? "up" : "down",
      srcPath: entry.path,
      destDir,
    });
    if (ctx.queue.isCancelled(entry.path)) {
      ctx.queue.setState(entry.path, "skip", "취소됨");
      return;
    }
    const resumeFrom = await decideResume(ctx, from, entry, destPath);
    if (resumeFrom === null) {
      ctx.queue.setState(entry.path, "skip", ctx.xfer.cancelled ? "취소됨" : "건너뜀");
      return;
    }
    const transferId = crypto.randomUUID();
    const startedAt = performance.now();
    ctx.setTransfer(transferId);
    ctx.queue.setState(entry.path, "run");
    if (ctx.bundle.total > 0) ctx.showProgress(entry.name, ctx.bundle.done, ctx.bundle.total);
    else ctx.showProgress(entry.name, 0, entry.size);
    try {
      if (from === "local")
        await sftpUpload(ctx.getSftpId()!, entry.path, destPath, transferId, resumeFrom);
      else await sftpDownload(ctx.getSftpId()!, entry.path, destPath, transferId, resumeFrom);
    } catch (e) {
      // 실패는 큐에 남겨 나중에 다시 시도할 수 있게 한다. 던지기는 그대로 — 위쪽
      // 집계(실패 개수)와 폴더 재귀의 기존 동작을 바꾸지 않는다.
      ctx.queue.setState(
        entry.path,
        ctx.xfer.cancelled || ctx.queue.isCancelled(entry.path) ? "skip" : "fail",
        ctx.queue.isCancelled(entry.path) ? "취소됨" : String(e).slice(0, 120),
      );
      ctx.setTransfer(null);
      throw e;
    }
    ctx.queue.setState(entry.path, "done");
    ctx.setTransfer(null);
    // 경로별 속도 비교용 — 진단 로그가 꺼져 있으면 비용이 없다.
    {
      const sec = (performance.now() - startedAt) / 1000;
      const mbps = sec > 0 ? entry.size / sec / (1024 * 1024) : 0;
      logLine(
        "SFTP",
        `${from === "local" ? "올림" : "받음"} ${entry.name} ${entry.size}B ` +
          `${sec.toFixed(2)}s ${mbps.toFixed(2)}MB/s 이어받기=${resumeFrom}`,
      );
    }
    // 이 파일 몫을 누적한다. 다음 파일의 진행 이벤트는 여기에 더해져 전체 진행이 된다.
    ctx.bundle.done = Math.min(ctx.bundle.total || Number.MAX_SAFE_INTEGER, ctx.bundle.done + entry.size);
    setBundle(ctx);
    return;
  }

  // 폴더: 대상에 만들고 자식들을 재귀 전송.
  if (from === "local") await sftpMkdir(ctx.getSftpId()!, destPath).catch(() => undefined);
  else await localMkdir(destPath).catch(() => undefined);

  // 측정 단계에서 이미 읽은 폴더면 다시 조회하지 않는다.
  const children =
    ctx.listed.get(entry.path) ??
    ((from === "local"
      ? await localList(entry.path)
      : await sftpList(ctx.getSftpId()!, entry.path)) as Entry[]);
  for (const child of children) {
    if (child.name === "." || child.name === ".." || child.isDir) continue;
    ctx.queue.ensure({
      key: child.path,
      name: child.name,
      size: child.size,
      dir: from === "local" ? "up" : "down",
      srcPath: child.path,
      destDir: destPath,
    });
  }
  for (const child of children) {
    if (ctx.xfer.cancelled) return;
    if (child.name === "." || child.name === "..") continue;
    try {
      await transferOne(ctx, from, child, destPath, child.name);
    } catch (e) {
      console.error("하위 항목 전송 실패", child.path, e); // 링크·권한 문제는 건너뜀
    }
  }
}

// ── 탐색기 연계 ──

/** "폴더 지정해 다운로드" — 대상 폴더를 골라 원격 항목을 그리로 받는다. */
export async function xDownloadToPicked(ctx: TransferCtx, items: Entry[]): Promise<void> {
  if (items.length === 0) return;
  const dir = await openFolderDialog({ directory: true, title: "다운로드 위치 선택" });
  if (typeof dir !== "string" || !dir) return;
  // "C:\" 같은 루트의 꼬리 구분자만 떼고, 전부 구분자면("/") 그대로 둔다.
  await xTransferItems(ctx, ctx.panes.local(), items, dir.replace(/[\\/]+$/, "") || dir);
}


/** 디렉터리 항목의 자식 전부 읽기 — readEntries 는 한 번에 일부만 주므로 빌 때까지 반복. */
const readAllEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((res, rej) => {
    const acc: FileSystemEntry[] = [];
    const step = (): void =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return res(acc);
        acc.push(...batch);
        step();
      }, rej);
    step();
  });

const entryFile = (fe: FileSystemFileEntry): Promise<File> =>
  new Promise((res, rej) => fe.file(res, rej));

/** 드롭된 트리를 재귀로 훑어 파일(File 핸들)과 폴더(상대경로)를 모은다. */
async function collectEntry(
  ent: FileSystemEntry,
  rel: string,
  out: { files: { file: File; rel: string }[]; dirs: string[] },
): Promise<void> {
  if (ent.isFile) {
    out.files.push({ file: await entryFile(ent as FileSystemFileEntry), rel });
  } else if (ent.isDirectory) {
    out.dirs.push(rel);
    for (const child of await readAllEntries(
      (ent as FileSystemDirectoryEntry).createReader(),
    )) {
      await collectEntry(child, `${rel}/${child.name}`, out);
    }
  }
}

/**
 * 탐색기 드롭 업로드. 웹뷰는 드롭된 파일의 OS 경로를 주지 않으므로(경로를 주는
 * 네이티브 드롭을 켜면 앱 내부 드래그가 전부 죽는다) 내용을 읽어 임시 폴더에
 * 복원한 뒤, 평소 업로드와 같은 경로로 전송한다 — 진행률·충돌 처리도 그대로 탄다.
 * destDir 를 주면(트리 폴더에 조준한 드롭) 그 폴더로, 아니면 현재 원격 폴더로.
 */
/** 한 번에 서버로 보내는 조각 크기. base64 로 커지므로 1MB 가 무난하다. */
const UPLOAD_CHUNK = 1024 * 1024;

/** Blob 조각을 base64 로 — FileReader 가 네이티브로 처리해 큰 조각도 스택을 넘지 않는다. */
const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(r.error ?? new Error("조각 읽기 실패"));
    r.onload = () => {
      const s = String(r.result);
      res(s.slice(s.indexOf(",") + 1)); // "data:...;base64," 접두 제거
    };
    r.readAsDataURL(blob);
  });

/**
 * 탐색기 드롭 업로드 — 읽은 조각을 **곧바로** 서버에 이어 쓴다(0.76.0).
 *
 * 예전에는 드롭된 내용을 임시 폴더에 사본으로 만든 뒤 그 사본을 다시 올렸다. 웹뷰가
 * 파일의 OS 경로를 주지 않기 때문인데(경로를 주는 네이티브 드롭을 켜면 앱 내부 드래그가
 * 전부 죽는다), 그 탓에 디스크에 한 번 쓰고 한 번 더 읽었고 화면에도 진행이 두 번
 * 지나갔다("업로드가 끝났는데 또 올라간다" — 실기 보고). 이제 한 단계다.
 */
export async function xOnOsFilesDropped(
  ctx: TransferCtx,
  dt: DataTransfer,
  destDir?: string,
): Promise<void> {
  // 수집은 반드시 동기로 — 드롭 핸들러가 await 를 지나면 DataTransfer 를 더 읽을 수 없다.
  const tops: { entry: FileSystemEntry | null; file: File | null }[] = [];
  for (const it of Array.from(dt.items)) {
    if (it.kind !== "file") continue;
    const entry = typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null;
    tops.push({ entry, file: entry ? null : it.getAsFile() });
  }
  if (tops.every((t) => !t.entry && !t.file)) return;
  const id = ctx.getSftpId();
  if (!id) {
    ctx.setStatus("원격에 접속되지 않았습니다.");
    return;
  }

  // 파일 목록·폴더 목록을 먼저 모은다(내용은 아직 읽지 않는다 — 목록만).
  const col = { files: [] as { file: File; rel: string }[], dirs: [] as string[] };
  try {
    ctx.setStatus("탐색기 항목 읽는 중…");
    for (const t of tops) {
      if (t.entry) await collectEntry(t.entry, t.entry.name, col);
      else if (t.file) col.files.push({ file: t.file, rel: t.file.name });
    }
  } catch (e) {
    ctx.setStatus(`탐색기 항목을 읽지 못했습니다: ${String(e)}`);
    return;
  }
  if (col.files.length === 0 && col.dirs.length === 0) return;

  const root = destDir ?? ctx.panes.remote().path;
  // 전송은 큐에 넣는다 — 다른 전송이 돌고 있어도 거절하지 않고 줄을 선다.
  await ctx.enqueue(() => streamUpload(ctx, id, root, col));
}

/** 모은 파일들을 조각 단위로 서버에 직접 쓴다. */
async function streamUpload(
  ctx: TransferCtx,
  id: string,
  root: string,
  input: { files: { file: File; rel: string }[]; dirs: string[] },
): Promise<void> {
  let col = input;
  if (ctx.xfer.transferring) {
    ctx.setStatus("이미 전송 중입니다. 끝난 뒤 다시 시도하세요.");
    return;
  }
  ctx.xfer.transferring = true;
  ctx.xfer.cancelled = false;
  ctx.resumeAll = null;
  ctx.queue.begin();

  // ── 같은 이름 확인 ──
  //
  // 스트리밍으로 바꾸면서 이 단계가 빠졌었다(0.76.0) — 묻지 않고 덮어썼다. 드롭은
  // 실수로 하기 쉬운 조작이라 반드시 물어야 한다. 예전(임시 사본 경로)과 같은 규칙으로
  // **최상위 항목만** 본다. 폴더 안까지 파고들며 묻지는 않는다(그때도 그랬다).
  const names = new Set(
    ((await sftpList(id, root).catch(() => [])) as Entry[]).map((e) => e.name),
  );
  /** 최상위 이름이 바뀐 경우의 대응표("사진" → "사진 (2)"). 하위 경로도 함께 옮긴다. */
  const renamed = new Map<string, string>();
  const skipTop = new Set<string>();
  const topNames = [
    ...new Set(
      [...col.dirs, ...col.files.map((f) => f.rel)]
        .map((rel) => rel.split("/")[0])
        .filter(Boolean),
    ),
  ];
  let applied: ConflictChoice | null = null;
  for (let i = 0; i < topNames.length; i++) {
    const top = topNames[i];
    if (!names.has(top)) continue;
    const decision: ConflictResult = applied
      ? { choice: applied, applyToRest: true }
      : await conflictDialog(top, topNames.length - i - 1);
    if (decision.applyToRest) applied = decision.choice;
    if (decision.choice === "cancel") {
      ctx.xfer.transferring = false;
      ctx.setStatus("전송 취소됨");
      return;
    }
    if (decision.choice === "skip") skipTop.add(top);
    else if (decision.choice === "rename") {
      const next = uniqueName(top, (c) => names.has(c));
      names.add(next);
      renamed.set(top, next);
    }
  }
  /** 최상위 이름 교체를 반영한 상대 경로. */
  const mapRel = (rel: string): string => {
    const cut = rel.indexOf("/");
    const top = cut < 0 ? rel : rel.slice(0, cut);
    const next = renamed.get(top);
    return next ? next + rel.slice(top.length) : rel;
  };
  const dropped = (rel: string): boolean => skipTop.has(rel.split("/")[0]);
  col = {
    files: col.files.filter((f) => !dropped(f.rel)).map((f) => ({ ...f, rel: mapRel(f.rel) })),
    dirs: col.dirs.filter((d) => !dropped(d)).map(mapRel),
  };
  if (col.files.length === 0 && col.dirs.length === 0) {
    ctx.xfer.transferring = false;
    ctx.setStatus("보낼 항목이 없습니다(모두 건너뜀).");
    return;
  }

  const pathOf = (rel: string): string => joinPath(root, rel);
  for (const f of col.files) {
    ctx.queue.ensure({
      key: pathOf(f.rel),
      name: f.file.name,
      size: f.file.size,
      dir: "up",
      srcPath: f.rel,
      destDir: root,
    });
  }
  ctx.bundle.total = col.files.reduce((s, f) => s + f.file.size, 0);
  ctx.bundle.done = 0;
  setBundle(ctx);
  ctx.setStatus(ctx.bundle.total > 0 ? `전송 시작 (${fmtSize(ctx.bundle.total)})` : "전송 시작");

  // 폴더를 상위부터 만든다(하위를 먼저 만들면 부모가 없어 실패한다).
  for (const d of [...col.dirs].sort((a, b) => a.length - b.length)) {
    if (ctx.xfer.cancelled) break;
    await sftpMkdir(id, pathOf(d)).catch(() => undefined);
  }

  let failed = 0;
  for (let i = 0; i < col.files.length; i++) {
    if (ctx.xfer.cancelled) break;
    const { file, rel } = col.files[i];
    const dest = pathOf(rel);
    if (ctx.queue.isCancelled(dest)) {
      ctx.queue.setState(dest, "skip", "취소됨");
      continue;
    }
    if (col.files.length > 1) ctx.setOverall(`${i + 1}/${col.files.length}`);

    // 이어보내기 — 서버에 남은 조각이 있으면 묻는다(로컬 패널 업로드와 같은 규칙).
    let offset = 0;
    const part = (await sftpStat(id, `${dest}.part`).catch(() => null))?.[0] ?? 0;
    if (part > 0 && part < file.size) {
      const d: ResumeResult = ctx.resumeAll
        ? { choice: ctx.resumeAll, applyToRest: true }
        : await resumeDialog(file.name, part, file.size, "up");
      if (d.applyToRest) ctx.resumeAll = d.choice;
      if (d.choice === "cancel") {
        ctx.xfer.cancelled = true;
        break;
      }
      if (d.choice === "skip") {
        ctx.queue.setState(dest, "skip", "건너뜀");
        continue;
      }
      offset = d.choice === "resume" ? part : 0;
    }
    if (offset === 0 && part > 0) await sftpUploadDiscard(id, dest).catch(() => undefined);

    ctx.queue.setState(dest, "run");
    const startedAt = performance.now();
    try {
      let sent = offset;
      while (sent < file.size) {
        if (ctx.xfer.cancelled) break;
        const end = Math.min(file.size, sent + UPLOAD_CHUNK);
        const b64 = await toBase64(file.slice(sent, end));
        await sftpUploadChunk(id, dest, sent, b64);
        sent = end;
        ctx.showProgress(
          file.name,
          ctx.bundle.total > 0 ? ctx.bundle.done + sent : sent,
          ctx.bundle.total > 0 ? ctx.bundle.total : file.size,
        );
        const live = liveSftp.get(ctx.session.id);
        if (live && ctx.bundle.total > 0) {
          live.name = file.name;
          live.done = Math.min(ctx.bundle.total, ctx.bundle.done + sent);
          live.total = ctx.bundle.total;
          notifyLive();
        }
      }
      if (ctx.xfer.cancelled || ctx.queue.isCancelled(dest)) {
        ctx.queue.setState(dest, "skip", "취소됨");
        break;
      }
      await sftpUploadFinish(id, dest);
      ctx.queue.setState(dest, "done");
      const sec = (performance.now() - startedAt) / 1000;
      logLine(
        "SFTP",
        `올림(드롭) ${file.name} ${file.size}B ${sec.toFixed(2)}s ` +
          `${sec > 0 ? (file.size / sec / (1024 * 1024)).toFixed(2) : "0"}MB/s 이어보내기=${offset}`,
      );
    } catch (e) {
      failed++;
      ctx.queue.setState(dest, "fail", String(e).slice(0, 120));
      console.error("드롭 업로드 실패", dest, e);
    }
    ctx.bundle.done += file.size;
    setBundle(ctx);
  }

  ctx.hideProgress();
  ctx.setOverall("");
  ctx.setTransfer(null);
  ctx.xfer.transferring = false;
  ctx.bundle.total = 0;
  ctx.bundle.done = 0;
  setBundle(ctx);
  ctx.setStatus(
    ctx.xfer.cancelled ? "전송 취소됨" : failed > 0 ? `전송 완료 (${failed}개 실패)` : "전송 완료",
  );
  if (!ctx.isDisposed()) await ctx.panes.remote().reload();
}
