# SSHTool2 — 재설계 & 이식 로드맵 (WPF SSHTool 0.46.1 → Tauri)

WPF SSHTool은 90여 버전에 걸쳐 쌓인 ~15,000줄 성숙 앱이다. 이 문서는 그 전 기능을
A–Z로 분해하고, Tauri(Rust + xterm.js) 재구현의 아키텍처와 단계별 이행 계획을 못박는다.
**"테마 조금 고치고 끝"을 막기 위한 완료 기준 체크리스트다.**

WPF의 최대 비용(OLE 마우스 캡처 도난, 커스텀 ScrollBar/ControlTemplate, 네이티브
타이틀바 테마, DPI 수학, IME 박스 억제)은 전부 WPF/Win32 고유라 웹 렌더러에선 사라진다.
그 대신 xterm.js 통합 + SSH 백엔드 + SFTP 스트리밍 + 보안 키스토어에 예산을 쓴다.
**원본에서 그대로 이식할 도메인 로직: 한글 오토마타(HangulComposer), 세션 임포터 파서,
볼트 암호화 스킴, 트리거 엔진, 테마 팔레트, ChangeLog(버그 회피 체크리스트).**

---

## 개발기 제약 (중요)

이 개발기(Linux)에서는 `cargo check` 가 불가능하다 — tauri 가 webkit2gtk/gio 를 요구하고
설치할 수 없으며, Windows 타깃 크로스체크도 C 의존 크레이트가 MSVC `lib.exe` 를 요구한다.
그래서 **`bash scripts/typecheck-rust.sh`** 로 검증한다 — tauri 를 최소 스텁으로 대체하고
프로젝트의 실제 소스를 `#[path]` 로 참조해 타입체크한다(main.rs 만 매크로 때문에 제외).
**Rust 를 수정했으면 push 전에 반드시 이 스크립트를 돌릴 것.**
(v0.9.0 이 파라미터 doc 주석 하나로 CI 빌드가 깨진 뒤 도입)

## 아키텍처 (재설계)

### 백엔드 (Rust, `src-tauri/src/`)
| 모듈 | 책임 | 상태 |
|---|---|---|
| `ssh.rs` | SSH 셸 세션(PTY) — russh 0.62, 다중 세션, keepalive | ✅ 있음 |
| `sftp.rs` | SFTP — 목록/스트리밍 전송(진행·취소)/조작 | ✅ |
| `vault.rs` | v2 DEK 구조 — PBKDF2-HMAC-SHA512 300k → AES-256-GCM, 복구키·마스터 변경 | ✅ |
| `store.rs` | 세션·폴더·설정 영속화(JSON) | ✅ |
| `import.rs` | PuTTY(registry/CP949)·SecureCRT(ini)·MobaXterm(ini) 파서 | ✅ |
| `hostkey.rs` | known_hosts TOFU, SHA-256 지문 검증 | ✅ |
| `localfs.rs` | SFTP 좌측 패널용 로컬 파일시스템 | ✅ |
| `localshell.rs` | 로컬 셸(portable-pty) — cmd/pwsh, claude CLI 등 | ✅ |
| `portfwd.rs` | 포트 포워딩 L/R | ✅ |

### 프론트 (TypeScript, `src/`)
```
core/     ipc, 전역 상태 store, 설정
terminal/ TerminalTab, addons(search/web-links/unicode), 선택·복사, zoom, 한글 오토마타
sftp/     4분할 브라우저, 전송 매니저, DnD
ui/       sidebar(트리·검색·DnD), tabbar, tiles, statusbar, command-window, dialogs, settings, themes
```

---

## 단계별 로드맵 (완료 기준)

### Phase 0 — 골격 ✅ (v0.1–v0.5)
접속·다중탭·볼트(기본)·동시명령·단일패널 SFTP·자동업데이트.

### Phase 1 — 정체성 & 일상 사용 (v0.6) ✅
- [x] **테마 10종** (Everforest/Gruvbox/Kanagawa/Monokai/EverforestLight/GruvboxLight/Midnight/Charcoal/PureWhite/StoneWhite) — 앱 크롬 + 터미널 색 동시, 재시작 유지
- [x] **임베디드 폰트 4종**(D2Coding·JetBrains Mono·IBM Plex Mono·Hack) + @font-face, xterm 적용
- [x] **폰트 피커** — 내장/시스템 배지, 크기, D2Coding fallback 선두(한글 보장)
- [x] **설정 다이얼로그 + 영속화** — 테마·폰트·크기·커서·copy-on-select·스크롤백 (라이브 적용)
- [x] **터미널 UX** — 선택→자동복사·복사 토스트, 우클릭=복사/붙여넣기(PuTTY식), Ctrl+Shift+F 검색(Enter/F3/Shift+F3), Ctrl+휠/±/0 zoom, 웹링크
- [x] **터미널 키** — Ctrl+Enter=LF, Ctrl+C/Ctrl+Insert 복사·Shift+Insert 붙여넣기 (나머지는 xterm.js 기본)
- [x] **탭 키** — Ctrl+Tab/Ctrl+Shift+Tab, Ctrl+1~9, Ctrl+F4
- [x] **탭 상태색** — 비활성 탭 출력=호박색, 끊김=적색(글자 검정), 열어보면 해제
- [x] **상태바** — 세션 상태 / 터미널 크기 / 커서 / 인코딩
- [x] **사이드바 검색**(250ms 디바운스+✕클리어) + 폴더 접힘 유지
- [x] Shift+PageUp/Down 스크롤백, Ctrl+Shift+T 빠른접속 — v0.10.0
- [x] 세션 세부정보 토글 — v0.12.0
- [ ] 남음: 한영·CAP·NUM 표시

