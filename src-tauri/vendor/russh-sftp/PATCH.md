# russh-sftp 2.3.0 — SSHTool2 로컬 패치

## 왜 동봉하는가
원본 crate 는 SFTP 와이어 문자열(파일명·경로)을 다룰 때

- 수신: `String::from_utf8_lossy` — UTF-8 이 아닌 이름(EUC-KR 등)이 U+FFFD 로 뭉개져 **복원 불가**
- 송신: `str::as_bytes` — 항상 UTF-8 로 나감

이라서, EUC-KR 로케일 서버에 한글 파일명을 올리면 서버 쪽에서 깨지고, 반대로 서버의
EUC-KR 파일명은 우리 화면에서 깨진 채 조작(삭제·이름변경·다운로드)도 불가능했다.
SFTP v3 프로토콜은 파일명 인코딩을 규정하지 않으므로(= 바이트 그대로) 라이브러리가
UTF-8 을 가정하는 것이 문제였다.

## 패치 내용(2곳, 총 ~6줄)
- `src/buf.rs` `try_get_string` — 바이트 하나를 코드포인트 하나(U+0000~U+00FF)로 옮겨 무손실 전달
- `src/ser.rs` `serialize_str` — 위의 역매핑으로 되돌려 씀

문자셋 해석은 호출자(`src-tauri/src/sftp.rs`)가 세션 문자셋으로 수행한다.
ASCII 는 두 매핑에서 UTF-8 과 동일해 기존 동작이 그대로 유지된다.

## 업그레이드 절차
1. 새 버전 crate 를 이 폴더에 풀고 `[[example]]`·`[[bench]]`·`[dev-dependencies]` 제거
2. 위 2곳을 다시 패치(`SSHTool2 패치` 주석으로 표시해 둘 것)
3. `npm run check:ui` + check CI(cargo check) 통과 확인

원본 라이선스: Apache-2.0 (LICENSE 파일 동봉)
