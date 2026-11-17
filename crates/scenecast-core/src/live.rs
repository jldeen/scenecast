//! Bundle v2: live-page scenes and what the replica engine plays on top of them.
//!
//! A `live-page` scene is a captured page (DOM, CSSOM, fonts, shadow DOM, iframes) that the player morphs into.
//! It's the default scene kind. Screenshot and video-frame scenes stay only as fallbacks for screens that can't be
//! captured live, or for explicit video import.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    BundleManifest, SceneId, ValidationError, ValidationReport, ValidationWarning,
    validate_identifier, validate_portable_asset_path,
};

/// One web app the demo shows (a browser tab on the real machine).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct App {
    pub id: String,
    pub title: String,
    /// Presenter key: one letter, pressed with the presenter modifier (⌥ on the Mac, Ctrl+Alt on Windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The page's start URL on the real product. Only the origin and path; never tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// The captured page behind a `live-page` scene.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LivePage {
    /// The app (tab) the page belongs to.
    pub app: String,
    /// The captured page, relative to the bundle root (`data/snaps/<id>.html`).
    pub snapshot: String,
    /// The window title while the scene shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// A screenshot of the real page, kept only as the fidelity reference (never shown as the scene).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// SHA-256 of the snapshot as built, for incremental builds and drift checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum StateTrigger {
    Click,
    Enter,
    Type,
    Hover,
    Escape,
}

/// A move from one live-page scene to another: the player morphs the page into the target's capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StateTransition {
    pub trigger: StateTrigger,
    pub target: SceneId,
    /// What the trigger acts on: a matcher (`sel`, `text`, `label`, `testid`, `in`, `nth`, `frame`, …). Never a
    /// generated class.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<serde_json::Value>,
    /// A streamed answer that plays before the target settles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    /// Switches to another app after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// Player-specific ordering and behavior not represented by the common transition fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback: Option<TransitionPlayback>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransitionPlayback {
    pub order: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_key: Option<String>,
    #[serde(default)]
    pub options: serde_json::Value,
}

/// Additional browser-player data. Scene, app, beat, stream and focus identities remain in the bundle model.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlaybackData {
    #[serde(default)]
    pub options: serde_json::Value,
    #[serde(default)]
    pub apps: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub scenes: BTreeMap<String, ScenePlayback>,
    #[serde(default)]
    pub streams: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub focus_points: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScenePlayback {
    #[serde(default)]
    pub options: serde_json::Value,
    #[serde(default)]
    pub actions: Vec<PlaybackAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlaybackAction {
    pub order: u32,
    pub action: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum StreamTiming {
    /// Each frame at its recorded time, scaled to the stream's duration.
    #[default]
    Real,
    /// Frames spread evenly.
    Even,
}

/// A streamed AI answer, replayed from its captured frames at a set pace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Stream {
    pub id: String,
    /// The scene the answer ends on.
    pub target: SceneId,
    /// How many captured frames it plays.
    pub frames: u32,
    #[serde(default)]
    pub timing: StreamTiming,
    /// Replay length at the default pace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// What was sent to get it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// A presenter beat: modifier+0 is beats[0] (reset), modifier+1…9 are beats[1…9].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Beat {
    pub label: String,
    /// The app on screen.
    pub active: String,
    /// The scene each app is on at this beat.
    #[serde(default)]
    pub scenes: BTreeMap<String, SceneId>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum FocusMark {
    /// A rectangle around the target (ZoomIt's box).
    #[default]
    Box,
    /// An arrow pointing at the target.
    Arrow,
    /// Zoom only, no mark.
    Zoom,
}

/// A ZoomIt-style focus point: zoom to fit the target and draw its mark.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FocusPoint {
    pub id: String,
    /// The beat it belongs to (the presenter key that lands just before it).
    pub beat: u32,
    pub app: String,
    pub scenes: Vec<SceneId>,
    /// Text on screen to find.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub find: Option<String>,
    /// Matchers whose combined box is the target.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub union: Vec<serde_json::Value>,
    #[serde(default)]
    pub mark: FocusMark,
    /// For an arrow: the side its tail comes from (`n`, `ne`, `e`, `se`, `s`, `sw`, `w`, `nw`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// The script line it goes with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PresenterModifier {
    /// ⌥ alone.
    Alt,
    /// Ctrl+Alt: for Windows and Edge, which keep Alt alone for their menus.
    CtrlAlt,
}

/// Hidden presenter keys. The player accepts both modifiers on every OS; these are the ones the docs and cue
/// sheets show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PresenterConfig {
    pub macos: PresenterModifier,
    pub windows: PresenterModifier,
    /// Next focus point (with Shift: the one before).
    pub focus_key: String,
    /// Type the scripted text into the field.
    pub fill_key: String,
    /// The screen's next step.
    pub next_key: String,
}

