//! AI-assisted recording (`packages/ai`): GitHub Copilot through the presenter's own GitHub sign-in, and the three
//! modes a new demo can start in besides "I know my demo":
//!
//! - **Record for me**: the presenter's goal or material → a plan in plain words (plan.md), reviewed and approved
//!   here → the browser driven through the recorder while it records, asking before anything that sends or changes
//!   something → the talk track from what happened.
//! - **I'll click, you script it**: an ordinary recording → the talk track from it.
//! - **Coach me**: the next step and line, live, while the presenter records.
//!
//! The demo keeps `ai.json` (its mode and goal), `source.md` (material the presenter gave) and `plan.md`. What was
//! sent to the model is in `.out/ai/sent/`. Questions the AI asks are answered with [`answer`]; [`stop`] stops it.

use std::path::{Path, PathBuf};

use scenecast_build::Progress;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{AppError, Update};

/// How a demo is made.
pub const MODES: [&str; 4] = ["record", "script", "coach", "manual"];

/// Where sign-in, settings and the Copilot runtime live: the app's own data folder (never Documents, which may sync).
pub fn home() -> PathBuf {
    if let Some(h) = std::env::var_os("SCENECAST_AI_HOME") {
        return PathBuf::from(h);
    }
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join("Scenecast")
        .join("ai")
}

/// The demo's AI settings: its mode and goal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DemoAi {
    pub mode: Option<String>,
    pub goal: Option<String>,
}

pub fn read(dir: &Path) -> DemoAi {
    std::fs::read(dir.join("ai.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Keeps the mode, goal and source material with the demo (an empty one is removed).
pub fn save(
    dir: &Path,
    mode: Option<&str>,
    goal: Option<&str>,
    source: Option<&str>,
) -> Result<(), AppError> {
    let mut ai = read(dir);
    if let Some(m) = mode {
        if !MODES.contains(&m) {
            return Err(AppError::Invalid(format!(
                "`{m}`: a demo is recorded for you, scripted from your clicks, coached, or yours"
            )));
        }
        ai.mode = Some(m.to_owned());
    }
    if let Some(g) = goal {
        ai.goal = Some(g.trim().to_owned()).filter(|g| !g.is_empty());
    }
    std::fs::write(dir.join("ai.json"), serde_json::to_string_pretty(&ai)?)?;
    if let Some(s) = source {
        let path = dir.join("source.md");
        if s.trim().is_empty() {
            let _ = std::fs::remove_file(path);
        } else {
            std::fs::write(path, s)?;
        }
    }
    Ok(())
}

pub fn save_plan(dir: &Path, text: &str) -> Result<(), AppError> {
    if !text.lines().any(|l| l.trim_start().starts_with("- ")) {
        return Err(AppError::Invalid(
            "the plan has no steps: each step is a line starting with \"- \"".into(),
        ));
    }
    std::fs::write(dir.join("plan.md"), text)?;
    Ok(())
}

/// Everything the window shows about a demo's AI side.
pub fn get(dir: &Path) -> Value {
    let read_text = |f: &str| std::fs::read_to_string(dir.join(f)).ok();
    let ai = read(dir);
    let run: Option<Value> = std::fs::read(dir.join(".out/ai/run.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    json!({
        "mode": ai.mode,
        "goal": ai.goal,
        "source": read_text("source.md"),
        "plan": read_text("plan.md"),
        "run": run,
        "sent": sent(dir),
    })
}

/// What was sent to the model, newest last: `{ file, task, model, at, chars, pageText }`.
pub fn sent(dir: &Path) -> Vec<Value> {
    let d = dir.join(".out/ai/sent");
    let Ok(rd) = std::fs::read_dir(&d) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|f| {
            let v: Value = serde_json::from_slice(&std::fs::read(&f).ok()?).ok()?;
            Some(json!({
                "file": f,
                "task": v["task"],
                "model": v["model"],
                "at": v["at"],
                "chars": v["prompt"].as_str().map(str::len).unwrap_or(0),
                "pageText": v["pageText"],
            }))
        })
        .collect()
}

/// Answers a question the AI asked (`do`, `self`, `skip`, `stop`, `done`; `text`: a step in plain words).
pub fn answer(dir: &Path, id: &str, answer: &str, text: Option<&str>) -> Result<(), AppError> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Invalid(format!("`{id}` isn't a question")));
    }
    let d = dir.join(".out/ai/answers");
    std::fs::create_dir_all(&d)?;
    let tmp = d.join(format!("{id}.tmp"));
    std::fs::write(&tmp, json!({ "answer": answer, "text": text }).to_string())?;
    std::fs::rename(tmp, d.join(format!("{id}.json")))?;
    Ok(())
}

/// Stops Record for me or the coach (they stop the recording cleanly, keeping what was captured).
pub fn stop(dir: &Path) -> Result<(), AppError> {
    let d = dir.join(".out/ai");
    std::fs::create_dir_all(&d)?;
    std::fs::write(d.join("stop"), "1")?;
    Ok(())
}

