//! The receiver the recorder extension talks to, kept running by the app for the demo that's open: started with the
//! app's own Node, restarted if it stops, stopped when the app quits. Its port is the demo's (47621 unless set); when
//! something else holds that port, the next free one in a small range (the extension looks through the same range).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{LazyLock, Mutex, Once};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::AppError;

/// How many ports from the demo's the receiver may use (the extension looks through the same ones).
pub const PORT_RANGE: u16 = 10;

/// The receiver now, for the Record screen.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverState {
    /// The demo folder it records into.
    pub demo: Option<PathBuf>,
    pub port: Option<u16>,
    /// Answering on its port.
    pub running: bool,
    /// The app started it (rather than finding one already there for this demo).
    pub owned: bool,
    pub pid: Option<u32>,
    /// The recorder (extension) is polling it now.
    pub connected: bool,
    /// Seconds since the recorder last asked it for work.
    pub recorder_secs_ago: Option<u64>,
    pub restarts: u32,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    dir: Option<PathBuf>,
    port: Option<u16>,
    child: Option<Child>,
    restarts: u32,
    /// Pings in a row it didn't answer.
    misses: u32,
    error: Option<String>,
}

/// Checks in a row (2 s apart, 1.5 s each) a running receiver may miss before it's restarted. A receiver taking in a
/// big snapshot can be slow to answer: restarting it then (one missed ping did, on a presenter's real tabs) dropped
/// the recorder in the middle of a recording.
const PATIENCE: u32 = 6;

#[derive(Default)]
pub struct ReceiverHost {
    inner: Mutex<Inner>,
    supervisor: Once,
}

static HOST: LazyLock<ReceiverHost> = LazyLock::new(ReceiverHost::default);

/// The app's one receiver.
pub fn host() -> &'static ReceiverHost {
    &HOST
}

/// `GET /<path>` on a local port; the JSON it answers, or None.
pub fn get_json(port: u16, path: &str, timeout: Duration) -> Option<Value> {
    request(port, "GET", path, timeout)
}

fn request(port: u16, method: &str, path: &str, timeout: Duration) -> Option<Value> {
    request_body(port, method, path, "", timeout)
}

/// Queues a command for the recorder (`{"op":"reload"}`); its id.
pub fn send_command(port: u16, command: &Value) -> Option<Value> {
    request_body(
        port,
        "POST",
        "/cmd",
        &command.to_string(),
        Duration::from_millis(2000),
    )
}

