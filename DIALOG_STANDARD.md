# SSHTool2 다이얼로그·메뉴 구성 표준

알림/설정/편집/전송 등 모든 모달이 **같은 시각 언어**를 쓰도록 하는 규약.
새 다이얼로그·메뉴를 만들 때 반드시 이 표준을 따른다(이질감 방지).

## 1. 컨테이너
- 모든 모달은 `.modal-overlay` > `.modal-card` 구조.
- 여러 탭/카테고리가 있는 큰 설정·편집 창은 `.modal-card` 에 용도별 클래스 추가(`.settings-card`, `.session-card`).
- 오버레이 클릭·Esc = 취소(미저장). 저장은 명시적 버튼으로만.

## 2. 골격 순서 (위→아래)
1. **제목** — `<h3>` 하나.
2. **탭 내비게이션** — `.std-tabs`(항목 마다 `.std-tab`).
   - 카테고리 **4개 이하**: 상단 **가로** 탭(`.std-tabs`).
   - 카테고리 **5개 이상** 또는 넓은 폭이 유리한 설정류: 좌측 **세로** 탭(`.std-tabs.vertical`) — 본문을 넓게.
3. **본문** — `.std-body` (탭 패널 `.std-panel` 를 담음).
4. **푸터** — `.modal-buttons` 오른쪽 정렬. **취소(좌) / 주동작 accent(우)** 순서 고정.

## 3. 본문 내부 구성 요소(공통 클래스)
- 구획 제목: `.settings-section` (accent 색 + 하단 실선).
- 라벨+컨트롤 한 줄: `.control-row` (라벨 좌 / 입력 우, space-between).
- 체크박스 줄: `.check-row.control-row` (설명 좌 / 체크 우).
- 보조 설명: `.settings-hint` (muted, 작은 글씨).
- 위험 동작 버튼: `.danger-btn`. 보조 버튼: `.sftp-btn`.

## 4. 탭 칩 스타일(통일)
- 가로 탭 active: accent 글자 + accent 하단 밑줄.
- 세로 탭 active: accent 글자 + accent 좌측 바 + `--panel-2` 배경.
- hover: `--fg` 로 밝아짐.

## 5. 컨텍스트 메뉴
- `showContextMenu` 사용. 항목마다 한 글자 `accel`.
- 순서: **주동작(열기/전송) → 구분선 → 편집(이름변경/새로고침) → 구분선 → 삭제(danger)**.
- 다중 선택 시 개수를 라벨에 `(N개)` 로 표기.

## 6. 적용 현황
- 설정(`settingsdialog.ts`): 세로 탭(모양/터미널/보안/일반).
- 세션 편집(`sessiondialog.ts`): 가로 탭(연결/인증/자동화/트리거).
- 전송 충돌(`conflict.ts`) · 알림(`dialogs.ts`): 표준 푸터 버튼.
