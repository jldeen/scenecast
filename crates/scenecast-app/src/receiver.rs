//! The receiver, kept running by the app: the local endpoint the recorder extension posts captures to. The app starts
//! it (with its own Node) for the demo that's open, on the demo's port or the next free one (the extension looks
//! there too), starts it again if it stops, and stops it when the app quits. One receiver at a time: a receiver is
//! one demo's (it writes that demo's captures).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::{AppError, engine, record};

/// How many ports past the demo's the app (and the extension) look at.
pub const PORT_SPAN: u16 = 10;

/// What the Record step shows about the receiver.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverState {
    /// The demo it's receiving for.
    pub demo: Option<String>,
    pub port: Option<u16>,
    /// Answering on its port.
    pub up: bool,
    /// The recorder extension is polling it.
    pub connected: bool,
    pub pid: Option<u32>,
    /// Started by the app (not one that was already running).
    pub owned: bool,
    pub restarts: u32,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    demo: Option<String>,
    dir: Option<PathBuf>,
    port: Option<u16>,
    child: Option<Child>,
    pid: Option<u32>,
    restarts: u32,
    last_start: Option<Instant>,
    error: Option<String>,
}

#[derive(Default)]
pub struct Receiver {
    inner: Mutex<Inner>,
}

/// The receiver's `/ping` on a port: `None` when nothing answers as one.
pub fn ping(port: u16, timeout: Duration) -> Option<Value> {
    let body = http(port, "GET", "/ping", timeout)?;
    let v: Value = serde_json::from_str(&body).ok()?;
    (v["app"] == "scenecast-receiver" || v.get("raw").is_some()).then_some(v)
}

/// Whether anything at all listens on the port.
pub fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&addr(port), Duration::from_millis(300)).is_ok()
}

/// The recorder (extension or agent) asked for work in the last 30 s, or is waiting for some now.
pub fn connected(ping: &Value) -> bool {
    let a = &ping["agent"];
    a["polling"].as_bool().unwrap_or(false) || a["secsAgo"].as_u64().is_some_and(|s| s < 30)
}

fn addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

fn http(port: u16, method: &str, path: &str, timeout: Duration) -> Option<String> {
    let mut s = TcpStream::connect_timeout(&addr(port), timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(
        s,
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\n\r\n"
    )
    .ok()?;
    let mut out = Vec::new();
    s.read_to_end(&mut out).ok()?;
    let text = String::from_utf8_lossy(&out);
    let (head, body) = text.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.").then(|| body.to_owned())
}

fn same_dir(a: &Path, b: &str) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(Path::new(b))
}

/// A port for this demo's receiver, starting at `base`: one where this demo's receiver already runs (`Ok(Some)`), or
/// a free one. A scenecast receiver for another demo (left over) is asked to stop and its port taken.
fn choose_port(base: u16, dir: &Path) -> Result<(u16, Option<Value>), AppError> {
    for port in base..base.saturating_add(PORT_SPAN) {
        match ping(port, Duration::from_millis(1500)) {
            Some(p) if p["demo"].as_str().is_some_and(|d| same_dir(dir, d)) => {
                return Ok((port, Some(p)));
            }
            Some(p) if p["app"] == "scenecast-receiver" => {
                let _ = http(port, "POST", "/shutdown", Duration::from_secs(2));
                let t = Instant::now();
                while listening(port) && t.elapsed() < Duration::from_secs(3) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !listening(port) {
                    return Ok((port, None));
                }
            }
            Some(_) => {}
            None if !listening(port) => return Ok((port, None)),
            None => {}
        }
    }
    Err(AppError::Invalid(format!(
        "ports {base}–{} are all taken by other programs: close one, or set another receiverPort in demo.json",
        base + PORT_SPAN - 1
    )))
}

impl Receiver {
    /// The receiver for this demo, running: started (or found already running) and answering. Stops the one for
    /// another demo first.
    pub fn ensure(&self, demo: &str, dir: &Path) -> Result<ReceiverState, AppError> {
        let mut g = self.inner.lock().expect("receiver lock");
        if g.demo.as_deref() == Some(demo)
            && let Some(port) = g.port
            && alive(&mut g)
            && ping(port, Duration::from_millis(1500)).is_some()
        {
            drop(g);
            return Ok(self.state());
        }
        if g.demo.as_deref() != Some(demo) {
            g.restarts = 0;
        }
        stop_child(&mut g);
        g.demo = Some(demo.to_owned());
        g.dir = Some(dir.to_path_buf());
        let r = start(&mut g, dir);
        g.error = r.as_ref().err().map(|e| e.to_string());
        drop(g);
        r.map(|_| self.state())
    }

    /// The watchdog's turn: starts the receiver again if it stopped (at most once every few seconds), and says how
    /// it is.
    pub fn tick(&self) -> ReceiverState {
        let mut g = self.inner.lock().expect("receiver lock");
        if let (Some(dir), Some(port)) = (g.dir.clone(), g.port) {
            let dead = !alive(&mut g)
                || (g.child.is_none() && ping(port, Duration::from_secs(3)).is_none());
            let waited = g
                .last_start
                .is_none_or(|t| t.elapsed() > Duration::from_secs(3));
            if dead && waited {
                stop_child(&mut g);
                g.restarts += 1;
                let r = start(&mut g, &dir);
                g.error = r.err().map(|e| e.to_string());
            }
        }
        drop(g);
        self.state()
    }

