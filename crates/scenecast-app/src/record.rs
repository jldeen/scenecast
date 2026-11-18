//! Getting ready to record, and the recording: the recorder extension (built once, loaded unpacked), preflight item
//! by item with fixes, and record start / status / stop with the recorder's time apart from the product's.

use std::path::{Path, PathBuf};

use scenecast_build::recorder;
pub use scenecast_build::recorder::{PreflightItem, PreflightReport, RecordStatus, RecordSummary};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AppError, Update, engine};

/// The receiver's default port (the engine's own default).
pub const DEFAULT_RECEIVER_PORT: u16 = 47621;

/// What the presenter needs to load the extension once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSetup {
    /// The unpacked extension folder.
    pub dir: PathBuf,
    /// `edge` or `chrome`.
    pub browser: String,
    /// The browser's own name.
    pub browser_name: String,
    /// The page to load it from (`edge://extensions`).
    pub extensions_page: String,
    pub port: u16,
    /// The steps, in words.
    pub steps: Vec<String>,
}

/// `SCENECAST_EXTENSION_DIR`, else `~/.scenecast/extension` (where preflight looks too).
pub fn extension_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SCENECAST_EXTENSION_DIR") {
        return PathBuf::from(dir);
    }
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    };
    home.map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".scenecast")
        .join("extension")
}

/// The receiver port the demo's recorder uses: `REPLICA_RX_PORT`, else `demo.json` `receiverPort`, else the default.
pub fn receiver_port(dir: &Path) -> u16 {
    if let Some(port) = std::env::var("REPLICA_RX_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
    {
        return port;
    }
    config(dir)
        .and_then(|c| c["receiverPort"].as_u64())
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_RECEIVER_PORT)
}

/// `edge` or `chrome`: `demo.json` `chrome.browser`, else Edge on Windows and Chrome elsewhere (the engine's default).
pub fn browser(dir: &Path) -> String {
    config(dir)
        .and_then(|c| c["chrome"]["browser"].as_str().map(str::to_owned))
        .filter(|b| b == "edge" || b == "chrome")
        .unwrap_or_else(|| if cfg!(windows) { "edge" } else { "chrome" }.to_owned())
}

fn config(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(dir.join("demo.json")).ok()?).ok()
}

/// Sets the demo's browser (`edge` or `chrome`) in `demo.json`.
pub fn set_browser(dir: &Path, browser: &str) -> Result<(), AppError> {
    if browser != "edge" && browser != "chrome" {
        return Err(AppError::Invalid(format!("`{browser}`: Edge or Chrome")));
    }
    let file = dir.join("demo.json");
    let mut cfg: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    if !cfg["chrome"].is_object() {
        cfg["chrome"] = Value::Object(Default::default());
    }
    cfg["chrome"]["browser"] = Value::from(browser);
    std::fs::write(&file, serde_json::to_string_pretty(&cfg)? + "\n")?;
    Ok(())
}

/// The steps to load the extension once, for a browser.
pub fn setup_for(dir: PathBuf, browser: &str, port: u16) -> ExtensionSetup {
    let (name, page) = if browser == "edge" {
        ("Microsoft Edge", "edge://extensions")
    } else {
        ("Google Chrome", "chrome://extensions")
    };
    ExtensionSetup {
        steps: vec![
            format!("In {name}, go to {page}"),
            "Turn on Developer mode".to_owned(),
            "Choose Load unpacked, and pick the folder below".to_owned(),
            "Come back here and run the check again".to_owned(),
        ],
        dir,
        browser: browser.to_owned(),
        browser_name: name.to_owned(),
        extensions_page: page.to_owned(),
        port,
    }
}

/// Builds the recorder extension for this demo's receiver port, and says how to load it.
pub fn prepare_extension(dir: &Path) -> Result<ExtensionSetup, AppError> {
    let port = receiver_port(dir);
    let out = extension_dir();
    recorder::build_extension(&engine()?, &out, port)?;
    Ok(setup_for(out, &browser(dir), port))
}

/// Preflight: each item as it lands. With `fix`, what fails is put right where it can be; a running browser is
/// never relaunched.
pub fn preflight(
    dir: &Path,
    fix: bool,
    mut on: impl FnMut(Update),
) -> Result<PreflightReport, AppError> {
    let engine = engine()?;
    Ok(recorder::preflight(&engine, dir, fix, |item| {
        on(Update::Preflight { item: item.clone() })
    })?)
}

pub fn start(dir: &Path, resume: bool) -> Result<Value, AppError> {
    let answer = recorder::record_start(&engine()?, dir, resume)?;
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        return Err(AppError::Invalid(error.to_owned()));
    }
    Ok(answer)
}

pub fn status(dir: &Path) -> Result<RecordStatus, AppError> {
    Ok(recorder::record_status(&engine()?, dir)?)
}

pub fn stop(dir: &Path) -> Result<RecordSummary, AppError> {
    Ok(recorder::record_stop(&engine()?, dir)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{Library, NewApp, NewDemo};

    #[test]
    fn the_browser_and_port_come_from_the_demo() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path());
        let demo = lib
            .create(&NewDemo {
                title: "Rec".into(),
                apps: vec![NewApp {
                    id: "chat".into(),
                    url: "https://chat.example.com/".into(),
                }],
                browser: None,
            })
            .unwrap();
        let default = if cfg!(windows) { "edge" } else { "chrome" };
        assert_eq!(browser(&demo.dir), default);
        set_browser(&demo.dir, "edge").unwrap();
        assert_eq!(browser(&demo.dir), "edge");
        assert!(set_browser(&demo.dir, "safari").is_err());
        if std::env::var_os("REPLICA_RX_PORT").is_none() {
            assert_eq!(receiver_port(&demo.dir), DEFAULT_RECEIVER_PORT);
        }
        let s = setup_for(PathBuf::from("/x/extension"), "edge", 47621);
        assert_eq!(s.extensions_page, "edge://extensions");
        assert!(s.steps.iter().any(|s| s.contains("Load unpacked")));
    }
}
