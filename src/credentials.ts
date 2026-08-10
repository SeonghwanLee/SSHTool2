// 접속 자격증명 공급자 — 저장분 우선, 없으면 프롬프트. 접속 성공 후 저장 제안까지.
// main.ts 에서 분리(0.67.0 정지작업). 로직 변경 없음.

import { sshProbe, vaultGetPassword, vaultSetPassword, vaultDeletePassword } from "./ipc";
import { passwordPrompt, loginPrompt, confirmDialog, alertDialog } from "./dialogs";
import type { CredentialProvider } from "./tabs";
import { sessions, setSessions, redraw, persist } from "./appstate";
import { ensureVaultUnlocked, refreshLockIndicator } from "./vaultflow";

/**
 * 자격증명 해결:
 * - savePassword + 볼트에 저장돼 있고 사용자 이름도 있으면 → 그대로 사용(프롬프트 없음)
 * - 사용자 이름이 없으면 → 로그인(아이디+비밀번호) 입력
 * - 그 외 → 비밀번호만 입력
 */
export const credentials: CredentialProvider = {
  async resolve(session) {
    try {
      if (session.savePassword && session.user && (await ensureVaultUnlocked())) {
        const stored = await vaultGetPassword(session.id);
        if (stored !== null) return { user: session.user, password: stored, prompted: false };
      }
    } catch (e) {
      console.error("볼트 사용 실패 — 직접 입력받습니다", e);
      await alertDialog(`저장된 비밀번호를 사용할 수 없습니다: ${String(e)}`);
    }

    // 여기부터는 사용자에게 물어봐야 한다. 묻기 전에 **서버가 실제로 붙는지 먼저 확인**한다
    // — 예전에는 네트워크에 손도 대기 전에 비밀번호 창부터 떴다. 호스트가 죽었거나
    // 호스트키가 바뀐 경우에도 비밀번호를 받아 놓고 나서야 실패했다.
    // probe 는 TCP·키교환·호스트키 확인까지 마치고, 계정을 알린 뒤 서버 응답까지 받아 온다.
    // 로컬 셸은 이 경로를 타지 않는다(인증 자체가 없다).
    try {
      await sshProbe(session.host, session.port, session.user, session.allowLegacyAlgorithms);
    } catch (e) {
      // 붙지도 않는 서버에 비밀번호를 묻지 않는다. 실패 사유는 팝업이 아니라
      // 탭의 재접속 오버레이로 보여 준다(0.59.0 — 팝업은 늦게 떠서 불편했다).
      return { failed: String(e) };
    }

    if (!session.user) {
      // 가져온 세션 등 계정이 없는 경우 — 아이디+비밀번호를 함께 입력받는다.
      const login = await loginPrompt(session);
      if (login === null) return null;
      return { user: login.user, password: login.password, prompted: true };
    }
    const pw = await passwordPrompt(session);
    if (pw === null) return null;
    return { user: session.user, password: pw, prompted: true };
  },

  async onConnected(session, creds) {
    void refreshLockIndicator();
    // 저장된 자격증명을 그대로 쓴 경우엔 물어볼 게 없다.
    if (!creds.prompted) return;
    // 임시(빠른 접속) 세션은 목록에 없으니 저장 제안 안 함.
    const saved = sessions.find((x) => x.id === session.id);
    if (!saved) return;

    const persistCreds = async (updateUser: boolean) => {
      if (updateUser || !saved.savePassword) {
        setSessions(sessions.map((x) =>
          x.id === session.id ? { ...x, user: creds.user, savePassword: true } : x,
        ));
        // 이 탭에서의 재접속도 저장된 계정을 쓰도록 라이브 세션도 갱신.
        session.user = creds.user;
        session.savePassword = true;
        await persist();
        redraw();
      }
      try {
        if (await ensureVaultUnlocked()) await vaultSetPassword(session.id, creds.password);
      } catch (e) {
        console.error("비밀번호 저장 실패", e);
      }
    };

    if (saved.savePassword) {
      // 이미 저장 대상 — 조용히 최신 값으로 갱신(사용자 이름이 바뀌었으면 함께).
      await persistCreds(saved.user !== creds.user);
      return;
    }
    // 저장 안 하던 세션 — 입력한 계정 정보를 저장할지 물어본다(WPF 0.42.0).
    const yes = await confirmDialog("입력한 계정 정보를 이 세션에 저장할까요?");
    if (yes) await persistCreds(true);
  },

  async onError(session, error) {
    // 저장된 비밀번호가 틀렸을 수 있으니 '인증 실패' 면 폐기 → 다음엔 다시 물어봄.
    // (백엔드는 자격증명 오류에 항상 '인증 실패' 를 쓴다 — '인증서' 등 오탐 회피)
    if (session.savePassword && error.includes("인증 실패")) {
      try {
        await vaultDeletePassword(session.id);
      } catch {
        /* 무시 */
      }
    }
  },
};

