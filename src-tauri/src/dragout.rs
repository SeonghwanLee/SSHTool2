//! 원격 파일을 탐색기로 끌어내기(Windows 전용).
//!
//! # 왜 이렇게 만드는가
//!
//! 끌기가 시작되는 순간 우리에겐 파일이 없다 — 서버에 있다. Windows 는 이 상황을 위해
//! **지연 렌더링**을 준비해 두었다: 데이터 객체가 "이런 이름·크기의 파일이 있다"는 명세
//! (`CFSTR_FILEDESCRIPTORW`)만 먼저 주고, 상대가 실제로 놓았을 때 내용
//! (`CFSTR_FILECONTENTS`)을 그때 스트림으로 흘려보낸다. WinSCP·FileZilla 가 쓰는 길이다.
//!
//! # 스레드 구조 — 앱이 굳지 않는 이유
//!
//! `DoDragDrop` 은 끝날 때까지 자기 스레드를 붙잡는 모달 호출이다. 그래서 **전용 STA
//! 스레드**에서 돈다. WebView2(UI) 스레드는 그동안 아무 영향도 받지 않는다.
//! 탐색기는 다른 프로세스라 우리 스트림을 COM 프록시로 부르고, 그 호출은 이 전용
//! 스레드의 메시지 펌프가 받아 처리한다. 즉 **파일 내용을 넘기는 동안에도 굳는 것은
//! 없고**, 진행률과 취소는 탐색기가 자기 복사창으로 보여 준다.
//!
//! # 지금 판의 범위
//!
//! 파일만(폴더 제외), 여러 개 동시 가능. 폴더는 하위 목록을 명세에 모두 펼쳐 넣어야 해서
//! 다음 단계로 미룬다. 설정에서 켠 사람만 쓴다(기본 꺼짐) — 실기 확인이 쌓이기 전까지
//! 평소 사용에 영향을 주지 않기 위해서다.

use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// BOOL·HRESULT 는 0.62 에서 windows::core 소속이다(Win32::Foundation 아님).
use windows::core::{implement, Ref, Result as WinResult, BOOL, HRESULT};
use windows::Win32::Foundation::{E_FAIL, E_NOTIMPL, S_FALSE, S_OK};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, ISequentialStream_Impl,
    IStream, IStream_Impl, FORMATETC, STATSTG, STGC, STATFLAG, STGMEDIUM, STREAM_SEEK,
    STREAM_SEEK_CUR, STREAM_SEEK_SET, DVASPECT_CONTENT, LOCKTYPE, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, DROPEFFECT,
    DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::{MODIFIERKEYS_FLAGS, MK_LBUTTON, MK_RBUTTON};
use windows::Win32::UI::Shell::SHCreateStdEnumFmtEtc;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

/// 끌기 결과 코드. windows 크레이트의 상수 경로가 판마다 달라, 값이 고정된 것들은
/// 여기서 직접 둔다(잘못된 import 로 빌드가 깨지는 것보다 낫다).
const DRAGDROP_S_DROP: HRESULT = HRESULT(0x0004_0100_u32 as i32);
const DRAGDROP_S_CANCEL: HRESULT = HRESULT(0x0004_0101_u32 as i32);
const DRAGDROP_S_USEDEFAULTCURSORS: HRESULT = HRESULT(0x0004_0102_u32 as i32);
/// 요청한 형식을 우리가 주지 않는다는 표준 응답.
const DV_E_FORMATETC: HRESULT = HRESULT(0x8004_0064_u32 as i32);
/// 스트림에서 지원하지 않는 조작(되감기 등).
const STG_E_INVALIDFUNCTION: HRESULT = HRESULT(0x8003_0001_u32 as i32);
/// FILEDESCRIPTORW.dwFlags — 크기와 진행률 UI 를 쓴다는 표시.
const FD_FILESIZE: u32 = 0x0000_0040;
const FD_PROGRESSUI: u32 = 0x0000_4000;

/// 끌어낼 항목 하나(프런트에서 넘어온다).
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragItem {
    /// 탐색기에 만들어질 파일 이름.
    pub name: String,
    /// 원격 절대 경로.
    pub path: String,
    pub size: u64,
}

/// 조각 하나를 넘겨받는 채널. Err 이면 그 시점에 전송이 깨진 것이다.
type Chunk = Result<Vec<u8>, String>;

/// 원격 파일 하나를 흘려보내는 스트림. 실제 읽기는 tokio 작업이 하고, 여기서는
/// 채널에서 꺼내 탐색기가 준 버퍼에 채운다(탐색기 쪽 스레드에서 불린다).
#[implement(IStream)]
struct RemoteStream {
    size: u64,
    state: Mutex<StreamState>,
    /// 살아 있는 스트림 수 — 끌기 스레드가 언제까지 메시지를 펌프할지 정하는 데 쓴다.
    live: Arc<AtomicUsize>,
}