    pub fn state(&self) -> ReceiverState {
        let (demo, port, pid, owned, restarts, error) = {
            let g = self.inner.lock().expect("receiver lock");
            (
                g.demo.clone(),
                g.port,
                g.pid,
                g.child.is_some(),
                g.restarts,
                g.error.clone(),
            )
        };
        let p = port.and_then(|port| ping(port, Duration::from_millis(1500)));
        ReceiverState {
            demo,
            port,
            up: p.is_some(),
            connected: p.as_ref().is_some_and(connected),
            pid,
            owned,
            restarts,
            error,
        }
    }

    /// Stops the receiver the app started (the app is quitting).
    pub fn stop(&self) {
        let mut g = self.inner.lock().expect("receiver lock");
        stop_child(&mut g);
        g.demo = None;
        g.dir = None;
        g.port = None;
        record::set_receiver_port(None);
    }
}

fn alive(g: &mut Inner) -> bool {
    match g.child.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => g.port.is_some(),
    }
}

fn stop_child(g: &mut Inner) {
    if let Some(mut c) = g.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    g.pid = None;
}

fn start(g: &mut Inner, dir: &Path) -> Result<(), AppError> {
    g.last_start = Some(Instant::now());
    let (port, running) = choose_port(record::configured_port(dir), dir)?;
    g.port = Some(port);
    record::set_receiver_port(Some(port));
    if let Some(p) = running {
        g.pid = p["pid"].as_u64().map(|p| p as u32);
        return Ok(());
    }
    let engine = engine()?;
    let mut cmd = std::process::Command::new(&engine.node);
    cmd.arg(engine.packages.join("recorder").join("receiver.mjs"))
        .arg("--demo")
        .arg(dir)
        .env("REPLICA_RX_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|e| AppError::Invalid(format!("couldn't start the receiver: {e}")))?;
    g.pid = Some(child.id());
    g.child = Some(child);
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(10) {
        if ping(port, Duration::from_millis(500)).is_some() {
            return Ok(());
        }
        if !alive(g) {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    stop_child(g);
    Err(AppError::Invalid(format!(
        "the receiver didn't start on port {port} (its log: the demo's raw folder, receiver.log)"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_port_taken_by_something_else_is_skipped() {
        let held = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        // Something that isn't a receiver: never a receiver, and its port isn't free.
        assert!(listening(port));
        assert!(ping(port, Duration::from_millis(300)).is_none());
        let tmp = tempfile::tempdir().unwrap();
        let (got, running) = choose_port(port, tmp.path()).unwrap();
        assert!(got > port && got < port + PORT_SPAN, "{got}");
        assert!(running.is_none());
    }

    #[test]
    fn the_receiver_is_started_kept_running_and_stopped() {
        if engine().is_err() {
            return; // no Node here
        }
        let tmp = tempfile::tempdir().unwrap();
        let lib = crate::library::Library::new(tmp.path());
        let demo = lib
            .create(&crate::library::NewDemo {
                title: "Rx".into(),
                apps: vec![crate::library::NewApp {
                    id: "chat".into(),
                    url: "https://chat.example.com/".into(),
                }],
                browser: None,
            })
            .unwrap();
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let file = demo.dir.join("demo.json");
        let mut cfg: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        cfg["receiverPort"] = free.into();
        cfg["raw"] = tmp.path().join("raw").display().to_string().into();
        std::fs::write(&file, cfg.to_string()).unwrap();
        if std::env::var_os("REPLICA_RX_PORT").is_some() {
            return;
        }
        let rx = Receiver::default();
        let st = rx.ensure(&demo.id, &demo.dir).unwrap();
        assert!(st.up && st.owned, "{st:?}");
        let port = st.port.unwrap();
        assert!((free..free + PORT_SPAN).contains(&port));
        assert_eq!(record::receiver_port_override(), Some(port));
        // Asked again: the same one, not a second.
        assert_eq!(rx.ensure(&demo.id, &demo.dir).unwrap().pid, st.pid);
        // It stops: the watchdog starts it again.
        {
            let mut g = rx.inner.lock().unwrap();
            let c = g.child.as_mut().unwrap();
            c.kill().unwrap();
            c.wait().unwrap();
            g.last_start = None;
        }
        let again = rx.tick();
        assert!(
            again.up && again.restarts == 1 && again.pid != st.pid,
            "{again:?}"
        );
        rx.stop();
        assert!(!listening(port));
        assert_eq!(record::receiver_port_override(), None);
    }

    #[test]
    fn connected_means_the_recorder_asked_lately() {
        assert!(connected(
            &serde_json::json!({ "agent": { "polling": true, "secsAgo": null } })
        ));
        assert!(connected(
            &serde_json::json!({ "agent": { "polling": false, "secsAgo": 5 } })
        ));
        assert!(!connected(
            &serde_json::json!({ "agent": { "polling": false, "secsAgo": 90 } })
        ));
        assert!(!connected(
            &serde_json::json!({ "agent": { "polling": false, "secsAgo": null } })
        ));
    }
}
