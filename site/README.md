# SSHTool2 안내 페이지 (Vercel)

`index.html` 하나짜리 정적 페이지. 빌드 단계가 없다.
버전·용량·배포일은 GitHub API 에서 실시간으로 읽으므로 **릴리스 때 재배포할 필요가 없다**.

## Vercel 연결 (최초 1회)

1. https://vercel.com/new 접속 → GitHub 로 로그인
2. `SeonghwanLee/SSHTool2` 저장소 **Import**
3. 설정 하나만 바꾼다: **Root Directory** → `site`
   (Framework Preset 은 "Other" 그대로, Build Command 비움)
4. **Deploy** — 이후 `site/` 가 바뀌는 push 마다 자동 재배포된다

기본 주소는 `<프로젝트명>.vercel.app`. 도메인을 붙이려면 프로젝트 Settings → Domains.

## 다운로드 주소

| 주소 | 무엇 |
|---|---|
| `https://sshtool2.vercel.app/dl` | 최신 설치파일 바로 받기 |
| `https://sshtool2.vercel.app` | 안내 페이지 |

`/dl` 은 `api/dl.js` 가 GitHub API 로 최신 릴리스를 찾아 그 설치파일로 넘긴다.
**릴리스 자산에는 손대지 않는다** — 파일 이름을 바꾸거나 사본을 더 올리면 업데이터
(`latest.json`)나 이미 돌아다니는 링크가 흔들릴 여지가 생기기 때문이다(2026-08-21 결정).

- 결과는 엣지에 10분 캐싱한다(`s-maxage=600`). GitHub API 는 인증 없이 시간당 60회
  제한이고 서버리스의 나가는 IP 는 여럿이 함께 쓰므로, 캐싱하지 않으면 한도에 걸릴 수 있다.
- 실패하면 릴리스 페이지로 보내고 그때는 캐싱하지 않는다.
- 새 버전을 내면 늦어도 10분 안에 `/dl` 이 따라온다.

주소를 더 줄이려면 Vercel 프로젝트 Settings → Domains 에서 `.vercel.app` 이름을 하나 더
붙일 수 있다(2026-08-21 확인: `sshtool` · `ssht` · `sshtl` 비어 있음). 무료이고,
기존 주소도 그대로 살아 있다.
