//! Scenecast's build orchestration, as a library: everything the `scenecast` CLI does beyond editing a manifest
//! is callable from Rust here (the CLI, and later the desktop app, sit on top), with structured results and
//! progress instead of printed text.
//!
//! - [`project`]: a new demo project (`scenecast new`): live-page by default.
//! - [`engine`]: the JavaScript engine in `packages/` (recorder, player, checks), run under Node.
//! - [`recorder`]: preflight, the recorder extension and the recording, with per-item progress and timing.
//! - [`sync`]: the bundle manifest (v2) from what the engine built (`flow.json`, `data/`).

pub mod engine;
pub mod fingerprint;
pub mod project;
pub mod recorder;
pub mod scrub;
pub mod sync;

use std::path::{Path, PathBuf};

pub use engine::{Engine, EngineError, Progress};
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
