//! Script to focus points (`scenecast script <file>`): the presenter's script (plain text, Markdown or a RunLines
//! `.sk`) matched line by line to the replica screen it plays over, using the captured text and accessibility roles;
//! the on-screen elements that back each line become focus points (`focus.json`, with a box or an arrow, the zoom
//! the focus engine fits, and the ⌥F order); then the line-to-screen sheet (HTML and PDF, with every unbacked line
//! flagged) and the presenter cue sheet, in `.out/script/`.
//!
//! The matching itself is the engine's (`packages/script`), pluggable: a deterministic text-and-roles matcher by
//! default (CI runs it with no model), or a demo's own (`--matcher <file.mjs>`, or demo.json `script.matcher`).
//! Progress comes as [`ScriptProgress`]: one event per step (parsed, each screen indexed, each line matched, each
//! focus point landed, done), so the CLI and the desktop app show the same thing.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::engine::{Engine, EngineError, Progress, with_demo};

const EVENT: &str = "@script ";

#[derive(Debug, Clone)]
pub struct ScriptOptions {
    /// The script: `.md`, `.txt` or `.sk`.
    pub file: PathBuf,
    /// A replica already served for authoring (default: one is started for the run).
    pub url: Option<String>,
    /// `text` (the default), or a module of the demo's own.
    pub matcher: Option<String>,
    /// Write `focus.json` (false: the sheets only).
    pub write: bool,
    /// The sheet as PDF too.
    pub pdf: bool,
}

impl ScriptOptions {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self {
            file: file.into(),
            url: None,
            matcher: None,
            write: true,
            pdf: true,
        }
    }
}