/// Runs `scenecast ai <args>` on the engine: each `@ai` line is an [`Update::Event`] (source `ai`; a `record` event is
/// an [`Update::Record`]), the rest engine lines. Returns the final result, or the AI's error.
pub fn run(
    dir: Option<&Path>,
    args: &[&str],
    mut on: impl FnMut(Update),
) -> Result<Value, AppError> {
    let mut engine = match dir {
        Some(d) => crate::receiver::engine_for(d)?,
        None => crate::engine()?,
    };
    engine
        .env
        .push(("SCENECAST_AI_HOME".into(), home().into_os_string()));
    let mut argv: Vec<std::ffi::OsString> = vec!["ai".into()];
    argv.extend(args.iter().map(Into::into));
    if let Some(d) = dir {
        argv.push("--demo".into());
        argv.push(d.as_os_str().to_owned());
    }
    let mut result = None;
    let mut error = None;
    let mut tail: Vec<String> = Vec::new();
    let code = engine.run_with_progress(argv, |p| {
        if let Progress::Stdout(line) = &p
            && let Some(rest) = line.strip_prefix("@ai ")
            && let Ok(Value::Object(mut data)) = serde_json::from_str::<Value>(rest)
        {
            let event = data
                .remove("event")
                .and_then(|e| e.as_str().map(str::to_owned))
                .unwrap_or_default();
            match event.as_str() {
                "done" => result = data.remove("result"),
                "error" => error = data["error"].as_str().map(str::to_owned),
                "stage" => on(Update::stage(
                    data["name"].as_str().unwrap_or("ai"),
                    data["label"].as_str().unwrap_or(""),
                )),
                "record" => {
                    if let Ok(status) = serde_json::from_value(data["status"].clone()) {
                        on(Update::Record { status });
                    }
                }
                _ => on(Update::Event {
                    source: "ai".into(),
                    event,
                    data: data.into_iter().collect::<Map<String, Value>>(),
                }),
            }
            return;
        }
        if let Progress::Stderr(l) = &p {
            tail.push(l.clone());
            if tail.len() > 6 {
                tail.remove(0);
            }
        }
        on(Update::line(&p));
    })?;
    if let Some(e) = error {
        return Err(AppError::Invalid(e));
    }
    match result {
        Some(r) if code == 0 => Ok(r),
        _ => Err(AppError::Invalid(format!(
            "the AI step stopped (exit {code}){}",
            tail.last().map(|l| format!(": {l}")).unwrap_or_default()
        ))),
    }
}

/// The coach window's address (the receiver's /coach page), for the laptop screen.
pub fn coach_url(dir: &Path) -> String {
    let port = crate::receiver::host()
        .port_for(dir)
        .unwrap_or_else(|| crate::record::receiver_port(dir));
    format!("http://127.0.0.1:{port}/coach")
}

/// Opens the coach window for the laptop screen, in the demo's browser and profile, as an app window (never on the
/// stage). With `REPLICA_NO_OPEN` set, nothing opens.
pub fn open_coach(dir: &Path) -> Result<String, AppError> {
    let url = coach_url(dir);
    if std::env::var_os("REPLICA_NO_OPEN").is_some() {
        return Ok(url);
    }
    let engine = crate::engine()?;
    let out = std::process::Command::new(&engine.node)
        .arg(engine.packages.join("player").join("open.mjs"))
        .arg("--demo")
        .arg(dir)
        .arg("--url")
        .arg(&url)
        .arg("--size")
        .arg("560,420")
        .stdin(std::process::Stdio::null())
        .output()?;
    if !out.status.success() {
        return Err(AppError::Invalid(format!(
            "the coach window didn't open: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_mode_goal_material_and_plan() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        assert_eq!(read(d), DemoAi::default());
        save(d, Some("record"), Some("  Show the delay  "), Some("notes")).unwrap();
        assert_eq!(read(d).mode.as_deref(), Some("record"));
        assert_eq!(read(d).goal.as_deref(), Some("Show the delay"));
        assert_eq!(
            std::fs::read_to_string(d.join("source.md")).unwrap(),
            "notes"
        );
        save(d, None, None, Some(" ")).unwrap();
        assert!(!d.join("source.md").exists());
        assert!(save(d, Some("magic"), None, None).is_err());
        assert!(save_plan(d, "# Plan\n\nno steps").is_err());
        save_plan(d, "## Beat 1\n- Click \"Plugins\"\n").unwrap();
        assert!(get(d)["plan"].as_str().unwrap().contains("Plugins"));
    }

    #[test]
    fn answers_and_stops_through_files() {
        let tmp = tempfile::tempdir().unwrap();
        answer(tmp.path(), "q3", "do", None).unwrap();
        let a: Value = serde_json::from_slice(
            &std::fs::read(tmp.path().join(".out/ai/answers/q3.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(a["answer"], "do");
        assert!(answer(tmp.path(), "../x", "do", None).is_err());
        stop(tmp.path()).unwrap();
        assert!(tmp.path().join(".out/ai/stop").exists());
    }

    #[test]
    fn lists_what_was_sent() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join(".out/ai/sent");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("001-plan.json"),
            r#"{"task":"plan","model":"stub","at":"t","prompt":"abc","pageText":true}"#,
        )
        .unwrap();
        let s = sent(tmp.path());
        assert_eq!(s.len(), 1);
        assert_eq!(s[0]["task"], "plan");
        assert_eq!(s[0]["chars"], 3);
    }
}
