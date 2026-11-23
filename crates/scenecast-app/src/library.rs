//! The demo library: a folder of demo projects (each a folder with `demo.json`), and where each one stands.
//!
//! The library is `SCENECAST_LIBRARY` if set, else `Scenecast` in the user's Documents folder. A demo's id is its
//! folder name.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use scenecast_build::project::{AppSpec, NewProject, create_project, default_port};
use scenecast_core::{SceneKind, read_manifest};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::AppError;

/// The library folder.
#[derive(Debug, Clone)]
pub struct Library {
    pub root: PathBuf,
}

/// One app (browser tab) of a demo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DemoApp {
    pub id: String,
    pub url: String,
    /// Its presenter key (a letter), once the demo has a manifest.
    pub key: Option<String>,
}

/// The fidelity loop's last result: screens within the threshold out of all compared, each by its own verdict (as
/// Review counts it); its zoom levels and menus that differ are counted apart (`views_differ`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelityScore {
    pub pass: bool,
    pub within: usize,
    pub total: usize,
    /// Zoom levels and menus that differ, apart from the screens.
    #[serde(default)]
    pub views_differ: usize,
    /// `within / total`, as a percentage.
    pub score: f64,
    pub fonts_ok: bool,
    pub at: Option<u64>,
}

/// The checklist's last result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksScore {
    pub pass: bool,
    pub passed: usize,
    pub failed: usize,
    pub quick: bool,
    pub at: Option<u64>,
}

/// Where a demo stands, from what's on disk.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoStatus {
    pub recorded: bool,
    /// Milliseconds since the Unix epoch.
    pub recorded_at: Option<u64>,
    /// Screens in the recording.
    pub screens: usize,
    pub built: bool,
    pub built_at: Option<u64>,
    pub live_scenes: usize,
    pub fallback_scenes: usize,
    pub fidelity: Option<FidelityScore>,
    pub checks: Option<ChecksScore>,
    pub focus_points: usize,
    pub has_script: bool,
    /// The last fidelity loop or checklist run.
    pub last_checked: Option<u64>,
    /// `new`, `recorded`, `built` or `checked`: the furthest step done.
    pub stage: String,
    /// When it was last rehearsed (a rehearsal that reached the first beat).
    #[serde(default)]
    pub rehearsed_at: Option<u64>,
    /// Where the time went: the take, the finishing after Stop, the build (timeline.rs).
    #[serde(default)]
    pub timing: crate::timeline::Timing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Demo {
    pub id: String,
    pub title: String,
    pub dir: PathBuf,
    pub port: u16,
    pub apps: Vec<DemoApp>,
    /// `edge` or `chrome`: what it's recorded and presented in.
    pub browser: String,
    /// The browser profile (`Profile 10`), when the demo names one.
    pub profile: Option<String>,
    /// How it's made: `record` (Record for me), `script` (I'll click, you script it), `coach` (Coach me) or
    /// `manual` (I know my demo; also every demo from before there was a choice).
    pub mode: String,
    /// The presenter's slot on stage, in seconds (demo.json `presenter.slot`), when it's set.
    #[serde(default)]
    pub slot: Option<u32>,
    pub status: DemoStatus,
}

/// What the New demo form sends.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NewDemo {
    pub title: String,
    pub apps: Vec<NewApp>,
    /// `edge` or `chrome` (default: Edge on Windows, Chrome on the Mac).
    #[serde(default)]
    pub browser: Option<String>,
    /// The browser profile's folder name (`Profile 10`); none: the one that's open when recording.
    #[serde(default)]
    pub profile: Option<String>,
    /// How it's made (`record`, `script`, `coach`, `manual`; default `manual`).
    #[serde(default)]
    pub mode: Option<String>,
    /// What the demo should show, in the presenter's words (Record for me, Coach me).
    #[serde(default)]
    pub goal: Option<String>,
    /// Material to work from: notes, a doc, an email, a script (Record for me, Coach me).
    #[serde(default)]
    pub source: Option<String>,
    /// The slot on stage, in seconds.
    #[serde(default)]
    pub slot: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NewApp {
    /// Optional: derived from the URL's host when empty.
    #[serde(default)]
    pub id: String,
    pub url: String,
}

impl Library {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `SCENECAST_LIBRARY`, else `<Documents>/Scenecast`.
    pub fn default_root() -> PathBuf {
        if let Some(root) = std::env::var_os("SCENECAST_LIBRARY") {
            return PathBuf::from(root);
        }
        let home = if cfg!(windows) {
            std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
        } else {
            std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
        };
        home.map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Documents")
            .join("Scenecast")
    }