impl Default for PresenterConfig {
    fn default() -> Self {
        Self {
            macos: PresenterModifier::Alt,
            windows: PresenterModifier::CtrlAlt,
            focus_key: "F".to_owned(),
            fill_key: "P".to_owned(),
            next_key: "N".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    #[serde(default = "one")]
    pub dpr: f32,
}

fn one() -> f32 {
    1.0
}

#[derive(Debug, Clone, PartialEq)]
pub enum LiveError {
    InvalidAppId {
        app: String,
        reason: &'static str,
    },
    DuplicateAppId {
        app: String,
    },
    InvalidAppKey {
        app: String,
        key: String,
    },
    DuplicateAppKey {
        key: String,
    },
    UnknownApp {
        context: String,
        app: String,
    },
    MissingTransitionTarget {
        scene_id: SceneId,
        target: SceneId,
    },
    MissingStream {
        scene_id: SceneId,
        stream: String,
    },
    DuplicateStreamId {
        stream: String,
    },
    InvalidStreamId {
        stream: String,
        reason: &'static str,
    },
    MissingStreamTarget {
        stream: String,
        target: SceneId,
    },
    EmptyStream {
        stream: String,
    },
    MissingBeatScene {
        beat: usize,
        scene_id: SceneId,
    },
    DuplicateFocusId {
        id: String,
    },
    InvalidFocusId {
        id: String,
        reason: &'static str,
    },
    FocusBeatOutOfRange {
        id: String,
        beat: u32,
        beats: usize,
    },
    MissingFocusScene {
        id: String,
        scene_id: SceneId,
    },
    FocusWithoutTarget {
        id: String,
    },
    LiveDataOnFallbackScene {
        scene_id: SceneId,
    },
    InvalidPresenterKey {
        key: String,
    },
}

impl fmt::Display for LiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAppId { app, reason } => {
                write!(f, "app id `{app}` is not valid: {reason}")
            }
            Self::DuplicateAppId { app } => write!(f, "app id `{app}` is duplicated"),
            Self::InvalidAppKey { app, key } => write!(
                f,
                "app `{app}` key `{key}` must be one letter A-Z, not F, N or P (those are presenter keys)"
            ),
            Self::DuplicateAppKey { key } => write!(f, "presenter key `{key}` is used by two apps"),
            Self::UnknownApp { context, app } => {
                write!(f, "{context} refers to unknown app `{app}`")
            }
            Self::MissingTransitionTarget { scene_id, target } => write!(
                f,
                "scene `{scene_id}` has a transition to missing scene `{target}`"
            ),
            Self::MissingStream { scene_id, stream } => write!(
                f,
                "scene `{scene_id}` has a transition that plays missing stream `{stream}`"
            ),
            Self::DuplicateStreamId { stream } => write!(f, "stream id `{stream}` is duplicated"),
            Self::InvalidStreamId { stream, reason } => {
                write!(f, "stream id `{stream}` is not valid: {reason}")
            }
            Self::MissingStreamTarget { stream, target } => {
                write!(f, "stream `{stream}` ends on missing scene `{target}`")
            }
            Self::EmptyStream { stream } => write!(f, "stream `{stream}` has no frames"),
            Self::MissingBeatScene { beat, scene_id } => {
                write!(f, "beat {beat} refers to missing scene `{scene_id}`")
            }
            Self::DuplicateFocusId { id } => write!(f, "focus point id `{id}` is duplicated"),
            Self::InvalidFocusId { id, reason } => {
                write!(f, "focus point id `{id}` is not valid: {reason}")
            }
            Self::FocusBeatOutOfRange { id, beat, beats } => write!(
                f,
                "focus point `{id}` is on beat {beat}, but there are only {beats} beats"
            ),
            Self::MissingFocusScene { id, scene_id } => {
                write!(f, "focus point `{id}` refers to missing scene `{scene_id}`")
            }
            Self::FocusWithoutTarget { id } => {
                write!(
                    f,
                    "focus point `{id}` needs `find` text or a `union` of matchers"
                )
            }
            Self::LiveDataOnFallbackScene { scene_id } => write!(
                f,
                "scene `{scene_id}` has a captured live page but is marked as a fallback scene; use kind `live-page`"
            ),
            Self::InvalidPresenterKey { key } => {
                write!(f, "presenter key `{key}` must be one letter A-Z")
            }
        }
    }
}

fn one_letter(key: &str) -> bool {
    key.len() == 1 && key.chars().all(|c| c.is_ascii_uppercase())
}

