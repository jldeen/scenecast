//! The fidelity loop (`scenecast fidelity`): every captured state of the real product compared with the replica, each
//! difference diagnosed and fixed with a per-demo patch, and checked again, until every state is within the threshold
//! or the round limit is reached. Then a residual report for the presenter (`.out/fidelity/report.html` and `.json`).
//!
//! One round: the engine's comparison (`fidelity-compare`: every state at 100%, each zoom capture at its zoom, each
//! click side state, and fonts by file hash), then, for what's over the threshold, the fixer (`fidelity-fix`: pluggable
//! diagnosers, rule-based by default, that write `flow.fixes.json`), then the build. The loop never writes a fallback
//! scene: it fails if the manifest has more of them at the end than at the start.
//!
//! Progress comes as [`FidelityProgress`]: rounds, the engine's events (each state compared, each diagnosis), and the
//! build's own progress, so the CLI and the desktop app show the same thing.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::build::{BuildError, BuildProgress, build};
use crate::engine::{Engine, EngineError, Progress, with_demo};
use crate::sync::{SyncError, fallback_scenes};

/// The prefix of the engine's machine-readable lines.
const EVENT: &str = "@fidelity ";

#[derive(Debug, Clone)]
pub struct FidelityOptions {
    /// Fix rounds at most (each: diagnose, patch, build, compare again).
    pub rounds: u32,
    /// Share of pixels (percent) a state may differ by.
    pub threshold: f64,
    /// Diagnose and patch (false: compare and report only).
    pub fix: bool,
    /// The replica's URL (default: the demo's own server, started if it isn't up).
    pub url: Option<String>,
}

impl Default for FidelityOptions {
    fn default() -> Self {
        Self {
            rounds: 3,
            threshold: 0.5,
            fix: true,
            url: None,
        }
    }
}

/// One machine-readable line from the engine: `event` (`compare-start`, `compared`, `compare-done`, `fix-start`,
/// `diagnosed`, `fix-done`, `report`) and its fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FidelityEvent {
    pub event: String,
    #[serde(flatten)]
    pub data: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub enum FidelityProgress {
    /// A round starts (1-based): its comparison comes next.
    Round(u32),
    /// What the engine reports as it goes.
    Event(FidelityEvent),
    /// The fixes of this round are being built.
    Building(u32),
    Build(BuildProgress),
    /// Any other line of the engine's output.
    Engine(Progress),
}