### Phase 2 — 데이터 & 온보딩 (v0.7) ✅
- [x] **세션 임포트** PuTTY(레지스트리·CP949)/SecureCRT(ini)/MobaXterm(ini) — 프로그램/폴더 그룹 트리, 검색, host+user 중복제거, 비밀번호 제외
- [x] **세션 CRUD 폴리시** — 복제("이름 (복사)")·폴더이동·이름변경·순서(↑↓)·일괄삭제(체크목록)·빈 폴더 생성/이름변경/삭제
- [x] **우클릭 컨텍스트 메뉴** + 단축키(C/F/E/U/M/R/K/J/N/D/B/I)
- [x] **호스트키 TOFU 검증** — SHA-256 지문 known_hosts.json, 불일치 시 거부 + 안내, 관리 UI(개별/전체 삭제)
- [x] **세션별 옵션** — 문자셋(UTF-8/EUC-KR/CP949, 스트리밍 변환)·접속시 자동실행 명령·트리거(패턴→자동입력, 쿨다운·평문 경고)
- [x] 드래그앤드롭 순서변경(삽입선)·폴더 이동 — v0.11.0
- [x] 최근접속순 정렬 — v0.12.0

### Phase 3 — SFTP 완전판 (v0.8) ✅
- [x] **로컬 | 원격 이중 패널**(FileZilla식) — 각 패널 경로바·상위·새로고침·새 폴더
- [x] 업/다운로드 **DnD 양방향**(패널 간), 다중선택(Ctrl+클릭), 우클릭 메뉴, **폴더 재귀 전송**
- [x] **전송 진행바**(파일명·바이트·%) + 취소(청크 단위 중단), 실패/취소 시 부분 파일 정리
- [x] **충돌 다이얼로그**(덮기/이름변경("이름 (2)")/건너뜀/취소 + 남은 항목 전체 적용)
- [x] 파일 확장자 색상, F2 이름변경 / Del 삭제 / F5 새로고침, 더블클릭 폴더 진입
- [x] 백엔드 스트리밍 전송(64KB 청크) — 대용량 파일도 메모리 상주 없이 전송
- [x] 리사이즈 스플리터·MB/s·전체 진행 — v0.15.0
- [ ] 남음: 좌우 트리 패널(4분할의 트리 절반), 탐색기 in/out DnD(HTML5 DnD 채택으로 보류)

### Phase 4 — 파워 & 보안 (v0.9)
- [x] **복구키**(160비트 base32 1회 발급) + **마스터 변경** + **무활동 자동잠금** — v0.8.0 선반영
      · 볼트 v2 구조: 랜덤 DEK 를 마스터/복구키로 각각 wrap → 마스터 변경 시 재암호화 불필요
- [x] OS 키체인 자동해제(keyring — Windows Credential Manager 등) — v0.15.0
- [x] **포트 포워딩** L:/R: 자동시작 — v0.13.0(L)·v0.14.0(R)
- [x] **뷰 모드** 탭/세로타일/가로타일(2×2, 포커스 테두리, 타일별 닫기, Ctrl+1–9) — v0.9.0
- [x] **로컬 셸 세션**(portable-pty) — 서버 없이 cmd/PowerShell·claude CLI 실행 — v0.10.0
      · SSH 와 동일 이벤트를 써서 터미널 표시 경로 공유, 인증·SFTP 없음
- [x] **세션 로그** 원문 파일 기록(stdout+stderr, 문자셋 변환 후) — v0.9.0

### Phase 5 — 마감 폴리시 (v1.0)
- [ ] **인앱 한글 오토마타**(두벌식, 플로팅 IME 제거 — HangulComposer 로직 이식)
- [x] **About/체인지로그** — 배너·버전 배지·이력(최근 5 + 더보기)·업데이트 확인·진단 정보 복사 — v0.10.0
- [x] 설정 export/import(JSON 번들)·공장초기화 — v0.10.0
- [x] 오프라인(내부망) 모드 — v0.11.0


---

## 이식 시 반드시 지킬 교훈 (ChangeLog에서)
- 탭 이름 = **사이드바 세션명**(셸 타이틀 X), 원격 타이틀은 툴팁 — 0.43.2
- 닫기 확인은 **연결 살아있을 때만**, 죽은(빨강) 탭은 조용히 닫기; 휠클릭 닫기 — 0.28/0.43.0
- 선택은 5px 임계 이후에만(클릭=포커스), 놓으면 자동복사(xterm식) — 0.45.4
- 데이터 손실 주의: 편집 저장이 포트포워드/로그/정렬 누락 금지, 복구키 해제가 세션 비우기 금지 — 0.43.0
- OnAccent(강조 위 글자)는 강조 배경 전용 — 0.20.1
- 마스터키 암호화 항목 추가 시 재암호화 레지스트리에 등록 필수
- ANSI 파서 예외는 격리(앱 안 죽게)
