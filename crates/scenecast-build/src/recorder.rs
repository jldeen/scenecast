//! The recorder, as a library: what the desktop app calls to get a presenter ready and record, with structured
//! results instead of printed text. It drives the engine (`packages/recorder`): the recorder extension for Edge and
//! Chrome, the local receiver it posts captures to, and the recording itself.
//!
//! - [`preflight`]: is everything ready? Each item (receiver, browser and profile, recorder, each app's tab) as it
//!   lands; only what fails is fixed, and a running browser is never relaunched.
//! - [`build_extension`]: the unpacked extension folder to load once in Edge or Chrome.
//! - [`record_start`], [`record_status`], [`record_stop`]: the recording, with the recorder's own time reported
//!   apart from the product's ([`RecordTiming`]).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::engine::{Engine, EngineError, Progress, with_demo};

#[derive(Debug, Error)]
pub enum RecorderError {
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error("the engine's `{command}` failed (exit {code}): {output}")]
    Failed {
        command: String,
        code: i32,
        output: String,
    },
    #[error("the engine's `{command}` answered something that isn't JSON: {output}")]
    BadOutput { command: String, output: String },
    /// The recorder answered with an error (`{"error": …}`): never read as an empty result.
    #[error("{0}")]
    Recorder(String),
}

/// How one preflight item came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemStatus {
    /// Already as it should be: nothing done.
    Ok,
    /// It wasn't, and preflight put it right.
    Fixed,
    /// It isn't, and the presenter has to act (`detail` says what).
    Fail,
    /// Not checked (it needs an earlier item).
    Skip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreflightItem {
    /// `receiver`, `browser`, `recorder`, or `app <id>`.
    pub id: String,
    pub status: ItemStatus,
    pub detail: String,
    pub ms: u64,
    /// What else the item says, kept as it is: the open tabs for an app it couldn't find (`missing`, `tabs`), a
    /// sign-in page an app landed on (`signIn`), the profile, the recorder's version.
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreflightReport {
    pub ready: bool,
    pub secs: f64,
    pub items: Vec<PreflightItem>,
}

/// Where a recording's time went, in seconds: the recorder's own work apart from the product's (its answers).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordTiming {
    /// Side states swept, screens captured, and making sure each action was done.
    pub recorder_secs: f64,
    /// The product working: from each action to its last change (an answer streaming in).
    pub product_secs: f64,
    pub sweep_secs: f64,
    pub capture_secs: f64,
    pub confirm_secs: f64,
}

/// `record status`: what the recorder is doing now.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordStatus {
    pub recording: bool,
    /// Capturing side states or a screen: the presenter waits for this to be false before the next step.
    pub busy: bool,
    /// The side path running now (`hovers on chat-start`).
    pub side: Option<String>,
    /// Screens captured so far.
    pub count: u32,
    pub streams: u32,
    pub actions: u32,
    pub active: Option<String>,
    pub timing: Option<RecordTiming>,
    /// Set when the recording was picked up from its checkpoint (the extension restarted mid-recording).
    pub resumed: Option<serde_json::Value>,
    /// The last few lines of the recorder's log.
    pub log: Vec<String>,
    /// Paused: nothing the presenter does is recorded until `record go-on`.
    pub held: Option<RecordHeld>,
    /// Clicks held back because they came while a screen was being captured (each needs doing again).
    pub blocked: u32,
    /// Seconds since the recording started.
    pub chrome_secs: Option<u64>,
}

/// Why a recording is paused, and for how long.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordHeld {
    /// `you` (Pause) or `bar` (the browser's "debugging" bar was closed).
    pub why: String,
    pub secs: u64,
}

/// `record stop`: the recording, written to the raw folder (`recording.json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordSummary {
    pub states: u32,
    pub streams: u32,
    pub beats: u32,
    pub steps: u32,
    pub secs: u64,
    pub timing: Option<RecordTiming>,
    /// Things to check (a control that changed nothing, a screen left changed by a side path).
    pub notes: Vec<String>,
    /// One line per screen: its side states and how long they took.
    pub autos: Vec<String>,
}

