//! `scenecast new`: a demo project folder whose scenes are live pages (the engine's captured DOM) by default.
//!
//! The folder is both the engine's demo folder (`demo.json`, `focus.mjs`, `flow.overrides.mjs`, `capture/`) and
//! a scenecast bundle (`manifest.json`, schema v2). The template lives in `packages/core/template/`, embedded here
//! so the binary needs nothing else to scaffold.

use std::fs;
use std::path::{Path, PathBuf};

use stuntdouble_format::{
    App, BundleManifest, MANIFEST_FILE_NAME, Scene, SceneId, Section, Viewport, write_manifest,
};
use thiserror::Error;

const TEMPLATE: &[(&str, &str)] = &[
    (
        "demo.json",
        include_str!("../../../packages/core/template/demo.json"),
    ),
    (
        "focus.mjs",
        include_str!("../../../packages/core/template/focus.mjs"),
    ),
    (
        "flow.overrides.mjs",
        include_str!("../../../packages/core/template/flow.overrides.mjs"),
    ),
    (
        "README.md",
        include_str!("../../../packages/core/template/README.md"),
    ),
    (
        ".gitignore",
        include_str!("../../../packages/core/template/gitignore"),
    ),
    (
        ".gitattributes",
        include_str!("../../../packages/core/template/gitattributes"),
    ),
    (
        "capture/README.md",
        include_str!("../../../packages/core/template/capture/README.md"),
    ),
    (
        "capture/prep.js",
        include_str!("../../../packages/core/template/capture/prep.js"),
    ),
    (
        "capture/vendor/README.md",
        include_str!("../../../packages/core/template/capture/vendor/README.md"),
    ),
];

/// One app (browser tab) of the demo: `id=url` on the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppSpec {
    pub id: String,
    pub url: String,
}

