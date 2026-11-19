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

fn home() -> PathBuf {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    };
    home.map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// `SCENECAST_EXTENSION_DIR`, else `Documents/Scenecast/Recorder Extension`: a folder the presenter can see and drag
/// onto the browser's extensions page (preflight looks there too).
pub fn extension_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SCENECAST_EXTENSION_DIR") {
        return PathBuf::from(dir);
    }
    home()
        .join("Documents")
        .join("Scenecast")
        .join("Recorder Extension")
}

/// Where 0.3.0 and earlier built it (a hidden folder).
pub fn old_extension_dir() -> PathBuf {
    home().join(".scenecast").join("extension")
}

/// The recorder's version in this app's engine (the extension's version).
pub fn recorder_version() -> Option<String> {
    let engine = engine().ok()?;
    let pkg: Value =
        serde_json::from_slice(&std::fs::read(engine.packages.join("recorder/package.json")).ok()?)
            .ok()?;
    pkg["version"].as_str().map(str::to_owned)
}

fn folder_version(dir: &Path) -> Option<String> {
    let m: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).ok()?).ok()?;
    m["version"].as_str().map(str::to_owned)
}

/// The extension folder, built (or rebuilt when this app's recorder is newer). Returns the folder and whether its
/// files changed (a loaded extension then needs a reload).
pub fn ensure_extension() -> Result<(PathBuf, bool), AppError> {
    let out = extension_dir();
    let want = recorder_version();
    let have = folder_version(&out);
    if have.is_some() && have == want {
        return Ok((out, false));
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // The port it tries first (it looks through the next few too, and 47621 on).
    let port = std::env::var("REPLICA_RX_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_RECEIVER_PORT);
    recorder::build_extension(&engine()?, &out, port)?;
    retire_old_extension();
    Ok((out, have.is_some()))
}

/// The old hidden copy, when there is one, becomes a stub that does nothing and says where the recorder went (a
/// browser that still has it loaded picks that up on its next start, so two copies never record at once).
pub fn retire_old_extension() -> bool {
    let old = old_extension_dir();
    let Some(v) = folder_version(&old) else {
        return false;
    };
    if v.starts_with("0.0.") {
        return false;
    }
    let manifest = serde_json::json!({
        "manifest_version": 3,
        "name": "Scenecast Recorder (old copy: remove it)",
        "description": "This copy moved. Remove it, then load the one in Documents/Scenecast/Recorder Extension (Scenecast: Install recorder).",
        "version": "0.0.1",
        "action": { "default_popup": "popup.html", "default_title": "Old copy: remove it" }
    });
    let popup = "<!doctype html><meta charset=utf-8><body style=\"font:13px system-ui;width:260px;margin:12px\"><h1 style=\"font-size:14px\">This copy moved</h1><p>Remove this extension, then in the Scenecast app click <b>Install recorder</b>. The recorder now lives in Documents/Scenecast/Recorder Extension.</p>";
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(&old).is_ok()
        && std::fs::write(
            old.join("manifest.json"),
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        )
        .is_ok()
        && std::fs::write(old.join("popup.html"), popup).is_ok()
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

/// Builds the recorder extension (when it isn't current), and says how to load it.
pub fn prepare_extension(dir: &Path) -> Result<ExtensionSetup, AppError> {
    let (out, _) = ensure_extension()?;
    Ok(setup_for(out, &browser(dir), receiver_port(dir)))
}

/// What "Install recorder" did: the folder ready, the extensions page opened in the presenter's running browser (in
/// the demo's profile), and the old hidden copy retired.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub dir: PathBuf,
    pub version: Option<String>,
    pub browser: String,
    pub browser_name: String,
    pub extensions_page: String,
    /// The profile folder (`Profile 10`) and its name.
    pub profile: Option<String>,
    pub profile_name: Option<String>,
    /// The setup page (the steps, a tick on connect) opened in the browser, in the profile's window: browsers don't
    /// open their extensions page from outside, so the app copies its address for the presenter to paste.
    pub opened: bool,
    pub setup_url: Option<String>,
    pub open_error: Option<String>,
    /// The browser was running (so the page opened in it, nothing restarted).
    pub running: bool,
    /// The browser already has the recorder in this profile, with Developer mode on or off.
    pub loaded: bool,
    pub dev_mode: Option<bool>,
    /// The old hidden copy is loaded somewhere (remove it).
    pub old_loaded: bool,
    pub steps: Vec<String>,
}

/// Install recorder: the folder, then the browser's extensions page in the demo's profile.
pub fn install(dir: &Path) -> Result<InstallReport, AppError> {
    let (out, _) = ensure_extension()?;
    let b = browser(dir);
    let setup = setup_for(out.clone(), &b, receiver_port(dir));
    let mut opened = String::new();
    let code = crate::receiver::engine_for(dir)?.run_with_progress(
        scenecast_build::engine::with_demo("open-extensions", &[], dir),
        |p| {
            if let scenecast_build::Progress::Stdout(l) = p {
                opened.push_str(&l);
            }
        },
    )?;
    let r: Value = opened
        .find('{')
        .and_then(|i| serde_json::from_str(&opened[i..]).ok())
        .unwrap_or_default();
    let open_error = r["error"].as_str().map(str::to_owned).or_else(|| {
        (code != 0 && r.is_null()).then(|| format!("couldn't open {}", setup.extensions_page))
    });
    let steps = if b == "edge" {
        vec![
            "Paste edge://extensions in the address bar (it's copied), then turn on Developer mode (bottom left)".to_owned(),
            "Drag the Recorder Extension folder onto the page, or click Load unpacked and pick it"
                .to_owned(),
            "Scenecast turns green as soon as the recorder connects".to_owned(),
        ]
    } else {
        vec![
            "Paste chrome://extensions in the address bar (it's copied), then turn on Developer mode (top right)".to_owned(),
            "Drag the Recorder Extension folder onto the page, or click Load unpacked and pick it"
                .to_owned(),
            "Scenecast turns green as soon as the recorder connects".to_owned(),
        ]
    };
    Ok(InstallReport {
        version: folder_version(&out),
        dir: out,
        browser: b,
        browser_name: setup.browser_name,
        extensions_page: setup.extensions_page,
        profile: r["profile"].as_str().map(str::to_owned),
        profile_name: r["profileName"].as_str().map(str::to_owned),
        opened: r["ok"] == true,
        setup_url: r["setup"].as_str().map(str::to_owned),
        open_error,
        running: r["running"] == true,
        loaded: r["loaded"] == true,
        dev_mode: r["devMode"].as_bool(),
        old_loaded: r["oldLoaded"] == true,
        steps,
    })
}

/// The browser's profiles (names, pictures, which are open, where the recorder is), for the demo or a browser.
pub fn profiles(dir: Option<&Path>, browser: Option<&str>) -> Result<Value, AppError> {
    let mut args: Vec<std::ffi::OsString> = vec!["profiles".into(), "--json".into()];
    if let Some(b) = browser {
        args.push("--browser".into());
        args.push(b.into());
    }
    if let Some(d) = dir {
        args.push("--demo".into());
        args.push(d.as_os_str().to_owned());
    }
    let mut out = String::new();
    engine()?.run_with_progress(args, |p| {
        if let scenecast_build::Progress::Stdout(l) = p {
            out.push_str(&l);
        }
    })?;
    let start = out
        .find('{')
        .ok_or_else(|| AppError::Invalid("couldn't read the browser's profiles".into()))?;
    Ok(serde_json::from_str(&out[start..])?)
}

/// Sets the demo's browser profile (the folder name, `Profile 10`) in `demo.json`; empty: the one that's open.
pub fn set_profile(dir: &Path, profile: &str) -> Result<(), AppError> {
    let file = dir.join("demo.json");
    let mut cfg: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    if !cfg["chrome"].is_object() {
        cfg["chrome"] = Value::Object(Default::default());
    }
    let obj = cfg["chrome"].as_object_mut().expect("an object");
    if profile.trim().is_empty() {
        obj.remove("profile");
        obj.remove("profilePicked");
    } else {
        obj.insert("profile".into(), Value::from(profile.trim()));
        obj.insert("profilePicked".into(), Value::from(true));
    }
    std::fs::write(&file, serde_json::to_string_pretty(&cfg)? + "\n")?;
    Ok(())
}

/// The demo's chosen profile, if the presenter picked one ("Default" from 0.3.0's template, not picked, means the
/// one that's open).
pub fn profile(dir: &Path) -> Option<String> {
    let c = config(dir)?;
    let p = c["chrome"]["profile"].as_str()?;
    (p != "Default" || c["chrome"]["profilePicked"] == true).then(|| p.to_owned())
}

/// Preflight: each item as it lands. With `fix`, what fails is put right where it can be; a running browser is
/// never relaunched.
pub fn preflight(
    dir: &Path,
    fix: bool,
    on: impl FnMut(Update),
) -> Result<PreflightReport, AppError> {
    preflight_with(dir, fix, None, on)
}

/// Preflight that stops (with [`scenecast_build::EngineError::Cancelled`]) when `cancel` turns true; the app's receiver
/// is started first, so the receiver item is about the one the extension finds.
pub fn preflight_with(
    dir: &Path,
    fix: bool,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    mut on: impl FnMut(Update),
) -> Result<PreflightReport, AppError> {
    let _ = crate::receiver::host().ensure(dir);
    let mut engine = crate::receiver::engine_for(dir)?;
    engine.cancel = cancel;
    Ok(recorder::preflight(&engine, dir, fix, |item| {
        on(Update::Preflight { item: item.clone() })
    })?)
}

pub fn start(dir: &Path, resume: bool) -> Result<Value, AppError> {
    let _ = crate::receiver::host().ensure(dir);
    let answer = recorder::record_start(&crate::receiver::engine_for(dir)?, dir, resume)?;
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        return Err(AppError::Invalid(error.to_owned()));
    }
    Ok(answer)
}

pub fn status(dir: &Path) -> Result<RecordStatus, AppError> {
    Ok(recorder::record_status(
        &crate::receiver::engine_for(dir)?,
        dir,
    )?)
}

pub fn stop(dir: &Path) -> Result<RecordSummary, AppError> {
    Ok(recorder::record_stop(
        &crate::receiver::engine_for(dir)?,
        dir,
    )?)
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
                profile: None,
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
        // 0.3.0's template said "Default" for every demo: not a choice. A picked profile is kept.
        assert_eq!(profile(&demo.dir), None);
        set_profile(&demo.dir, "Profile 10").unwrap();
        assert_eq!(profile(&demo.dir).as_deref(), Some("Profile 10"));
        set_profile(&demo.dir, "Default").unwrap();
        assert_eq!(profile(&demo.dir).as_deref(), Some("Default"));
        set_profile(&demo.dir, "").unwrap();
        assert_eq!(profile(&demo.dir), None);
        let s = setup_for(PathBuf::from("/x/extension"), "edge", 47621);
        assert_eq!(s.extensions_page, "edge://extensions");
        assert!(s.steps.iter().any(|s| s.contains("Load unpacked")));
    }
}
