//! Getting ready to record, and the recording: the recorder extension (built once, loaded unpacked), preflight item
//! by item with fixes, and record start / status / stop with the recorder's time apart from the product's.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    /// The recorder's version in the folder.
    #[serde(default)]
    pub version: Option<String>,
    /// The profile the extensions page was opened in (guided install).
    #[serde(default)]
    pub profile: Option<String>,
    /// Whether the extensions page was opened in the browser.
    #[serde(default)]
    pub opened: bool,
}

fn home() -> PathBuf {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    };
    home.map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// `SCENECAST_EXTENSION_DIR`, else a folder people can find: `Documents/Scenecast/Recorder Extension` (where
/// preflight looks too).
pub fn extension_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SCENECAST_EXTENSION_DIR") {
        return PathBuf::from(dir);
    }
    home()
        .join("Documents")
        .join("Scenecast")
        .join("Recorder Extension")
}

/// Where versions before 0.3.1 put the extension (`~/.scenecast/extension`): kept up to date while it's there.
pub fn old_extension_dir() -> PathBuf {
    home().join(".scenecast").join("extension")
}

static RECEIVER_PORT: Mutex<Option<u16>> = Mutex::new(None);

/// The port the app's receiver is on (it may not be the demo's, when that one was taken): every engine command gets
/// it as `REPLICA_RX_PORT`.
pub fn set_receiver_port(port: Option<u16>) {
    *RECEIVER_PORT.lock().expect("port lock") = port;
}

pub fn receiver_port_override() -> Option<u16> {
    *RECEIVER_PORT.lock().expect("port lock")
}

/// The receiver port the demo's recorder uses: the app's running receiver's, else the configured one.
pub fn receiver_port(dir: &Path) -> u16 {
    receiver_port_override().unwrap_or_else(|| configured_port(dir))
}

/// `REPLICA_RX_PORT`, else `demo.json` `receiverPort`, else the default.
pub fn configured_port(dir: &Path) -> u16 {
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

/// Sets the browser profile the demo records in (`demo.json` `chrome.profile`, a folder name like `Profile 10`);
/// `None` goes back to picking it (the open one with the recorder).
pub fn set_profile(dir: &Path, profile: Option<&str>) -> Result<(), AppError> {
    let file = dir.join("demo.json");
    let mut cfg: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    if !cfg["chrome"].is_object() {
        cfg["chrome"] = Value::Object(Default::default());
    }
    match profile.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) if p.contains(['/', '\\']) || p.starts_with('.') => {
            return Err(AppError::Invalid(format!(
                "`{p}` isn't a profile folder name"
            )));
        }
        Some(p) => cfg["chrome"]["profile"] = Value::from(p),
        None => {
            cfg["chrome"].as_object_mut().map(|c| c.remove("profile"));
        }
    }
    std::fs::write(&file, serde_json::to_string_pretty(&cfg)? + "\n")?;
    Ok(())
}

/// The browser's profiles (names, pictures, which are open, which have the recorder) and the one the demo uses.
pub fn profiles(dir: &Path) -> Result<Value, AppError> {
    engine_json(dir, "profiles", &[])
}

/// Opens a page (the browser's extensions page by default) in a window of the demo's profile, in the running browser:
/// never a restart.
pub fn open_in_browser(dir: &Path, url: Option<&str>) -> Result<Value, AppError> {
    engine_json(dir, "open-in-browser", url.as_slice())
}

fn engine_json(dir: &Path, sub: &str, rest: &[&str]) -> Result<Value, AppError> {
    let rest: Vec<std::ffi::OsString> = rest.iter().map(Into::into).collect();
    let mut out = String::new();
    engine()?.run_with_progress(scenecast_build::engine::with_demo(sub, &rest, dir), |p| {
        if let scenecast_build::Progress::Stdout(line) = p {
            out.push_str(&line);
            out.push('\n');
        }
    })?;
    Ok(recorder::parse_json(sub, &out)?)
}

/// The recorder's version (the extension the app builds).
pub fn recorder_version() -> Option<String> {
    let e = engine().ok()?;
    let p: Value =
        serde_json::from_slice(&std::fs::read(e.packages.join("recorder/package.json")).ok()?)
            .ok()?;
    p["version"].as_str().map(str::to_owned)
}

fn folder_version(dir: &Path) -> Option<String> {
    let m: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).ok()?).ok()?;
    m["version"].as_str().map(str::to_owned)
}

/// After an update: the extension folders the presenter loaded get the new recorder (the extension then reloads
/// itself from its folder). Returns the folders written.
pub fn refresh_extensions(port: u16) -> Vec<PathBuf> {
    let (Ok(e), Some(want)) = (engine(), recorder_version()) else {
        return vec![];
    };
    let mut done = vec![];
    // The old folder only when the folder isn't set by hand (a test's own folder never touches the presenter's).
    let mut dirs = vec![extension_dir()];
    if std::env::var_os("SCENECAST_EXTENSION_DIR").is_none() {
        dirs.push(old_extension_dir());
    }
    for dir in dirs {
        if dir.join("manifest.json").is_file()
            && folder_version(&dir).as_deref() != Some(&want)
            && !done.contains(&dir)
            && recorder::build_extension(&e, &dir, port).is_ok()
        {
            done.push(dir);
        }
    }
    done
}

/// The guided install: the extension written to its folder, the browser's extensions page opened in the demo's
/// profile (in the running browser), and the folder shown in Finder or File Explorer (by the app).
pub fn install_recorder(dir: &Path) -> Result<ExtensionSetup, AppError> {
    let mut setup = prepare_extension(dir)?;
    let opened = open_in_browser(dir, None).ok();
    if let Some(o) = &opened {
        setup.profile = o["profile"].as_str().map(str::to_owned);
        setup.opened = o["ok"].as_bool().unwrap_or(false);
    }
    Ok(setup)
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
            "Drag the Recorder Extension folder onto the page, or choose Load unpacked and pick it"
                .to_owned(),
            "Come back here: Scenecast turns green when the recorder connects".to_owned(),
        ],
        version: folder_version(&dir),
        profile: None,
        opened: false,
        dir,
        browser: browser.to_owned(),
        browser_name: name.to_owned(),
        extensions_page: page.to_owned(),
        port,
    }
}

/// Builds the recorder extension for this demo's receiver port, and says how to load it.
pub fn prepare_extension(dir: &Path) -> Result<ExtensionSetup, AppError> {
    // The demo's own port: when the app's receiver had to take another, the extension finds it.
    let port = configured_port(dir);
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
            assert_eq!(configured_port(&demo.dir), DEFAULT_RECEIVER_PORT);
        }
        let s = setup_for(PathBuf::from("/x/extension"), "edge", 47621);
        assert_eq!(s.extensions_page, "edge://extensions");
        assert!(s.steps.iter().any(|s| s.contains("Load unpacked")));
        set_profile(&demo.dir, Some("Profile 10")).unwrap();
        assert_eq!(
            config(&demo.dir).unwrap()["chrome"]["profile"],
            "Profile 10"
        );
        assert!(set_profile(&demo.dir, Some("../x")).is_err());
        set_profile(&demo.dir, None).unwrap();
        assert!(
            config(&demo.dir).unwrap()["chrome"]
                .get("profile")
                .is_none()
        );
        assert_eq!(config(&demo.dir).unwrap()["chrome"]["browser"], "edge");
    }
}