struct StreamState {
    rx: tokio::sync::mpsc::Receiver<Chunk>,
    /// 지난번에 다 못 준 조각의 나머지.
    leftover: Vec<u8>,
    pos: u64,
    done: bool,
}

impl Drop for RemoteStream {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ISequentialStream_Impl for RemoteStream_Impl {
    fn Read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return E_FAIL;
        }
        let out = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, cb as usize) };
        let mut st = match self.state.lock() {
            Ok(s) => s,
            Err(_) => return E_FAIL,
        };
        let mut filled = 0usize;
        while filled < out.len() && !st.done {
            if st.leftover.is_empty() {
                // 조각이 올 때까지 기다린다 — 여기서 기다리는 것은 탐색기의 복사 스레드이고,
                // 그쪽은 자기 진행창으로 사용자에게 상태를 보여 준다.
                match st.rx.blocking_recv() {
                    Some(Ok(chunk)) => st.leftover = chunk,
                    Some(Err(_)) => {
                        st.done = true;
                        if filled == 0 {
                            return E_FAIL; // 한 바이트도 못 준 실패는 그대로 알린다
                        }
                    }
                    None => st.done = true, // 끝까지 읽었다
                }
                continue;
            }
            let n = std::cmp::min(out.len() - filled, st.leftover.len());
            out[filled..filled + n].copy_from_slice(&st.leftover[..n]);
            st.leftover.drain(..n);
            filled += n;
        }
        st.pos += filled as u64;
        if !pcbread.is_null() {
            unsafe { *pcbread = filled as u32 };
        }
        S_OK
    }

    fn Write(&self, _pv: *const c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        E_NOTIMPL // 읽기 전용 스트림이다
    }
}

impl IStream_Impl for RemoteStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> WinResult<()> {
        let st = self.state.lock().map_err(|_| windows::core::Error::from(E_FAIL))?;
        // 앞으로만 흐르는 스트림이다. 위치를 묻는 호출(0 이동)만 받아 준다 —
        // 크기는 Stat 으로 알려 주므로 탐색기가 끝으로 건너뛸 일이 없다.
        let ok = (dworigin == STREAM_SEEK_CUR && dlibmove == 0)
            || (dworigin == STREAM_SEEK_SET && dlibmove as u64 == st.pos);
        if !ok {
            return Err(windows::core::Error::from(STG_E_INVALIDFUNCTION));
        }
        if !plibnewposition.is_null() {
            unsafe { *plibnewposition = st.pos };
        }
        Ok(())
    }

    fn SetSize(&self, _libnewsize: u64) -> WinResult<()> {
        Err(windows::core::Error::from(E_NOTIMPL))
    }

    fn CopyTo(
        &self,
        _pstm: Ref<'_, IStream>,
        _cb: u64,
        _pcbread: *mut u64,
        _pcbwritten: *mut u64,
    ) -> WinResult<()> {
        // 구현하지 않으면 호출자가 Read 로 되돌아간다(탐색기가 그렇게 한다).
        Err(windows::core::Error::from(E_NOTIMPL))
    }

    fn Commit(&self, _grfcommitflags: &STGC) -> WinResult<()> {
        Ok(())
    }

    fn Revert(&self) -> WinResult<()> {
        Ok(())
    }

    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> WinResult<()> {
        Err(windows::core::Error::from(STG_E_INVALIDFUNCTION))
    }

    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> WinResult<()> {
        Err(windows::core::Error::from(STG_E_INVALIDFUNCTION))
    }

    fn Stat(&self, pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> WinResult<()> {
        if pstatstg.is_null() {
            return Err(windows::core::Error::from(E_FAIL));
        }
        // 크기를 여기서 정확히 알려 줘야 탐색기가 미리 자리를 잡고 진행률을 낼 수 있다.
        unsafe {
            // 종류(type) 필드는 판마다 이름이 달라 건드리지 않는다. 탐색기가 실제로 보는
            // 값은 크기뿐이고, 나머지는 0 으로 둬도 파일 복사 경로에 지장이 없다.
            let mut s: STATSTG = std::mem::zeroed();
            s.cbSize = self.size;
            *pstatstg = s;
        }
        Ok(())
    }

    fn Clone(&self) -> WinResult<IStream> {
        Err(windows::core::Error::from(E_NOTIMPL))
    }
}

/// 끌기 중 마우스 상태를 보고 계속할지/놓았는지/취소인지 판정하는 표준 구현.
#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() || (grfkeystate & MK_RBUTTON) != MODIFIERKEYS_FLAGS(0) {
            return DRAGDROP_S_CANCEL;
        }
        if (grfkeystate & MK_LBUTTON) == MODIFIERKEYS_FLAGS(0) {
            return DRAGDROP_S_DROP; // 버튼을 놓았다 = 여기에 놓겠다
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS // 커서는 OS 기본을 쓴다
    }
}