/// A command to the recorder through the receiver on `port`, and its answer (`None`: no answer within `timeout`, or
/// the recorder said it failed).
pub fn command_result(port: u16, command: &Value, timeout: Duration) -> Option<Value> {
    let id = send_command(port, command)?["id"].as_str()?.to_owned();
    let t = Instant::now();
    while t.elapsed() < timeout {
        let r = get_json(
            port,
            &format!("/result?id={id}"),
            Duration::from_millis(1500),
        )?;
        if r["pending"] != true {
            return (r["ok"] == true).then(|| r["value"].clone());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    None
}

/// The browser's open web pages (title and address, in its own order), from the recorder connected to the app's
/// receiver; empty when none is.
pub fn open_tabs() -> Vec<Value> {
    let r = host().state();
    let Some(port) = r.port.filter(|_| r.connected) else {
        return Vec::new();
    };
    command_result(
        port,
        &serde_json::json!({ "op": "openTabs" }),
        Duration::from_secs(8),
    )
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
}

/// Present: the stage window full screen, on `place` (the projector) when it's given, by the recorder in the browser the
/// stage opened in (a browser that was already running ignores the flags that would). False: no recorder connected, or
/// it couldn't find the window (the stage stays a window).
pub fn stage_fullscreen(url: &str, place: Option<crate::guide::Place>) -> bool {
    let r = host().state();
    let Some(port) = r.port.filter(|_| r.connected) else {
        return false;
    };
    command_result(
        port,
        &serde_json::json!({ "op": "stageWindow", "url": url, "place": place }),
        Duration::from_secs(15),
    )
    .is_some_and(|v| v["state"] == "fullscreen")
}

/// Stop presenting: the stage and guide windows at `url` closed, by the recorder (only windows with nothing else in
/// them). How many it closed; 0 with no recorder connected.
pub fn close_stage(url: &str) -> u64 {
    let r = host().state();
    let Some(port) = r.port.filter(|_| r.connected) else {
        return 0;
    };
    command_result(
        port,
        &serde_json::json!({ "op": "closeStage", "url": url }),
        Duration::from_secs(8),
    )
    .and_then(|v| v["closed"].as_u64())
    .unwrap_or(0)
}

fn request_body(
    port: u16,
    method: &str,
    path: &str,
    body: &str,
    timeout: Duration,
) -> Option<Value> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(
        s,
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .ok()?;
    let mut buf = Vec::new();
    // What came before a reset is still the answer.
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let body = text.split_once("\r\n\r\n")?.1;
    serde_json::from_str(body).ok()
}

/// Whether anything at all listens on the port.
pub fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// A scenecast receiver's answer to /ping (an older receiver doesn't say which demo or pid).
fn ping(port: u16) -> Option<Value> {
    get_json(port, "/ping", Duration::from_millis(1500)).filter(|v| v["ok"] == true)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

fn is_for(ping: &Value, dir: &Path) -> bool {
    ping["demo"]
        .as_str()
        .is_some_and(|d| same_dir(Path::new(d), dir))
}

/// In a test (`SCENECAST_TEST_FENCE`: its own folders, by the path list separator), only a receiver of its own makes
/// way: its demo and raw folders are inside them. Another test's, or a presenter's, is never asked to quit.
fn test_fence() -> Option<Vec<PathBuf>> {
    let v = std::env::var_os("SCENECAST_TEST_FENCE")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&v)
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| real(&p))
        .collect();
    (!dirs.is_empty()).then_some(dirs)
}

/// A path as it really is (macOS's /var is /private/var), for one that doesn't exist yet too: its nearest folder that
/// does, resolved, with the rest after it.
fn real(p: &Path) -> PathBuf {
    let mut at = p.to_path_buf();
    let mut rest = Vec::new();
    while !at.exists() {
        let (Some(name), Some(up)) = (
            at.file_name().map(|n| n.to_owned()),
            at.parent().map(Path::to_path_buf),
        ) else {
            return p.to_path_buf();
        };
        rest.push(name);
        at = up;
    }
    let mut out = std::fs::canonicalize(&at).unwrap_or(at);
    out.extend(rest.iter().rev());
    out
}

fn may_make_way(ping: &Value, fence: Option<&[PathBuf]>) -> bool {
    let Some(dirs) = fence else {
        return true;
    };
    let inside = |k: &str| {
        ping[k]
            .as_str()
            .is_some_and(|p| dirs.iter().any(|d| real(Path::new(p)).starts_with(d)))
    };
    inside("demo") && (ping["raw"].is_null() || inside("raw"))
}

fn child_alive(child: &mut Option<Child>) -> bool {
    match child {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => false,
    }
}

impl ReceiverHost {
    /// The receiver for this demo, started (or kept) running. Returns its state.
    pub fn ensure(&'static self, dir: &Path) -> Result<ReceiverState, AppError> {
        self.supervisor.call_once(|| {
            std::thread::Builder::new()
                .name("receiver".into())
                .spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_secs(2));
                        self.keep_alive();
                    }
                })
                .ok();
            std::thread::Builder::new()
                .name("prescan".into())
                .spawn(move || self.prescan())
                .ok();
        });
        {
            let mut g = self.inner.lock().expect("receiver lock");
            let same = g.dir.as_deref().is_some_and(|d| same_dir(d, dir));
            if !same {
                stop_child(&mut g);
                g.dir = Some(dir.to_path_buf());
                g.port = None;
                g.restarts = 0;
            }
            if let Err(e) = self.start_locked(&mut g) {
                g.error = Some(e.to_string());
                return Err(e);
            }
            g.error = None;
        }
        Ok(self.state())
    }

    /// Whether the receiver for this demo is the app's, and on which port.
    pub fn port_for(&self, dir: &Path) -> Option<u16> {
        let g = self.inner.lock().expect("receiver lock");
        g.dir.as_deref().filter(|d| same_dir(d, dir)).and(g.port)
    }

    /// Up (or adopted) on a port for `g.dir`; nothing to do when it already answers.
    fn start_locked(&self, g: &mut Inner) -> Result<(), AppError> {
        let dir = g
            .dir
            .clone()
            .ok_or_else(|| AppError::Invalid("no demo open".into()))?;
        if let Some(port) = g.port
            && let Some(p) = ping(port)
            && (is_for(&p, &dir) || child_alive(&mut g.child))
        {
            return Ok(());
        }
        stop_child(g);
        let first = crate::record::receiver_port(&dir);
        let mut why = Vec::new();
        for port in first..first.saturating_add(PORT_RANGE) {
            if listening(port) {
                match ping(port) {
                    // This demo's receiver already (one preflight or the CLI started): use it.
                    Some(p) if is_for(&p, &dir) => {
                        g.port = Some(port);
                        return Ok(());
                    }
                    // Another demo's scenecast receiver, left running: it makes way (in a test, only its own).
                    Some(p)
                        if p["scenecast"] == "receiver"
                            && may_make_way(&p, test_fence().as_deref()) =>
                    {
                        let _ = request(port, "POST", "/quit", Duration::from_millis(1500));
                        let t = Instant::now();
                        while listening(port) && t.elapsed() < Duration::from_secs(3) {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        if listening(port) {
                            why.push(format!("{port}: another receiver won't stop"));
                            continue;
                        }
                    }
                    Some(p) if p["scenecast"] == "receiver" => {
                        why.push(format!("{port}: another receiver, not this test's"));
                        continue;
                    }
                    Some(_) => {
                        why.push(format!("{port}: an older scenecast receiver"));
                        continue;
                    }
                    None => {
                        why.push(format!("{port}: in use by another program"));
                        continue;
                    }
                }
            }
            match spawn(&dir, port) {
                Ok(child) => {
                    g.child = Some(child);
                    let t = Instant::now();
                    while t.elapsed() < Duration::from_secs(10) {
                        if ping(port).is_some() {
                            g.port = Some(port);
                            return Ok(());
                        }
                        if !child_alive(&mut g.child) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    stop_child(g);
                    why.push(format!(
                        "{port}: it didn't start (see the demo's raw/receiver.log)"
                    ));
                }
                Err(e) => {
                    why.push(format!("{port}: {e}"));
                    break;
                }
            }
        }
        Err(AppError::Invalid(format!(
            "couldn't start the receiver ({})",
            why.join("; ")
        )))
    }

    /// Captures are scanned for secrets as they arrive (a look every 3 s, on two threads, while the demo's receiver
    /// runs), so the build after Stop finds them already scanned.
    fn prescan(&self) {
        let mut scan: Option<scenecast_build::scrub::Prescan> = None;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let dir = {
                let g = self.inner.lock().expect("receiver lock");
                g.dir.clone().filter(|_| g.port.is_some())
            };
            let Some(dir) = dir else {
                scan = None;
                continue;
            };
            let Ok(raw) = scenecast_build::build::raw_dir(&dir) else {
                continue;
            };
            if !raw.is_dir() {
                continue;
            }
            if scan.as_ref().is_none_or(|s| s.root() != raw) {
                scan = Some(scenecast_build::scrub::Prescan::new(&raw));
            }
            let open = || {
                let allowlist = scenecast_build::build::scrub_allowlist(&dir).ok()?;
                let cache = scenecast_build::scrub::ScrubCache::for_demo(&dir, &allowlist)?;
                Some((allowlist, cache))
            };
            if let Some(s) = scan.as_mut() {
                s.look(open, 2);
            }
        }
    }

    /// The supervisor's round: a receiver that stopped is started again.
    fn keep_alive(&self) {
        let mut g = self.inner.lock().expect("receiver lock");
        if g.dir.is_none() {
            return;
        }
        if g.port.and_then(ping).is_some() {
            g.misses = 0;
            return;
        }
        g.misses += 1;
        let running = child_alive(&mut g.child) || g.port.is_some_and(listening);
        if running && g.misses < PATIENCE {
            return;
        }
        g.misses = 0;
        g.restarts += 1;
        g.error = self.start_locked(&mut g).err().map(|e| e.to_string());
    }

    pub fn state(&self) -> ReceiverState {
        let (dir, port, owned, pid, restarts, error) = {
            let mut g = self.inner.lock().expect("receiver lock");
            let owned = child_alive(&mut g.child);
            let pid = g.child.as_ref().map(Child::id);
            (
                g.dir.clone(),
                g.port,
                owned,
                pid,
                g.restarts,
                g.error.clone(),
            )
        };
        let p = port.and_then(ping);
        let agent = p.as_ref().map(|p| &p["agent"]);
        let secs = agent.and_then(|a| a["secsAgo"].as_u64());
        ReceiverState {
            demo: dir,
            port,
            running: p.is_some(),
            owned,
            pid: pid.or_else(|| p.as_ref().and_then(|p| p["pid"].as_u64()).map(|n| n as u32)),
            // Polling, or working on a command (a check's): either way it's there.
            connected: agent.is_some_and(|a| a["polling"] == true || a["busy"] == true)
                || secs.is_some_and(|s| s <= 25),
            recorder_secs_ago: secs,
            restarts,
            error,
        }
    }

    /// Stops the app's receiver (when the app quits).
    pub fn stop(&self) {
        let mut g = self.inner.lock().expect("receiver lock");
        stop_child(&mut g);
        g.dir = None;
        g.port = None;
    }
}

