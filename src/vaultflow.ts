// 볼트(자격증명 저장소) 흐름 — 잠금 해제·생성·복구 키·마스터 변경·OS 키체인 자동해제.
// main.ts 에서 분리(0.67.0 정지작업). 로직 변경 없음 — 공유 상태는 appstate 를 통해 본다.

import {
  vaultStatus,
  vaultInit,
  vaultUnlock,
  vaultUnlockRecovery,
  vaultChangeMaster,
  keystoreStore,
  keystoreGet,
  keystoreHas,
  keystoreClear,
} from "./ipc";
import { masterPrompt, confirmDialog, textPrompt, alertDialog } from "./dialogs";
import { applyIcon } from "./icons";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/** 볼트가 잠겨 있으면 마스터 입력을 받아 해제(없으면 최초 생성). 준비되면 true. */
export async function ensureVaultUnlocked(): Promise<boolean> {
  const st = await vaultStatus();
  if (st.unlocked) return true;

  if (!st.exists) {
    const master = await masterPrompt(
      "볼트 마스터 비밀번호 설정",
      "비밀번호를 저장하려면 볼트를 보호할 마스터 비밀번호를 정하세요.",
      "설정",
      true,
    );
    if (master === null) return false;
    const recovery = await vaultInit(master);
    await showRecoveryKey(recovery);
    return true;
  }

  for (let i = 0; i < 3; i++) {
    const master = await masterPrompt(
      "볼트 잠금 해제",
      i === 0
        ? "저장된 비밀번호를 사용하려면 마스터 비밀번호를 입력하세요."
        : "마스터 비밀번호가 올바르지 않습니다. 다시 입력하세요.",
      "해제",
    );
    if (master === null) return false;
    const outcome = await vaultUnlock(master);
    if (outcome.ok) {
      // 구형 볼트가 방금 이관됐다면 새로 발급된 복구 키를 반드시 보여준다.
      if (outcome.migratedRecovery) await showRecoveryKey(outcome.migratedRecovery);
      return true;
    }
  }

  // 3회 실패 → 복구 키로 열 기회를 준다.
  const useRecovery = await confirmDialog(
    "마스터 비밀번호로 열지 못했습니다. 복구 키로 잠금을 해제할까요?",
  );
  if (!useRecovery) return false;
  const key = await textPrompt("복구 키 입력 (XXXX-XXXX-… 형식)", "", "해제");
  if (!key) return false;
  try {
    if (!(await vaultUnlockRecovery(key))) {
      await alertDialog("복구 키가 올바르지 않습니다.");
      return false;
    }
  } catch (e) {
    await alertDialog(`복구 해제 실패: ${String(e)}`);
    return false;
  }
  // 복구로 열었으면 새 마스터를 반드시 설정하게 한다.
  const next = await masterPrompt(
    "새 마스터 비밀번호 설정",
    "복구 키로 열었습니다. 새 마스터 비밀번호를 설정하세요.",
    "설정",
    true,
  );
  if (next === null) {
    await alertDialog(
      "새 마스터 비밀번호를 설정하지 않았습니다.\n" +
        "이번 실행에서는 볼트를 쓸 수 있지만, 다시 시작하면 예전 마스터 비밀번호나 복구 키가 다시 필요합니다.",
    );
    return true;
  }
  const newRecovery = await vaultChangeMaster(next);
  await showRecoveryKey(newRecovery);
  return true;
}

/** 복구 키를 1회 표시하고 클립보드 복사를 돕는다(다시 볼 수 없음). */
export async function showRecoveryKey(recovery: string): Promise<void> {
  let copied = false;
  try {
    await navigator.clipboard.writeText(recovery);
    copied = true;
  } catch {
    copied = false; // 복사 실패를 숨기면 사용자가 키를 잃는다
  }
  await alertDialog(
    `복구 키: ${recovery}\n\n` +
      "마스터 비밀번호를 잊었을 때 볼트를 여는 유일한 수단입니다.\n" +
      (copied
        ? "클립보드에 복사해 두었습니다 — 안전한 곳에 보관하세요."
        : "⚠ 클립보드 복사에 실패했습니다. 위 키를 직접 옮겨 적으세요.") +
      "\n이 화면 이후에는 다시 볼 수 없습니다.",
    "복구 키 (1회 표시)",
  );
}