/// 파일 목록을 지연 렌더링으로 내주는 데이터 객체.
#[implement(IDataObject)]
struct FileGroup {
    items: Vec<DragItem>,
    /// 형식 번호(클립보드 등록 형식) — 생성 시 한 번 받아 둔다.
    cf_descriptor: u16,
    cf_contents: u16,
    /// 항목 하나의 스트림을 만든다(index → 스트림). 실제 SFTP 읽기를 시작하는 지점.
    open: Box<dyn Fn(&DragItem) -> WinResult<IStream> + Send + Sync>,
}

impl FileGroup {
    /// 파일 명세 덩어리(FILEGROUPDESCRIPTORW) 를 손으로 빚는다.
    /// 레이아웃은 `u32 개수` + `FILEDESCRIPTORW × 개수` 로 고정돼 있다 — 구조체를
    /// import 하지 않고 직접 쌓아 판 차이를 타지 않게 한다.
    fn descriptor_blob(&self) -> Vec<u8> {
        use windows::Win32::UI::Shell::FILEDESCRIPTORW;
        let mut blob = Vec::with_capacity(4 + self.items.len() * std::mem::size_of::<FILEDESCRIPTORW>());
        blob.extend_from_slice(&(self.items.len() as u32).to_le_bytes());
        for it in &self.items {
            // 이 구조체는 packed 라 필드 참조(&fd.x, fd.arr[..])를 만들 수 없다 —
            // 정렬이 어긋난 참조는 Rust 에서 금지다. 포인터로 직접 써 넣는다.
            let mut fd: FILEDESCRIPTORW = unsafe { std::mem::zeroed() };
            let mut name: Vec<u16> = it.name.encode_utf16().take(259).collect();
            name.push(0);
            unsafe {
                std::ptr::addr_of_mut!(fd.dwFlags).write_unaligned(FD_FILESIZE | FD_PROGRESSUI);
                std::ptr::addr_of_mut!(fd.nFileSizeHigh).write_unaligned((it.size >> 32) as u32);
                std::ptr::addr_of_mut!(fd.nFileSizeLow)
                    .write_unaligned((it.size & 0xFFFF_FFFF) as u32);
                let dst = std::ptr::addr_of_mut!(fd.cFileName) as *mut u16;
                for (i, ch) in name.iter().enumerate() {
                    dst.add(i).write_unaligned(*ch);
                }
            }
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    (&fd as *const FILEDESCRIPTORW) as *const u8,
                    std::mem::size_of::<FILEDESCRIPTORW>(),
                )
            };
            blob.extend_from_slice(bytes);
        }
        blob
    }
}

/// 바이트 덩어리를 HGLOBAL 로 옮긴다(클립보드·드래그가 요구하는 형태).
fn to_hglobal(data: &[u8]) -> WinResult<windows::Win32::Foundation::HGLOBAL> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, data.len())?;
        let p = GlobalLock(h);
        if p.is_null() {
            return Err(windows::core::Error::from(E_FAIL));
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), p as *mut u8, data.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

impl IDataObject_Impl for FileGroup_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
        let fmt = unsafe { &*pformatetcin };
        let mut medium: STGMEDIUM = unsafe { std::mem::zeroed() };

        if fmt.cfFormat == self.cf_descriptor && (fmt.tymed & TYMED_HGLOBAL.0 as u32) != 0 {
            let blob = self.descriptor_blob();
            medium.tymed = TYMED_HGLOBAL.0 as u32;
            medium.u.hGlobal = to_hglobal(&blob)?;
            return Ok(medium);
        }

        if fmt.cfFormat == self.cf_contents && (fmt.tymed & TYMED_ISTREAM.0 as u32) != 0 {
            let idx = if fmt.lindex < 0 { 0 } else { fmt.lindex as usize };
            let item = self.items.get(idx).ok_or_else(|| windows::core::Error::from(DV_E_FORMATETC))?;
            let stream = (self.open)(item)?;
            medium.tymed = TYMED_ISTREAM.0 as u32;
            medium.u.pstm = std::mem::ManuallyDrop::new(Some(stream));
            return Ok(medium);
        }

        Err(windows::core::Error::from(DV_E_FORMATETC))
    }

    fn GetDataHere(&self, _pformatetc: *const FORMATETC, _pmedium: *mut STGMEDIUM) -> WinResult<()> {
        Err(windows::core::Error::from(E_NOTIMPL))
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        let fmt = unsafe { &*pformatetc };
        if (fmt.cfFormat == self.cf_descriptor && (fmt.tymed & TYMED_HGLOBAL.0 as u32) != 0)
            || (fmt.cfFormat == self.cf_contents && (fmt.tymed & TYMED_ISTREAM.0 as u32) != 0)
        {
            return S_OK;
        }
        DV_E_FORMATETC
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        if !pformatetcout.is_null() {
            unsafe { (*pformatetcout).ptd = std::ptr::null_mut() };
        }
        S_FALSE // "따로 정규화할 것 없다"는 표준 응답
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> WinResult<()> {
        Err(windows::core::Error::from(E_NOTIMPL))
    }

    fn EnumFormatEtc(&self, _dwdirection: u32) -> WinResult<IEnumFORMATETC> {
        // 표준 열거자를 셸에서 받아 쓴다 — 직접 구현할 만한 것이 없다.
        let formats = [
            FORMATETC {
                cfFormat: self.cf_descriptor,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            },
            FORMATETC {
                cfFormat: self.cf_contents,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_ISTREAM.0 as u32,
            },
        ];
        unsafe { SHCreateStdEnumFmtEtc(&formats) }
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: Ref<'_, IAdviseSink>,
    ) -> WinResult<u32> {
        Err(windows::core::Error::from(E_NOTIMPL))
    }

    fn DUnadvise(&self, _dwconnection: u32) -> WinResult<()> {
        Err(windows::core::Error::from(E_NOTIMPL))
    }

    fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
        Err(windows::core::Error::from(E_NOTIMPL))
    }
}