    /// Every demo in the library, by title.
    pub fn list(&self) -> Result<Vec<Demo>, AppError> {
        let mut demos = Vec::new();
        if !self.root.is_dir() {
            return Ok(demos);
        }
        for entry in fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.join("demo.json").is_file()
                && let Ok(demo) = load(&path)
            {
                demos.push(demo);
            }
        }
        demos.sort_by_key(|d| (d.title.to_lowercase(), d.id.clone()));
        Ok(demos)
    }

    /// A demo's folder, by id (its folder name). Refuses anything that isn't a plain folder name.
    pub fn dir(&self, id: &str) -> Result<PathBuf, AppError> {
        if id.is_empty()
            || id.starts_with('.')
            || id.contains(['/', '\\', ':'])
            || !self.root.join(id).join("demo.json").is_file()
        {
            return Err(AppError::NoDemo(id.to_owned()));
        }
        Ok(self.root.join(id))
    }

    pub fn get(&self, id: &str) -> Result<Demo, AppError> {
        load(&self.dir(id)?)
    }

    /// A new demo: live-page scenes, one start scene per app, waiting to be recorded.
    pub fn create(&self, spec: &NewDemo) -> Result<Demo, AppError> {
        let title = spec.title.trim();
        if title.is_empty() {
            return Err(AppError::Invalid("give the demo a name".into()));
        }
        let mut apps = Vec::new();
        for app in &spec.apps {
            let url = app.url.trim();
            if url.is_empty() {
                continue;
            }
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(AppError::Invalid(format!(
                    "`{url}` isn't a web address (it starts with https://)"
                )));
            }
            let id = if app.id.trim().is_empty() {
                app_id_from_url(url)
            } else {
                slug(&app.id)
            };
            let mut id = if id.is_empty() { "app".to_owned() } else { id };
            let base = id.clone();
            let mut n = 2;
            while apps.iter().any(|a: &AppSpec| a.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            apps.push(AppSpec {
                id,
                url: url.to_owned(),
            });
        }
        if apps.is_empty() {
            return Err(AppError::Invalid(
                "add the web address of at least one app".into(),
            ));
        }
        if let Some(m) = spec.mode.as_deref()
            && !crate::ai::MODES.contains(&m)
        {
            return Err(AppError::Invalid(format!(
                "`{m}` isn't a way to make a demo"
            )));
        }
        fs::create_dir_all(&self.root)?;
        let id = self.free_id(&slug(title));
        create_project(&NewProject {
            dir: self.root.join(&id),
            title: Some(title.to_owned()),
            apps,
            port: None,
        })?;
        if let Some(browser) = spec.browser.as_deref().filter(|b| !b.is_empty()) {
            crate::record::set_browser(&self.root.join(&id), browser)?;
        }
        if let Some(profile) = spec.profile.as_deref().filter(|p| !p.trim().is_empty()) {
            crate::record::set_profile(&self.root.join(&id), profile)?;
        }
        if spec.slot.is_some_and(|s| s > 0) {
            set_slot(&self.root.join(&id), spec.slot)?;
        }
        if spec.mode.is_some() || spec.goal.is_some() || spec.source.is_some() {
            crate::ai::save(
                &self.root.join(&id),
                spec.mode.as_deref().or(Some("manual")),
                spec.goal.as_deref(),
                spec.source.as_deref(),
            )?;
        }
        self.get(&id)
    }

    /// A copy of a demo, recording included, under a new name (its own folder, raw folder and port).
    pub fn duplicate(&self, id: &str, title: Option<&str>) -> Result<Demo, AppError> {
        let from = self.get(id)?;
        let title = title
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{} copy", from.title));
        let new_id = self.free_id(&slug(&title));
        let to = self.root.join(&new_id);
        let raw_from = scenecast_build::build::raw_dir(&from.dir).ok();
        copy_dir(&from.dir, &to, &|p| {
            p.file_name().is_some_and(|n| n == ".git")
        })?;
        let file = to.join("demo.json");
        let mut cfg: Value = serde_json::from_slice(&fs::read(&file)?)?;
        let port = default_port(&new_id);
        cfg["name"] = Value::from(new_id.clone());
        cfg["title"] = Value::from(title.clone());
        cfg["port"] = Value::from(port);
        let default_raw = format!("~/.scenecast/{id}/raw");
        if cfg["raw"].as_str().is_none_or(|r| r == default_raw) {
            cfg["raw"] = Value::from(format!("~/.scenecast/{new_id}/raw"));
        }
        fs::write(&file, serde_json::to_string_pretty(&cfg)? + "\n")?;
        if let Ok(mut manifest) = read_manifest(&to) {
            manifest.title = title;
            scenecast_core::write_manifest(&to, &manifest)?;
        }
        if let (Some(raw_from), Ok(raw_to)) = (raw_from, scenecast_build::build::raw_dir(&to))
            && raw_from.is_dir()
            && raw_from != raw_to
            && !raw_to.exists()
        {
            copy_dir(&raw_from, &raw_to, &|_| false)?;
        }
        self.get(&new_id)
    }

    /// Removes a demo's folder for good (the app moves it to the Trash or Recycle Bin instead when it can).
    pub fn remove(&self, id: &str) -> Result<PathBuf, AppError> {
        let dir = self.dir(id)?;
        fs::remove_dir_all(&dir)?;
        Ok(dir)
    }

    /// The demo's recording folder, when it has one and no other demo in the library records into it.
    pub fn own_recording(&self, id: &str) -> Option<PathBuf> {
        let raw = scenecast_build::build::raw_dir(&self.dir(id).ok()?).ok()?;
        if !raw.is_dir() {
            return None;
        }
        let shared = self.list().ok()?.iter().any(|d| {
            d.id != id && scenecast_build::build::raw_dir(&d.dir).ok().as_ref() == Some(&raw)
        });
        (!shared).then_some(raw)
    }

    pub(crate) fn free_id(&self, base: &str) -> String {
        let base = if base.is_empty() { "demo" } else { base };
        let mut id = base.to_owned();
        let mut n = 2;
        while self.root.join(&id).exists() {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }
}

