//! The presenter guide: a second window for the laptop screen that follows the stage (the talk track word for word,
//! the clicks, watch-outs, the time, what's on screen and what's next). Made from the demo's script
//! (`presenter/notes.json`, `scenecast notes`) with a picture per beat (`presenter/shots/`, `scenecast guide-shots`);
//! opened next to the stage in the same browser, which it talks to over a BroadcastChannel.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use scenecast_build::engine::with_demo;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AppError, Update, engine};

/// Where the guide stands for a demo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideStatus {
    pub title: String,
    /// The script's beats (not counting Start and End).
    pub beats: usize,
    pub pictures: usize,
    /// Pictures the guide shows that aren't made yet.
    pub missing_pictures: usize,
    /// The script the notes came from, relative to the demo.
    pub script: String,
}

/// Where a window goes, in screen points: the laptop screen, where this app's window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn notes_file(dir: &Path) -> PathBuf {
    dir.join("presenter").join("notes.json")
}

fn shots_dir(dir: &Path) -> PathBuf {
    dir.join("presenter").join("shots")
}

/// The guide's notes, if the demo has them.
pub fn status(dir: &Path) -> Option<GuideStatus> {
    let notes: Value = serde_json::from_slice(&std::fs::read(notes_file(dir)).ok()?).ok()?;
    let shots: Vec<&str> = notes["shots"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s["name"].as_str()).collect())
        .unwrap_or_default();
    let missing = shots
        .iter()
        .filter(|n| !shots_dir(dir).join(format!("{n}.png")).is_file())
        .count();
    Some(GuideStatus {
        title: notes["title"].as_str().unwrap_or_default().to_owned(),
        beats: notes["beats"]
            .as_array()
            .map_or(0, |b| b.len().saturating_sub(2)),
        pictures: shots.len(),
        missing_pictures: missing,
        script: notes["script"].as_str().unwrap_or_default().to_owned(),
    })
}

