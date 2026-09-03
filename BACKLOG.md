# SSHTool2 — 백로그

아직 하지 않은 것만 둔다. 반영된 항목은 지운다 — 무엇을 왜 그렇게 했는지는
changelog(사용자용)와 git 커밋 메시지(설계 근거)에 남아 있다.

## 경쟁 제품 대비 공백 (SecureCRT · MobaXterm · WinSCP · FileZilla)

각 제품의 **공식 기능 페이지** 기준으로 추린 것. 가치 순.

- **점프 호스트(SSH 게이트웨이)** — SecureCRT(dependent session)·MobaXterm(SSH gateway) 양쪽 공식.
  폐쇄망 bastion 경유에 사실상 필수.
  **단독으로 진행할 것** — russh 접속 경로를 바꿔야 하고 이 개발 장비에서는 실행 검증이
  불가능하다(컴파일 확인만 CI). 구현 단서: russh 는 게이트웨이 세션에서 `direct-tcpip`
  채널을 연 뒤 그 스트림 위에 두 번째 클라이언트 세션을 붙일 수 있다.
- **SSH 에이전트 연동(Pageant/OpenSSH agent)** — SecureCRT·WinSCP 공식. 점프 호스트와 세트로 검토.
- **동적 포워딩 -D(SOCKS)** — SecureCRT 공식. 지금은 -L/-R 만 (`portfwd.rs` 의 Rule 에 종류를 하나 더한다).
- **키워드 실시간 강조** — SecureCRT(정규식)·MobaXterm(구문 강조). 대량 출력에서 비용이 있어
  켠 세션에만 적용 + 규칙 수 제한이 전제.
- **파일 이름 필터 · 원격 경로 북마크** — WinSCP·FileZilla 공통.
- 조건부: **Telnet · 시리얼(COM)** (네트워크 장비 콘솔을 다룰 때만), **X11 포워딩**.

## 손볼 자리 (사용 중 나온 것)

- **SFTP 파일 목록 — 방향키로 선택 옮기기 · Shift+방향키 범위** (2026-08-14)
  마우스 쪽은 이미 된다(Ctrl 클릭·Shift 클릭·Ctrl+A). 키보드는 글자를 쳐서 점프하는
  타입어헤드만 있고 ↑↓ 로 한 칸씩 옮기거나 Shift+↑↓ 로 범위를 넓히는 길이 없어,
  키보드만으로 여러 개를 고르려면 Ctrl+A 밖에 없다. 세션 목록 다중 선택(0.78.0)과
  같은 성격이라 붙여 두면 조작이 한 갈래로 모인다.
  자리: `src/sftppane.ts` 의 `onKey`(Ctrl+A·F2·F5·Delete 가 이미 있는 곳)와
  `anchor`(Shift 범위 기준, 이미 있다). 목록 렌더는 건드리지 않아도 된다.

## 다른 SSH 도구 검토 (2026-08-13) — 보류

Xshell·Termius·Tabby·mRemoteNG·Royal TS 에서 "두 제품 이상이 공통으로 갖췄고 우리에게
없는 것"만 추린 결과. **사용자 판단으로 지금은 넣지 않는다**(급하지 않음).

- **자격증명 세트 분리** (Xshell '인증 프로파일', Termius 'Identity/Keychain', mRemoteNG·Royal TS)
  계정·비밀번호·키를 세션과 따로 이름 붙여 저장하고 세션은 참조만 한다. 지금은 세션마다
  각각 저장이라, 공용 계정 비밀번호가 바뀌면 서버 수만큼 고쳐야 한다. 폴더 상속(폴더에
  지정하면 하위 세션이 물려받음)까지 얹으면 관리 부담이 크게 준다. 프런트 위주.
- **세션별 터미널 색·배경** (Xshell·Windows Terminal·Tabby·iTerm2)
  지금 색 태그는 목록·탭의 띠만 바꾼다. 터미널 배경 자체를 세션마다 달리하면 운영 서버에
  엉뚱한 명령을 넣는 사고를 줄인다. 세션에 테마 id 하나 추가하는 수준으로 작다.
- **~/.ssh/config 가져오기** (Termius·Tabby·VS Code Remote)
  기존 5종 가져오기에 OpenSSH 표준 설정만 빠져 있다. **사용자가 그 파일을 쓰는지가 전제** —
  GUI 클라이언트만 써 왔다면 파일 자체가 없어 값이 없다. 와일드카드(`Host db-*`)와
  ProxyJump 는 대응이 없어 건너뛰어야 한다.

## 정지작업 — 파일 크기

사내 규칙(200~400줄 권장, 800줄 상한)을 넘긴 파일. 동작 변화 없는 분리 작업이라
기능 배포에 얹어 나가면 된다. `changelog.ts` 는 데이터 파일이라 예외.

- `src/tabs.ts` · `src/termtab.ts` · `src-tauri/src/main.rs`

## 넣지 않기로 한 것

스크립팅 엔진(VBScript/Python) · 스크립트 녹화 · 내장 X 서버 · VNC · Zmodem/Kermit ·
TFTP 서버 · 인쇄 · FIPS/Kerberos/스마트카드 · 패키지 관리자 · FTP/WebDAV/S3 ·
클라우드 동기화(폐쇄망에서 무의미) · 스니펫/Compose Pane · 탐색기로 끌어내기
(0.75.1 에서 제거 — 실기에서 드래그가 시작조차 되지 않았고, 원인 규명에 Windows 반복
확인이 필요한데 그 여건이 없다) · 전송 큐 순서 바꾸기 · 동시 전송(연결 여러 개).
