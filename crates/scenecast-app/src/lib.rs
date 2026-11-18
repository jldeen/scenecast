//! What the Scenecast desktop app calls, as a library with no UI toolkit in it: the demo library, and each step of a
//! demo (record, build and check, fidelity, script, edit, present, export) with structured, serializable progress.
//! The Tauri shell (`apps/desktop`) turns these into commands and events; the CLI drives the same `scenecast-build`
//! underneath.
//!
//! - [`library`]: the user's demos and where each stands (recorded, built, fidelity score, focus points, last checked).
//! - [`record`]: the recorder extension, preflight item by item, and the recording.
//! - [`build`]: the build with its scrub report, and the checklist.
//! - [`fidelity`]: the fidelity loop and its report, real vs replica for each state.
//! - [`script`]: script to focus points, and its sheets.
//! - [`servers`]: the replica served for the editor or for presenting.
//! - [`keys`]: the presenter's one-page key reference.
//! - [`export`]: a plain folder or a zip for another presenter.
//! - [`files`]: a local, token-guarded file server for reports and pictures shown in the app.
//! - [`updates`]: app updates (a stub for now).

pub mod build;
pub mod export;
pub mod fidelity;
pub mod files;
pub mod keys;
pub mod library;
pub mod record;
pub mod script;
pub mod servers;
pub mod updates;

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use thiserror::Error;

pub use library::{Demo, DemoStatus, Library, NewApp, NewDemo};

#[derive(Debug, Error)]
pub enum AppError {
    #[error("there's no demo called `{0}` in the library")]
    NoDemo(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Project(#[from] scenecast_build::ProjectError),
    #[error(transparent)]
    Bundle(#[from] scenecast_core::BundleIoError),
    #[error(transparent)]
    Engine(#[from] scenecast_build::EngineError),
    #[error(transparent)]
    Recorder(#[from] scenecast_build::recorder::RecorderError),
    #[error(transparent)]
    Build(#[from] scenecast_build::build::BuildError),
    #[error(transparent)]
    Fidelity(#[from] scenecast_build::fidelity::FidelityError),
    #[error(transparent)]
    Script(#[from] scenecast_build::script::ScriptError),
    #[error(transparent)]
    Edit(#[from] scenecast_build::edit::EditError),
    #[error(transparent)]
    Export(#[from] scenecast_build::export::ExportError),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
}

/// Errors reach the app's window as their message.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// One piece of progress, as the app's window shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Update {
    /// A step of a longer job starts.
    Stage { name: String, label: String },
    /// A line of the engine's output.
    Line { text: String, error: bool },
    /// A preflight item as it lands.
    Preflight {
        item: scenecast_build::recorder::PreflightItem,
    },
    /// The recorder now.
    Record {
        status: scenecast_build::recorder::RecordStatus,
    },
    /// A checklist item.
    Check {
        id: String,
        status: String,
        detail: String,
    },
    /// A fidelity loop or script event, as the engine reports it.
    Event {
        source: String,
        event: String,
        data: Map<String, Value>,
    },
    /// The editor saved (or refused) a change.
    Saved { data: Map<String, Value> },
}

impl Update {
    pub fn stage(name: &str, label: &str) -> Self {
        Self::Stage {
            name: name.to_owned(),
            label: label.to_owned(),
        }
    }

    pub fn line(progress: &scenecast_build::Progress) -> Self {
        match progress {
            scenecast_build::Progress::Stdout(text) => Self::Line {
                text: text.clone(),
                error: false,
            },
            scenecast_build::Progress::Stderr(text) => Self::Line {
                text: text.clone(),
                error: true,
            },
        }
    }
}

/// The engine (`packages/` under Node), checked once so a missing Node reads as one clear message.
pub fn engine() -> Result<scenecast_build::Engine, AppError> {
    let engine = scenecast_build::Engine::locate()?;
    engine.check_node()?;
    Ok(engine)
}
