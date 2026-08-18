// 세션 로그 파일(0.84.0) — 설정에서 켰을 때 터미널 수신 내용을 logs/ 에 적는다.
//
// 왜 따로 뒀는가: 예전에는 파일을 한 번 열고 끝없이 이어 붙였다. 상한도, 오래된 파일을
// 치우는 코드도 없었다 — 접속할 때마다 새 파일이 생기고 **아무도 지우지 않는다**.
// `tail -f` 를 걸어 둔 세션 하나면 파일 하나가 수 GB 까지 자란다. 사용자가 알아채는
// 시점은 디스크가 찬 뒤라서, 그때는 이미 늦다.
//
// 두 가지를 건다: 파일 하나가 커지면 조각을 나누고(rotate), 열 때 오래된 것과 총량
// 초과분을 치운다(prune). 로그는 있으면 좋은 것이지 접속을 막을 이유가 아니므로
// 모든 실패는 조용히 삼킨다.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 파일 하나의 상한 — 넘으면 다음 조각으로 넘어간다.
const MAX_BYTES: u64 = 50 * 1024 * 1024;
/// 이 기간이 지난 로그는 치운다.
const KEEP_SECS: u64 = 30 * 24 * 60 * 60;
/// logs/ 전체가 이 크기를 넘으면 오래된 것부터 치운다.
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;

pub(crate) struct SessionLog {
    dir: PathBuf,
    /// 조각 이름의 앞부분 — `{base}.log`, `{base}.2.log` …
    base: String,
    part: u32,
    file: File,
    written: u64,
}

impl SessionLog {
    /// 로그 파일을 연다. 실패해도 접속은 계속되어야 하므로 Option.
    pub(crate) fn open(app: &AppHandle, name: &str, session_id: &str) -> Option<Self> {
        let dir = crate::paths::config_dir_opt(app)?.join("logs");
        std::fs::create_dir_all(&dir).ok()?;
        prune(&dir);

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        let safe: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let base = format!("{safe}-{stamp}-{}", &session_id[..8.min(session_id.len())]);
        let path = dir.join(format!("{base}.log"));
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()?;
        // 이어 여는 경우가 있으므로 지금 크기에서 센다.
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Some(Self { dir, base, part: 1, file, written })
    }

    /// 한 덩어리를 적는다. 상한을 넘으면 다음 조각으로 넘어간 뒤 적는다.
    pub(crate) fn write(&mut self, buf: &[u8]) {
        if self.written >= MAX_BYTES {
            self.rotate();
        }
        if self.file.write_all(buf).is_ok() {
            self.written += buf.len() as u64;
        }
    }

    fn rotate(&mut self) {
        self.part += 1;
        let path = self.dir.join(format!("{}.{}.log", self.base, self.part));
        if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            self.file = f;
            self.written = 0;
        } else {
            // 새 조각을 못 열면 지금 파일에 계속 적는다 — 로그를 잃는 것보다 낫다.
            // 매번 다시 시도하지 않도록 셈을 되돌린다.
            self.written = 0;
        }
    }
}

/// logs/ 를 훑어 치울 것을 지운다. 열려 있는 파일은 지워지지 않지만(Windows) 그 실패는
/// 무시해도 된다 — 다음에 다시 후보가 된다.
fn prune(dir: &Path) {
    let now = std::time::SystemTime::now();
    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new(); // (경로, 나이(초), 크기)
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let age = md
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        files.push((path, age, md.len()));
    }
    let doomed = doomed_files(files, KEEP_SECS, MAX_TOTAL);
    for p in doomed {
        let _ = std::fs::remove_file(p);
    }
}

/// 지울 파일을 고른다 — 기한이 지났거나, 새것부터 더해 총량을 넘긴 것.
///
/// 순수 함수로 뺀 이유: 파일시스템 없이 시험할 수 있어야 규칙(기한·총량)이 맞는지
/// 확인할 수 있다. windowfit 의 placement 와 같은 방식이다.
fn doomed_files<T>(mut files: Vec<(T, u64, u64)>, keep_secs: u64, max_total: u64) -> Vec<T> {
    // 새것 먼저 — 총량은 새것부터 채우고 넘치는 옛것을 버린다.
    files.sort_by_key(|(_, age, _)| *age);
    let mut total = 0u64;
    let mut out = Vec::new();
    for (path, age, size) in files {
        if age > keep_secs {
            out.push(path);
            continue;
        }
        total = total.saturating_add(size);
        if total > max_total {
            out.push(path);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_recent_small_logs() {
        let f = vec![("a", 10u64, 100u64), ("b", 20, 100)];
        assert!(doomed_files(f, KEEP_SECS, MAX_TOTAL).is_empty());
    }

    #[test]
    fn drops_logs_past_the_deadline() {
        let f = vec![("old", KEEP_SECS + 1, 10u64), ("new", 5, 10)];
        assert_eq!(doomed_files(f, KEEP_SECS, MAX_TOTAL), vec!["old"]);
    }

    #[test]
    fn drops_oldest_when_total_is_over() {
        // 새것부터 100+100 이 상한 150 을 넘으므로 옛것 하나가 버려진다.
        let f = vec![("old", 100u64, 100u64), ("new", 1, 100)];
        assert_eq!(doomed_files(f, KEEP_SECS, 150), vec!["old"]);
    }

    #[test]
    fn a_single_oversized_log_still_goes() {
        // 하나만으로 상한을 넘겨도 지운다 — 안 그러면 총량이 영영 안 내려간다.
        let f = vec![("huge", 1u64, 999u64)];
        assert_eq!(doomed_files(f, KEEP_SECS, 150), vec!["huge"]);
    }

    #[test]
    fn empty_dir_yields_nothing() {
        let f: Vec<(&str, u64, u64)> = vec![];
        assert!(doomed_files(f, KEEP_SECS, MAX_TOTAL).is_empty());
    }

    #[test]
    fn deadline_beats_size_budget() {
        // 기한이 지난 것은 총량에 여유가 있어도 지운다.
        let f = vec![("old", KEEP_SECS + 1, 1u64)];
        assert_eq!(doomed_files(f, KEEP_SECS, MAX_TOTAL), vec!["old"]);
    }
}