export async function toggleAutoUnlock(enable: boolean): Promise<boolean> {
  if (!enable) {
    try {
      await keystoreClear();
    } catch (e) {
      console.error("키체인 삭제 실패", e);
    }
    return false;
  }
  // 켤 때는 마스터를 확인받아 저장한다(볼트가 없으면 먼저 생성 흐름).
  const st = await vaultStatus();
  if (!st.exists) {
    await alertDialog("먼저 비밀번호를 저장할 세션에 접속해 볼트를 만든 뒤 사용하세요.");
    return false;
  }
  const master = await masterPrompt(
    "이 PC 자동 잠금 해제",
    "확인을 위해 마스터 비밀번호를 입력하세요. OS 키체인(이 PC·이 계정)에 저장됩니다.",
    "저장",
  );
  if (master === null) return false;
  if (!(await vaultUnlock(master)).ok) {
    await alertDialog("마스터 비밀번호가 올바르지 않습니다.");
    return false;
  }
  try {
    await keystoreStore(master);
    return true;
  } catch (e) {
    await alertDialog(`키체인 저장 실패: ${String(e)}`);
    return false;
  }
}

/** 시작 시 OS 키체인에 저장된 마스터가 있으면 볼트를 자동 해제한다. */
export async function tryAutoUnlock(): Promise<void> {
  try {
    const master = await keystoreGet();
    if (!master) return;
    // vaultUnlock 이 ok:false 를 '정상 반환'하면 마스터가 틀린 것(파일 손상 등은 Rust 가
    // Err 를 던져 여기 catch 로 빠지므로, 이 분기는 '마스터 불일치'로 안전하게 단정 가능).
    const outcome = await vaultUnlock(master);
    if (!outcome.ok) {
      await keystoreClear(); // 마스터가 바뀜 — 낡은 키 정리(다음엔 프롬프트)
    } else if (outcome.migratedRecovery) {
      await showRecoveryKey(outcome.migratedRecovery);
    }
  } catch (e) {
    // 볼트 파일 잠김/손상 등 일시적 오류 — 키체인은 보존한다(잘못 지우지 않음).
    console.error("자동 잠금 해제 실패(키체인 보존)", e);
  }
}

/** 마스터 비밀번호 변경 — 잠겨 있으면 먼저 해제한 뒤 새 비밀번호를 받는다. */
export async function changeMasterFlow(): Promise<void> {
  try {
    if (!(await ensureVaultUnlocked())) return;
    const next = await masterPrompt(
      "새 마스터 비밀번호",
      "저장된 비밀번호는 다시 암호화하지 않아도 됩니다(키만 재포장). 기존 복구 키는 무효가 됩니다.",
      "변경",
    );
    if (next === null) return;
    const recovery = await vaultChangeMaster(next);
    // 자동 해제가 켜져 있었다면 키체인의 마스터도 새 값으로 갱신한다.
    try {
      if (await keystoreHas().catch(() => false)) await keystoreStore(next);
    } catch (e) {
      console.error("키체인 갱신 실패", e);
    }
    await showRecoveryKey(recovery);
  } catch (e) {
    await alertDialog(`마스터 변경 실패: ${String(e)}`);
  }
}

/**
 * 처음 보는 호스트키 확인 요청 처리. 백엔드의 접속은 이 응답이 갈 때까지 멈춰 있으므로,
 * 어떤 경로로 끝나든 반드시 답을 보낸다(안 보내면 백엔드 타임아웃까지 매달린다).
 */
export function reflectLock(locked: boolean): void {
  const sidebar = document.getElementById("sidebar")!;
  sidebar.classList.toggle("locked", locked);
  $("lock-overlay").classList.toggle("hidden", !locked);
  // 버튼 아이콘·툴팁으로 현재 상태와 클릭 동작을 함께 표시.
  const btn = $("vault-lock");
  applyIcon(btn, locked ? "lock" : "unlock");
  btn.title = locked ? "잠김 — 클릭하여 마스터 비밀번호로 잠금 해제" : "볼트 잠금";
}

/** 실제 볼트 상태를 조회해 잠금 표시를 맞춘다(존재하고 잠겨 있으면 잠금). */
export async function refreshLockIndicator(): Promise<void> {
  try {
    const st = await vaultStatus();
    reflectLock(st.exists && !st.unlocked);
  } catch {
    /* 무시 */
  }
}

/** 무활동 자동 잠금 — 설정된 시간 동안 입력이 없으면 볼트를 잠근다. */