/// Whether the pictures need making: one is missing, or a beat now starts on another screen than its picture is of.
pub fn pictures_stale(dir: &Path) -> bool {
    let Ok(notes) = std::fs::read(notes_file(dir)) else {
        return false;
    };
    let Ok(notes) = serde_json::from_slice::<Value>(&notes) else {
        return true;
    };
    let want: Vec<Value> = notes["shots"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| serde_json::json!([s["name"], s["app"], s["state"]]))
                .collect()
        })
        .unwrap_or_default();
    let made: Option<Vec<Value>> = std::fs::read(shots_dir(dir).join("shots.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    made.as_ref() != Some(&want)
        || want.iter().any(|s| {
            !shots_dir(dir)
                .join(format!("{}.png", s[0].as_str().unwrap_or_default()))
                .is_file()
        })
}

fn has_script(dir: &Path) -> bool {
    let named = std::fs::read(dir.join("demo.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c["presenter"]["script"].as_str().map(|s| dir.join(s)));
    named.is_some_and(|p| p.is_file())
        || [
            "presenter/script.md",
            "presenter/script.txt",
            "presenter/script.sk",
            "script.md",
            "script.txt",
            "script.sk",
        ]
        .iter()
        .any(|f| dir.join(f).is_file())
}

fn run(dir: &Path, sub: &str, on: &mut impl FnMut(Update)) -> Result<(), AppError> {
    run_with(dir, sub, &[], on)
}

fn run_with(
    dir: &Path,
    sub: &str,
    args: &[&str],
    on: &mut impl FnMut(Update),
) -> Result<(), AppError> {
    let args: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
    let mut lines = Vec::new();
    let code = engine()?.run_with_progress(with_demo(sub, &args, dir), |p| {
        let (scenecast_build::Progress::Stdout(l) | scenecast_build::Progress::Stderr(l)) = &p;
        lines.push(l.clone());
        on(Update::line(&p));
    })?;
    if code != 0 {
        return Err(AppError::Invalid(format!(
            "the presenter guide: {}",
            lines.last().map_or("it stopped", String::as_str)
        )));
    }
    Ok(())
}

/// Makes the guide from the demo's script: its notes, then the pictures that need making. `None`: no script yet.
pub fn make(dir: &Path, mut on: impl FnMut(Update)) -> Result<Option<GuideStatus>, AppError> {
    if !has_script(dir) {
        return Ok(None);
    }
    on(Update::stage("guide", "Writing the presenter guide"));
    run(dir, "notes", &mut on)?;
    if pictures_stale(dir) {
        on(Update::stage(
            "guide-shots",
            "Taking the presenter guide's pictures",
        ));
        run(dir, "guide-shots", &mut on)?;
    }
    Ok(status(dir))
}

/// Before there's a script, the guide comes from the recording: each beat's steps, and a picture of the screen it starts
/// on. Made after each build, so "On screen now" shows that screen (an empty black frame before). `None`: there's a
/// script (`make` does its guide).
pub fn from_recording(
    dir: &Path,
    mut on: impl FnMut(Update),
) -> Result<Option<GuideStatus>, AppError> {
    if has_script(dir) {
        return Ok(None);
    }
    run_with(dir, "notes", &["--from-recording"], &mut on)?;
    if pictures_stale(dir) {
        on(Update::stage(
            "guide-shots",
            "Taking the presenter guide's pictures",
        ));
        run(dir, "guide-shots", &mut on)?;
    }
    Ok(status(dir))
}

/// The guide's address on the replica at `stage` (`http://127.0.0.1:<port>/…`), with where it should go.
pub fn url(stage: &str, place: Option<Place>) -> Result<String, AppError> {
    let rest = stage
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(|| AppError::Invalid(format!("not the replica on this computer: {stage}")))?;
    let port: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if port.is_empty() {
        return Err(AppError::Invalid(format!("no port in {stage}")));
    }
    let mut url = format!("http://127.0.0.1:{port}/presenter.html");
    if let Some(p) = place {
        url.push_str(&format!("#place={},{},{},{}", p.x, p.y, p.width, p.height));
    }
    Ok(url)
}

/// Opens the guide next to the stage at `stage`, in the demo's browser and profile (the stage's: the two talk inside
/// one browser), as an app window at `place`. Returns its address. With `REPLICA_NO_OPEN` set, nothing opens.
pub fn open(dir: &Path, stage: &str, place: Option<Place>) -> Result<String, AppError> {
    let url = url(stage, place)?;
    if std::env::var_os("REPLICA_NO_OPEN").is_some() {
        return Ok(url);
    }
    let engine = engine()?;
    let mut cmd = Command::new(&engine.node);
    cmd.arg(engine.packages.join("player").join("open.mjs"))
        .arg("--demo")
        .arg(dir)
        .arg("--url")
        .arg(&url);
    if let Some(p) = place {
        cmd.arg("--position")
            .arg(format!("{},{}", p.x, p.y))
            .arg("--size")
            .arg(format!("{},{}", p.width, p.height));
    }
    let out = cmd.stdin(Stdio::null()).output()?;
    if !out.status.success() {
        return Err(AppError::Invalid(format!(
            "the presenter guide didn't open: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guide_is_on_the_stages_server() {
        assert_eq!(
            url("http://127.0.0.1:4699/?pace=2", None).unwrap(),
            "http://127.0.0.1:4699/presenter.html"
        );
        let place = Place {
            x: -1440,
            y: 25,
            width: 1440,
            height: 875,
        };
        assert_eq!(
            url("http://127.0.0.1:4699/", Some(place)).unwrap(),
            "http://127.0.0.1:4699/presenter.html#place=-1440,25,1440,875"
        );
        assert!(url("https://example.com/", None).is_err());
    }

    #[test]
    fn reads_the_notes_and_sees_missing_pictures() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(status(tmp.path()).is_none());
        assert!(!pictures_stale(tmp.path()));
        std::fs::create_dir_all(shots_dir(tmp.path())).unwrap();
        std::fs::write(
            notes_file(tmp.path()),
            r#"{"title":"Talk","script":"script.md","beats":[{},{},{},{}],"shots":[{"name":"beat-00","app":"chat","state":"a"},{"name":"beat-01","app":"chat","state":"b"}]}"#,
        )
        .unwrap();
        std::fs::write(shots_dir(tmp.path()).join("beat-00.png"), b"png").unwrap();
        let s = status(tmp.path()).unwrap();
        assert_eq!(
            (s.title.as_str(), s.beats, s.pictures, s.missing_pictures),
            ("Talk", 2, 2, 1)
        );
        assert!(pictures_stale(tmp.path()));
        std::fs::write(shots_dir(tmp.path()).join("beat-01.png"), b"png").unwrap();
        std::fs::write(
            shots_dir(tmp.path()).join("shots.json"),
            r#"[["beat-00","chat","a"],["beat-01","chat","b"]]"#,
        )
        .unwrap();
        assert!(!pictures_stale(tmp.path()));
        // A beat that now starts on another screen.
        std::fs::write(
            shots_dir(tmp.path()).join("shots.json"),
            r#"[["beat-00","chat","a"],["beat-01","chat","c"]]"#,
        )
        .unwrap();
        assert!(pictures_stale(tmp.path()));
    }

    #[test]
    fn makes_nothing_without_a_script() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(make(tmp.path(), |_| {}).unwrap(), None);
    }
}
