# 배포 가이드

SSHTool2 는 **태그 push → GitHub Actions 자동 빌드/서명 → Release + `latest.json` 발행 → 앱 자동 업데이트** 흐름으로 배포한다.

## 사전 준비: GitHub Secrets 2개 등록 (최초 1회)

리포지토리 **Settings → Secrets and variables → Actions → New repository secret** 에서 아래 2개를 등록한다.

| Secret 이름 | 값 |
|-------------|-----|
| `TAURI_SIGNING_PRIVATE_KEY` | 리포 루트 `updater-private-key.key` **파일 내용 전체** 를 그대로 붙여넣는다. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | **빈 값**. (키에 암호를 걸지 않았음 — 값 없이 저장) |

> 공개키(pubkey)는 이미 `src-tauri/tauri.conf.json` 의 `plugins.updater.pubkey` 에 계약값으로 박혀 있다. 개인키는 절대 커밋하지 말 것(`updater-private-key.key` 는 로컬/시크릿에만 보관).

## ⚠️ 자동 업데이트 필수 설정 (건드리지 말 것 — v0.13.0 사고)

Tauri v2 는 아래가 있어야 서명 번들·`latest.json` 을 만든다. 하나라도 빠지면
릴리스에 인스톨러만 올라가고 자동 업데이트가 **조용히 동작하지 않는다**(v0.1~0.12 내내 그랬음).
- `src-tauri/tauri.conf.json` → `bundle.createUpdaterArtifacts: true` (**핵심 스위치**)
- `build.yml` args → `--bundles nsis` (v1 전용 `updater` 타깃 금지 — v2 에선 무효)
- 릴리스는 `releaseDraft:false, prerelease:false` 라야 `.../releases/latest/download/latest.json` 접근 가능

## 릴리스 절차

1. 버전을 올린다 (`package.json` 및 `src-tauri/tauri.conf.json` 의 version — 담당 에이전트 파일).
2. main 브랜치에 반영 후 태그를 push 한다.

```bash
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

3. 태그 push 가 감지되면 CI(`.github/workflows/build.yml`)가 windows-latest 러너에서:
   - `npm ci` → Rust toolchain → `tauri-action` 으로 NSIS 인스톨러 빌드 + 업데이터 번들 **서명**
   - GitHub Release(`SSHTool2 vX.Y.Z`) 생성, 서명된 번들과 **`latest.json`** 업로드
4. 사용자 앱은 시작 시 아래 엔드포인트를 조회해 새 버전을 서명 검증 후 설치한다.
   `https://github.com/SeonghwanLee/SSHTool2/releases/latest/download/latest.json`

## 내부망(오프라인) 배포 참고

- WebView2 가 없는 폐쇄망 PC 대응: `src-tauri/tauri.conf.json` 의 `bundle.windows.webviewInstallMode` 를 **`fixedRuntime`(고정 런타임 동봉)** 으로 설정하면 WebView2 부재 환경에서도 실행된다. (인스톨러 용량 증가 — 백엔드 담당 영역)
