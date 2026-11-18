//! Script to focus points: the presenter's script (pasted, or a text, Markdown or RunLines `.sk` file) kept with the
//! demo, each line put on its screen, its focus points, and the line-to-screen and cue sheets.

use std::path::{Path, PathBuf};

use scenecast_build::script::{self, ScriptOptions, ScriptProgress, ScriptReport};
use serde::{Deserialize, Serialize};

use crate::{AppError, Update};

/// The names a demo's own script is kept under, in the order they're looked for.
pub const SCRIPT_FILES: [&str; 3] = ["script.md", "script.txt", "script.sk"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptView {
    pub report: ScriptReport,
    pub sheet: PathBuf,
    pub sheet_pdf: Option<PathBuf>,
    pub cues: PathBuf,
    /// The presenter guide made from the same script.
    #[serde(default)]
    pub guide: Option<crate::guide::GuideStatus>,
    /// Why the guide couldn't be made, when it couldn't (the focus points are still there).
    #[serde(default)]
    pub guide_error: Option<String>,
}

/// The demo's script, if it has one.
pub fn saved_script(dir: &Path) -> Option<PathBuf> {
    SCRIPT_FILES
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.is_file())
}

/// The demo's script text and file name, for the editor box.
pub fn read(dir: &Path) -> Option<(String, String)> {
    let path = saved_script(dir)?;
    let text = std::fs::read_to_string(&path).ok()?;
    Some((text, path.file_name()?.to_string_lossy().into_owned()))
}

/// Keeps a script with the demo: `text` as it was pasted (`kind`: `md`, `txt` or `sk`). Replaces the one before.
pub fn save(dir: &Path, text: &str, kind: &str) -> Result<PathBuf, AppError> {
    let name = match kind {
        "md" | "markdown" => "script.md",
        "txt" | "text" => "script.txt",
        "sk" => "script.sk",
        other => {
            return Err(AppError::Invalid(format!(
                "`{other}`: a script is text, Markdown or a RunLines .sk file"
            )));
        }
    };
    if text.trim().is_empty() {
        return Err(AppError::Invalid("the script is empty".into()));
    }
    for f in SCRIPT_FILES {
        if f != name {
            let _ = std::fs::remove_file(dir.join(f));
        }
    }
    let path = dir.join(name);
    std::fs::write(&path, text)?;
    Ok(path)
}

/// The kind of a script file, from its name.
pub fn kind_of(file: &Path) -> &'static str {
    match file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("sk") => "sk",
        Some("txt") | Some("text") => "txt",
        _ => "md",
    }
}

/// Copies a script file into the demo (so it travels with it) and returns its text.
pub fn import(dir: &Path, file: &Path) -> Result<(String, PathBuf), AppError> {
    let text = std::fs::read_to_string(file)?;
    let path = save(dir, &text, kind_of(file))?;
    Ok((text, path))
}

pub fn last(dir: &Path) -> Option<ScriptView> {
    let out = dir.join(".out").join("script");
    let report: ScriptReport =
        serde_json::from_slice(&std::fs::read(out.join("script.json")).ok()?).ok()?;
    let pdf = out.join("sheet.pdf");
    Some(ScriptView {
        report,
        sheet: out.join("sheet.html"),
        sheet_pdf: pdf.is_file().then_some(pdf),
        cues: out.join("cues.html"),
        guide: crate::guide::status(dir),
        guide_error: None,
    })
}

/// Runs script to focus on the demo's script.
pub fn run(dir: &Path, mut on: impl FnMut(Update)) -> Result<ScriptView, AppError> {
    let file = saved_script(dir)
        .ok_or_else(|| AppError::Invalid("paste or open the script first".into()))?;
    on(Update::stage("script", "Putting each line on its screen"));
    let outcome = script::run(dir, &ScriptOptions::new(file), |p| match p {
        ScriptProgress::Event(e) => on(Update::Event {
            source: "script".into(),
            event: e.event,
            data: e.data,
        }),
        ScriptProgress::Engine(line) => on(Update::line(&line)),
    })?;
    // The presenter guide from the same script: its notes (with the focus points just made) and its pictures.
    let (guide, guide_error) = match crate::guide::make(dir, &mut on) {
        Ok(g) => (g, None),
        Err(e) => (crate::guide::status(dir), Some(e.to_string())),
    };
    Ok(ScriptView {
        report: outcome.report,
        sheet: outcome.sheet_html,
        sheet_pdf: outcome.sheet_pdf,
        cues: outcome.cues.with_extension("html"),
        guide,
        guide_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_script_with_the_demo() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(saved_script(tmp.path()).is_none());
        save(tmp.path(), "> Hello.", "md").unwrap();
        assert_eq!(
            read(tmp.path()).unwrap(),
            ("> Hello.".into(), "script.md".into())
        );
        save(tmp.path(), "Hello.\nThen this.", "txt").unwrap();
        assert!(!tmp.path().join("script.md").exists());
        assert_eq!(
            saved_script(tmp.path()).unwrap(),
            tmp.path().join("script.txt")
        );
        assert!(save(tmp.path(), "  ", "md").is_err());
        assert!(save(tmp.path(), "x", "docx").is_err());
    }

    #[test]
    fn imports_a_file_by_its_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Talk Track.SK");
        std::fs::write(&file, "beat\tline").unwrap();
        let demo = tmp.path().join("demo");
        std::fs::create_dir(&demo).unwrap();
        let (text, path) = import(&demo, &file).unwrap();
        assert_eq!(
            (text.as_str(), path),
            ("beat\tline", demo.join("script.sk"))
        );
        assert_eq!(kind_of(Path::new("a.markdown")), "md");
        assert_eq!(kind_of(Path::new("a.txt")), "txt");
    }

    #[test]
    fn asks_for_a_script_before_running() {
        let tmp = tempfile::tempdir().unwrap();
        let err = run(tmp.path(), |_| {}).unwrap_err();
        assert!(err.to_string().contains("paste or open the script"));
    }
}