/// Lowercase letters, digits and dashes.
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(48).collect::<String>()
}

/// `chat` for `https://chat.example.com/…`, `contoso` for `https://www.contoso.com/`; for a local address, its first
/// path segment (`http://127.0.0.1:4100/chat` → `chat`).
fn app_id_from_url(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority.split(':').next().unwrap_or("");
    let local = host == "localhost" || host.chars().all(|c| c.is_ascii_digit() || c == '.');
    let id = if local {
        slug(path.split(['/', '?', '#']).next().unwrap_or(""))
    } else {
        // The first part of the host that names something: preview.iq.example.com is "iq", portal.azure.com "azure".
        const GENERIC: &[&str] = &[
            "www", "app", "apps", "portal", "web", "my", "daily", "go", "beta", "preview",
            "insiders",
        ];
        let parts: Vec<&str> = host.split('.').collect();
        let named = parts[..parts.len().saturating_sub(1).max(1)]
            .iter()
            .find(|p| !GENERIC.contains(p))
            .or(parts.first());
        slug(named.copied().unwrap_or(""))
    };
    if id.is_empty() { "app".to_owned() } else { id }
}

fn millis(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// A demo, from its folder.
pub fn load(dir: &Path) -> Result<Demo, AppError> {
    let cfg: Value = serde_json::from_slice(&fs::read(dir.join("demo.json"))?)?;
    let id = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let manifest = read_manifest(dir).ok();
    let keys: Vec<(String, Option<String>)> = manifest
        .as_ref()
        .map(|m| {
            m.apps
                .iter()
                .map(|a| (a.id.clone(), a.key.clone()))
                .collect()
        })
        .unwrap_or_default();
    let apps = cfg["apps"]
        .as_array()
        .map(|apps| {
            apps.iter()
                .map(|a| {
                    let id = a["id"].as_str().unwrap_or_default().to_owned();
                    let key = keys
                        .iter()
                        .find(|(k, _)| *k == id)
                        .and_then(|(_, k)| k.clone());
                    DemoApp {
                        url: a["url"].as_str().unwrap_or_default().to_owned(),
                        id,
                        key,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Demo {
        title: cfg["title"]
            .as_str()
            .filter(|t| !t.is_empty())
            .unwrap_or(&id)
            .to_owned(),
        port: cfg["port"].as_u64().unwrap_or(0) as u16,
        apps,
        browser: crate::record::browser(dir),
        profile: crate::record::profile(dir),
        mode: crate::ai::read(dir).mode.unwrap_or_else(|| "manual".into()),
        slot: cfg["presenter"]["slot"]
            .as_u64()
            .filter(|s| *s > 0)
            .map(|s| s as u32),
        status: status(dir, manifest.as_ref()),
        dir: dir.to_path_buf(),
        id,
    })
}

/// An app's address, changed after the demo was made (or picked from the open tabs: "Which tab is it?"): its start
/// page, and its match (how Record finds its tab: the address's host). The manifest's start address follows.
pub fn set_app(dir: &Path, id: &str, url: &str) -> Result<Demo, AppError> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::Invalid(format!(
            "`{url}` isn't a web address (it starts with https://)"
        )));
    }
    let host = url
        .split_once("://")
        .map_or(url, |(_, r)| r)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_owned();
    if host.is_empty() {
        return Err(AppError::Invalid(format!("`{url}` has no host")));
    }
    let file = dir.join("demo.json");
    let mut cfg: Value = serde_json::from_slice(&fs::read(&file)?)?;
    let Some(app) = cfg["apps"]
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|a| a["id"] == id))
    else {
        return Err(AppError::Invalid(format!("the demo has no app `{id}`")));
    };
    app["url"] = Value::from(url);
    app["match"] = Value::from(host);
    fs::write(&file, serde_json::to_string_pretty(&cfg)? + "\n")?;
    if let Ok(mut m) = read_manifest(dir)
        && let Some(a) = m.apps.iter_mut().find(|a| a.id == id)
    {
        a.url = Some(url.to_owned());
        scenecast_core::write_manifest(dir, &m)?;
    }
    load(dir)
}

