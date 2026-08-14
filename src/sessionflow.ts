// 세션 CRUD 흐름 — 볼트 비밀값 추출/주입, 편집·이름변경, 폴더 이동, SFTP 열기.
// main.ts 에서 분리(0.67.0 정지작업). 로직 변경 없음.

import type { SessionInfo } from "./types";
import { alertDialog, appToast } from "./dialogs";
import { sessionDialog } from "./sessiondialog";
import { textPrompt } from "./dialogs";
import { openSftpBrowser, liveSftpOf } from "./sftpui";
import { vaultSetSecret, vaultGetSecret, vaultDeleteSecret } from "./ipc";
import { saveSettings } from "./settings";
import {
  sessions,
  setSessions,
  settings,
  setSettings,
  redraw,
  persist,
} from "./appstate";
import { credentials } from "./credentials";
import { ensureVaultUnlocked } from "./vaultflow";

/**
 * 폴더를 다른 폴더 안(destParent) 또는 루트("")로 옮긴다.
 * 하위 폴더·세션 경로 접두사를 함께 바꿔 안의 것들이 모두 따라 이동한다.
 */
export async function moveFolder(sourcePath: string, destParent: string): Promise<void> {
  const seg = sourcePath.split("/").pop() ?? sourcePath;
  const newPath = destParent ? `${destParent}/${seg}` : seg;
  if (newPath === sourcePath) return; // 제자리
  if (destParent === sourcePath || destParent.startsWith(`${sourcePath}/`)) {
    await alertDialog("폴더를 자기 자신이나 그 하위로 옮길 수 없습니다.");
    return;
  }
  const rePrefix = (folder: string): string => {
    if (folder === sourcePath) return newPath;
    if (folder.startsWith(`${sourcePath}/`)) return newPath + folder.slice(sourcePath.length);
    return folder;
  };
  setSessions(sessions.map((s) => ({ ...s, folder: rePrefix(s.folder) })));
  setSettings({ ...settings, folders: settings.folders.map(rePrefix) });
  await persist();
  await saveSettings(settings);
  redraw();
}

export const trigKey = (id: string): string => `${id}:triggers`;
export const startKey = (id: string): string => `${id}:startup`;

/** 세션에 볼트로 보낼 비밀 값이 하나라도 있는가. */
export const hasSecrets = (s: SessionInfo): boolean =>
  s.startupCommandsSecret || s.triggers.some((t) => t.secret);

/**
 * 저장 직전 호출 — 비밀 값을 볼트에 넣고, 파일에 남길 세션에서는 그 값을 비운다.
 * 볼트 해제를 취소하면 null 을 돌려 저장 자체를 중단시킨다(평문으로 새어 나가지 않게).
 */
export async function extractSecrets(s: SessionInfo): Promise<SessionInfo | null> {
  if (!hasSecrets(s)) {
    // 체크를 해제한 경우 볼트에 남아 있던 항목을 정리한다(실패는 무시 — 저장을 막지 않는다).
    await vaultDeleteSecret(trigKey(s.id)).catch(() => {});
    await vaultDeleteSecret(startKey(s.id)).catch(() => {});
    return s;
  }
  if (!(await ensureVaultUnlocked())) return null;

  const secretTriggers = s.triggers.filter((t) => t.secret);
  if (secretTriggers.length) {
    // 비밀 규칙의 send 만 모아 한 항목으로 — 패턴은 비밀이 아니라 파일에 남는다.
    await vaultSetSecret(trigKey(s.id), JSON.stringify(secretTriggers.map((t) => t.send)));
  } else {
    await vaultDeleteSecret(trigKey(s.id)).catch(() => {});
  }

  if (s.startupCommandsSecret) await vaultSetSecret(startKey(s.id), s.startupCommands);
  else await vaultDeleteSecret(startKey(s.id)).catch(() => {});

  return {
    ...s,
    startupCommands: s.startupCommandsSecret ? "" : s.startupCommands,
    triggers: s.triggers.map((t) => (t.secret ? { ...t, send: "" } : t)),
  };
}

/**
 * 접속 직전 호출 — 볼트에서 비밀 값을 꺼내 메모리 상의 세션을 원래대로 되돌린다.
 * 해제를 취소하면 값이 빈 채로 접속한다(트리거가 안 걸릴 뿐, 접속 자체는 막지 않는다).
 */
export async function hydrateSecrets(s: SessionInfo): Promise<SessionInfo> {
  if (!hasSecrets(s)) return s;
  if (!(await ensureVaultUnlocked())) return s;

  let startup = s.startupCommands;
  if (s.startupCommandsSecret) startup = (await vaultGetSecret(startKey(s.id))) ?? "";

  let triggers = s.triggers;
  if (s.triggers.some((t) => t.secret)) {
    const raw = await vaultGetSecret(trigKey(s.id));
    const sends: string[] = raw ? JSON.parse(raw) : [];
    let n = 0;
    triggers = s.triggers.map((t) => (t.secret ? { ...t, send: sends[n++] ?? "" } : t));
  }
  return { ...s, startupCommands: startup, triggers };
}

