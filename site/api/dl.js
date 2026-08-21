// /dl — 최신 설치파일로 넘겨 준다.
//
// 왜 함수인가: 릴리스 자산에는 손대지 않겠다는 결정(2026-08-21). 설치파일 이름에는 버전이
// 박혀 있어(SSHTool2_0.85.3_x64-setup.exe) 주소가 릴리스마다 바뀐다. 버전 없는 이름으로
// 사본을 하나 더 올리면 GitHub 이 직접 풀어 주는 고정 주소를 쓸 수 있지만, 자산 구성이
// 바뀌면 업데이터(latest.json)나 기존 링크가 흔들릴 여지가 생긴다. 그래서 파일은 그대로
// 두고 **여기서 그때그때 찾아** 넘긴다.
//
// 값싸게 굴리기: 결과를 엣지에 10분 캐싱한다(s-maxage). GitHub API 는 인증 없이 시간당
// 60회 제한이고 서버리스의 나가는 IP 는 여럿이 함께 쓰므로, 캐싱하지 않으면 남의 호출까지
// 얹혀 한도에 걸릴 수 있다. 10분이면 한 시간에 여섯 번이면 충분하다.
//
// 실패하면 릴리스 페이지로 보낸다 — 빈손으로 돌려보내지 않는다. 그때는 캐싱하지 않는다
// (실패한 판단을 10분 동안 물고 있으면 안 된다).
const REPO = "SeonghwanLee/SSHTool2";

export default async function handler(req, res) {
  const releasesPage = `https://github.com/${REPO}/releases/latest`;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        accept: "application/vnd.github+json",
        // GitHub 은 User-Agent 가 없으면 거절한다.
        "user-agent": "sshtool2-site",
      },
    });
    if (!r.ok) throw new Error(`github ${r.status}`);
    const rel = await r.json();
    // 설치파일만 고른다 — 같은 릴리스에 latest.json 과 서명(.sig)도 함께 올라간다.
    const exe = (rel.assets ?? []).find(
      (a) => a.name.endsWith("-setup.exe") && !a.name.endsWith(".sig"),
    );
    if (!exe?.browser_download_url) throw new Error("설치파일을 찾지 못했습니다");
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=86400");
    res.redirect(302, exe.browser_download_url);
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, releasesPage);
  }
}
