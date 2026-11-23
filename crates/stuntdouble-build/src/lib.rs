//! Scenecast's build orchestration, as a library: everything the `scenecast` CLI does beyond editing a manifest
//! is callable from Rust here (the CLI, and later the desktop app, sit on top), with structured results and
//! progress instead of printed text.
//!
//! - [`project`]: a new demo project (`scenecast new`): live-page by default.
//! - [`engine`]: the JavaScript engine in `packages/` (recorder, player, checks), run under Node.
//! - [`recorder`]: preflight, the recorder extension and the recording, with per-item progress and timing.
//! - [`sync`]: the bundle manifest (v2) from what the engine built (`flow.json`, `data/`).
//! - [`build`]: content-hashed build orchestration and scrub reporting with structured progress.
//! - [`fidelity`]: the fidelity loop: real vs replica, diagnose, patch, build, again; with a residual report.
//! - [`script`]: script to focus points: each line on its screen, its focus points, the line-to-screen and cue sheets.
//! - [`edit`]: the editor: the replica served in edit mode, each saved change reported.

pub mod build;
pub mod compose;
pub mod edit;
pub mod engine;
pub mod export;
pub mod fidelity;
pub mod fingerprint;
pub mod flow;
pub mod interactions;
pub mod par;
pub mod project;
pub mod publish;
pub mod recorder;
pub mod script;
pub mod scrub;
pub mod streams;
pub mod sync;

use std::path::{Path, PathBuf};

pub use engine::{Bundled, Engine, EngineError, Progress, use_bundled};
pub use project::{AppSpec, NewProject, ProjectCreated, ProjectError, create_project};
pub use sync::{SyncError, SyncReport, fallback_scenes, sync_manifest};

/// The demo settings file at the root of every project.
pub const DEMO_FILE: &str = "demo.json";

/// Finds a project folder: `given`, else the nearest folder at or above `cwd` with a `demo.json`.
pub fn find_project_dir(given: Option<&Path>, cwd: &Path) -> Option<PathBuf> {
    if let Some(dir) = given {
        return dir.join(DEMO_FILE).is_file().then(|| dir.to_path_buf());
    }
    cwd.ancestors()
        .find(|dir| dir.join(DEMO_FILE).is_file())
        .map(Path::to_path_buf)
}
pub mod assets;
