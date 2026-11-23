//! The replica, served: for the editor (the editor in the page, each saved change reported) and for presenting (no
//! editor in the page, opened full screen in an Edge or Chrome app window, the browser the replica's fidelity was
//! checked in). One server per demo at a time: both use the demo's port.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use scenecast_build::edit::{EditOptions, EditProgress, EditServer};
use serde_json::{Map, Value};

use crate::{AppError, Update, engine};

/// The editor's server.
pub struct EditSession {
    pub server: EditServer,
}

impl EditSession {
    /// Serves the demo in edit mode and opens it (in Edge or Chrome, unless `REPLICA_NO_OPEN` is set).
    pub fn start(dir: &Path) -> Result<Self, AppError> {
        let server = scenecast_build::edit::start(
            dir,
            &EditOptions {
                port: None,
                open: true,
            },
        )?;
        Ok(Self { server })
    }

    pub fn url(&self) -> &str {
        &self.server.url
    }

    /// The saved changes as updates, for a thread that forwards them until the server stops.
    pub fn updates(&mut self) -> impl Iterator<Item = Update> + Send + 'static {
        self.server
            .take_events()
            .into_iter()
            .filter_map(|p| match p {
                EditProgress::Saved(e) if e.event == "saved" => {
                    Some(Update::Saved { data: e.data })
                }
                EditProgress::Saved(_) => None,
                EditProgress::Engine(line) => Some(Update::line(&line)),
            })
    }

    pub fn stop(&mut self) -> Result<(), AppError> {
        Ok(self.server.stop()?)
    }
}

/// The replica served for presenting.
pub struct PresentSession {
    child: Child,
    pub url: String,
    /// Whether the app window was asked to open (it's not when `REPLICA_NO_OPEN` is set: the URL is shown instead).
    pub opened: bool,
    lines: Option<Receiver<(bool, String)>>,
}

/// The line the server prints when it's up: `<title> replica: http://127.0.0.1:<port>/…`.
pub fn replica_url(line: &str) -> Option<String> {
    let at = line.find("replica: http")?;
    let url = line[at + "replica: ".len()..].split_whitespace().next()?;
    Some(url.to_owned())
}

impl PresentSession {
    /// Serves the built replica with no editor in the page, and opens it full screen as an Edge or Chrome app window.
    pub fn start(dir: &Path, fullscreen: bool) -> Result<Self, AppError> {
        Self::start_at(dir, fullscreen, None, false)
    }

    /// The same, with the stage on a given screen (the projector), and when rehearsing, each beat's time kept in
    /// `.out/rehearsal.json` (a rehearsal starts afresh).
    pub fn start_at(
        dir: &Path,
        fullscreen: bool,
        place: Option<crate::guide::Place>,
        rehearse: bool,
    ) -> Result<Self, AppError> {
        let engine = engine()?;
        let mut cmd = Command::new(&engine.node);
        cmd.envs(engine.env.iter().map(|(k, v)| (k, v)));
        cmd.arg(engine.packages.join("player").join("serve.mjs"))
            .arg("--demo")
            .arg(dir)
            .args(["--no-editor", "--open"]);
        if fullscreen {
            cmd.arg("--fullscreen");
        }
        if let Some(p) = place {
            cmd.arg("--position")
                .arg(format!("{},{}", p.x, p.y))
                .arg("--size")
                .arg(format!("{},{}", p.width, p.height));
        }
        if rehearse {
            cmd.arg("--rehearse");
        }
        let mut child = cmd
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
                    let _ = tx.send((is_err, line));
                }
            });
        }
        drop(tx);
        let mut before = Vec::new();
        let url = loop {
            match rx.recv_timeout(Duration::from_secs(60)) {
                Ok((false, line)) => match replica_url(&line) {
                    Some(url) => break url,
                    None => before.push(line),
                },
                Ok((true, line)) => before.push(line),
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::Invalid(format!(
                        "the replica didn't start{}",
                        if before.is_empty() {
                            String::new()
                        } else {
                            format!(": {}", before.join("\n"))
                        }
                    )));
                }
            }
        };
        Ok(Self {
            child,
            url,
            opened: std::env::var_os("REPLICA_NO_OPEN").is_none(),
            lines: Some(rx),
        })
    }

    /// The server's later lines, for a thread that forwards (or just drains) them.
    pub fn updates(&mut self) -> impl Iterator<Item = Update> + Send + 'static {
        self.lines
            .take()
            .unwrap_or_else(|| mpsc::channel().1)
            .into_iter()
            .map(|(error, text)| Update::Line { text, error })
    }

    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(&mut self) -> Result<(), AppError> {
        if self.running() {
            self.child.kill()?;
        }
        self.child.wait()?;
        Ok(())
    }
}

impl Drop for PresentSession {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// An editor save, in words for the app's list (`added a dot`, `changed "May 4" to "June 2" (3 places)`).
pub fn describe_saved(data: &Map<String, Value>) -> String {
    let what = data
        .get("what")
        .and_then(Value::as_str)
        .unwrap_or("a change");
    match data.get("error").and_then(Value::as_str) {
        Some(error) if !error.is_empty() => format!("{what}: not saved ({error})"),
        _ => what.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_replicas_url_in_the_servers_line() {
        assert_eq!(
            replica_url("Fixture replica: http://127.0.0.1:4699/ (release: as built)").as_deref(),
            Some("http://127.0.0.1:4699/")
        );
        assert_eq!(
            replica_url("Fixture replica: http://127.0.0.1:4699/?pace=2").as_deref(),
            Some("http://127.0.0.1:4699/?pace=2")
        );
        assert_eq!(replica_url("compiled flow"), None);
    }

    #[test]
    fn says_what_the_editor_saved() {
        let saved: Map<String, Value> =
            serde_json::from_str(r#"{"what":"added a dot","files":["focus.json"],"error":null}"#)
                .unwrap();
        assert_eq!(describe_saved(&saved), "added a dot");
        let refused: Map<String, Value> =
            serde_json::from_str(r#"{"what":"changed a date","error":"no such text"}"#).unwrap();
        assert_eq!(
            describe_saved(&refused),
            "changed a date: not saved (no such text)"
        );
    }
}