/// The slot on stage (seconds) in demo.json's `presenter.slot`; `None` or 0 clears it. The guide's other settings
/// there are kept.
pub fn set_slot(dir: &Path, slot: Option<u32>) -> Result<(), AppError> {
    let file = dir.join("demo.json");
    let mut cfg: Value = serde_json::from_slice(&fs::read(&file)?)?;
    if !cfg["presenter"].is_object() {
        cfg["presenter"] = Value::Object(Default::default());
    }
    match slot.filter(|s| *s > 0) {
        Some(s) => cfg["presenter"]["slot"] = Value::from(s),
        None => {
            if let Some(p) = cfg["presenter"].as_object_mut() {
                p.remove("slot");
            }
        }
    }
    fs::write(&file, serde_json::to_string_pretty(&cfg)? + "\n")?;
    Ok(())
}

/// Where a demo stands: recorded, built, its fidelity score, its focus points, when it was last checked.
pub fn status(dir: &Path, manifest: Option<&scenecast_core::BundleManifest>) -> DemoStatus {
    let mut s = DemoStatus::default();
    if let Ok(raw) = scenecast_build::build::raw_dir(dir) {
        let recording = raw.join("recording.json");
        if recording.is_file() {
            s.recorded = true;
            s.recorded_at = millis(&recording);
            let r = read_json(&recording);
            s.screens = r
                .as_ref()
                .and_then(|r| r["states"].as_object().map(|o| o.len()))
                .unwrap_or(0);
            s.timing = crate::timeline::summary(dir, r.as_ref());
        }
    }
    if let Some(m) = manifest {
        for scene in &m.graph.scenes {
            if scene.kind == SceneKind::LivePage {
                if scene.live.as_ref().is_some_and(|l| !l.snapshot.is_empty())
                    && dir
                        .join(&scene.live.as_ref().expect("checked").snapshot)
                        .is_file()
                {
                    s.live_scenes += 1;
                }
            } else {
                s.fallback_scenes += 1;
            }
        }
        s.built = s.live_scenes > 0;
        if s.built {
            s.built_at = millis(&dir.join("manifest.json"));
        }
    }
    let report = dir.join(".out/fidelity/report.json");
    if let Some(r) = read_json(&report) {
        let items = r["items"].as_array().cloned().unwrap_or_default();
        // A screen is its own view (kind "state"; an older report without kinds: an id with no "@" or "+").
        let own = |i: &Value| {
            i["kind"].as_str().map_or_else(
                || !i["id"].as_str().unwrap_or_default().contains(['@', '+']),
                |k| k == "state",
            )
        };
        let mut screens: BTreeMap<String, bool> = BTreeMap::new();
        let mut views_differ = 0;
        for i in &items {
            if own(i) {
                let key = i["state"].as_str().or(i["id"].as_str()).unwrap_or_default();
                screens.insert(key.to_owned(), i["pass"] == true);
            } else if i["pass"] != true {
                views_differ += 1;
            }
        }
        let total = screens.len();
        let within = screens.values().filter(|ok| **ok).count();
        let fonts_ok = r["fonts"]
            .as_array()
            .is_none_or(|f| f.iter().all(|f| f["status"] == "match"));
        s.fidelity = Some(FidelityScore {
            pass: r["pass"] == true,
            within,
            total,
            views_differ,
            score: if total == 0 {
                0.0
            } else {
                (within as f64 * 1000.0 / total as f64).round() / 10.0
            },
            fonts_ok,
            at: millis(&report),
        });
    }
    let checks = [(".out/fidelity.json", false), (".out/quick.json", true)]
        .into_iter()
        .filter_map(|(f, quick)| {
            let path = dir.join(f);
            Some((read_json(&path)?, quick, millis(&path)))
        })
        .max_by_key(|(_, _, at)| *at);
    if let Some((r, quick, at)) = checks {
        let items = r["items"].as_array().cloned().unwrap_or_default();
        let failed = items.iter().filter(|i| i["status"] == "fail").count();
        s.checks = Some(ChecksScore {
            pass: failed == 0,
            passed: items.iter().filter(|i| i["status"] == "pass").count(),
            failed,
            quick,
            at,
        });
    }
    s.focus_points = count_points(read_json(&dir.join("focus.json")).as_ref())
        .or_else(|| manifest.map(|m| m.focus_points.len()))
        .unwrap_or(0);
    s.has_script = crate::script::saved_script(dir).is_some();
    let rehearsal = crate::rundown::rehearsal_file(dir);
    if read_json(&rehearsal).is_some_and(|r| {
        r["events"]
            .as_array()
            .is_some_and(|e| e.iter().any(|e| e["beat"].as_u64().is_some_and(|b| b >= 1)))
    }) {
        s.rehearsed_at = millis(&rehearsal);
    }
    s.last_checked = [
        s.fidelity.as_ref().and_then(|f| f.at),
        s.checks.as_ref().and_then(|c| c.at),
    ]
    .into_iter()
    .flatten()
    .max();
    s.stage = if s.last_checked.is_some() && s.built {
        "checked"
    } else if s.built {
        "built"
    } else if s.recorded {
        "recorded"
    } else {
        "new"
    }
    .to_owned();
    s
}

