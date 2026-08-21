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

바뀌지 않는 주소 두 개를 쓴다. 릴리스마다 손볼 것이 없다.

| 주소 | 무엇 |
|---|---|
| `https://sshtool2.vercel.app/dl` | 최신 설치파일 바로 받기 |
| `https://github.com/SeonghwanLee/SSHTool2/releases/latest/download/SSHTool2-setup.exe` | 위가 가리키는 실제 파일 |

`/dl` 은 `vercel.json` 의 정적 리다이렉트다 — 서버리스 함수도, API 호출도 끼지 않아
느려지거나 한도에 걸릴 구석이 없다. 최종 목적지는 GitHub 이 `latest` 를 직접 풀어 준다.

고정 이름 사본(`SSHTool2-setup.exe`)은 릴리스 워크플로가 매번 한 벌 더 올린다
(`.github/workflows/build.yml` 의 '고정 이름 사본 업로드'). 버전이 든 원본은 그대로 둔다 —
업데이터의 `latest.json` 이 그 주소를 가리키고, 받아 둔 파일에서 버전을 알아볼 수 있어야 한다.

주소를 더 줄이려면 Vercel 프로젝트 Settings → Domains 에서 `.vercel.app` 이름을 하나 더
붙일 수 있다(2026-08-21 확인: `sshtool` · `ssht` · `sshtl` 비어 있음). 무료다.