impl std::str::FromStr for AppSpec {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (id, url) = value
            .split_once('=')
            .ok_or_else(|| format!("`{value}`: expected id=url"))?;
        let id = id.trim();
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!(
                "app id `{id}`: lowercase letters, digits and dashes"
            ));
        }
        Ok(Self {
            id: id.to_owned(),
            url: url.trim().to_owned(),
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct NewProject {
    /// The folder to create (it may exist if it's empty).
    pub dir: PathBuf,
    pub title: Option<String>,
    pub apps: Vec<AppSpec>,
    /// The replica's localhost port; derived from the name when not given.
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectCreated {
    pub dir: PathBuf,
    pub name: String,
    pub title: String,
    pub port: u16,
    pub apps: Vec<App>,
}

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("`{0}` already contains a {MANIFEST_FILE_NAME}")]
    AlreadyABundle(String),
    #[error("`{0}` exists and is not a directory")]
    NotADirectory(String),
    #[error("`{0}` exists and is not empty")]
    NotEmpty(String),
    #[error("bundle title must not be empty")]
    EmptyTitle,
    #[error("two apps have the id `{0}`")]
    DuplicateApp(String),
    #[error("failed to write `{path}`")]
    Write {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Manifest(#[from] stuntdouble_format::BundleIoError),
}

/// Creates a project: the engine's template, plus a v2 manifest whose start scene is a live page waiting to be
/// recorded. Never a screenshot or video-frame scene: those are only added on request, as fallbacks.
pub fn create_project(spec: &NewProject) -> Result<ProjectCreated, ProjectError> {
    let dir = &spec.dir;
    let shown = dir.display().to_string();
    if dir.join(MANIFEST_FILE_NAME).exists() {
        return Err(ProjectError::AlreadyABundle(shown));
    }
    if dir.is_file() {
        return Err(ProjectError::NotADirectory(shown));
    }
    if dir.exists()
        && dir
            .read_dir()
            .map_err(|source| write_err(dir, source))?
            .next()
            .is_some()
    {
        return Err(ProjectError::NotEmpty(shown));
    }

    let name = project_name(dir);
    let title = spec
        .title
        .clone()
        .unwrap_or_else(|| default_title(dir))
        .trim()
        .to_owned();
    if title.is_empty() {
        return Err(ProjectError::EmptyTitle);
    }
    let port = spec.port.unwrap_or_else(|| default_port(&name));
    let apps = assign_apps(&spec.apps)?;

    for (rel, contents) in TEMPLATE {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| write_err(parent, source))?;
        }
        let text = fill(contents, &name, &title, port, &apps);
        fs::write(&path, text).map_err(|source| write_err(&path, source))?;
    }
    // data/: what the build writes. captures/ and assets/: fallback scenes' images, if any are ever needed.
    for sub in ["data", "captures", "assets"] {
        let path = dir.join(sub);
        fs::create_dir_all(&path).map_err(|source| write_err(&path, source))?;
    }

    let manifest_apps: Vec<App> = apps
        .iter()
        .map(|a| App {
            id: a.id.clone(),
            title: a.title.clone(),
            key: Some(a.key.to_string()),
            url: Some(a.url.clone()),
        })
        .collect();
    let mut manifest = BundleManifest::starter(&title);
    manifest.apps = manifest_apps.clone();
    manifest.viewport = Some(Viewport {
        width: 1920,
        height: 1080,
        dpr: 2.0,
    });
    // One start scene per app (`<app>-start`, the recorder's name for it), live pages to be recorded. Without
    // --app there's one placeholder app and the start scene is plain `start`.
    let starts: Vec<SceneId> = if spec.apps.is_empty() {
        vec![SceneId::new("start").expect("static scene id is valid")]
    } else {
        apps.iter()
            .map(|a| SceneId::new(format!("{}-start", a.id)).expect("app ids are valid scene ids"))
            .collect()
    };
    manifest.graph.scenes = apps
        .iter()
        .zip(&starts)
        .map(|(a, id)| Scene {
            notes: Some(format!(
                "{} start screen: recorded by scenecast record",
                a.title
            )),
            ..Scene::live_page(
                id.clone(),
                if spec.apps.is_empty() {
                    "Start".to_owned()
                } else {
                    format!("{} start", a.title)
                },
                None,
            )
        })
        .collect();
    manifest.graph.start_scene = starts[0].clone();
    manifest.sections = vec![Section {
        id: "main".to_owned(),
        title: "Main".to_owned(),
        scenes: starts,
    }];
    write_manifest(dir, &manifest)?;

    Ok(ProjectCreated {
        dir: dir.clone(),
        name,
        title,
        port,
        apps: manifest_apps,
    })
}

#[derive(Debug, Clone)]
struct ScaffoldApp {
    id: String,
    key: char,
    title: String,
    url: String,
    host: String,
}

// Each app's presenter key is a letter of its id (not F, G, N or P: the focus, presenter guide, next and fill keys).
fn assign_apps(specs: &[AppSpec]) -> Result<Vec<ScaffoldApp>, ProjectError> {
    let defaults = [AppSpec {
        id: "app".to_owned(),
        url: "https://example.com/".to_owned(),
    }];
    let specs = if specs.is_empty() {
        &defaults[..]
    } else {
        specs
    };
    let mut used: Vec<char> = Vec::new();
    let mut apps: Vec<ScaffoldApp> = Vec::new();
    for spec in specs {
        if apps.iter().any(|a| a.id == spec.id) {
            return Err(ProjectError::DuplicateApp(spec.id.clone()));
        }
        let free = |c: &char| c.is_ascii_uppercase() && !used.contains(c) && !"FGNP".contains(*c);
        let key = spec
            .id
            .to_ascii_uppercase()
            .chars()
            .find(free)
            .or_else(|| ('A'..='Z').find(free))
            .unwrap_or('A');
        used.push(key);
        let title = app_title(&spec.id);
        apps.push(ScaffoldApp {
            id: spec.id.clone(),
            key,
            title,
            url: spec.url.clone(),
            host: host_of(&spec.url),
        });
    }
    Ok(apps)
}

/// An app's name from its id, as the app window shows it: `iq` is IQ, `admin-center` is Admin center.
fn app_title(id: &str) -> String {
    let words = id.replace(['-', '_'], " ");
    let words = words.trim();
    if words.chars().count() <= 3 {
        return words.to_uppercase();
    }
    let mut c = words.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

// The app's tab is found by its host (demo.json `match`).
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if host.is_empty() {
        url.to_owned()
    } else {
        host.to_owned()
    }
}

fn fill(template: &str, name: &str, title: &str, port: u16, apps: &[ScaffoldApp]) -> String {
    let json = |s: &str| serde_json::to_string(s).expect("strings serialize");
    let apps_json = format!(
        "[\n{}\n  ]",
        apps.iter()
            .map(|a| format!(
                "    {{\"id\": {}, \"key\": {}, \"title\": {}, \"url\": {}, \"match\": {}}}",
                json(&a.id),
                json(&a.key.to_string()),
                json(&a.title),
                json(&a.url),
                json(&a.host)
            ))
            .collect::<Vec<_>>()
            .join(",\n")
    );
    let app_keys = apps
        .iter()
        .map(|a| {
            format!(
                "| **⌥{}** | Switch to {}, like clicking its browser tab. |",
                a.key, a.title
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    template
        .replace("__NAME__", name)
        .replace("__TITLE__", title)
        .replace("__PORT__", &port.to_string())
        .replace("__APPS__", &apps_json)
        .replace("| __APPKEYS__ |", &app_keys)
}

/// The project's name: its folder name, as lowercase letters, digits and dashes (`Demo 2.scenecast` → `demo-2`).
pub fn project_name(dir: &Path) -> String {
    let stem = dir
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("demo")
        .to_ascii_lowercase();
    let mut name = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c);
        } else if !name.ends_with('-') {
            name.push('-');
        }
    }
    let name = name.trim_matches('-').to_owned();
    if name.is_empty() {
        "demo".to_owned()
    } else {
        name
    }
}

fn default_title(dir: &Path) -> String {
    dir.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Untitled Scenecast")
        .to_owned()
}

/// A port from the name (4620–4919), so two demos rarely share one.
pub fn default_port(name: &str) -> u16 {
    let hash = name
        .chars()
        .fold(7u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32));
    4620 + (hash % 300) as u16
}