/// The engine's JSON answer: the text from its first `{` on (it may print a line before it).
pub fn parse_json<T: for<'de> Deserialize<'de>>(
    command: &str,
    out: &str,
) -> Result<T, RecorderError> {
    let bad = || RecorderError::BadOutput {
        command: command.to_string(),
        output: out.chars().take(400).collect(),
    };
    let start = out.find('{').ok_or_else(bad)?;
    let value: serde_json::Value = serde_json::from_str(&out[start..]).map_err(|_| bad())?;
    // An error is an error, whatever the answer's type would make of it (a summary's fields all default to 0).
    if let Some(e) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(RecorderError::Recorder(e.to_owned()));
    }
    serde_json::from_value(value).map_err(|_| bad())
}

fn run(engine: &Engine, args: Vec<OsString>, command: &str) -> Result<String, RecorderError> {
    let mut out = String::new();
    let code = engine.run_with_progress(args, |p| {
        if let Progress::Stdout(line) = p {
            out.push_str(&line);
            out.push('\n');
        }
    })?;
    if code != 0 && !out.contains('{') {
        return Err(RecorderError::Failed {
            command: command.to_string(),
            code,
            output: out,
        });
    }
    Ok(out)
}

/// Runs preflight on a project; `on_item` gets each item as it lands. With `fix`, what fails is put right where it
/// can be (a receiver started, a missing tab opened); a running browser is never relaunched.
pub fn preflight(
    engine: &Engine,
    dir: &Path,
    fix: bool,
    mut on_item: impl FnMut(&PreflightItem),
) -> Result<PreflightReport, RecorderError> {
    let mut rest: Vec<OsString> = vec!["--ndjson".into()];
    if !fix {
        rest.push("--check".into());
    }
    let mut result = None;
    let mut other = String::new();
    engine.run_with_progress(with_demo("preflight", &rest, dir), |p| {
        let Progress::Stdout(line) = p else { return };
        #[derive(Deserialize)]
        struct Line {
            item: Option<PreflightItem>,
            result: Option<PreflightReport>,
        }
        match serde_json::from_str::<Line>(&line) {
            Ok(Line { item: Some(i), .. }) => on_item(&i),
            Ok(Line {
                result: Some(r), ..
            }) => result = Some(r),
            _ => {
                other.push_str(&line);
                other.push('\n');
            }
        }
    })?;
    result.ok_or(RecorderError::BadOutput {
        command: "preflight".into(),
        output: other,
    })
}

/// Builds the recorder extension into `out` (load it once: edge://extensions or chrome://extensions → Developer
/// mode → Load unpacked). Returns the folder.
pub fn build_extension(engine: &Engine, out: &Path, port: u16) -> Result<PathBuf, RecorderError> {
    let args: Vec<OsString> = vec![
        "extension".into(),
        out.as_os_str().to_owned(),
        "--port".into(),
        port.to_string().into(),
    ];
    let code = engine.run_with_progress(args, |_| {})?;
    if code != 0 || !out.join("manifest.json").is_file() {
        return Err(RecorderError::Failed {
            command: "extension".into(),
            code,
            output: String::new(),
        });
    }
    Ok(out.to_path_buf())
}

/// Starts recording (`resume`: from the receiver's checkpoint). The receiver must be up and the recorder connected
/// (run [`preflight`] first).
pub fn record_start(
    engine: &Engine,
    dir: &Path,
    resume: bool,
) -> Result<serde_json::Value, RecorderError> {
    record_start_checked(engine, dir, resume, false)
}

/// Starts recording. Unless `checked` (the caller ran the same check just now), `record start` runs the readiness
/// check with its fixes first, and answers `{ error: "not ready to record: …", items }` when it isn't.
pub fn record_start_checked(
    engine: &Engine,
    dir: &Path,
    resume: bool,
    checked: bool,
) -> Result<serde_json::Value, RecorderError> {
    let mut rest: Vec<OsString> = vec!["start".into()];
    if resume {
        rest.push("--resume".into());
    }
    if checked {
        rest.push("--no-check".into());
    }
    parse_json(
        "record start",
        &run(engine, with_demo("record", &rest, dir), "record start")?,
    )
}

pub fn record_status(engine: &Engine, dir: &Path) -> Result<RecordStatus, RecorderError> {
    let out = run(
        engine,
        with_demo("record", &["status".into()], dir),
        "record status",
    )?;
    parse_json("record status", &out)
}

