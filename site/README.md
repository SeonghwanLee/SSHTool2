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