/**
 * 지금 존재하는 폴더 경로 전부 — 명시적으로 만든 폴더(settings.folders)와 세션이 실제로
 * 들어 있는 폴더를 합치고, 중간 경로(`운영/DB` 의 `운영`)까지 펼쳐서 돌려준다.
 * 세션 편집 창의 폴더 제안 목록으로 쓴다.
 */
export function allFolderPaths(): string[] {
  const out = new Set<string>();
  for (const raw of [...settings.folders, ...sessions.map((s) => s.folder)]) {
    const path = (raw ?? "").trim();
    if (!path) continue;
    let acc = "";
    for (const seg of path.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      out.add(acc);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, "ko"));
}

/**
 * 세션 하나에 대해 SFTP 브라우저를 연다. 사이드바(세션·최근 접속)와 세션 탭 우클릭이
 * 같은 경로를 쓰도록 한 곳에 둔다.
 */
/**
 * 세션 편집 창을 열고 결과를 저장한다. 사이드바와 세션 탭 우클릭이 같은 경로를 쓰도록
 * 한 곳에 둔다. 반환값은 편집 결과(볼트 값이 채워진 메모리 상의 세션) — 열려 있는 탭이
 * 들고 있는 세션을 갱신하는 데 쓴다. 취소하거나 저장이 중단되면 null.
 */
export async function editSessionFlow(s: SessionInfo): Promise<SessionInfo | null> {
  // 편집 창에는 볼트에 있던 값도 채워서 보여 준다(빈 칸으로 열리면 지운 걸로 오해한다).
  const edited = await sessionDialog(await hydrateSecrets(s), "세션 편집", allFolderPaths());
  if (!edited) return null;
  const stripped = await extractSecrets(edited);
  if (!stripped) return null; // 볼트 해제 취소 — 평문으로 새지 않도록 저장 자체를 중단
  setSessions(sessions.map((x) => (x.id === stripped.id ? stripped : x)));
  await persist();
  redraw();
  return edited;
}

/**
 * 세션 이름 변경 — 사이드바와 세션 탭 우클릭 공용. 바뀐 이름을 돌려주면
 * 호출한 쪽(탭)이 라벨을 즉시 갱신한다. 취소하면 null.
 */
export async function renameSessionFlow(s: SessionInfo): Promise<string | null> {
  const next = await textPrompt("이름 변경", s.name, "변경");
  if (!next) return null;
  setSessions(sessions.map((x) => (x.id === s.id ? { ...x, name: next } : x)));
  await persist();
  redraw();
  return next;
}

/** 저장 목록에 있는 세션인지 — 빠른 접속 등 임시 세션과 구분한다. */
export const isSavedSession = (s: SessionInfo): boolean => sessions.some((x) => x.id === s.id);

/**
 * 비활성 세션이면 알리고 true — 접속으로 가는 길목마다 이 관문을 지난다.
 *
 * 막는 자리를 한 곳으로 몰지 않은 이유: 터미널·SFTP·원격 데스크톱이 서로 다른 경로로
 * 나가고, 사용자에게는 "왜 안 되는지" 를 그 자리에서 알려야 한다.
 */
export function blockedByDisabled(s: SessionInfo): boolean {
  if (!s.disabled) return false;
  appToast(`'${s.name || s.host}' 은(는) 비활성 세션입니다 — 우클릭에서 활성화하세요`);
  return true;
}

export async function openSftpFor(s: SessionInfo): Promise<void> {
  if (blockedByDisabled(s)) return;
  // 살아있는 연결을 재사용할 때는 자격증명이 필요 없다 — 묻지도 않는다(0.62.0).
  // 묻고 나서 버리면, 오타 난 비밀번호가 검증 없이 저장될 입구만 열어 준다.
  if (liveSftpOf(s.id)) {
    await openSftpBrowser(s, "", undefined, settings.sftpLocalDir, settings.sftpRateLimitKbps);
    return;
  }
  // SFTP 는 셸과 별개의 연결이라 자격증명이 필요 — 저장분 우선, 없으면 프롬프트.
  const creds = await credentials.resolve(s);
  if (creds === null) return;
  if ("failed" in creds) {
    // 세션 탭과 달리 SFTP 는 실패를 담아 둘 화면이 없다 — 여기서는 팝업으로 알린다.
    await alertDialog(creds.failed, "접속 실패");
    return;
  }
  const target = creds.user !== s.user ? { ...s, user: creds.user } : s;
  // 저장은 SFTP 인증이 '성공한 뒤에만' — 틀린 비번을 볼트에 넣지 않는다.
  await openSftpBrowser(
    target,
    creds.password,
    () => credentials.onConnected(s, creds),
    settings.sftpLocalDir,
    settings.sftpRateLimitKbps,
  );
}

