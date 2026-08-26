#!/usr/bin/env bash
# Rust 타입체크 하네스.
#
# 이 리포는 Linux 개발기에서 `cargo check` 를 돌릴 수 없다 — tauri 가 webkit2gtk/gio 를
# 요구하고(설치 불가), Windows 타깃 크로스체크는 C 의존 크레이트가 MSVC lib.exe 를 요구한다.
# 그래서 tauri 를 최소 스텁으로 대체한 임시 크레이트에서 **프로젝트의 실제 소스 파일을
# #[path] 로 직접 참조해** 타입체크한다. main.rs(매크로 의존)만 제외된다.
#
# 사용: bash scripts/typecheck-rust.sh
set -euo pipefail

# rustup 이 PATH 에 없을 수 있으므로 cargo 환경을 먼저 로드한다.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

SRC="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/src"
STUB=/tmp/tauri-stub
CHECK=/tmp/rustcheck

rm -rf "$STUB" "$CHECK"
mkdir -p "$STUB/src" "$CHECK/src"

cat > "$STUB/Cargo.toml" <<'EOF'
[package]
name = "tauri"
version = "2.0.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
EOF

cat > "$STUB/src/lib.rs" <<'EOF'
//! 타입체크 전용 tauri 스텁(실행되지 않음).
use std::ops::Deref;
use std::path::PathBuf;

#[derive(Debug)]
pub struct Error;
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "err") }
}
impl std::error::Error for Error {}

#[derive(Clone)]
pub struct AppHandle;

pub struct PathResolver;
impl PathResolver {
    pub fn app_config_dir(&self) -> Result<PathBuf, Error> { unimplemented!() }
}

pub struct State<'a, T: 'static>(std::marker::PhantomData<&'a T>);
impl<'a, T: 'static> Deref for State<'a, T> {
    type Target = T;
    fn deref(&self) -> &T { unimplemented!() }
}

pub trait Manager {
    fn path(&self) -> &PathResolver { unimplemented!() }
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> { unimplemented!() }
}
impl Manager for AppHandle {}

pub trait Emitter {
    fn emit<S: serde::Serialize + Clone>(&self, _event: &str, _payload: S) -> Result<(), Error> {
        unimplemented!()
    }
}
impl Emitter for AppHandle {}
EOF

cat > "$CHECK/Cargo.toml" <<EOF
[package]
name = "rustcheck"
version = "0.0.0"
edition = "2021"

[dependencies]
tauri = { path = "$STUB" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
russh = "0.62"
russh-sftp = "2.3"
uuid = { version = "1", features = ["v4"] }
aes-gcm = "0.10"
pbkdf2 = "0.12"
sha2 = "0.10"
base64 = "0.22"
encoding_rs = "0.8"
portable-pty = "0.9"
keyring = { version = "3", features = ["windows-native", "linux-native"] }
zip = "2"
ureq = "2"
EOF

{
  echo "// 프로젝트의 실제 소스를 직접 참조한다(복사본 아님)."
  # 모듈 목록은 main.rs 에서 뽑는다 — 손으로 적어 두면 새 모듈이 빠진 채 조용히
  # 통과한다(실제로 filecrypt · sesslog 가 빠져 있었다). 스텁으로는 볼 수 없는 것만
  # 아래에서 뺀다: tauri 매크로(#[tauri::command])나 실제 런타임 타입을 쓰는 모듈들.
  SKIP=" browser debuglog rdp sftpcmd stage windowfit "
  for m in $(sed -n 's/^mod \([a-z_]*\);$/\1/p' "$SRC/main.rs"); do
    case "$SKIP" in *" $m "*) continue ;; esac
    echo "#[path = \"$SRC/$m.rs\"] pub mod $m;"
  done
} > "$CHECK/src/lib.rs"

cd "$CHECK"
cargo check --message-format short

# 단위 시험까지 여기서 돌린다.
#
# CI(check.yml)는 Windows 에서 `cargo check` 만 한다 — 시험을 돌리려면 tauri 의존성을
# 통째로 링크해야 해서 몇 분이 더 든다. 그래서 이 하네스가 실질적인 시험 관문이다.
# 볼트·백업·가져오기처럼 실패의 대가가 큰 자리가 여기에 걸려 있으니, Rust 를 만졌으면
# 이 스크립트를 돌린다.
echo
echo "── 단위 시험 ──"
cargo test --quiet