/// `record pause`: nothing the presenter does is recorded until [`record_go_on`].
pub fn record_pause(engine: &Engine, dir: &Path) -> Result<serde_json::Value, RecorderError> {
    let out = run(
        engine,
        with_demo("record", &["pause".into()], dir),
        "record pause",
    )?;
    parse_json("record pause", &out)
}

/// `record go-on`: picks up where it was paused. A tab that isn't on the screen it was paused on comes back in `off`
/// (and it stays paused) unless `anyway`.
pub fn record_go_on(
    engine: &Engine,
    dir: &Path,
    anyway: bool,
) -> Result<serde_json::Value, RecorderError> {
    let mut rest: Vec<OsString> = vec!["go-on".into()];
    if anyway {
        rest.push("--anyway".into());
    }
    let out = run(engine, with_demo("record", &rest, dir), "record go-on")?;
    parse_json("record go-on", &out)
}

pub fn record_stop(engine: &Engine, dir: &Path) -> Result<RecordSummary, RecorderError> {
    let out = run(
        engine,
        with_demo("record", &["stop".into()], dir),
        "record stop",
    )?;
    parse_json("record stop", &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preflight_item_keeps_what_else_it_says() {
        let i: PreflightItem = serde_json::from_str(
            r#"{"id":"app admin","status":"fail","detail":"no tab for admin","ms":3,"missing":true,"tabs":[{"title":"Home","url":"https://admin.cloud.microsoft/","host":"admin.cloud.microsoft"}]}"#,
        )
        .unwrap();
        assert_eq!(i.status, ItemStatus::Fail);
        assert_eq!(i.extra["tabs"][0]["host"], "admin.cloud.microsoft");
        let back = serde_json::to_value(&i).unwrap();
        assert_eq!(back["missing"], true);
    }

    #[test]
    fn reads_status_with_the_recorder_and_product_time_apart() {
        let out = r#"{
 "recording": true, "busy": false, "count": 6, "streams": 1, "actions": 11, "active": "chat",
 "timing": { "recorderSecs": 48.2, "productSecs": 4.1, "sweepSecs": 40, "captureSecs": 1.2, "confirmSecs": 7 },
 "resumed": { "states": 6 }, "log": ["193.7s resumed: 6 screens, 6 steps"], "chromeSecs": 202,
 "held": { "why": "bar", "secs": 4 }, "blocked": 2 }"#;
        let s: RecordStatus = parse_json("record status", out).unwrap();
        assert!(s.recording && !s.busy);
        assert_eq!(s.count, 6);
        // Paused because the browser's debugging bar was closed; two clicks came too early.
        assert_eq!(s.held.as_ref().map(|h| h.why.as_str()), Some("bar"));
        assert_eq!((s.blocked, s.chrome_secs), (2, Some(202)));
        let t = s.timing.unwrap();
        assert_eq!((t.recorder_secs, t.product_secs), (48.2, 4.1));
        assert!(s.resumed.is_some());
    }

    #[test]
    fn reads_a_preflight_report() {
        let out = r#"{"ready":false,"secs":0.7,"items":[{"id":"receiver","status":"ok","detail":"up","ms":3},{"id":"app chat","status":"fixed","detail":"opened","ms":900},{"id":"recorder","status":"fail","detail":"load it","ms":20}]}"#;
        let r: PreflightReport = parse_json("preflight", out).unwrap();
        assert!(!r.ready);
        assert_eq!(
            r.items.iter().map(|i| i.status).collect::<Vec<_>>(),
            [ItemStatus::Ok, ItemStatus::Fixed, ItemStatus::Fail]
        );
    }

    #[test]
    fn an_error_answer_is_an_error_not_an_empty_recording() {
        let e = parse_json::<RecordSummary>("record stop", r#"{ "error": "not recording" }"#)
            .unwrap_err();
        assert!(
            matches!(e, RecorderError::Recorder(ref m) if m == "not recording"),
            "{e}"
        );
        assert!(
            parse_json::<RecordStatus>("record status", r#"{"error":"timeout waiting for c1"}"#)
                .is_err()
        );
    }

    #[test]
    fn says_what_the_engine_answered_when_it_isnt_json() {
        let e = parse_json::<RecordStatus>("record status", "receiver not running").unwrap_err();
        assert!(e.to_string().contains("receiver not running"));
    }
}