fn write_err(path: &Path, source: std::io::Error) -> ProjectError {
    ProjectError::Write {
        path: path.display().to_string(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stuntdouble_format::{SceneKind, read_manifest};

    #[test]
    fn new_project_is_live_page_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let created = create_project(&NewProject {
            dir: temp.path().join("Ignite Demo.scenecast"),
            title: Some("Ignite".to_owned()),
            apps: vec![
                "chat=https://chat.example.test/c?x=1".parse().unwrap(),
                "admin=https://admin.example.test/".parse().unwrap(),
            ],
            port: None,
        })
        .unwrap();

        assert_eq!(created.name, "ignite-demo");
        assert_eq!(
            ["iq", "admin-center", "chat"].map(app_title),
            ["IQ", "Admin center", "Chat"]
        );
        let keys: Vec<_> = created.apps.iter().map(|a| a.key.clone()).collect();
        assert_eq!(keys, [Some("C".to_owned()), Some("A".to_owned())]);
        let manifest = read_manifest(&created.dir).unwrap();
        assert!(
            manifest
                .graph
                .scenes
                .iter()
                .all(|s| s.kind == SceneKind::LivePage)
        );
        assert_eq!(manifest.graph.start_scene.as_str(), "chat-start");
        assert!(manifest.validate().is_valid());

        let demo: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(created.dir.join("demo.json")).unwrap())
                .unwrap();
        assert_eq!(demo["name"], "ignite-demo");
        assert_eq!(demo["apps"][0]["match"], "chat.example.test");
        assert_eq!(demo["port"], created.port);
        assert!(created.dir.join(".gitattributes").is_file());
    }

    #[test]
    fn new_project_refuses_a_folder_with_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("x"), "").unwrap();
        let err = create_project(&NewProject {
            dir: temp.path().to_path_buf(),
            ..NewProject::default()
        })
        .unwrap_err();
        assert!(matches!(err, ProjectError::NotEmpty(_)));
    }
}
