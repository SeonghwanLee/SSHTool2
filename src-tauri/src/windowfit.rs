//! 창을 지금 화면 안으로 들여놓는다.
//!
//! 창 크기·위치는 종료할 때 저장했다가 다음 실행에 되살린다(window-state 플러그인).
//! 그런데 그 복원에는 구멍이 둘 있다 —
//!   1. **크기는 화면과 대조하지 않고** 그대로 되살린다. 큰 모니터에서 쓰던 크기가
//!      작은 노트북 화면에 그대로 온다.
//!   2. **위치는 네 귀퉁이 중 하나라도 어떤 모니터에 걸치면** 그대로 되살린다.
//!      제목줄이 화면 위로 잘려 나가도 오른쪽 아래 귀퉁이만 걸쳐 있으면 통과한다.
//!
//! 이 앱은 OS 제목줄을 쓰지 않아(`decorations: false`) 창을 옮길 손잡이가 우리가 그린
//! 제목줄뿐이다. 그것이 화면 밖으로 나가면 창을 잡을 방법이 없고, 업데이트 안내창처럼
//! 창 안에 뜨는 물음에도 답할 수 없다(사용자 보고 0.76.8).
//!
//! 그래서 시작할 때 한 번 화면 안으로 들여놓고, 실행 중 화면 구성이 바뀐 경우를 위해
//! 단축키로 부를 수 있는 길(`window_fit_to_screen`)도 함께 둔다.

use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

/// 창을 작업영역(작업표시줄을 뺀 화면) 안으로 들여놓는다.
///
/// `center` 가 참이면 가운데로 옮긴다(사용자가 직접 부른 '되돌리기'). 거짓이면 최소한만
/// 밀어 넣는다 — 시작할 때는 사용자가 맞춰 둔 자리를 함부로 바꾸지 않는 편이 낫다.
pub fn fit(win: &WebviewWindow, center: bool) -> tauri::Result<()> {
    // 최대화·전체화면은 OS 가 알아서 화면에 맞춘다. 건드리면 그 상태만 깨진다.
    if win.is_maximized().unwrap_or(false) || win.is_fullscreen().unwrap_or(false) {
        return Ok(());
    }
    let size = win.outer_size()?;
    let pos = win.outer_position()?;

    // 창 가운데가 놓인 모니터를 기준으로 삼는다 — 걸친 모니터가 없으면(모니터를 뺀
    // 경우 등) 지금 모니터, 그것도 없으면 주 모니터.
    let cx = pos.x as f64 + size.width as f64 / 2.0;
    let cy = pos.y as f64 + size.height as f64 / 2.0;
    let monitor = match win.monitor_from_point(cx, cy)? {
        Some(m) => Some(m),
        None => match win.current_monitor()? {
            Some(m) => Some(m),
            None => win.primary_monitor()?,
        },
    };
    let Some(monitor) = monitor else {
        return Ok(()); // 모니터를 하나도 못 찾으면 손대지 않는다
    };

    let area = monitor.work_area();
    let Some((x, y, w, h)) = placement(
        (pos.x, pos.y),
        (size.width, size.height),
        (area.position.x, area.position.y, area.size.width, area.size.height),
        center,
    ) else {
        return Ok(());
    };

    if w != size.width || h != size.height {
        win.set_size(PhysicalSize { width: w, height: h })?;
    }
    if x != pos.x || y != pos.y {
        win.set_position(PhysicalPosition { x, y })?;
    }
    Ok(())
}

/// 화면 안에 들어가는 자리·크기를 셈한다 — 창을 실제로 옮기는 일과 떼어 놓아 시험한다.
/// 인자는 모두 물리 픽셀이고, `area` 는 (x, y, 너비, 높이) 작업영역이다.
/// 작업영역을 못 읽으면(0) None.
fn placement(
    pos: (i32, i32),
    size: (u32, u32),
    area: (i32, i32, u32, u32),
    center: bool,
) -> Option<(i32, i32, u32, u32)> {
    let (ax, ay, aw, ah) = area;
    if aw == 0 || ah == 0 {
        return None;
    }
    let w = size.0.min(aw);
    let h = size.1.min(ah);
    // 줄인 크기를 기준으로 자리를 정해야 오른쪽·아래가 다시 삐져나가지 않는다.
    let (max_x, max_y) = (ax + aw as i32 - w as i32, ay + ah as i32 - h as i32);
    let (x, y) = if center {
        (ax + (aw as i32 - w as i32) / 2, ay + (ah as i32 - h as i32) / 2)
    } else {
        (pos.0.clamp(ax, max_x), pos.1.clamp(ay, max_y))
    };
    Some((x, y, w, h))
}

#[cfg(test)]
mod tests {
    use super::placement;

    /// 1920x1040 작업영역(아래 40px 작업표시줄)을 기준으로 본다.
    const AREA: (i32, i32, u32, u32) = (0, 0, 1920, 1040);

    #[test]
    fn 화면_안에_있는_창은_건드리지_않는다() {
        assert_eq!(placement((100, 80), (1000, 680), AREA, false), Some((100, 80, 1000, 680)));
    }

    #[test]
    fn 제목줄이_위로_잘린_창을_끌어내린다() {
        // y 가 음수 — 우리 창은 OS 제목줄이 없어 이 상태면 잡을 손잡이가 사라진다.
        assert_eq!(placement((300, -220), (1000, 680), AREA, false), Some((300, 0, 1000, 680)));
    }

    #[test]
    fn 화면보다_큰_창은_작업영역까지_줄인다() {
        // 큰 모니터에서 쓰던 크기가 그대로 복원된 경우.
        assert_eq!(placement((-200, -100), (3200, 1800), AREA, false), Some((0, 0, 1920, 1040)));
    }

    #[test]
    fn 오른쪽_아래로_벗어난_창을_안으로_민다() {
        assert_eq!(placement((1800, 900), (1000, 680), AREA, false), Some((920, 360, 1000, 680)));
    }

    #[test]
    fn 가운데_정렬은_작업영역_기준이다() {
        assert_eq!(placement((5000, 5000), (1000, 680), AREA, true), Some((460, 180, 1000, 680)));
    }

    #[test]
    fn 보조_모니터의_음수_좌표도_그_화면_기준으로_본다() {
        // 주 모니터 왼쪽에 붙은 보조 모니터(-1920..0).
        let left = (-1920, 0, 1920, 1040);
        assert_eq!(placement((-1900, -50), (1000, 680), left, false), Some((-1900, 0, 1000, 680)));
        assert_eq!(placement((-3000, 0), (1000, 680), left, false), Some((-1920, 0, 1000, 680)));
    }

    #[test]
    fn 작업영역을_못_읽으면_손대지_않는다() {
        assert_eq!(placement((0, 0), (1000, 680), (0, 0, 0, 0), false), None);
    }
}
