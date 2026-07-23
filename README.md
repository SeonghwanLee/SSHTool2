# SSHTool2

크로스플랫폼 SSH/터미널 클라이언트. WPF 기반 **SSHTool** 을 **Tauri v2 + xterm.js** 로 재작성한 후속 프로젝트다.

- **가벼운 배포**: .NET 런타임 불필요. Windows 에 기본 포함된 **WebView2** 만 사용한다.
- **크로스플랫폼**: Rust(Tauri) 백엔드 + 웹 프론트엔드 구조로 Windows 외 플랫폼 확장이 용이하다.
- **자동 업데이트**: 앱 시작 시 최신 릴리스를 확인하고 서명 검증 후 업데이트한다.

## 스택

| 영역 | 기술 |
|------|------|
| 셸/데스크톱 | Tauri v2 (Rust) |
| SSH | russh 0.62 + tokio |
| 터미널 UI | @xterm/xterm ^6 + @xterm/addon-fit |
| 업데이터 | tauri-plugin-updater |

앱 식별자 `com.seonghwanlee.sshtool2` · 메인 윈도우 1000x680.

## 개발

```bash
npm install
npm run tauri dev
```

- 프론트 단독 빌드 검증: `npm run build`
- 개발 서버: http://localhost:1420

## 빌드

```bash
npm run tauri build
```

Windows 에서는 NSIS 인스톨러가 생성된다. 리눅스 환경에서는 WebKit 의존성 문제로 전체 빌드가 어려우므로, 배포용 정식 빌드는 CI(Windows 러너)에서 수행한다.

## 자동 업데이트

- 업데이터 매니페스트 엔드포인트:
  `https://github.com/SeonghwanLee/SSHTool2/releases/latest/download/latest.json`
- CI 가 릴리스 시 서명된 번들과 `latest.json` 을 함께 업로드한다.
- 앱은 시작 시 이 엔드포인트를 조회해 새 버전이 있으면 서명(공개키) 검증 후 설치한다.

릴리스/배포 절차는 [DEPLOY.md](./DEPLOY.md) 참고.