pub(crate) fn validate_live(manifest: &BundleManifest) -> ValidationReport {
    let mut errors: Vec<LiveError> = Vec::new();
    let mut report = ValidationReport::default();

    let mut app_ids = HashSet::new();
    let mut keys = HashSet::new();
    for app in &manifest.apps {
        if let Err(reason) = validate_identifier(&app.id) {
            errors.push(LiveError::InvalidAppId {
                app: app.id.clone(),
                reason,
            });
        }
        if !app_ids.insert(app.id.as_str()) {
            errors.push(LiveError::DuplicateAppId {
                app: app.id.clone(),
            });
        }
        if let Some(key) = &app.key {
            if !one_letter(key) || matches!(key.as_str(), "F" | "N" | "P") {
                errors.push(LiveError::InvalidAppKey {
                    app: app.id.clone(),
                    key: key.clone(),
                });
            } else if !keys.insert(key.as_str()) {
                errors.push(LiveError::DuplicateAppKey { key: key.clone() });
            }
        }
    }
    let known_app = |app: &str| manifest.apps.is_empty() || app_ids.contains(app);

    let p = &manifest.presenter;
    for key in [&p.focus_key, &p.fill_key, &p.next_key] {
        if !one_letter(key) {
            errors.push(LiveError::InvalidPresenterKey { key: key.clone() });
        }
    }

    let scene_ids: HashSet<&SceneId> = manifest.graph.scenes.iter().map(|s| &s.id).collect();
    let mut stream_ids = HashSet::new();
    for stream in &manifest.streams {
        if let Err(reason) = validate_identifier(&stream.id) {
            errors.push(LiveError::InvalidStreamId {
                stream: stream.id.clone(),
                reason,
            });
        }
        if !stream_ids.insert(stream.id.as_str()) {
            errors.push(LiveError::DuplicateStreamId {
                stream: stream.id.clone(),
            });
        }
        if !scene_ids.contains(&stream.target) {
            errors.push(LiveError::MissingStreamTarget {
                stream: stream.id.clone(),
                target: stream.target.clone(),
            });
        }
        if stream.frames == 0 {
            errors.push(LiveError::EmptyStream {
                stream: stream.id.clone(),
            });
        }
    }

    for scene in &manifest.graph.scenes {
        if let Some(live) = &scene.live {
            if scene.kind.is_fallback() {
                errors.push(LiveError::LiveDataOnFallbackScene {
                    scene_id: scene.id.clone(),
                });
            }
            if !known_app(&live.app) {
                errors.push(LiveError::UnknownApp {
                    context: format!("scene `{}`", scene.id),
                    app: live.app.clone(),
                });
            }
            for path in [Some(&live.snapshot), live.reference.as_ref()]
                .into_iter()
                .flatten()
            {
                if let Err(reason) = validate_portable_asset_path(path) {
                    report.errors.push(ValidationError::InvalidAssetPath {
                        path: path.clone(),
                        reason,
                    });
                }
            }
        } else if !scene.kind.is_fallback() {
            report.warnings.push(ValidationWarning::SceneNotRecorded {
                scene_id: scene.id.clone(),
            });
        }
        for t in &scene.transitions {
            if !scene_ids.contains(&t.target) {
                errors.push(LiveError::MissingTransitionTarget {
                    scene_id: scene.id.clone(),
                    target: t.target.clone(),
                });
            }
            if let Some(stream) = &t.stream
                && !stream_ids.contains(stream.as_str())
            {
                errors.push(LiveError::MissingStream {
                    scene_id: scene.id.clone(),
                    stream: stream.clone(),
                });
            }
            if let Some(app) = &t.app
                && !known_app(app)
            {
                errors.push(LiveError::UnknownApp {
                    context: format!("a transition on scene `{}`", scene.id),
                    app: app.clone(),
                });
            }
        }
    }

    for (i, beat) in manifest.beats.iter().enumerate() {
        if !known_app(&beat.active) {
            errors.push(LiveError::UnknownApp {
                context: format!("beat {i}"),
                app: beat.active.clone(),
            });
        }
        for (app, scene_id) in &beat.scenes {
            if !known_app(app) {
                errors.push(LiveError::UnknownApp {
                    context: format!("beat {i}"),
                    app: app.clone(),
                });
            }
            if !scene_ids.contains(scene_id) {
                errors.push(LiveError::MissingBeatScene {
                    beat: i,
                    scene_id: scene_id.clone(),
                });
            }
        }
    }

    let mut focus_ids = HashSet::new();
    for point in &manifest.focus_points {
        if let Err(reason) = validate_identifier(&point.id) {
            errors.push(LiveError::InvalidFocusId {
                id: point.id.clone(),
                reason,
            });
        }
        if !focus_ids.insert(point.id.as_str()) {
            errors.push(LiveError::DuplicateFocusId {
                id: point.id.clone(),
            });
        }
        if !manifest.beats.is_empty() && point.beat as usize >= manifest.beats.len() {
            errors.push(LiveError::FocusBeatOutOfRange {
                id: point.id.clone(),
                beat: point.beat,
                beats: manifest.beats.len(),
            });
        }
        if !known_app(&point.app) {
            errors.push(LiveError::UnknownApp {
                context: format!("focus point `{}`", point.id),
                app: point.app.clone(),
            });
        }
        for scene_id in &point.scenes {
            if !scene_ids.contains(scene_id) {
                errors.push(LiveError::MissingFocusScene {
                    id: point.id.clone(),
                    scene_id: scene_id.clone(),
                });
            }
        }
        if point.find.as_deref().is_none_or(|t| t.trim().is_empty()) && point.union.is_empty() {
            errors.push(LiveError::FocusWithoutTarget {
                id: point.id.clone(),
            });
        }
    }

    report
        .errors
        .extend(errors.into_iter().map(ValidationError::Live));
    report
}