fn count_points(focus: Option<&Value>) -> Option<usize> {
    match focus? {
        Value::Array(a) => Some(a.len()),
        Value::Object(o) => o
            .get("points")
            .and_then(Value::as_array)
            .map(Vec::len)
            .or_else(|| Some(o.values().filter_map(Value::as_array).map(Vec::len).sum())),
        _ => None,
    }
}

/// Copies a folder (skipping what `skip` says), creating `to`.
pub fn copy_dir(from: &Path, to: &Path, skip: &dyn Fn(&Path) -> bool) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        if skip(&path) {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&path, &target, skip)?;
        } else {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> (tempfile::TempDir, Library) {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path().join("library"));
        (tmp, lib)
    }

    fn new_demo(title: &str) -> NewDemo {
        NewDemo {
            title: title.into(),
            apps: vec![
                NewApp {
                    id: String::new(),
                    url: "https://chat.example.com/".into(),
                },
                NewApp {
                    id: "Admin".into(),
                    url: "https://admin.example.com/tools".into(),
                },
            ],
            browser: Some("edge".into()),
            profile: None,
            ..Default::default()
        }
    }

    #[test]
    fn keeps_how_a_demo_is_made() {
        let (_tmp, lib) = lib();
        assert_eq!(lib.create(&new_demo("Mine")).unwrap().mode, "manual");
        let d = lib
            .create(&NewDemo {
                mode: Some("record".into()),
                goal: Some("Show the supplier delay".into()),
                ..new_demo("For me")
            })
            .unwrap();
        assert_eq!(d.mode, "record");
        assert_eq!(
            crate::ai::read(&d.dir).goal.as_deref(),
            Some("Show the supplier delay")
        );
        assert!(
            lib.create(&NewDemo {
                mode: Some("magic".into()),
                ..new_demo("Bad")
            })
            .is_err()
        );
        assert!(lib.get("bad").is_err(), "nothing is made for a bad mode");
    }

    #[test]
    fn a_demos_own_recording_is_found_and_a_shared_one_is_not() {
        let (tmp, lib) = lib();
        let a = lib.create(&new_demo("A")).unwrap();
        let b = lib.create(&new_demo("B")).unwrap();
        let raw = tmp.path().join("raw-a");
        fs::create_dir_all(&raw).unwrap();
        let point = |d: &Demo, to: &Path| {
            let file = d.dir.join("demo.json");
            let mut cfg: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
            cfg["raw"] = Value::from(to.display().to_string());
            fs::write(&file, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
        };
        point(&a, &raw);
        assert_eq!(lib.own_recording("a"), Some(raw.clone()));
        assert_eq!(lib.own_recording("b"), None, "no recording yet");
        point(&b, &raw);
        assert_eq!(lib.own_recording("a"), None, "B records there too");
    }

    #[test]
    fn an_apps_address_changes_with_its_match() {
        let (_tmp, lib) = lib();
        let d = lib.create(&new_demo("Apps")).unwrap();
        let after = set_app(&d.dir, "admin", "https://admin.cloud.microsoft/?home").unwrap();
        assert_eq!(after.apps[1].url, "https://admin.cloud.microsoft/?home");
        let cfg: Value =
            serde_json::from_slice(&fs::read(d.dir.join("demo.json")).unwrap()).unwrap();
        assert_eq!(cfg["apps"][1]["match"], "admin.cloud.microsoft");
        assert_eq!(
            read_manifest(&d.dir).unwrap().apps[1].url.as_deref(),
            Some("https://admin.cloud.microsoft/?home")
        );
        assert!(set_app(&d.dir, "admin", "admin.cloud.microsoft").is_err());
        assert!(set_app(&d.dir, "nope", "https://x.example/").is_err());
    }

    #[test]
    fn keeps_the_slot_with_the_guide_settings() {
        let (_tmp, lib) = lib();
        assert_eq!(lib.create(&new_demo("No slot")).unwrap().slot, None);
        let d = lib
            .create(&NewDemo {
                slot: Some(480),
                ..new_demo("Eight minutes")
            })
            .unwrap();
        assert_eq!(d.slot, Some(480));
        let file = d.dir.join("demo.json");
        let mut cfg: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        cfg["presenter"]["script"] = Value::from("presenter/script.md");
        fs::write(&file, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
        set_slot(&d.dir, Some(300)).unwrap();
        assert_eq!(lib.get(&d.id).unwrap().slot, Some(300));
        set_slot(&d.dir, None).unwrap();
        let cfg: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(lib.get(&d.id).unwrap().slot, None);
        assert_eq!(cfg["presenter"]["script"], "presenter/script.md");
    }

    #[test]
    fn creates_lists_and_names_demos_from_their_titles() {
        let (_tmp, lib) = lib();
        assert!(lib.list().unwrap().is_empty());
        let a = lib.create(&new_demo("Contoso: Supplier delay")).unwrap();
        assert_eq!(a.id, "contoso-supplier-delay");
        assert_eq!(a.title, "Contoso: Supplier delay");
        assert_eq!(
            a.apps.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["chat", "admin"]
        );
        assert!(a.apps.iter().all(|a| a.key.is_some()));
        assert_eq!(a.status.stage, "new");
        assert!(!a.status.recorded && !a.status.built);
        assert_eq!(crate::record::browser(&a.dir), "edge");
        let b = lib.create(&new_demo("Contoso: supplier delay")).unwrap();
        assert_eq!(b.id, "contoso-supplier-delay-2");
        assert_eq!(lib.list().unwrap().len(), 2);
    }

    #[test]
    fn refuses_a_demo_without_a_name_or_an_app() {
        let (_tmp, lib) = lib();
        let mut spec = new_demo("  ");
        assert!(matches!(lib.create(&spec), Err(AppError::Invalid(_))));
        spec.title = "x".into();
        spec.apps = vec![NewApp {
            id: String::new(),
            url: " ".into(),
        }];
        assert!(
            lib.create(&spec)
                .unwrap_err()
                .to_string()
                .contains("at least one app")
        );
        spec.apps[0].url = "chat.example.com".into();
        assert!(
            lib.create(&spec)
                .unwrap_err()
                .to_string()
                .contains("https://")
        );
    }

    #[test]
    fn duplicates_with_its_own_name_port_and_raw_folder() {
        let (tmp, lib) = lib();
        let a = lib.create(&new_demo("Hello")).unwrap();
        // A recording in the demo's own raw folder (relative, so the test stays in its temp dir).
        let mut cfg: Value =
            serde_json::from_slice(&fs::read(a.dir.join("demo.json")).unwrap()).unwrap();
        cfg["raw"] = Value::from(tmp.path().join("raw-hello").to_string_lossy().into_owned());
        fs::write(a.dir.join("demo.json"), cfg.to_string()).unwrap();
        fs::create_dir_all(tmp.path().join("raw-hello")).unwrap();
        fs::write(
            tmp.path().join("raw-hello/recording.json"),
            r#"{"states":{"a":{},"b":{}}}"#,
        )
        .unwrap();
        let a = lib.get(&a.id).unwrap();
        assert!(a.status.recorded);
        assert_eq!((a.status.screens, a.status.stage.as_str()), (2, "recorded"));

        let b = lib.duplicate(&a.id, Some("Hello again")).unwrap();
        assert_eq!(
            (b.id.as_str(), b.title.as_str()),
            ("hello-again", "Hello again")
        );
        assert_ne!(a.port, b.port);
        assert_eq!(read_manifest(&b.dir).unwrap().title, "Hello again");
        // An explicit raw folder is shared, not copied: both demos point at the same recording.
        assert!(b.status.recorded);

        let c = lib.duplicate(&b.id, None).unwrap();
        assert_eq!(c.title, "Hello again copy");
        let removed = lib.remove(&c.id).unwrap();
        assert!(!removed.exists());
        assert_eq!(lib.list().unwrap().len(), 2);
    }

    #[test]
    fn rejects_ids_that_leave_the_library() {
        let (_tmp, lib) = lib();
        lib.create(&new_demo("Safe")).unwrap();
        for id in ["", "..", "../safe", "safe/..", ".hidden", "c:x", "missing"] {
            assert!(matches!(lib.dir(id), Err(AppError::NoDemo(_))), "{id}");
        }
        assert!(lib.dir("safe").is_ok());
    }

    #[test]
    fn reads_fidelity_checks_and_focus_points_from_the_demo() {
        let (_tmp, lib) = lib();
        let a = lib.create(&new_demo("Status")).unwrap();
        fs::create_dir_all(a.dir.join(".out/fidelity")).unwrap();
        fs::write(
            a.dir.join(".out/fidelity/report.json"),
            r#"{"pass":false,"threshold":0.5,"rounds":[],"fonts":[{"status":"match"}],"fixes":[],
               "items":[{"id":"a","pass":true},{"id":"b","pass":true},{"id":"c","pass":false},
                        {"id":"a@150","state":"a","pass":true},{"id":"b@150","state":"b","pass":false}]}"#,
        )
        .unwrap();
        fs::write(
            a.dir.join(".out/quick.json"),
            r#"{"items":[{"status":"pass"},{"status":"warn"},{"status":"fail"}]}"#,
        )
        .unwrap();
        fs::write(a.dir.join("focus.json"), r#"{"points":[{},{},{}]}"#).unwrap();
        let s = lib.get(&a.id).unwrap().status;
        let f = s.fidelity.unwrap();
        // Each screen by its own verdict, as Review: a and b match, c doesn't; b's 150% differs, counted apart.
        assert_eq!(
            (f.within, f.total, f.views_differ, f.score, f.pass),
            (2, 3, 1, 66.7, false)
        );
        assert!(f.fonts_ok);
        let c = s.checks.unwrap();
        assert_eq!((c.passed, c.failed, c.quick, c.pass), (1, 1, true, false));
        assert_eq!(s.focus_points, 3);
        assert!(s.last_checked.is_some());
        // Not built yet: checked results alone don't make it "checked".
        assert_eq!(s.stage, "new");
    }

    #[test]
    fn slugs_and_app_ids() {
        assert_eq!(slug("  Ignite '26 — Demo 1! "), "ignite-26-demo-1");
        assert_eq!(app_id_from_url("https://www.contoso.com/x"), "contoso");
        assert_eq!(app_id_from_url("http://127.0.0.1:4100/chat?x=1"), "chat");
        assert_eq!(app_id_from_url("http://localhost:4100/"), "app");
        assert_eq!(app_id_from_url("https://preview.iq.example.com/w"), "iq");
        assert_eq!(app_id_from_url("https://portal.azure.com/#home"), "azure");
        assert_eq!(app_id_from_url("https://teams.cloud.microsoft/"), "teams");
    }
}
