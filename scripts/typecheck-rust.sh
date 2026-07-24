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
EOF

{
  echo "// 프로젝트의 실제 소스를 직접 참조한다(복사본 아님)."
  for m in store vault hostkey localfs import ssh sftp localshell backup; do
    echo "#[path = \"$SRC/$m.rs\"] pub mod $m;"
  done
} > "$CHECK/src/lib.rs"

cd "$CHECK"
cargo check --message-format short
