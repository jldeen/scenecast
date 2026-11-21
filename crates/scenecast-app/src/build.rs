//! The build (captures → the replica, with the secret and PII scrub) and the checklist, with progress.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use scenecast_build::Progress;
use scenecast_build::build::BuildProgress;
use scenecast_build::engine::with_demo;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AppError, Update, engine};

/// What the scrub found in one place: a credential stops the build; anything else was redacted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrubFinding {
    /// `raw` (the recording) or `built` (the replica).
    pub source: String,
    pub file: String,
    pub line: usize,
    /// What it was (`email`, `tenant-id`, `bearer-token`, …).
    pub kind: String,
    pub credential: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrubSummary {
    pub findings: Vec<ScrubFinding>,
    /// Count per kind, for the summary line.
    pub by_kind: Vec<(String, usize)>,
    pub credentials: usize,
    pub redacted: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOutcome {
    pub ok: bool,
    pub exit_code: i32,
    /// Why it stopped, in words, when it did.
    pub stopped: Option<String>,
    pub scrub: ScrubSummary,
    pub live_scenes: usize,
    pub fallback: Vec<String>,
    pub streams: usize,
    pub beats: usize,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// One item of the checklist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckItem {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// `pass`, `fail`, `warn` or `manual`.
    pub status: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub secs: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksOutcome {
    pub pass: bool,
    pub quick: bool,
    pub items: Vec<CheckItem>,
    pub report: PathBuf,
}

/// Each build stage in words.
pub fn stage_label(stage: &str) -> &'static str {
    match stage {
        "scrub-raw" => "Checking the recording for secrets",
        "fingerprint" => "Seeing what changed",
        "compile-flow" => "Putting the recorded flow together",
        "process" => "Building the replica's pages",
        "scrub-built" => "Scrubbing the replica (secrets and personal data)",
        "sync" => "Writing the bundle manifest",
        _ => "Building",
    }
}

pub fn scrub_summary(report: &scenecast_build::scrub::ScrubReport) -> ScrubSummary {
    summarize(
        report
            .findings
            .iter()
            .map(|f| ScrubFinding {
                source: f.source.to_owned(),
                file: f.file.clone(),
                line: f.finding.line,
                kind: f.finding.kind.to_owned(),
                credential: f.finding.credential,
            })
            .collect(),
    )
}

fn summarize(findings: Vec<ScrubFinding>) -> ScrubSummary {
    let mut by_kind: Vec<(String, usize)> = Vec::new();
    for f in &findings {
        match by_kind.iter_mut().find(|(k, _)| *k == f.kind) {
            Some((_, n)) => *n += 1,
            None => by_kind.push((f.kind.clone(), 1)),
        }
    }
    let credentials = findings.iter().filter(|f| f.credential).count();
    ScrubSummary {
        redacted: findings.len() - credentials,
        credentials,
        by_kind,
        findings,
    }
}

/// Builds the demo: the recording's captures into the replica, scrubbed, then the manifest.
pub fn build(
    dir: &Path,
    force: bool,
    mut on: impl FnMut(Update),
) -> Result<BuildOutcome, AppError> {
    let args: Vec<OsString> = if force {
        vec!["--force".into()]
    } else {
        vec![]
    };
    // The engine's own reason ("error: …"), for the message and the app's log (Nov 20: a stopped build said only
    // "exit code 1", and the log had nothing).
    let mut reason: Option<String> = None;
    let result = scenecast_build::build::build(dir, &args, |p| match p {
        BuildProgress::Stage(stage) => on(Update::stage(stage, stage_label(stage))),
        BuildProgress::Engine(line) => {
            let (Progress::Stdout(text) | Progress::Stderr(text)) = &line;
            if let Some(r) = text.trim_start().strip_prefix("error:") {
                reason = Some(r.trim().to_owned());
            }
            on(Update::line(&line))
        }
        BuildProgress::Fingerprint { .. } => {}
    })?;
    if let Some(e) = result.sync.as_ref().and_then(|s| s.errors.first()) {
        reason = Some(e.clone());
    }
    let scrub = scrub_summary(&result.scrub);
    let stopped = match (result.credentials_in, result.exit_code) {
        (Some("raw"), _) => Some(format!(
            "The recording has {} credential(s) in it (a password, key or token). Nothing was built. Record again without them showing.",
            scrub.credentials
        )),
        (Some(_), _) => Some(
            "The built replica has a credential or a script in it. Nothing was published; see the scrub report.".to_owned(),
        ),
        (None, 0) => None,
        (None, code) => Some(match &reason {
            Some(r) => format!("The build stopped: {r}."),
            None => format!("The build stopped (exit code {code}); its output says why."),
        }),
    };
    if let Some(m) = &stopped {
        crate::ai::app_log(&format!("build ({})", dir.display()), m);
    }
    let sync = result.sync.as_ref();
    let errors = sync.map(|s| s.errors.clone()).unwrap_or_default();
    // No script yet: the guide's pictures from the replica just built. Without them the guide still works.
    if stopped.is_none()
        && errors.is_empty()
        && let Err(e) = crate::guide::from_recording(dir, &mut on)
    {
        crate::ai::app_log(
            &format!("guide pictures ({})", dir.display()),
            &e.to_string(),
        );
    }
    Ok(BuildOutcome {
        ok: stopped.is_none() && errors.is_empty(),
        exit_code: result.exit_code,
        stopped,
        live_scenes: sync.map_or(0, |s| s.live_scenes),
        fallback: sync
            .map(|s| {
                s.fallback
                    .iter()
                    .map(|(id, kind)| format!("{id} ({kind})"))
                    .collect()
            })
            .unwrap_or_default(),
        streams: sync.map_or(0, |s| s.streams),
        beats: sync.map_or(0, |s| s.beats),
        warnings: sync.map(|s| s.warnings.clone()).unwrap_or_default(),
        errors,
        scrub,
    })
}

/// The scrub report of the last build (`.out/scrub.json`), if there is one.
pub fn last_scrub(dir: &Path) -> Option<ScrubSummary> {
    let v: Value =
        serde_json::from_slice(&std::fs::read(dir.join(".out/scrub.json")).ok()?).ok()?;
    let findings: Vec<ScrubFinding> = v["findings"]
        .as_array()?
        .iter()
        .map(|f| ScrubFinding {
            source: f["source"].as_str().unwrap_or_default().to_owned(),
            file: f["file"].as_str().unwrap_or_default().to_owned(),
            line: f["line"].as_u64().unwrap_or(0) as usize,
            kind: f["kind"].as_str().unwrap_or_default().to_owned(),
            credential: f["credential"] == true,
        })
        .collect();
    Some(summarize(findings))
}

/// A checklist line (`PASS   keys: 6 beats, 2 app keys`).
pub fn parse_check_line(line: &str) -> Option<(String, String, String)> {
    let (status, rest) = line.split_once(char::is_whitespace)?;
    let status = status.to_ascii_lowercase();
    if !["pass", "fail", "warn", "manual"].contains(&status.as_str()) {
        return None;
    }
    let (id, detail) = rest
        .trim_start()
        .split_once(": ")
        .unwrap_or((rest.trim(), ""));
    if id.is_empty() || id.contains(char::is_whitespace) {
        return None;
    }
    Some((status, id.to_owned(), detail.to_owned()))
}

/// The checklist on the built replica (`quick`: only what changed since the last passing check). The engine makes
/// the presenter guide's notes again from the script first, when the demo has a guide.
pub fn checks(
    dir: &Path,
    quick: bool,
    mut on: impl FnMut(Update),
) -> Result<ChecksOutcome, AppError> {
    let engine = engine()?;
    on(Update::stage(
        "checks",
        if quick {
            "Checking what changed"
        } else {
            "Running the whole checklist"
        },
    ));
    let sub = if quick { "quick" } else { "checklist" };
    let code = engine.run_with_progress(with_demo(sub, &[], dir), |p| {
        if let Progress::Stdout(line) = &p
            && let Some((status, id, detail)) = parse_check_line(line)
        {
            on(Update::Check { id, status, detail });
            return;
        }
        on(Update::line(&p));
    })?;
    let report = dir.join(if quick {
        ".out/quick.json"
    } else {
        ".out/fidelity.json"
    });
    let items: Vec<CheckItem> = std::fs::read(&report)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| serde_json::from_value(v["items"].clone()).ok())
        .unwrap_or_default();
    if items.is_empty() && code != 0 {
        return Err(AppError::Invalid(format!(
            "the checklist didn't run (exit code {code}); its output says why"
        )));
    }
    Ok(ChecksOutcome {
        pass: code == 0 && items.iter().all(|i| i.status != "fail"),
        quick,
        items,
        report: dir.join(if quick {
            ".out/quick.md"
        } else {
            ".out/fidelity.md"
        }),
    })
}

