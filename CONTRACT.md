# SSHTool2 — 병렬 개발 공통 계약 (에이전트 필독)

WPF SSHTool의 후속. Tauri v2(Rust) + xterm.js(웹) 재작성. 목표: 최신·크로스플랫폼,
윈도우 종속 최소화, .NET 런타임 불필요(WebView2만 사용).

## 파일 소유권 (충돌 금지)
- 백엔드 에이전트: `src-tauri/**` 전체 (Cargo.toml, tauri.conf.json, capabilities/, build.rs, src/*.rs). 업데이터 플러그인 배선 포함.
- 프론트 에이전트: `src/**`, `index.html`(내용만), `src-tauri/icons/**`(아이콘 생성). package.json/vite/tsconfig는 이미 세팅됨 — 의존성 추가만.
- CI/배포 에이전트: `.github/**`, `README.md`, `DEPLOY.md`. tauri.conf.json/Rust는 수정 금지(엔드포인트·서명키는 이 계약 값 사용).

## 버전
tauri 2 · @tauri-apps/api ^2 · @tauri-apps/cli ^2 · russh 0.62 · tokio 1(full) · @xterm/xterm ^6 · @xterm/addon-fit ^0.11

## Tauri 앱 식별
- identifier: `com.seonghwanlee.sshtool2`
- productName: `SSHTool2`
- 메인 윈도우: label `main`, title "SSHTool2", 1000x680
- devUrl http://localhost:1420, frontendDist ../dist, beforeDevCommand `npm run dev`, beforeBuildCommand `npm run build`

> 로드맵·완료기준은 **DESIGN.md** 가 기준 문서다. 이 파일은 IPC/버전 계약만 유지한다.

## IPC 계약 (프론트 ↔ 백엔드)
### 명령 (invoke, 프론트 → 백엔드)
- 세션/설정: `sessions_load`, `sessions_save`, `settings_load`, `settings_save`
- 볼트: `vault_status/init/unlock/lock/set_password/get_password/delete_password`
- SFTP: `sftp_connect/list/download/upload/mkdir/remove/rename/disconnect`
- 임포트: `import_scan()` (async, spawn_blocking)
- 호스트키(TOFU): `hostkeys_list`, `hostkey_remove`, `hostkeys_clear`
- **신규 커맨드는 `generate_handler!` 목록에도 반드시 등록** — 누락 시 컴파일은 되지만
  런타임에 "Command not found" 로 조용히 실패한다(v0.6.0 설정 영속화 사고 원인).

- `ssh_connect({ host: string, port: number, user: string, password: string, cols: number, rows: number, charset: string }) -> string`
  접속 + PTY 셸 열고, 출력 읽기 루프를 spawn(→ `ssh://data` emit). 반환값 = 세션 id(문자열). 실패 시 Err(문자열).
- `ssh_write({ id: string, data: number[] })` — 셸에 바이트 쓰기.
- `ssh_resize({ id: string, cols: number, rows: number })` — PTY 크기 변경.
- `ssh_close({ id: string })` — 세션 종료.
(러스트 command 파라미터는 snake_case, 위 JS 키와 1:1. 인자는 단어 하나라 케이스 모호성 없음.)

### 이벤트 (emit, 백엔드 → 프론트)
- `ssh://data` payload `{ id: string, data: number[] }` — 셸 출력 바이트(UTF-8 원본).
- `ssh://closed` payload `{ id: string, message: string }` — 세션 종료/에러 사유.

## 자동 업데이트
- 플러그인: `tauri-plugin-updater` (+ 프론트 `@tauri-apps/plugin-updater`).
- 엔드포인트: `https://github.com/SeonghwanLee/SSHTool2/releases/latest/download/latest.json`
- 서명 공개키: tauri.conf.json plugins.updater.pubkey 에 아래 값 그대로 사용:
```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDVGNkVCNUYzNEQ0RDc5RjMKUldUemVVMU44N1Z1WDNDM041MW5uUThMeUJlMVlZN0JCSVV6UnFRbWZpRkJFSWVCTkhlVy9UV0QK
```
- CI가 릴리스 시 서명된 번들 + latest.json 업로드. 개인키는 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`(+ 암호 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

## 원격 저장소
git@github.com:SeonghwanLee/SSHTool2.git (main 브랜치)

## 검증 의무
- 프론트: `npm run build` 통과.
- 백엔드: russh 사용부는 독립 크레이트로 `cargo check` 검증(webkit 없어 Tauri 전체 빌드는 CI/Windows). Rust 코드 문법/타입은 최대한 맞출 것.
- CI: 워크플로 YAML 문법 유효.