/// 한 번에 넘길 조각 크기와 미리 받아 둘 조각 수(= 최대 4MB 선반영).
const STREAM_CHUNK: usize = 512 * 1024;
const STREAM_QUEUE: usize = 8;

/// 끌어내기를 시작한다. **즉시 반환**하고, 실제 끌기는 전용 스레드에서 돈다.
pub fn start(
    app: tauri::AppHandle,
    sftp_id: String,
    items: Vec<DragItem>,
) -> Result<(), String> {
    if items.is_empty() {
        return Err("끌어낼 항목이 없습니다".into());
    }
    let live = Arc::new(AtomicUsize::new(0));
    let live_thread = live.clone();

    std::thread::Builder::new()
        .name("dragout".into())
        .spawn(move || unsafe {
            // 이 스레드만의 STA. UI 스레드와 무관하므로 DoDragDrop 이 여기서 아무리
            // 오래 돌아도 앱 화면은 멀쩡하다.
            if OleInitialize(None).is_err() {
                return;
            }
            let cf_descriptor =
                RegisterClipboardFormatW(windows::core::w!("FileGroupDescriptorW")) as u16;
            let cf_contents = RegisterClipboardFormatW(windows::core::w!("FileContents")) as u16;

            let live_open = live_thread.clone();
            let app_open = app.clone();
            let id_open = sftp_id.clone();
            let group = FileGroup {
                items: items.clone(),
                cf_descriptor,
                cf_contents,
                open: Box::new(move |item: &DragItem| {
                    // 놓는 순간 호출된다 — 여기서 비로소 서버에서 읽기 시작한다.
                    let (tx, rx) = tokio::sync::mpsc::channel::<Chunk>(STREAM_QUEUE);
                    let app2 = app_open.clone();
                    let id2 = id_open.clone();
                    let path = item.path.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::sftp::stream_file(&app2, &id2, path, STREAM_CHUNK, tx).await;
                    });
                    live_open.fetch_add(1, Ordering::SeqCst);
                    let stream = RemoteStream {
                        size: item.size,
                        state: Mutex::new(StreamState {
                            rx,
                            leftover: Vec::new(),
                            pos: 0,
                            done: false,
                        }),
                        live: live_open.clone(),
                    };
                    Ok(IStream::from(stream))
                }),
            };

            let data: IDataObject = group.into();
            let source: IDropSource = DropSource.into();
            let mut effect = DROPEFFECT(0);
            let _ = DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect);

            // 놓은 뒤에도 상대가 스트림을 계속 읽을 수 있다(큰 파일). 그동안 이 스레드는
            // 메시지를 계속 펌프해 COM 호출을 받아 준다 — 안 그러면 상대가 멈춘다.
            // 살아 있는 스트림이 없어지면 끝낸다.
            let mut msg = MSG::default();
            let mut idle = 0u32;
            loop {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                    idle = 0;
                }
                if live_thread.load(Ordering::SeqCst) == 0 {
                    idle += 1;
                    // 놓자마자 확인하면 아직 스트림이 만들어지기 전일 수 있어 잠깐 더 본다.
                    if idle > 20 {
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            OleUninitialize();
        })
        .map_err(|e| format!("끌어내기 스레드 생성 실패: {e}"))?;
    Ok(())
}