fn stop_child(g: &mut Inner) {
    if let Some(mut c) = g.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn spawn(dir: &Path, port: u16) -> Result<Child, AppError> {
    let engine = crate::engine()?;
    let mut cmd = engine.command(["receiver".as_ref(), "--demo".as_ref(), dir.as_os_str()]);
    cmd.env("REPLICA_RX_PORT", port.to_string())
        .env("SCENECAST_RX_OWNER", "app")
        .env("SCENECAST_RX_PARENT", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window for it.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
        .map_err(|e| AppError::Invalid(format!("can't run {}: {e}", engine.node.display())))
}

/// The engine, pointed at the app's receiver for this demo when there is one.
pub fn engine_for(dir: &Path) -> Result<scenecast_build::Engine, AppError> {
    let mut engine = crate::engine()?;
    if let Some(port) = host().port_for(dir) {
        engine
            .env
            .push(("REPLICA_RX_PORT".into(), port.to_string().into()));
    }
    Ok(engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_a_test_only_its_own_receivers_make_way() {
        let tmp = std::env::temp_dir().join(format!("sc-fence-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("demo")).unwrap();
        let fence = [real(&tmp)];
        let own = serde_json::json!({ "scenecast": "receiver", "demo": tmp.join("demo"), "raw": tmp.join("raw") });
        let hers = serde_json::json!({ "scenecast": "receiver", "demo": "/Users/someone/Documents/Scenecast/demo", "raw": tmp.join("raw") });
        assert!(may_make_way(&own, Some(&fence)));
        assert!(!may_make_way(&hers, Some(&fence)));
        // Outside a test, any demo's receiver makes way, as before.
        assert!(may_make_way(&hers, None));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_slow_receiver_is_not_restarted_at_once() {
        // Listening, but it doesn't answer (busy): the first checks leave it alone.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let host = ReceiverHost::default();
        {
            let mut g = host.inner.lock().unwrap();
            g.dir = Some(std::env::temp_dir());
            g.port = Some(port);
        }
        for _ in 0..2 {
            host.keep_alive();
        }
        let g = host.inner.lock().unwrap();
        assert_eq!((g.restarts, g.misses, g.port), (0, 2, Some(port)));
        drop(l);
    }

    #[test]
    fn nothing_listens_on_a_closed_port() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert!(!listening(port));
        assert!(ping(port).is_none());
    }

    #[test]
    fn reads_a_json_answer() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            // The whole request first (closing with unread bytes resets the connection on Windows).
            let (mut got, mut b) = (Vec::new(), [0u8; 512]);
            while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut b) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => got.extend_from_slice(&b[..n]),
                }
            }
            s.write_all(b"HTTP/1.0 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"demo\":\"/x\"}")
                .unwrap();
            let _ = s.shutdown(std::net::Shutdown::Write);
        });
        let p = ping(port).unwrap();
        assert_eq!(p["demo"], "/x");
    }
}