/// One machine-readable line from the engine: `event` (`parsed`, `indexed`, `matched`, `landed`, `done`, `error`)
/// and its fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptEvent {
    pub event: String,
    #[serde(flatten)]
    pub data: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub enum ScriptProgress {
    Event(ScriptEvent),
    /// Any other line of the engine's output.
    Engine(Progress),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LineStatus {
    /// What the line says is on its screen.
    Backed,
    /// Something backs it, but facts it states (numbers, names) aren't on the screen, or a point didn't land.
    Partial,
    /// Nothing on its screen backs it (flagged on the sheet).
    Unbacked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineResult {
    /// `<beat>.<n>`, or `<n>` in a script without beats.
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub cue: String,
    pub app: String,
    /// The screen (scene) it plays over.
    pub state: String,
    pub status: LineStatus,
    #[serde(default)]
    pub missing: Vec<String>,
    /// Its focus points' ids, in ⌥F order.
    #[serde(default)]
    pub points: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScriptSummary {
    pub lines: usize,
    pub backed: usize,
    pub partial: usize,
    pub unbacked: usize,
    pub points: usize,
}

/// `.out/script/script.json`, as the engine writes it (the parts a caller needs; the file has the rest: each point
/// with its target, mark and landing).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptReport {
    pub script: String,
    pub matcher: String,
    pub lines: Vec<LineResult>,
    pub summary: ScriptSummary,
    #[serde(default)]
    pub points: Vec<Value>,
}

impl ScriptReport {
    pub fn unbacked(&self) -> impl Iterator<Item = &LineResult> {
        self.lines
            .iter()
            .filter(|l| l.status == LineStatus::Unbacked)
    }
}

#[derive(Debug, Clone)]
pub struct ScriptOutcome {
    pub report: ScriptReport,
    pub report_json: PathBuf,
    pub sheet_html: PathBuf,
    pub sheet_pdf: Option<PathBuf>,
    pub cues: PathBuf,
    /// Where the focus points went (None with `write: false`).
    pub focus_json: Option<PathBuf>,
}

#[derive(Debug, Error)]
pub enum ScriptError {
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{file}: {source}")]
    Json {
        file: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("no script at {0}")]
    NoScript(PathBuf),
    #[error("scenecast script failed (exit code {code}): {message}")]
    Failed { code: i32, message: String },
}

/// The engine's line, if it's one of its events.
pub fn parse_event(line: &str) -> Option<ScriptEvent> {
    serde_json::from_str(line.strip_prefix(EVENT)?).ok()
}

/// Runs script to focus on a project folder. See the module docs.
pub fn run(
    dir: &Path,
    opts: &ScriptOptions,
    mut on: impl FnMut(ScriptProgress),
) -> Result<ScriptOutcome, ScriptError> {
    let dir = crate::engine::dunce(fs::canonicalize(dir)?);
    let file = fs::canonicalize(&opts.file)
        .or_else(|_| fs::canonicalize(dir.join(&opts.file)))
        .map_err(|_| ScriptError::NoScript(opts.file.clone()))?;
    let file = crate::engine::dunce(file);
    let engine = Engine::locate()?;
    let mut args: Vec<OsString> = vec![file.into_os_string()];
    if let Some(url) = &opts.url {
        args.extend(["--url".into(), url.into()]);
    }
    if let Some(m) = &opts.matcher {
        args.extend(["--matcher".into(), m.into()]);
    }
    if !opts.write {
        args.push("--no-write".into());
    }
    if !opts.pdf {
        args.push("--no-pdf".into());
    }
    let mut failure = None;
    let code = engine.run_with_progress(with_demo("script", &args, &dir), |p| match &p {
        Progress::Stdout(line) => match parse_event(line) {
            Some(event) => {
                if event.event == "error" {
                    failure = event
                        .data
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                on(ScriptProgress::Event(event))
            }
            None => on(ScriptProgress::Engine(p)),
        },
        Progress::Stderr(_) => on(ScriptProgress::Engine(p)),
    })?;
    if code != 0 {
        return Err(ScriptError::Failed {
            code,
            message: failure.unwrap_or_else(|| "see its output".into()),
        });
    }
    let out = dir.join(".out").join("script");
    let report_json = out.join("script.json");
    let bytes = fs::read(&report_json)?;
    let report: ScriptReport =
        serde_json::from_slice(&bytes).map_err(|source| ScriptError::Json {
            file: report_json.clone(),
            source,
        })?;
    let pdf = out.join("sheet.pdf");
    Ok(ScriptOutcome {
        report,
        report_json,
        sheet_html: out.join("sheet.html"),
        sheet_pdf: (opts.pdf && pdf.is_file()).then_some(pdf),
        cues: out.join("cues.md"),
        focus_json: opts.write.then(|| dir.join("focus.json")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_engine_events_and_leaves_other_lines() {
        let e = parse_event(r#"@script {"event":"matched","line":"2.1","state":"chat-03","status":"unbacked","points":0}"#).unwrap();
        assert_eq!(e.event, "matched");
        assert_eq!(e.data["status"], "unbacked");
        assert!(parse_event("@fidelity {}").is_none());
        assert!(parse_event("@script nope").is_none());
    }

    #[test]
    fn reads_the_engines_report() {
        let report: ScriptReport = serde_json::from_value(serde_json::json!({
            "at": "2026-11-17T00:00:00Z", "script": "script.md", "title": "Demo", "matcher": "text", "beats": [],
            "lines": [
                { "id": "1.1", "beat": 1, "index": 0, "text": "Hi everyone.", "cue": "", "app": "chat", "state": "chat-start", "pos": 0,
                  "beatKey": 0, "status": "unbacked", "score": 0, "missing": [], "problems": [], "points": [], "backing": [], "shot": "shots/line-1-1.png" },
                { "id": "1.2", "beat": 1, "index": 1, "text": "It costs $5.", "cue": "", "app": "chat", "state": "chat-01", "pos": 2,
                  "beatKey": 1, "status": "backed", "score": 9.1, "missing": [], "problems": [], "points": ["l1-2-cost"], "backing": ["$5"], "shot": "x" }
            ],
            "points": [{ "id": "l1-2-cost", "beat": 1, "find": "$5", "landing": { "Z": 2 } }], "kept": [],
            "summary": { "lines": 2, "backed": 1, "partial": 0, "unbacked": 1, "points": 1 }, "errors": [], "secs": 3.2
        }))
        .unwrap();
        assert_eq!(report.summary.unbacked, 1);
        assert_eq!(
            report.unbacked().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            ["1.1"]
        );
        assert_eq!(report.lines[1].points, ["l1-2-cost"]);
    }
}
