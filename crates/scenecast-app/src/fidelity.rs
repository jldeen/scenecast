//! The fidelity loop (real vs replica for every captured state; with `fix`, each difference diagnosed and patched,
//! built and compared again) and its report, read back for the app's side-by-side view.

use std::path::{Path, PathBuf};

use scenecast_build::fidelity::{self, FidelityOptions, FidelityProgress};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AppError, Update, build::stage_label};

/// The last report, for the app: the engine's `report.json` as it is (items with their side-by-side and diff
/// pictures, residual differences with why, fonts, fixes) and the folder its picture paths are relative to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelityView {
    pub report: Value,
    /// `.out/fidelity`: `report.items[].sideBySide` and `.diff` are relative to it.
    pub dir: PathBuf,
    pub html: PathBuf,
    pub pass: bool,
    /// Why the loop stopped, when this view comes from a run.
    pub stop: Option<String>,
}

pub fn last(dir: &Path) -> Option<FidelityView> {
    let out = dir.join(".out").join("fidelity");
    let report: Value =
        serde_json::from_slice(&std::fs::read(out.join("report.json")).ok()?).ok()?;
    Some(FidelityView {
        pass: report["pass"] == true,
        report,
        html: out.join("report.html"),
        dir: out,
        stop: None,
    })
}

/// The compare running now: the latest round's `compare.json` while it's partial (the screens compared so far, so
/// Review fills in as they land). None when no compare is under way.
pub fn live(dir: &Path) -> Option<FidelityView> {
    let out = dir.join(".out").join("fidelity");
    let round = std::fs::read_dir(&out)
        .ok()?
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            name.strip_prefix("round-")?.parse::<u32>().ok()
        })
        .max()?;
    let compare: Value = serde_json::from_slice(
        &std::fs::read(out.join(format!("round-{round}/compare/compare.json"))).ok()?,
    )
    .ok()?;
    (compare["partial"] == true).then(|| FidelityView {
        pass: false,
        report: compare,
        html: out.join("report.html"),
        dir: out,
        stop: None,
    })
}

/// Runs the loop (`fix`: diagnose and patch; else compare and report only).
/// `real`: drawn in the installed Chrome or Edge whatever the recording says (Check again on a demo compared before
/// 0.5.3, headless).
pub fn run(
    dir: &Path,
    fix: bool,
    real: bool,
    on: impl FnMut(Update),
) -> Result<FidelityView, AppError> {
    crate::timeline::timed(dir, "compare", || run_inner(dir, fix, real, on))
}

fn run_inner(
    dir: &Path,
    fix: bool,
    real: bool,
    mut on: impl FnMut(Update),
) -> Result<FidelityView, AppError> {
    let opts = FidelityOptions {
        fix,
        checker: real.then(|| "real".to_owned()),
        ..FidelityOptions::default()
    };
    let outcome = fidelity::run(dir, &opts, |p| match p {
        FidelityProgress::Round(n) => on(Update::stage(
            "round",
            &if n == 1 {
                "Comparing every screen with the real product".to_owned()
            } else {
                format!("Round {n}: comparing again")
            },
        )),
        FidelityProgress::Building(n) => on(Update::stage(
            "building",
            &format!("Building round {n}'s fixes"),
        )),
        FidelityProgress::Build(scenecast_build::build::BuildProgress::Stage(s)) => {
            on(Update::stage(s, stage_label(s)))
        }
        FidelityProgress::Build(scenecast_build::build::BuildProgress::Engine(line))
        | FidelityProgress::Engine(line) => on(Update::line(&line)),
        FidelityProgress::Build(_) => {}
        FidelityProgress::Event(e) => on(Update::Event {
            source: "fidelity".into(),
            event: e.event,
            data: e.data,
        }),
    })?;
    let stop = serde_json::to_value(outcome.stop)?
        .as_str()
        .map(str::to_owned);
    let mut view = last(dir)
        .ok_or_else(|| AppError::Invalid("the fidelity loop ran but wrote no report".into()))?;
    view.pass = outcome.passed();
    view.stop = stop;
    // The guide's pictures came from the recording's screenshots: one whose screen differs is the replica's own now.
    if let Err(e) = crate::guide::pictures_from_compare(dir) {
        crate::ai::app_log(
            &format!("guide pictures ({})", dir.display()),
            &e.to_string(),
        );
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_compare_under_way_shows_what_it_has_compared() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(live(tmp.path()).is_none());
        let round = tmp.path().join(".out/fidelity/round-1/compare");
        std::fs::create_dir_all(&round).unwrap();
        std::fs::write(
            round.join("compare.json"),
            r#"{"partial":true,"items":[{"id":"a","kind":"state","state":"a","z":100,"pass":true,"pct":0}]}"#,
        )
        .unwrap();
        let v = live(tmp.path()).unwrap();
        assert_eq!(v.report["items"].as_array().unwrap().len(), 1);
        std::fs::write(round.join("compare.json"), r#"{"items":[]}"#).unwrap();
        assert!(
            live(tmp.path()).is_none(),
            "done: the report is the one to read"
        );
    }

    #[test]
    fn reads_the_last_report_with_its_picture_folder() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(last(tmp.path()).is_none());
        let out = tmp.path().join(".out/fidelity");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            out.join("report.json"),
            r#"{"pass":true,"items":[{"id":"chat-start","pass":true,"pct":0,"sideBySide":"round-1/compare/chat-start.side-by-side.png"}]}"#,
        )
        .unwrap();
        let v = last(tmp.path()).unwrap();
        assert!(v.pass);
        assert_eq!(v.dir, out);
        assert_eq!(
            v.report["items"][0]["sideBySide"],
            "round-1/compare/chat-start.side-by-side.png"
        );
    }
}
