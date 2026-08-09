// 업데이트 확인 실패 메시지 정리.
//
// tauri-plugin-updater 의 오류 문자열에는 배포 매니페스트 주소(GitHub URL)가 그대로
// 들어 있다. 내부망 PC 에서 업데이트 확인이 실패하면 그 주소가 화면에 뜨는데,
// 사용자가 볼 이유가 없고 외부 저장소 위치가 노출된다(0.66.0 사용자 요청).
// 실패 원인 자체는 알려 주되 주소·호스트는 지운다.

/** URL(스킴 포함)과 맨몸 도메인을 지운다. */
function stripUrls(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[주소 생략]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|kr|co\.kr)\b(?:\S*)/gi, "[주소 생략]");
}

/**
 * 사용자에게 보여 줄 실패 문구. 연결 자체가 안 된 경우와 그 외를 나눠 안내한다.
 * 원문은 주소를 지운 뒤 괄호로 덧붙여, 원인 파악은 되게 남긴다.
 */
export function updateErrorText(e: unknown): string {
  const raw = String(e);
  const low = raw.toLowerCase();
  const offline =
    low.includes("dns") ||
    low.includes("failed to lookup") ||
    low.includes("connection refused") ||
    low.includes("network") ||
    low.includes("unreachable") ||
    low.includes("timed out") ||
    low.includes("timeout") ||
    low.includes("certificate") ||
    low.includes("tls");
  const detail = stripUrls(raw).replace(/\s+/g, " ").trim().slice(0, 160);
  return offline
    ? `업데이트 서버에 연결할 수 없습니다 — 인터넷이 차단된 환경일 수 있습니다. (${detail})`
    : `업데이트 확인 실패 (${detail})`;
}
