//! Where a demo's time went, phase by phase: Check, Start, Stop, Build, the checks and the compare (`.out/timeline.json`,
//! newest last). The recorder's own timeline of the take (screens, sweeps by kind, waiting for Ready) is in the
//! recording (`timeline`, `timing`). Review shows "Recorded in X · finished in Y · built in Z" from both, and the
//! benchmark (`scenecast bench`) tells Scenecast's time apart from the demo's own prep (a tenant reset, opening tabs).
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE: &str = ".out/timeline.json";
const KEEP: usize = 200;

/// One phase: what ran, when it started (ms since the epoch), how long it took (ms), and whether it worked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub phase: String,
    pub at: u64,
    pub ms: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub detail: Value,
}

/// The latest time of each phase, in seconds, for the app's Review header.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    /// Check (or Check and fix).
    pub check_secs: Option<f64>,
    /// Start: the check Start runs, then the recorder's start screens.
    pub start_secs: Option<f64>,
    /// The take, from the recording (start to Stop).
    pub record_secs: Option<f64>,
    /// After Stop until the recording was saved (and, later, the unattended finishing pass).
    pub finish_secs: Option<f64>,
    pub build_secs: Option<f64>,
    pub checks_secs: Option<f64>,
    pub compare_secs: Option<f64>,
    /// The recorder's own split of the take (recording.json `timing`), as it wrote it.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub take: Value,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read(dir: &Path) -> Vec<Entry> {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Adds one phase. Never fails (timing is never a reason for a step to fail).
pub fn add(dir: &Path, phase: &str, started: Instant, ok: bool, detail: Value) {
    let ms = started.elapsed().as_millis() as u64;
    let mut all = read(dir);
    all.push(Entry {
        phase: phase.to_owned(),
        at: now_ms().saturating_sub(ms),
        ms,
        ok,
        detail,
    });
    if all.len() > KEEP {
        all.drain(..all.len() - KEEP);
    }
    let file = dir.join(FILE);
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&all) {
        let _ = std::fs::write(file, text + "\n");
    }
}

/// Times `f` as `phase` (ok when it returns Ok).
pub fn timed<T, E>(dir: &Path, phase: &str, f: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    let t = Instant::now();
    let r = f();
    add(dir, phase, t, r.is_ok(), Value::Null);
    r
}

/// The newest of each phase (the take's own length and split from the recording).
pub fn summary(dir: &Path, recording: Option<&Value>) -> Timing {
    let all = read(dir);
    let last = |phases: &[&str]| {
        all.iter()
            .rev()
            .find(|e| e.ok && phases.contains(&e.phase.as_str()))
            .map(|e| (e.ms as f64 / 100.0).round() / 10.0)
    };
    let mut t = Timing {
        check_secs: last(&["check", "check-fix"]),
        start_secs: last(&["start"]),
        finish_secs: last(&["stop"]),
        build_secs: last(&["build"]),
        checks_secs: last(&["checks"]),
        compare_secs: last(&["compare"]),
        ..Default::default()
    };
    if let Some(r) = recording {
        t.record_secs = r["secs"].as_f64();
        t.take = r["timing"].clone();
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_are_kept_newest_last_and_summed_up() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        let t = Instant::now();
        add(d, "build", t, true, Value::Null);
        add(d, "build", t, false, Value::Null);
        add(d, "check-fix", t, true, serde_json::json!({ "apps": 4 }));
        assert_eq!(read(d).len(), 3);
        let rec = serde_json::json!({ "secs": 512, "timing": { "presenterSecs": 300 } });
        let s = summary(d, Some(&rec));
        assert!(s.build_secs.is_some() && s.check_secs.is_some() && s.compare_secs.is_none());
        assert_eq!(s.record_secs, Some(512.0));
        assert_eq!(s.take["presenterSecs"], 300);
        for _ in 0..KEEP + 5 {
            add(d, "check", t, true, Value::Null);
        }
        assert_eq!(read(d).len(), KEEP);
        assert_eq!(timed(d, "stop", || Err::<(), _>("no")), Err("no"));
        assert!(!read(d).last().unwrap().ok);
    }
}