/// What a check covers: changing any of these after the last full checklist means it has to run again.
const CHECKED_INPUTS: [&str; 11] = [
    "manifest.json",
    "demo.json",
    "flow.overrides.mjs",
    "flow.fixes.json",
    "flow.editor.json",
    "focus.json",
    "focus.mjs",
    "data/build.json",
    "presenter/notes.json",
    "presenter/shots/shots.json",
    "presenter/presenter.css",
];

/// Whether the whole checklist needs to run (before an export): it never passed, or something it covers changed since.
pub fn needs_full_check(dir: &Path) -> bool {
    let report = dir.join(".out/fidelity.json");
    let passed = std::fs::read(&report)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v["pass"] == true && v["quick"] != true);
    let Some(at) = passed
        .then(|| std::fs::metadata(&report).and_then(|m| m.modified()).ok())
        .flatten()
    else {
        return true;
    };
    CHECKED_INPUTS.iter().any(|f| {
        std::fs::metadata(dir.join(f))
            .and_then(|m| m.modified())
            .is_ok_and(|m| m > at)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use scenecast_build::scrub::{FileFinding, Finding, ScrubReport};

    #[test]
    fn reads_checklist_lines() {
        assert_eq!(
            parse_check_line("PASS   keys: 6 beats, 2 app keys"),
            Some(("pass".into(), "keys".into(), "6 beats, 2 app keys".into()))
        );
        assert_eq!(
            parse_check_line("MANUAL voice"),
            Some(("manual".into(), "voice".into(), String::new()))
        );
        assert_eq!(parse_check_line("replica: http://127.0.0.1:4699/"), None);
        assert_eq!(parse_check_line("fail to start: something"), None);
    }

    #[test]
    fn sums_up_what_the_scrub_removed() {
        let f = |kind: &'static str, credential| FileFinding {
            source: "built",
            file: "data/snaps/a.html".into(),
            finding: Finding {
                kind,
                line: 3,
                credential,
            },
        };
        let s = scrub_summary(&ScrubReport {
            findings: vec![
                f("email", false),
                f("email", false),
                f("tenant-id", false),
                f("bearer", true),
            ],
        });
        assert_eq!((s.redacted, s.credentials), (3, 1));
        assert_eq!(s.by_kind[0], ("email".to_owned(), 2));
        assert_eq!(s.findings[3].kind, "bearer");
    }

    #[test]
    fn reads_the_last_scrub_report() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(last_scrub(tmp.path()).is_none());
        std::fs::create_dir_all(tmp.path().join(".out")).unwrap();
        std::fs::write(
            tmp.path().join(".out/scrub.json"),
            r#"{"findings":[{"source":"built","file":"data/x.json","kind":"email","line":1,"credential":false}]}"#,
        )
        .unwrap();
        let s = last_scrub(tmp.path()).unwrap();
        assert_eq!(
            (s.redacted, s.findings[0].file.as_str()),
            (1, "data/x.json")
        );
    }

    #[test]
    fn a_full_check_runs_again_only_after_a_change() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("manifest.json"), "{}").unwrap();
        assert!(needs_full_check(dir));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::create_dir_all(dir.join(".out")).unwrap();
        std::fs::write(
            dir.join(".out/fidelity.json"),
            r#"{"pass":false,"quick":false}"#,
        )
        .unwrap();
        assert!(needs_full_check(dir));
        std::fs::write(
            dir.join(".out/fidelity.json"),
            r#"{"pass":true,"quick":false}"#,
        )
        .unwrap();
        assert!(!needs_full_check(dir));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("focus.json"), "{}").unwrap();
        assert!(needs_full_check(dir));
    }

    #[test]
    fn every_stage_has_words() {
        for stage in [
            "scrub-raw",
            "fingerprint",
            "compile-flow",
            "process",
            "scrub-built",
            "sync",
        ] {
            assert_ne!(stage_label(stage), "Building", "{stage}");
        }
    }
}
