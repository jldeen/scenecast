//! The editor (`scenecast edit`): the replica served for authoring and opened in edit mode, where people adjust
//! what the script matcher worked out: focus-point dots (click to drop one; drag, delete, reorder), wording and date
//! overrides (applied everywhere the text appears), and which screen each beat starts on. Every change shows at once
//! in the replica and is saved by the server to the demo's `focus.json` and `flow.editor.json` (no build).
//!
//! [`start`] runs the server and returns once it's ready, with its URL; the server's events (each saved change)
//! then come as [`EditProgress`] from [`EditServer::events`] until it stops. For the CLI and the desktop app alike.

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::engine::{Engine, EngineError, Progress, with_demo};

const EVENT: &str = "@edit ";

#[derive(Debug, Clone, Default)]
pub struct EditOptions {
    /// The port (default: the demo's own).
    pub port: Option<u16>,
    /// Open it as an app window (Chrome on the Mac, Edge on Windows).
    pub open: bool,
}

/// One machine-readable line from the server: `ready` (with `url`) or `saved` (`what`, `files`, `error`,
/// `pendingEdits`, `needsBuild`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditEvent {
    pub event: String,
    #[serde(flatten)]
    pub data: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub enum EditProgress {
    /// A change was saved (or refused: `error`).
    Saved(EditEvent),
    /// Any other server line.
    Engine(Progress),
}

#[derive(Debug, Error)]
pub enum EditError {
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("the replica server stopped before it was ready{0}")]
    NotReady(String),
}

pub fn parse_event(line: &str) -> Option<EditEvent> {
    serde_json::from_str(line.strip_prefix(EVENT)?).ok()
}

/// The running server.
pub struct EditServer {
    child: Child,
    /// The replica in edit mode (`…/?edit=1`).
    pub url: String,
    events: Receiver<EditProgress>,
}

impl EditServer {
    /// The server's events, until it stops.
    pub fn events(&self) -> impl Iterator<Item = EditProgress> + '_ {
        self.events.iter()
    }
    /// The server's events as a channel of their own (for a thread that forwards them); `events()` is empty after.
    pub fn take_events(&mut self) -> Receiver<EditProgress> {
        std::mem::replace(&mut self.events, mpsc::channel().1)
    }
    pub fn stop(&mut self) -> std::io::Result<()> {
        self.child.kill()?;
        self.child.wait().map(|_| ())
    }
    /// Waits for the server to stop; its exit code.
    pub fn wait(&mut self) -> std::io::Result<i32> {
        Ok(self.child.wait()?.code().unwrap_or(1))
    }
}

impl Drop for EditServer {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Starts the editor's server on a project folder and returns when it's ready.
pub fn start(dir: &Path, opts: &EditOptions) -> Result<EditServer, EditError> {
    let engine = Engine::locate()?;
    engine.check_node()?;
    let mut args: Vec<OsString> = Vec::new();
    if let Some(port) = opts.port {
        args.extend(["--port".into(), port.to_string().into()]);
    }
    if !opts.open {
        args.push("--no-open".into());
    }
    let dir = crate::engine::dunce(dir.to_path_buf());
    let mut child = engine
        .command(with_demo("edit", &args, &dir))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    for (pipe, is_err) in [
        child
            .stdout
            .take()
            .map(|s| (Box::new(s) as Box<dyn std::io::Read + Send>, false)),
        child
            .stderr
            .take()
            .map(|s| (Box::new(s) as Box<dyn std::io::Read + Send>, true)),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if tx.send((is_err, line)).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let mut before = Vec::new();
    let url = loop {
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok((false, line)) => match parse_event(&line) {
                Some(e) if e.event == "ready" => {
                    break e
                        .data
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                }
                _ => before.push(line),
            },
            Ok((true, line)) => before.push(line),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                let tail = before.join("\n");
                return Err(EditError::NotReady(if tail.is_empty() {
                    String::new()
                } else {
                    format!(": {tail}")
                }));
            }
        }
    };
    let (etx, events) = mpsc::channel();
    thread::spawn(move || {
        for (is_err, line) in rx {
            let p = match parse_event(&line) {
                Some(e) if !is_err => EditProgress::Saved(e),
                _ if is_err => EditProgress::Engine(Progress::Stderr(line)),
                _ => EditProgress::Engine(Progress::Stdout(line)),
            };
            if etx.send(p).is_err() {
                break;
            }
        }
    });
    Ok(EditServer { child, url, events })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_servers_events() {
        let e = parse_event(
            r#"@edit {"event":"saved","what":"added a dot","files":["focus.json"],"error":null}"#,
        )
        .unwrap();
        assert_eq!(e.event, "saved");
        assert_eq!(e.data["files"][0], "focus.json");
        assert!(parse_event("replica: http://127.0.0.1:4620/").is_none());
    }
}