/// Why the loop stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stop {
    /// Every state within the threshold, every font the real file.
    Within,
    /// Asked to compare only.
    CompareOnly,
    /// Differences left that no diagnoser could patch (they're in the report, with what was found).
    NothingToPatch,
    /// The round limit.
    RoundLimit,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Worst {
    pub id: String,
    pub pct: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RoundSummary {
    pub round: u32,
    pub pass: bool,
    pub worst: Option<Worst>,
    #[serde(default)]
    pub over: Vec<String>,
    #[serde(default)]
    pub fonts: Vec<String>,
    #[serde(default)]
    pub added: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ItemResult {
    pub id: String,
    pub kind: String,
    pub z: u32,
    pub pass: bool,
    pub pct: Option<f64>,
    #[serde(rename = "firstPct")]
    pub first_pct: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FontResult {
    pub family: String,
    #[serde(default)]
    pub name: Option<String>,
    pub weight: String,
    pub style: String,
    pub status: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FixResult {
    pub kind: String,
    pub cause: Option<String>,
    pub finding: Option<String>,
    pub round: Option<u32>,
    pub why: Option<String>,
}

/// `.out/fidelity/report.json`, as the engine writes it (the parts a caller needs; the file has the rest).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FidelityReport {
    pub pass: bool,
    pub threshold: f64,
    pub rounds: Vec<RoundSummary>,
    pub items: Vec<ItemResult>,
    pub fonts: Vec<FontResult>,
    pub fixes: Vec<FixResult>,
    #[serde(default)]
    pub fallback: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct FidelityOutcome {
    pub report: FidelityReport,
    pub report_html: PathBuf,
    pub report_json: PathBuf,
    /// Comparisons made (the first, and one after each fix round).
    pub rounds: u32,
    pub stop: Stop,
    /// Fallback scenes in the manifest before and after (the loop never adds one).
    pub fallback_before: usize,
    pub fallback_after: usize,
}

impl FidelityOutcome {
    /// Within the threshold, fonts matching, no fallback scene added.
    pub fn passed(&self) -> bool {
        self.report.pass && self.fallback_after <= self.fallback_before
    }
}

#[derive(Debug, Error)]
pub enum FidelityError {
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Build(#[from] BuildError),
    #[error(transparent)]
    Sync(#[from] SyncError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{file}: {source}")]
    Json {
        file: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("the engine's {step} stopped with exit code {code}")]
    Step { step: &'static str, code: i32 },
    #[error("the build of round {round}'s fixes failed (exit code {code}); see its output")]
    BuildFailed { round: u32, code: i32 },
}

/// The engine's line, if it's one of its events.
pub fn parse_event(line: &str) -> Option<FidelityEvent> {
    serde_json::from_str(line.strip_prefix(EVENT)?).ok()
}

fn read_json<T: for<'de> Deserialize<'de>>(file: &Path) -> Result<T, FidelityError> {
    let bytes = fs::read(file)?;
    serde_json::from_slice(&bytes).map_err(|source| FidelityError::Json {
        file: file.to_owned(),
        source,
    })
}

/// Runs the loop on a project folder. See the module docs.
pub fn run(
    dir: &Path,
    opts: &FidelityOptions,
    mut on: impl FnMut(FidelityProgress),
) -> Result<FidelityOutcome, FidelityError> {
    let dir = &crate::engine::dunce(fs::canonicalize(dir)?);
    let engine = Engine::locate()?;
    let out = dir.join(".out").join("fidelity");
    if out.is_dir() {
        for entry in fs::read_dir(&out)? {
            let path = entry?.path();
            if path.is_dir()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("round-"))
            {
                fs::remove_dir_all(path)?;
            }
        }
    }
    fs::create_dir_all(&out)?;
    let fallback_before = fallback_scenes(dir)?.len();
    let step = |name: &'static str, args: Vec<OsString>, on: &mut dyn FnMut(FidelityProgress)| {
        let code = engine.run_with_progress(with_demo(name, &args, dir), |p| match &p {
            Progress::Stdout(line) => match parse_event(line) {
                Some(event) => on(FidelityProgress::Event(event)),
                None => on(FidelityProgress::Engine(p)),
            },
            Progress::Stderr(_) => on(FidelityProgress::Engine(p)),
        })?;
        if code != 0 {
            return Err(FidelityError::Step { step: name, code });
        }
        Ok(())
    };
    let mut round = 1;
    let stop = loop {
        on(FidelityProgress::Round(round));
        let rdir = out.join(format!("round-{round}"));
        let mut args: Vec<OsString> = vec![
            "--out".into(),
            rdir.join("compare").into(),
            "--threshold".into(),
            opts.threshold.to_string().into(),
        ];
        if let Some(url) = &opts.url {
            args.extend(["--url".into(), url.into()]);
        }
        step("fidelity-compare", args, &mut on)?;
        let compare: Value = read_json(&rdir.join("compare").join("compare.json"))?;
        if compare["pass"].as_bool() == Some(true) {
            break Stop::Within;
        }
        if !opts.fix {
            break Stop::CompareOnly;
        }
        if round > opts.rounds {
            break Stop::RoundLimit;
        }
        let mut args: Vec<OsString> = vec![
            "--out".into(),
            rdir.clone().into(),
            "--round".into(),
            round.to_string().into(),
        ];
        if let Some(url) = &opts.url {
            args.extend(["--url".into(), url.into()]);
        }
        step("fidelity-fix", args, &mut on)?;
        let diagnoses: Value = read_json(&rdir.join("diagnoses.json"))?;
        if diagnoses["added"].as_array().is_none_or(Vec::is_empty) {
            break Stop::NothingToPatch;
        }
        on(FidelityProgress::Building(round));
        let built = build(dir, &[], |p| on(FidelityProgress::Build(p)))?;
        if built.exit_code != 0 {
            return Err(FidelityError::BuildFailed {
                round,
                code: built.exit_code,
            });
        }
        round += 1;
    };
    step(
        "fidelity-report",
        vec![
            "--out".into(),
            out.clone().into(),
            "--fallback-before".into(),
            fallback_before.to_string().into(),
        ],
        &mut on,
    )?;
    let report_json = out.join("report.json");
    let report: FidelityReport = read_json(&report_json)?;
    Ok(FidelityOutcome {
        report,
        report_html: out.join("report.html"),
        report_json,
        rounds: round,
        stop,
        fallback_before,
        fallback_after: fallback_scenes(dir)?.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_engine_events_and_leaves_other_lines() {
        let e = parse_event(
            r#"@fidelity {"event":"compared","id":"lab-start","pct":0.04,"pass":true}"#,
        )
        .unwrap();
        assert_eq!(e.event, "compared");
        assert_eq!(e.data["id"], "lab-start");
        assert!(parse_event("secret scan: clean").is_none());
        assert!(parse_event("@fidelity not json").is_none());
    }

    #[test]
    fn reads_the_engines_report() {
        let report: FidelityReport = serde_json::from_value(serde_json::json!({
            "pass": true, "threshold": 0.5,
            "rounds": [{ "round": 1, "pass": false, "worst": { "id": "a@67", "pct": 1.2 }, "over": ["a@67"], "added": ["pin: a@67"] },
                       { "round": 2, "pass": true, "worst": { "id": "a", "pct": 0.01 } }],
            "items": [{ "id": "a@67", "kind": "zoom", "z": 67, "pass": true, "pct": 0.0, "firstPct": 1.2 }],
            "fonts": [{ "family": "lab blocks", "name": "Lab Blocks", "weight": "400", "style": "normal", "status": "match" }],
            "fixes": [{ "kind": "pin", "cause": "script-pinned", "finding": "a@67", "round": 1, "why": "…" }],
            "fallback": [], "residual": [], "summary": {}
        }))
        .unwrap();
        assert!(report.pass);
        assert_eq!(report.rounds[0].added, ["pin: a@67"]);
        assert_eq!(report.items[0].first_pct, Some(1.2));
        assert_eq!(report.fonts[0].status, "match");
    }
}
