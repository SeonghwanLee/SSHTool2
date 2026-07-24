//! SSH 포트 포워딩 (WPF 0.31.0 대응).
//!
//! 규칙 형식(한 줄에 하나):
//!   `L:로컬포트:대상호스트:대상포트`  — ssh -L. 로컬 포트로 들어온 연결을 서버를 거쳐 대상으로.
//!   `R:원격포트:대상호스트:대상포트`  — ssh -R (현재 미지원, 파싱만 하고 안내).
//!
//! 로컬(-L)은 접속 직후 리스너를 띄우고, TCP 연결마다 direct-tcpip 채널을 열어
//! 양방향으로 바이트를 중계한다. 세션이 끊기면 리스너 태스크를 abort 한다.

use std::sync::Arc;

use russh::client::{Handle, Handler, Msg};
use russh::{Channel, ChannelMsg};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::AbortHandle;

#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    /// true = -L(로컬), false = -R(원격)
    pub local: bool,
    /// -L 이면 로컬 바인드 포트, -R 이면 원격 바인드 포트
    pub bind_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
}

/// 규칙을 파싱한다. 반환: (유효 규칙, 형식이 틀려 건너뛴 줄들).
/// 틀린 줄을 함께 돌려줘 호출부가 사용자에게 안내할 수 있게 한다.
pub fn parse(text: &str) -> (Vec<Rule>, Vec<String>) {
    let mut out = Vec::new();
    let mut bad = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match parse_line(line) {
            Some(rule) => out.push(rule),
            None => bad.push(line.to_string()),
        }
    }
    (out, bad)
}

fn parse_line(line: &str) -> Option<Rule> {
    let parts: Vec<&str> = line.split(':').collect();
    if parts.len() != 4 {
        return None;
    }
    let local = match parts[0].trim().to_ascii_uppercase().as_str() {
        "L" => true,
        "R" => false,
        _ => return None,
    };
    let bind_port = parts[1].trim().parse::<u16>().ok()?;
    let dest_port = parts[3].trim().parse::<u16>().ok()?;
    let dest_host = parts[2].trim().to_string();
    if dest_host.is_empty() || bind_port == 0 || dest_port == 0 {
        return None;
    }
    Some(Rule {
        local,
        bind_port,
        dest_host,
        dest_port,
    })
}

/// -L 리스너를 띄운다. 반환한 AbortHandle 로 세션 종료 시 중단한다.
/// `notify` 는 상태 문구를 터미널에 표시하기 위한 콜백.
pub fn spawn_local<H, F>(handle: Arc<Handle<H>>, rule: Rule, notify: F) -> AbortHandle
where
    H: Handler + 'static,
    F: Fn(String) + Send + Sync + 'static,
{
    let notify = Arc::new(notify);
    let task = tokio::spawn(async move {
        let addr = format!("127.0.0.1:{}", rule.bind_port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                notify(format!(
                    "[포워딩] L:{} 바인드 실패 — {e}",
                    rule.bind_port
                ));
                return;
            }
        };
        notify(format!(
            "[포워딩] L:{} → {}:{} 시작",
            rule.bind_port, rule.dest_host, rule.dest_port
        ));

        // 서버가 포워딩을 거부하는 경우, 매 연결마다가 아니라 한 번만 알린다.
        let warned = Arc::new(std::sync::atomic::AtomicBool::new(false));
        loop {
            let Ok((sock, _peer)) = listener.accept().await else {
                break;
            };
            let handle = handle.clone();
            let rule = rule.clone();
            let notify = notify.clone();
            let warned = warned.clone();
            tokio::spawn(async move {
                match handle
                    .channel_open_direct_tcpip(
                        rule.dest_host.clone(),
                        rule.dest_port as u32,
                        "127.0.0.1",
                        rule.bind_port as u32,
                    )
                    .await
                {
                    Ok(channel) => {
                        let _ = pump(channel, sock).await;
                    }
                    Err(_) => {
                        if !warned.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            notify(format!(
                                "[포워딩] L:{} → {}:{} — 서버가 거부했습니다(AllowTcpForwarding 확인)",
                                rule.bind_port, rule.dest_host, rule.dest_port
                            ));
                        }
                    }
                }
            });
        }
    });
    task.abort_handle()
}

/// TCP 소켓 ↔ SSH 채널 양방향 중계.
async fn pump(mut channel: Channel<Msg>, mut sock: TcpStream) -> Result<(), std::io::Error> {
    let mut buf = vec![0u8; 16 * 1024];
    let mut sock_eof = false; // 소켓이 먼저 닫혀도 채널→소켓 방향은 끝까지 흘린다(half-close)
    loop {
        tokio::select! {
            read = sock.read(&mut buf), if !sock_eof => {
                let n = read?;
                if n == 0 {
                    let _ = channel.eof().await;
                    sock_eof = true;
                } else if channel.data(&buf[..n]).await.is_err() {
                    break;
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        sock.write_all(&data).await?;
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        sock.write_all(&data).await?;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    let _ = sock.shutdown().await;
    Ok(())
}
