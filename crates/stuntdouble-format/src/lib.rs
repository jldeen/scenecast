use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fmt;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

mod live;
pub use live::{
    App, Beat, FocusMark, FocusPoint, LiveError, LivePage, PlaybackAction, PlaybackData,
    PresenterConfig, PresenterModifier, ScenePlayback, StateTransition, StateTrigger, Stream,
    StreamTiming, TransitionPlayback, Viewport,
};

pub const MANIFEST_FILE_NAME: &str = "manifest.json";
/// The bundle schema this crate writes and validates.
pub const SCHEMA_VERSION: &str = "scenecast.bundle.v2";
/// The first schema. v1 bundles still load: they're migrated on read, their scenes read as fallback scenes.
pub const SCHEMA_VERSION_V1: &str = "scenecast.bundle.v1";

macro_rules! id_schema {
    ($ty:ty, $name:literal) => {
        impl JsonSchema for $ty {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                $name.into()
            }

            fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 96,
                    "pattern": "^[A-Za-z0-9._-]+$"
                })
            }
        }
    };
}
id_schema!(SceneId, "SceneId");
id_schema!(HotspotId, "HotspotId");
id_schema!(GuideMarkId, "GuideMarkId");

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SceneId(String);

impl SceneId {
    pub fn new(value: impl Into<String>) -> Result<Self, SceneIdError> {
        let value = value.into();
        if let Err(reason) = validate_identifier(&value) {
            return Err(SceneIdError { value, reason });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TranscriptSegmentRef {
    pub source_id: String,
    pub segment_id: String,
}

impl fmt::Display for SceneId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for SceneId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SceneId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("invalid scene id `{value}`: {reason}")]
pub struct SceneIdError {
    value: String,
    reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HotspotId(String);

impl HotspotId {
    pub fn new(value: impl Into<String>) -> Result<Self, HotspotIdError> {
        let value = value.into();
        if let Err(reason) = validate_identifier(&value) {
            return Err(HotspotIdError { value, reason });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for HotspotId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GuideMarkId(String);

impl GuideMarkId {
    pub fn new(value: impl Into<String>) -> Result<Self, GuideMarkIdError> {
        let value = value.into();
        if let Err(reason) = validate_identifier(&value) {
            return Err(GuideMarkIdError { value, reason });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for GuideMarkId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for GuideMarkId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for GuideMarkId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("invalid guide mark id `{value}`: {reason}")]
pub struct GuideMarkIdError {
    value: String,
    reason: &'static str,
}

impl Serialize for HotspotId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HotspotId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("invalid hotspot id `{value}`: {reason}")]
pub struct HotspotIdError {
    value: String,
    reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BundleManifest {
    pub schema_version: String,
    pub title: String,
    /// The web apps (browser tabs) the demo shows. Live-page scenes belong to one each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<App>,
    /// The size the demo was recorded and is shown at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<Viewport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<Section>,
    pub graph: SceneGraph,
    /// Streamed AI answers, replayed from their captured frames.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub streams: Vec<Stream>,
    /// Presenter beats: modifier+0 is beats[0] (reset), modifier+1…9 the rest.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub beats: Vec<Beat>,
    /// ZoomIt-style focus points, in script order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub focus_points: Vec<FocusPoint>,
    /// Browser-player options and behavior not covered by the portable graph fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback: Option<PlaybackData>,
    #[serde(default)]
    pub presenter: PresenterConfig,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<SourceArtifact>,
    #[serde(default)]
    pub assets: Vec<BundleAsset>,
}

impl BundleManifest {
    pub fn starter(title: impl Into<String>) -> Self {
        let title = title.into();
        let start_scene = SceneId::new("start").expect("static scene id is valid");

        Self {
            schema_version: SCHEMA_VERSION.to_owned(),
            title: title.clone(),
            apps: Vec::new(),
            viewport: None,
            streams: Vec::new(),
            beats: Vec::new(),
            focus_points: Vec::new(),
            playback: None,
            presenter: PresenterConfig::default(),
            sections: vec![Section {
                id: "main".to_owned(),
                title: "Main".to_owned(),
                scenes: vec![start_scene.clone()],
            }],
            graph: SceneGraph {
                start_scene: start_scene.clone(),
                scenes: vec![Scene {
                    notes: Some(format!("Starter scene for {title}")),
                    ..Scene::live_page(start_scene, "Start", None)
                }],
            },
            sources: Vec::new(),
            assets: Vec::new(),
        }
    }

    pub fn add_scene(&mut self, scene: Scene) {
        self.graph.scenes.push(scene);
    }

    pub fn add_hotspot(
        &mut self,
        scene_id: &SceneId,
        hotspot: Hotspot,
    ) -> Result<(), AddHotspotError> {
        let scene =
            self.graph
                .scene_mut(scene_id)
                .ok_or_else(|| AddHotspotError::MissingScene {
                    scene_id: scene_id.clone(),
                })?;

        if scene.hotspot(&hotspot.id).is_some() {
            return Err(AddHotspotError::DuplicateHotspotId {
                scene_id: scene_id.clone(),
                hotspot_id: hotspot.id,
            });
        }

        scene.hotspots.push(hotspot);
        Ok(())
    }

    /// Scenes that aren't live pages (screenshot, video-frame, composite): the fallbacks a check flags.
    pub fn fallback_scenes(&self) -> impl Iterator<Item = &Scene> {
        self.graph
            .scenes
            .iter()
            .filter(|scene| scene.kind.is_fallback())
    }

    pub fn referenced_asset_paths(&self) -> Vec<&str> {
        let mut paths = Vec::new();

        paths.extend(self.assets.iter().map(|asset| asset.path.as_str()));
        for scene in &self.graph.scenes {
            if let Some(live) = &scene.live {
                paths.push(live.snapshot.as_str());
                if let Some(reference) = live.reference.as_deref() {
                    paths.push(reference);
                }
            }
            if let Some(path) = scene.assets.screenshot.as_deref() {
                paths.push(path);
            }
            if let Some(path) = scene.assets.video.as_deref() {
                paths.push(path);
            }
            for hotspot in &scene.hotspots {
                if let Some(transition) = &hotspot.transition {
                    paths.extend(transition.frames.iter().map(|frame| frame.path.as_str()));
                }
            }
        }

        paths
    }

    pub fn validate(&self) -> ValidationReport {
        let mut report = ValidationReport::default();

        if self.schema_version != SCHEMA_VERSION {
            report
                .errors
                .push(ValidationError::UnsupportedSchemaVersion {
                    expected: SCHEMA_VERSION.to_owned(),
                    actual: self.schema_version.clone(),
                });
        }

        if self.title.trim().is_empty() {
            report.errors.push(ValidationError::EmptyTitle);
        }

        let mut asset_paths = HashSet::new();
        for asset in &self.assets {
            if let Err(reason) = validate_portable_asset_path(&asset.path) {
                report.errors.push(ValidationError::InvalidAssetPath {
                    path: asset.path.clone(),
                    reason,
                });
            }

            if !asset_paths.insert(asset.path.clone()) {
                report.errors.push(ValidationError::DuplicateAssetPath {
                    path: asset.path.clone(),
                });
            }

            if asset.media_type.trim().is_empty() {
                report.errors.push(ValidationError::EmptyAssetMediaType {
                    path: asset.path.clone(),
                });
            }
        }

        report.extend(validate_sources(&self.sources));
        report.extend(validate_sections(&self.sections, &self.graph));
        report.extend(validate_scene_provenance(&self.graph, &self.sources));
        report.extend(self.graph.validate());
        report.extend(live::validate_live(self));
        report
    }

    /// Parses a manifest, migrating a v1 manifest to v2 on the way. Returns the schema it was read from.
    pub fn from_json_str(contents: &str) -> Result<(Self, String), serde_json::Error> {
        let mut value: serde_json::Value = serde_json::from_str(contents)?;
        let read_as = value
            .get("schema_version")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned();
        if read_as == SCHEMA_VERSION_V1 {
            migrate_v1_value(&mut value);
        }
        Ok((serde_json::from_value(value)?, read_as))
    }
}

/// v1 → v2: a scene without a `kind` was a screenshot scene (v1's default); in v2 the default is `live-page`, so it
/// is written out as `screenshot`, a fallback scene. Nothing else changes: every v1 field is still in v2.
fn migrate_v1_value(value: &mut serde_json::Value) {
    if let Some(scenes) = value
        .pointer_mut("/graph/scenes")
        .and_then(|scenes| scenes.as_array_mut())
    {
        for scene in scenes {
            if let Some(scene) = scene.as_object_mut() {
                scene
                    .entry("kind")
                    .or_insert_with(|| serde_json::Value::from("screenshot"));
            }
        }
    }
    value["schema_version"] = serde_json::Value::from(SCHEMA_VERSION);
}

/// The JSON Schema of a v2 bundle manifest, generated from these types (the JS packages read this, so the two
/// can't drift).
pub fn bundle_json_schema() -> serde_json::Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(BundleManifest))
        .expect("the bundle schema serializes");
    schema["$id"] = serde_json::Value::from("https://scenecast.dev/schema/bundle.v2.json");
    schema["title"] = serde_json::Value::from("Scenecast bundle manifest (scenecast.bundle.v2)");
    schema.sort_all_objects();
    schema
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Section {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub scenes: Vec<SceneId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AddHotspotError {
    #[error("scene `{scene_id}` does not exist")]
    MissingScene { scene_id: SceneId },
    #[error("scene `{scene_id}` already contains hotspot `{hotspot_id}`")]
    DuplicateHotspotId {
        scene_id: SceneId,
        hotspot_id: HotspotId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BundleAsset {
    pub path: String,
    pub media_type: String,
    #[serde(default)]
    pub role: AssetRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceArtifact {
    pub id: String,
    #[serde(default)]
    pub kind: SourceArtifactKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript_segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SourceArtifactKind {
    #[default]
    Other,
    Video,
    Transcript,
    Trace,
    Manual,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AssetRole {
    #[default]
    Capture,
    Thumbnail,
    Supporting,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SceneGraph {
    pub start_scene: SceneId,
    pub scenes: Vec<Scene>,
}

impl SceneGraph {
    pub fn scene(&self, id: &SceneId) -> Option<&Scene> {
        self.scenes.iter().find(|scene| scene.id == *id)
    }

    pub fn scene_mut(&mut self, id: &SceneId) -> Option<&mut Scene> {
        self.scenes.iter_mut().find(|scene| scene.id == *id)
    }

    pub fn validate(&self) -> ValidationReport {
        let mut report = ValidationReport::default();
        let mut scene_ids = HashSet::new();

        if self.scenes.is_empty() {
            report.errors.push(ValidationError::NoScenes);
            return report;
        }

        for scene in &self.scenes {
            if !scene_ids.insert(scene.id.clone()) {
                report.errors.push(ValidationError::DuplicateSceneId {
                    scene_id: scene.id.clone(),
                });
            }

            if scene.title.trim().is_empty() {
                report.errors.push(ValidationError::EmptySceneTitle {
                    scene_id: scene.id.clone(),
                });
            }

            report.extend(scene.validate());
        }

        if !scene_ids.contains(&self.start_scene) {
            report.errors.push(ValidationError::MissingStartScene {
                scene_id: self.start_scene.clone(),
            });
        }

        for scene in &self.scenes {
            for hotspot in &scene.hotspots {
                if !scene_ids.contains(&hotspot.target) {
                    report.errors.push(ValidationError::MissingHotspotTarget {
                        scene_id: scene.id.clone(),
                        hotspot_id: hotspot.id.clone(),
                        target: hotspot.target.clone(),
                    });
                }
            }
        }

        report
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Scene {
    pub id: SceneId,
    pub title: String,
    #[serde(default)]
    pub kind: SceneKind,
    #[serde(default)]
    pub assets: SceneAssets,
    #[serde(default)]
    pub hotspots: Vec<Hotspot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guide_marks: Vec<GuideMark>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SceneProvenance>,
    /// The captured page, for a `live-page` scene (absent until it's recorded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<LivePage>,
    /// Moves to other live-page scenes (clicks, typing, Enter, hovers, Escape), morphed by the player.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transitions: Vec<StateTransition>,
}

impl Scene {
    /// A live-page scene: the default kind. `live` is `None` until the page is recorded.
    pub fn live_page(id: SceneId, title: impl Into<String>, live: Option<LivePage>) -> Self {
        Self {
            id,
            title: title.into(),
            kind: SceneKind::LivePage,
            assets: SceneAssets::default(),
            hotspots: Vec::new(),
            guide_marks: Vec::new(),
            description: None,
            notes: None,
            provenance: None,
            live,
            transitions: Vec::new(),
        }
    }

    pub fn screenshot(id: SceneId, title: impl Into<String>, screenshot: Option<String>) -> Self {
        Self {
            id,
            title: title.into(),
            kind: SceneKind::Screenshot,
            assets: SceneAssets {
                screenshot,
                video: None,
            },
            hotspots: Vec::new(),
            guide_marks: Vec::new(),
            description: None,
            notes: None,
            provenance: None,
            live: None,
            transitions: Vec::new(),
        }
    }

    pub fn hotspot(&self, id: &HotspotId) -> Option<&Hotspot> {
        self.hotspots.iter().find(|hotspot| hotspot.id == *id)
    }

    fn validate(&self) -> ValidationReport {
        let mut report = ValidationReport::default();
        let mut hotspot_ids = HashSet::new();
        let mut guide_mark_ids = HashSet::new();

        if self.kind.is_fallback()
            && self.assets.screenshot.is_none()
            && self.assets.video.is_none()
        {
            report.warnings.push(ValidationWarning::SceneHasNoCapture {
                scene_id: self.id.clone(),
            });
        }

        for path in [&self.assets.screenshot, &self.assets.video]
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

        for hotspot in &self.hotspots {
            if !hotspot_ids.insert(hotspot.id.clone()) {
                report.errors.push(ValidationError::DuplicateHotspotId {
                    scene_id: self.id.clone(),
                    hotspot_id: hotspot.id.clone(),
                });
            }

            if hotspot.label.trim().is_empty() {
                report.errors.push(ValidationError::EmptyHotspotLabel {
                    scene_id: self.id.clone(),
                    hotspot_id: hotspot.id.clone(),
                });
            }

            if !hotspot.bounds.is_valid() {
                report.errors.push(ValidationError::InvalidHotspotBounds {
                    scene_id: self.id.clone(),
                    hotspot_id: hotspot.id.clone(),
                    bounds: hotspot.bounds,
                });
            }

            if let Some(transition) = &hotspot.transition {
                if transition.frames.is_empty() {
                    report.errors.push(ValidationError::EmptyTransitionFrames {
                        scene_id: self.id.clone(),
                        hotspot_id: hotspot.id.clone(),
                    });
                }

                if let Some(duration_ms) = transition.default_frame_duration_ms
                    && duration_ms == 0
                {
                    report
                        .errors
                        .push(ValidationError::InvalidTransitionDefaultDuration {
                            scene_id: self.id.clone(),
                            hotspot_id: hotspot.id.clone(),
                            duration_ms,
                        });
                }

                for frame in &transition.frames {
                    if let Err(reason) = validate_portable_asset_path(&frame.path) {
                        report
                            .errors
                            .push(ValidationError::InvalidTransitionFramePath {
                                scene_id: self.id.clone(),
                                hotspot_id: hotspot.id.clone(),
                                path: frame.path.clone(),
                                reason,
                            });
                    }

                    if let Some(duration_ms) = frame.duration_ms
                        && duration_ms == 0
                    {
                        report
                            .errors
                            .push(ValidationError::InvalidTransitionFrameDuration {
                                scene_id: self.id.clone(),
                                hotspot_id: hotspot.id.clone(),
                                path: frame.path.clone(),
                                duration_ms,
                            });
                    }
                }
            }
        }

        for guide_mark in &self.guide_marks {
            if !guide_mark_ids.insert(guide_mark.id.clone()) {
                report.errors.push(ValidationError::DuplicateGuideMarkId {
                    scene_id: self.id.clone(),
                    guide_mark_id: guide_mark.id.clone(),
                });
            }

            if guide_mark.label.trim().is_empty() {
                report.errors.push(ValidationError::EmptyGuideMarkLabel {
                    scene_id: self.id.clone(),
                    guide_mark_id: guide_mark.id.clone(),
                });
            }

            if !guide_mark.bounds.is_valid() {
                report.errors.push(ValidationError::InvalidGuideMarkBounds {
                    scene_id: self.id.clone(),
                    guide_mark_id: guide_mark.id.clone(),
                    bounds: guide_mark.bounds,
                });
            }
        }

        report
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SceneProvenance {
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript_segment_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript_segments: Vec<TranscriptSegmentRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<EvidenceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EvidenceRef {
    #[serde(default)]
    pub kind: EvidenceKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceKind {
    #[default]
    Other,
    Frame,
    TranscriptSegment,
    Event,
    Heuristic,
    Agent,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SceneKind {
    /// The engine's captured page (DOM, CSSOM, fonts, shadow DOM, iframes). The default, and the primary kind.
    #[default]
    LivePage,
    /// Fallback: a still image, only for a screen that can't be captured live.
    Screenshot,
    /// Fallback: a frame from an imported video.
    VideoFrame,
    /// Fallback: an image composed from several captures.
    Composite,
}

impl SceneKind {
    pub fn is_fallback(self) -> bool {
        self != SceneKind::LivePage
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SceneKind::LivePage => "live-page",
            SceneKind::Screenshot => "screenshot",
            SceneKind::VideoFrame => "video-frame",
            SceneKind::Composite => "composite",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SceneAssets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionTrigger {
    #[default]
    Click,
    Scroll,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ScrollDirection {
    #[default]
    Any,
    Down,
    Up,
}

fn is_default_scroll_direction(direction: &ScrollDirection) -> bool {
    *direction == ScrollDirection::Any
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Hotspot {
    pub id: HotspotId,
    pub label: String,
    pub target: SceneId,
    pub bounds: Rect,
    #[serde(default)]
    pub trigger: InteractionTrigger,
    #[serde(default, skip_serializing_if = "is_default_scroll_direction")]
    pub scroll_direction: ScrollDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<Transition>,
}

impl Hotspot {
    pub fn new(id: HotspotId, label: impl Into<String>, target: SceneId, bounds: Rect) -> Self {
        Self {
            id,
            label: label.into(),
            target,
            bounds,
            trigger: InteractionTrigger::Click,
            scroll_direction: ScrollDirection::Any,
            transition: None,
        }
    }

    pub fn with_trigger(mut self, trigger: InteractionTrigger) -> Self {
        self.trigger = trigger;
        self
    }

    pub fn with_scroll_direction(mut self, direction: ScrollDirection) -> Self {
        self.scroll_direction = direction;
        self
    }

    pub fn with_transition(mut self, transition: Transition) -> Self {
        self.transition = Some(transition);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GuideMark {
    pub id: GuideMarkId,
    pub label: String,
    pub bounds: Rect,
    #[serde(default)]
    pub style: GuideMarkStyle,
}

impl GuideMark {
    pub fn new(id: GuideMarkId, label: impl Into<String>, bounds: Rect) -> Self {
        Self {
            id,
            label: label.into(),
            bounds,
            style: GuideMarkStyle::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum GuideMarkStyle {
    #[default]
    Pulse,
    Ring,
    Highlight,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn is_valid(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Transition {
    #[serde(default)]
    pub kind: TransitionKind,
    #[serde(default)]
    pub frames: Vec<TransitionFrame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_frame_duration_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TransitionKind {
    #[default]
    FrameSequence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TransitionFrame {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ValidationReport {
    pub errors: Vec<ValidationError>,
    pub warnings: Vec<ValidationWarning>,
}

impl ValidationReport {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }

    pub fn into_result(self) -> Result<(), ValidationReport> {
        if self.is_valid() { Ok(()) } else { Err(self) }
    }

    fn extend(&mut self, other: ValidationReport) {
        self.errors.extend(other.errors);
        self.warnings.extend(other.warnings);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ValidationError {
    UnsupportedSchemaVersion {
        expected: String,
        actual: String,
    },
    EmptyTitle,
    InvalidAssetPath {
        path: String,
        reason: &'static str,
    },
    DuplicateAssetPath {
        path: String,
    },
    EmptyAssetMediaType {
        path: String,
    },
    InvalidSourceId {
        source_id: String,
        reason: &'static str,
    },
    DuplicateSourceId {
        source_id: String,
    },
    EmptySourceLabel {
        source_id: String,
    },
    EmptySourceMediaType {
        source_id: String,
    },
    InvalidTranscriptSegmentId {
        source_id: String,
        segment_id: String,
        reason: &'static str,
    },
    DuplicateTranscriptSegmentId {
        source_id: String,
        segment_id: String,
    },
    EmptyTranscriptSegmentText {
        source_id: String,
        segment_id: String,
    },
    InvalidTranscriptSegmentRange {
        source_id: String,
        segment_id: String,
        start_ms: u64,
        end_ms: u64,
    },
    MissingTranscriptSegment {
        scene_id: SceneId,
        source_id: String,
        segment_id: String,
    },
    MissingProvenanceSource {
        scene_id: SceneId,
        source_id: String,
    },
    InvalidProvenanceConfidence {
        scene_id: SceneId,
        confidence: f32,
    },
    InvalidEvidenceId {
        scene_id: SceneId,
        evidence_id: String,
        reason: &'static str,
    },
    InvalidSectionId {
        section_id: String,
        reason: &'static str,
    },
    DuplicateSectionId {
        section_id: String,
    },
    EmptySectionTitle {
        section_id: String,
    },
    MissingSectionScene {
        section_id: String,
        scene_id: SceneId,
    },
    NoScenes,
    MissingStartScene {
        scene_id: SceneId,
    },
    DuplicateSceneId {
        scene_id: SceneId,
    },
    EmptySceneTitle {
        scene_id: SceneId,
    },
    DuplicateHotspotId {
        scene_id: SceneId,
        hotspot_id: HotspotId,
    },
    EmptyHotspotLabel {
        scene_id: SceneId,
        hotspot_id: HotspotId,
    },
    DuplicateGuideMarkId {
        scene_id: SceneId,
        guide_mark_id: GuideMarkId,
    },
    EmptyGuideMarkLabel {
        scene_id: SceneId,
        guide_mark_id: GuideMarkId,
    },
    InvalidGuideMarkBounds {
        scene_id: SceneId,
        guide_mark_id: GuideMarkId,
        bounds: Rect,
    },
    InvalidHotspotBounds {
        scene_id: SceneId,
        hotspot_id: HotspotId,
        bounds: Rect,
    },
    EmptyTransitionFrames {
        scene_id: SceneId,
        hotspot_id: HotspotId,
    },
    InvalidTransitionFramePath {
        scene_id: SceneId,
        hotspot_id: HotspotId,
        path: String,
        reason: &'static str,
    },
    InvalidTransitionFrameDuration {
        scene_id: SceneId,
        hotspot_id: HotspotId,
        path: String,
        duration_ms: u32,
    },
    InvalidTransitionDefaultDuration {
        scene_id: SceneId,
        hotspot_id: HotspotId,
        duration_ms: u32,
    },
    MissingHotspotTarget {
        scene_id: SceneId,
        hotspot_id: HotspotId,
        target: SceneId,
    },
    Live(LiveError),
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion { expected, actual } => {
                write!(
                    formatter,
                    "unsupported schema version `{actual}`; expected `{expected}`"
                )
            }
            Self::EmptyTitle => formatter.write_str("bundle title must not be empty"),
            Self::InvalidAssetPath { path, reason } => {
                write!(formatter, "asset path `{path}` is not portable: {reason}")
            }
            Self::DuplicateAssetPath { path } => {
                write!(formatter, "bundle asset path `{path}` is duplicated")
            }
            Self::EmptyAssetMediaType { path } => {
                write!(
                    formatter,
                    "bundle asset `{path}` media_type must not be empty"
                )
            }
            Self::InvalidSourceId { source_id, reason } => {
                write!(formatter, "source id `{source_id}` is not valid: {reason}")
            }
            Self::DuplicateSourceId { source_id } => {
                write!(formatter, "source id `{source_id}` is duplicated")
            }
            Self::EmptySourceLabel { source_id } => {
                write!(formatter, "source `{source_id}` label must not be empty")
            }
            Self::EmptySourceMediaType { source_id } => {
                write!(
                    formatter,
                    "source `{source_id}` media_type must not be empty when provided"
                )
            }
            Self::InvalidTranscriptSegmentId {
                source_id,
                segment_id,
                reason,
            } => {
                write!(
                    formatter,
                    "source `{source_id}` transcript segment id `{segment_id}` is not valid: {reason}"
                )
            }
            Self::DuplicateTranscriptSegmentId {
                source_id,
                segment_id,
            } => {
                write!(
                    formatter,
                    "source `{source_id}` transcript segment id `{segment_id}` is duplicated"
                )
            }
            Self::EmptyTranscriptSegmentText {
                source_id,
                segment_id,
            } => {
                write!(
                    formatter,
                    "source `{source_id}` transcript segment `{segment_id}` text must not be empty"
                )
            }
            Self::InvalidTranscriptSegmentRange {
                source_id,
                segment_id,
                start_ms,
                end_ms,
            } => {
                write!(
                    formatter,
                    "source `{source_id}` transcript segment `{segment_id}` must end after it starts (got {start_ms}ms..{end_ms}ms)"
                )
            }
            Self::MissingTranscriptSegment {
                scene_id,
                source_id,
                segment_id,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` references missing transcript segment `{segment_id}` from source `{source_id}`"
                )
            }
            Self::MissingProvenanceSource {
                scene_id,
                source_id,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` references missing provenance source `{source_id}`"
                )
            }
            Self::InvalidProvenanceConfidence {
                scene_id,
                confidence,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` provenance confidence must be between 0 and 1 (got `{confidence}`)"
                )
            }
            Self::InvalidEvidenceId {
                scene_id,
                evidence_id,
                reason,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` evidence id `{evidence_id}` is not valid: {reason}"
                )
            }
            Self::InvalidSectionId { section_id, reason } => {
                write!(
                    formatter,
                    "section id `{section_id}` is not valid: {reason}"
                )
            }
            Self::DuplicateSectionId { section_id } => {
                write!(formatter, "section id `{section_id}` is duplicated")
            }
            Self::EmptySectionTitle { section_id } => {
                write!(formatter, "section `{section_id}` title must not be empty")
            }
            Self::MissingSectionScene {
                section_id,
                scene_id,
            } => {
                write!(
                    formatter,
                    "section `{section_id}` references missing scene `{scene_id}`"
                )
            }
            Self::NoScenes => formatter.write_str("scene graph must contain at least one scene"),
            Self::MissingStartScene { scene_id } => {
                write!(formatter, "start scene `{scene_id}` does not exist")
            }
            Self::DuplicateSceneId { scene_id } => {
                write!(formatter, "scene id `{scene_id}` is duplicated")
            }
            Self::EmptySceneTitle { scene_id } => {
                write!(formatter, "scene `{scene_id}` title must not be empty")
            }
            Self::DuplicateHotspotId {
                scene_id,
                hotspot_id,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot id `{hotspot_id}` is duplicated"
                )
            }
            Self::EmptyHotspotLabel {
                scene_id,
                hotspot_id,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot `{hotspot_id}` label must not be empty"
                )
            }
            Self::InvalidHotspotBounds {
                scene_id,
                hotspot_id,
                bounds,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot `{hotspot_id}` has invalid bounds x={} y={} width={} height={}",
                    bounds.x, bounds.y, bounds.width, bounds.height
                )
            }
            Self::DuplicateGuideMarkId {
                scene_id,
                guide_mark_id,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` guide mark id `{guide_mark_id}` is duplicated"
                )
            }
            Self::EmptyGuideMarkLabel {
                scene_id,
                guide_mark_id,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` guide mark `{guide_mark_id}` label must not be empty"
                )
            }
            Self::InvalidGuideMarkBounds {
                scene_id,
                guide_mark_id,
                bounds,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` guide mark `{guide_mark_id}` has invalid bounds x={} y={} width={} height={}",
                    bounds.x, bounds.y, bounds.width, bounds.height
                )
            }
            Self::EmptyTransitionFrames {
                scene_id,
                hotspot_id,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot `{hotspot_id}` transition must contain at least one frame"
                )
            }
            Self::InvalidTransitionFramePath {
                scene_id,
                hotspot_id,
                path,
                reason,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot `{hotspot_id}` transition frame path `{path}` is not portable: {reason}"
                )
            }
            Self::InvalidTransitionFrameDuration {
                scene_id,
                hotspot_id,
                path,
                duration_ms,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot `{hotspot_id}` transition frame `{path}` has invalid duration `{duration_ms}`ms"
                )
            }
            Self::InvalidTransitionDefaultDuration {
                scene_id,
                hotspot_id,
                duration_ms,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot `{hotspot_id}` transition default duration must be greater than 0ms (got `{duration_ms}`ms)"
                )
            }
            Self::MissingHotspotTarget {
                scene_id,
                hotspot_id,
                target,
            } => {
                write!(
                    formatter,
                    "scene `{scene_id}` hotspot `{hotspot_id}` targets missing scene `{target}`"
                )
            }
            Self::Live(error) => error.fmt(formatter),
        }
    }
}

fn validate_sources(sources: &[SourceArtifact]) -> ValidationReport {
    let mut report = ValidationReport::default();
    let mut source_ids = HashSet::new();

    for source in sources {
        let mut transcript_segment_ids = HashSet::new();
        if let Err(reason) = validate_identifier(&source.id) {
            report.errors.push(ValidationError::InvalidSourceId {
                source_id: source.id.clone(),
                reason,
            });
        }

        if !source_ids.insert(source.id.clone()) {
            report.errors.push(ValidationError::DuplicateSourceId {
                source_id: source.id.clone(),
            });
        }

        if source.label.trim().is_empty() {
            report.errors.push(ValidationError::EmptySourceLabel {
                source_id: source.id.clone(),
            });
        }

        if source
            .media_type
            .as_deref()
            .is_some_and(|media_type| media_type.trim().is_empty())
        {
            report.errors.push(ValidationError::EmptySourceMediaType {
                source_id: source.id.clone(),
            });
        }

        for segment in &source.transcript_segments {
            if let Err(reason) = validate_identifier(&segment.id) {
                report
                    .errors
                    .push(ValidationError::InvalidTranscriptSegmentId {
                        source_id: source.id.clone(),
                        segment_id: segment.id.clone(),
                        reason,
                    });
            }
            if !transcript_segment_ids.insert(segment.id.clone()) {
                report
                    .errors
                    .push(ValidationError::DuplicateTranscriptSegmentId {
                        source_id: source.id.clone(),
                        segment_id: segment.id.clone(),
                    });
            }
            if segment.text.trim().is_empty() {
                report
                    .errors
                    .push(ValidationError::EmptyTranscriptSegmentText {
                        source_id: source.id.clone(),
                        segment_id: segment.id.clone(),
                    });
            }
            if segment.end_ms <= segment.start_ms {
                report
                    .errors
                    .push(ValidationError::InvalidTranscriptSegmentRange {
                        source_id: source.id.clone(),
                        segment_id: segment.id.clone(),
                        start_ms: segment.start_ms,
                        end_ms: segment.end_ms,
                    });
            }
        }
    }

    report
}

fn validate_scene_provenance(graph: &SceneGraph, sources: &[SourceArtifact]) -> ValidationReport {
    let mut report = ValidationReport::default();
    let source_ids = sources
        .iter()
        .map(|source| source.id.as_str())
        .collect::<HashSet<_>>();
    let transcript_segments_by_source = sources
        .iter()
        .map(|source| {
            (
                source.id.as_str(),
                source
                    .transcript_segments
                    .iter()
                    .map(|segment| segment.id.as_str())
                    .collect::<HashSet<_>>(),
            )
        })
        .collect::<HashMap<_, _>>();

    for scene in &graph.scenes {
        let Some(provenance) = &scene.provenance else {
            continue;
        };

        if !source_ids.contains(provenance.source_id.as_str()) {
            report
                .errors
                .push(ValidationError::MissingProvenanceSource {
                    scene_id: scene.id.clone(),
                    source_id: provenance.source_id.clone(),
                });
        }

        if let Some(confidence) = provenance.confidence
            && (!confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
        {
            report
                .errors
                .push(ValidationError::InvalidProvenanceConfidence {
                    scene_id: scene.id.clone(),
                    confidence,
                });
        }

        for segment in &provenance.transcript_segments {
            if !transcript_segments_by_source
                .get(segment.source_id.as_str())
                .is_some_and(|segment_ids| segment_ids.contains(segment.segment_id.as_str()))
            {
                report
                    .errors
                    .push(ValidationError::MissingTranscriptSegment {
                        scene_id: scene.id.clone(),
                        source_id: segment.source_id.clone(),
                        segment_id: segment.segment_id.clone(),
                    });
            }
        }

        for evidence in &provenance.evidence {
            if let Err(reason) = validate_identifier(&evidence.id) {
                report.errors.push(ValidationError::InvalidEvidenceId {
                    scene_id: scene.id.clone(),
                    evidence_id: evidence.id.clone(),
                    reason,
                });
            }
            if let Some(source_id) = &evidence.source_id
                && !source_ids.contains(source_id.as_str())
            {
                report
                    .errors
                    .push(ValidationError::MissingProvenanceSource {
                        scene_id: scene.id.clone(),
                        source_id: source_id.clone(),
                    });
            }
        }
    }

    report
}

fn validate_sections(sections: &[Section], graph: &SceneGraph) -> ValidationReport {
    let mut report = ValidationReport::default();
    let scene_ids = graph
        .scenes
        .iter()
        .map(|scene| scene.id.clone())
        .collect::<HashSet<_>>();
    let mut section_ids = HashSet::new();

    for section in sections {
        if let Err(reason) = validate_identifier(&section.id) {
            report.errors.push(ValidationError::InvalidSectionId {
                section_id: section.id.clone(),
                reason,
            });
        }

        if !section_ids.insert(section.id.clone()) {
            report.errors.push(ValidationError::DuplicateSectionId {
                section_id: section.id.clone(),
            });
        }

        if section.title.trim().is_empty() {
            report.errors.push(ValidationError::EmptySectionTitle {
                section_id: section.id.clone(),
            });
        }

        for scene_id in &section.scenes {
            if !scene_ids.contains(scene_id) {
                report.errors.push(ValidationError::MissingSectionScene {
                    section_id: section.id.clone(),
                    scene_id: scene_id.clone(),
                });
            }
        }
    }

    report
}

#[derive(Debug, Clone, PartialEq)]
pub enum ValidationWarning {
    SceneHasNoCapture { scene_id: SceneId },
    SceneNotRecorded { scene_id: SceneId },
}

impl fmt::Display for ValidationWarning {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SceneHasNoCapture { scene_id } => {
                write!(
                    formatter,
                    "scene `{scene_id}` has no screenshot or video asset"
                )
            }
            Self::SceneNotRecorded { scene_id } => {
                write!(
                    formatter,
                    "live-page scene `{scene_id}` has not been recorded yet (scenecast record, then scenecast build)"
                )
            }
        }
    }
}

#[derive(Debug, Error)]
pub enum BundleIoError {
    #[error("failed to read `{path}`")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write `{path}`")]
    Write {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to replace `{path}`")]
    Replace {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse bundle manifest `{path}`")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to serialize bundle manifest")]
    Serialize(#[from] serde_json::Error),
}

pub fn manifest_path(bundle_path: impl AsRef<Path>) -> std::path::PathBuf {
    bundle_path.as_ref().join(MANIFEST_FILE_NAME)
}

pub fn read_manifest(bundle_path: impl AsRef<Path>) -> Result<BundleManifest, BundleIoError> {
    read_manifest_with_version(bundle_path).map(|(manifest, _)| manifest)
}

/// Reads a manifest (migrating v1 to v2) and says which schema it was read from.
pub fn read_manifest_with_version(
    bundle_path: impl AsRef<Path>,
) -> Result<(BundleManifest, String), BundleIoError> {
    let path = manifest_path(bundle_path);
    let contents = fs::read_to_string(&path).map_err(|source| BundleIoError::Read {
        path: path.display().to_string(),
        source,
    })?;
    BundleManifest::from_json_str(&contents).map_err(|source| BundleIoError::Parse {
        path: path.display().to_string(),
        source,
    })
}

pub fn write_manifest(
    bundle_path: impl AsRef<Path>,
    manifest: &BundleManifest,
) -> Result<(), BundleIoError> {
    let path = manifest_path(bundle_path);
    let contents = serde_json::to_string_pretty(manifest)?;
    let temp_path = path.with_file_name(format!("{MANIFEST_FILE_NAME}.tmp-{}", std::process::id()));
    let display_path = path.display().to_string();
    let temp_contents = format!("{contents}\n");

    if let Err(source) = write_temp_file(&temp_path, &temp_contents) {
        let _ = fs::remove_file(&temp_path);
        return Err(BundleIoError::Write {
            path: temp_path.display().to_string(),
            source,
        });
    }

    match fs::rename(&temp_path, &path) {
        Ok(()) => Ok(()),
        Err(_first_error) if path.exists() => {
            fs::remove_file(&path).map_err(|source| BundleIoError::Replace {
                path: display_path.clone(),
                source,
            })?;
            fs::rename(&temp_path, &path).map_err(|source| BundleIoError::Replace {
                path: display_path,
                source,
            })
        }
        Err(source) => Err(BundleIoError::Replace {
            path: display_path,
            source,
        }),
    }
}

fn write_temp_file(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut temp_file = File::create(path)?;
    temp_file.write_all(contents.as_bytes())?;
    temp_file.sync_all()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileValidationReport {
    pub missing_files: Vec<MissingReferencedFile>,
}

impl FileValidationReport {
    pub fn is_valid(&self) -> bool {
        self.missing_files.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingReferencedFile {
    pub path: String,
}

impl fmt::Display for MissingReferencedFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "referenced asset `{}` does not exist", self.path)
    }
}

pub fn validate_referenced_files(
    bundle_path: impl AsRef<Path>,
    manifest: &BundleManifest,
) -> FileValidationReport {
    let bundle_path = bundle_path.as_ref();
    let mut report = FileValidationReport::default();
    let mut seen = HashSet::new();

    for path in manifest.referenced_asset_paths() {
        if validate_portable_asset_path(path).is_err() || !seen.insert(path) {
            continue;
        }

        if !referenced_file_exists_exact_case(bundle_path, path) {
            report.missing_files.push(MissingReferencedFile {
                path: path.to_owned(),
            });
        }
    }

    report
}

fn referenced_file_exists_exact_case(bundle_path: &Path, portable_path: &str) -> bool {
    let mut current = bundle_path.to_path_buf();
    let mut components = portable_path.split('/').peekable();

    while let Some(component) = components.next() {
        let is_last = components.peek().is_none();
        let Ok(entries) = fs::read_dir(&current) else {
            return false;
        };
        let Some(entry) = entries
            .filter_map(Result::ok)
            .find(|entry| entry.file_name() == OsStr::new(component))
        else {
            return false;
        };
        let Ok(file_type) = entry.file_type() else {
            return false;
        };

        if is_last {
            return file_type.is_file();
        }

        if !file_type.is_dir() {
            return false;
        }
        current = entry.path();
    }

    false
}

pub(crate) fn validate_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty() {
        return Err("must not be empty");
    }

    if matches!(value, "." | "..") {
        return Err("must not be `.` or `..`");
    }

    if value.len() > 96 {
        return Err("must be 96 characters or fewer");
    }

    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err("must contain only ASCII letters, numbers, dots, dashes, or underscores");
    }

    Ok(())
}

pub(crate) fn validate_portable_asset_path(value: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() {
        return Err("must not be empty");
    }

    if value != value.trim() {
        return Err("must not start or end with whitespace");
    }

    if value.contains('\\') {
        return Err("must use forward slashes");
    }

    if value.contains(':') {
        return Err("must not contain a URL scheme or Windows drive prefix");
    }

    if value.starts_with('/') {
        return Err("must be relative to the bundle root");
    }

    if value
        .split('/')
        .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err("must not contain empty, current-directory, or parent-directory segments");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_manifest_is_valid_with_capture_warning() {
        let manifest = BundleManifest::starter("Demo");

        let report = manifest.validate();

        assert!(report.is_valid(), "{:?}", report.errors);
        assert_eq!(report.warnings.len(), 1);
    }

    #[test]
    fn validation_reports_missing_hotspot_targets() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.graph.scenes[0].hotspots.push(Hotspot {
            id: HotspotId::new("cta").unwrap(),
            label: "Open missing scene".to_owned(),
            target: SceneId::new("missing").unwrap(),
            bounds: Rect {
                x: 10.0,
                y: 10.0,
                width: 50.0,
                height: 24.0,
            },
            trigger: InteractionTrigger::Click,
            scroll_direction: ScrollDirection::Any,
            transition: None,
        });

        let report = manifest.validate();

        assert!(matches!(
            report.errors.as_slice(),
            [ValidationError::MissingHotspotTarget { .. }]
        ));
    }

    #[test]
    fn validation_rejects_duplicate_scene_ids_and_invalid_bounds() {
        let duplicate_id = SceneId::new("start").unwrap();
        let mut manifest = BundleManifest::starter("Demo");
        manifest.add_scene(Scene {
            id: duplicate_id,
            title: "Duplicate".to_owned(),
            kind: SceneKind::Screenshot,
            assets: SceneAssets::default(),
            hotspots: vec![Hotspot {
                id: HotspotId::new("bad-bounds").unwrap(),
                label: "Bad".to_owned(),
                target: SceneId::new("start").unwrap(),
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 10.0,
                },
                trigger: InteractionTrigger::Click,
                scroll_direction: ScrollDirection::Any,
                transition: None,
            }],
            guide_marks: Vec::new(),
            description: None,
            notes: None,
            provenance: None,
            live: None,
            transitions: Vec::new(),
        });

        let report = manifest.validate();

        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::DuplicateSceneId { .. }))
        );
        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::InvalidHotspotBounds { .. }))
        );
    }

    #[test]
    fn identifiers_are_url_and_path_segment_friendly() {
        assert!(SceneId::new("home.screen-1").is_ok());
        assert!(SceneId::new(".").is_err());
        assert!(SceneId::new("..").is_err());
        assert!(SceneId::new("home screen").is_err());
        assert!(HotspotId::new("").is_err());
    }

    #[test]
    fn deserialization_rejects_invalid_identifiers() {
        let json = r#"{
            "schema_version": "scenecast.bundle.v1",
            "title": "Demo",
            "graph": {
                "start_scene": "start",
                "scenes": [
                    {
                        "id": "bad scene",
                        "title": "Bad",
                        "kind": "screenshot",
                        "assets": {},
                        "hotspots": []
                    }
                ]
            },
            "assets": []
        }"#;

        assert!(serde_json::from_str::<BundleManifest>(json).is_err());
    }

    #[test]
    fn validation_rejects_non_portable_asset_paths() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.graph.scenes[0].assets.screenshot = Some("../outside.png".to_owned());
        manifest.assets.push(BundleAsset {
            path: "assets\\logo.png".to_owned(),
            media_type: "image/png".to_owned(),
            role: AssetRole::Supporting,
        });

        let report = manifest.validate();

        assert_eq!(
            report
                .errors
                .iter()
                .filter(|error| matches!(error, ValidationError::InvalidAssetPath { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn validation_checks_source_artifacts_and_scene_provenance() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.sources.push(SourceArtifact {
            id: "video-source".to_owned(),
            kind: SourceArtifactKind::Video,
            label: "demo.mp4".to_owned(),
            media_type: Some("video/mp4".to_owned()),
            transcript_segments: Vec::new(),
        });
        manifest.graph.scenes[0].provenance = Some(SceneProvenance {
            source_id: "video-source".to_owned(),
            timestamp_ms: Some(2_500),
            transcript_segment_ids: vec!["seg-1".to_owned()],
            transcript_segments: Vec::new(),
            evidence: vec![EvidenceRef {
                kind: EvidenceKind::Frame,
                id: "frame-0001".to_owned(),
                source_id: Some("video-source".to_owned()),
                label: Some("Sampled frame 1".to_owned()),
            }],
            confidence: Some(0.8),
        });

        assert!(manifest.validate().is_valid());

        manifest.graph.scenes[0]
            .provenance
            .as_mut()
            .unwrap()
            .source_id = "missing".to_owned();
        manifest.graph.scenes[0]
            .provenance
            .as_mut()
            .unwrap()
            .confidence = Some(1.5);
        manifest.graph.scenes[0]
            .provenance
            .as_mut()
            .unwrap()
            .evidence[0]
            .id = "bad evidence".to_owned();

        let report = manifest.validate();

        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::MissingProvenanceSource { .. }))
        );
        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::InvalidProvenanceConfidence { .. }))
        );
        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::InvalidEvidenceId { .. }))
        );
    }

    #[test]
    fn validation_checks_transcript_segments() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.sources.push(SourceArtifact {
            id: "transcript-source".to_owned(),
            kind: SourceArtifactKind::Transcript,
            label: "demo.srt".to_owned(),
            media_type: Some("application/x-subrip".to_owned()),
            transcript_segments: vec![TranscriptSegment {
                id: "segment-0001".to_owned(),
                start_ms: 0,
                end_ms: 1_000,
                text: "Welcome.".to_owned(),
            }],
        });

        assert!(manifest.validate().is_valid());

        manifest.sources[0]
            .transcript_segments
            .push(TranscriptSegment {
                id: "segment-0001".to_owned(),
                start_ms: 1_000,
                end_ms: 1_000,
                text: " ".to_owned(),
            });
        let report = manifest.validate();

        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::DuplicateTranscriptSegmentId { .. }))
        );
        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::EmptyTranscriptSegmentText { .. }))
        );
        assert!(
            report.errors.iter().any(|error| matches!(
                error,
                ValidationError::InvalidTranscriptSegmentRange { .. }
            ))
        );
    }

    #[test]
    fn validation_requires_source_qualified_transcript_segments_to_resolve() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.sources.push(SourceArtifact {
            id: "transcript-source".to_owned(),
            kind: SourceArtifactKind::Transcript,
            label: "demo.srt".to_owned(),
            media_type: Some("application/x-subrip".to_owned()),
            transcript_segments: vec![TranscriptSegment {
                id: "segment-0001".to_owned(),
                start_ms: 0,
                end_ms: 1_000,
                text: "Welcome.".to_owned(),
            }],
        });
        manifest.graph.scenes[0].provenance = Some(SceneProvenance {
            source_id: "transcript-source".to_owned(),
            timestamp_ms: Some(500),
            transcript_segment_ids: vec!["segment-0001".to_owned()],
            transcript_segments: vec![TranscriptSegmentRef {
                source_id: "transcript-source".to_owned(),
                segment_id: "segment-0001".to_owned(),
            }],
            evidence: Vec::new(),
            confidence: Some(1.0),
        });

        assert!(manifest.validate().is_valid());

        manifest.graph.scenes[0]
            .provenance
            .as_mut()
            .unwrap()
            .transcript_segments[0]
            .segment_id = "missing".to_owned();
        assert!(
            manifest
                .validate()
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::MissingTranscriptSegment { .. }))
        );
    }

    #[test]
    fn file_validation_reports_missing_referenced_assets() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.graph.scenes[0].assets.screenshot = Some("captures/start.png".to_owned());

        let report = validate_referenced_files("missing-bundle", &manifest);

        assert_eq!(
            report.missing_files,
            vec![MissingReferencedFile {
                path: "captures/start.png".to_owned()
            }]
        );
    }

    #[test]
    fn file_validation_requires_exact_case_for_portability() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("Captures")).unwrap();
        fs::write(temp.path().join("Captures").join("Start.png"), []).unwrap();
        let mut manifest = BundleManifest::starter("Demo");
        manifest.graph.scenes[0].assets.screenshot = Some("captures/start.png".to_owned());

        let report = validate_referenced_files(temp.path(), &manifest);

        assert_eq!(
            report.missing_files,
            vec![MissingReferencedFile {
                path: "captures/start.png".to_owned()
            }]
        );
    }

    #[test]
    fn write_manifest_round_trips_through_disk() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = BundleManifest::starter("Disk round trip");

        write_manifest(temp.path(), &manifest).unwrap();

        assert_eq!(read_manifest(temp.path()).unwrap(), manifest);
    }

    #[test]
    fn add_hotspot_links_existing_scenes() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.add_scene(Scene::screenshot(
            SceneId::new("pricing").unwrap(),
            "Pricing",
            Some("captures/pricing.png".to_owned()),
        ));
        let hotspot = Hotspot::new(
            HotspotId::new("pricing-link").unwrap(),
            "Pricing",
            SceneId::new("pricing").unwrap(),
            Rect::new(10.0, 20.0, 100.0, 40.0),
        );

        manifest
            .add_hotspot(&SceneId::new("start").unwrap(), hotspot)
            .unwrap();

        assert!(manifest.validate().is_valid());
        assert_eq!(manifest.graph.scenes[0].hotspots.len(), 1);
    }

    #[test]
    fn add_hotspot_rejects_missing_source_scene() {
        let mut manifest = BundleManifest::starter("Demo");
        let error = manifest
            .add_hotspot(
                &SceneId::new("missing").unwrap(),
                Hotspot::new(
                    HotspotId::new("cta").unwrap(),
                    "CTA",
                    SceneId::new("start").unwrap(),
                    Rect::new(0.0, 0.0, 10.0, 10.0),
                ),
            )
            .unwrap_err();

        assert!(matches!(error, AddHotspotError::MissingScene { .. }));
    }

    #[test]
    fn transition_validation_rejects_empty_frames_and_bad_durations() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.add_scene(Scene::screenshot(
            SceneId::new("pricing").unwrap(),
            "Pricing",
            Some("captures/pricing.png".to_owned()),
        ));
        manifest.graph.scenes[0].hotspots.push(
            Hotspot::new(
                HotspotId::new("scroll-pricing").unwrap(),
                "Scroll to pricing",
                SceneId::new("pricing").unwrap(),
                Rect::new(0.0, 0.0, 100.0, 40.0),
            )
            .with_trigger(InteractionTrigger::Scroll)
            .with_transition(Transition {
                kind: TransitionKind::FrameSequence,
                frames: Vec::new(),
                default_frame_duration_ms: Some(0),
            }),
        );

        let report = manifest.validate();
        assert!(
            report
                .errors
                .iter()
                .any(|error| matches!(error, ValidationError::EmptyTransitionFrames { .. }))
        );
        assert!(report.errors.iter().any(|error| matches!(
            error,
            ValidationError::InvalidTransitionDefaultDuration { .. }
        )));
    }

    #[test]
    fn transition_frames_are_referenced_assets() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.add_scene(Scene::screenshot(
            SceneId::new("pricing").unwrap(),
            "Pricing",
            Some("captures/pricing.png".to_owned()),
        ));
        manifest.graph.scenes[0].hotspots.push(
            Hotspot::new(
                HotspotId::new("scroll-pricing").unwrap(),
                "Scroll to pricing",
                SceneId::new("pricing").unwrap(),
                Rect::new(0.0, 0.0, 100.0, 40.0),
            )
            .with_trigger(InteractionTrigger::Scroll)
            .with_transition(Transition {
                kind: TransitionKind::FrameSequence,
                frames: vec![
                    TransitionFrame {
                        path: "captures/scroll-0001.png".to_owned(),
                        duration_ms: Some(80),
                    },
                    TransitionFrame {
                        path: "captures/scroll-0002.png".to_owned(),
                        duration_ms: None,
                    },
                ],
                default_frame_duration_ms: Some(90),
            }),
        );

        let paths = manifest.referenced_asset_paths();
        assert!(paths.contains(&"captures/scroll-0001.png"));
        assert!(paths.contains(&"captures/scroll-0002.png"));
    }

    #[test]
    fn starter_scene_is_live_page_and_unrecorded() {
        let manifest = BundleManifest::starter("Demo");
        let scene = &manifest.graph.scenes[0];

        assert_eq!(manifest.schema_version, SCHEMA_VERSION);
        assert_eq!(scene.kind, SceneKind::LivePage);
        assert_eq!(manifest.fallback_scenes().count(), 0);
        assert!(matches!(
            manifest.validate().warnings.as_slice(),
            [ValidationWarning::SceneNotRecorded { .. }]
        ));
    }

    #[test]
    fn v1_scene_without_kind_migrates_to_a_fallback_screenshot() {
        let json = r#"{
            "schema_version": "scenecast.bundle.v1",
            "title": "Demo",
            "graph": { "start_scene": "start", "scenes": [{ "id": "start", "title": "Start" }] }
        }"#;

        let (manifest, read_as) = BundleManifest::from_json_str(json).unwrap();

        assert_eq!(read_as, SCHEMA_VERSION_V1);
        assert_eq!(manifest.schema_version, SCHEMA_VERSION);
        assert_eq!(manifest.graph.scenes[0].kind, SceneKind::Screenshot);
        assert_eq!(manifest.fallback_scenes().count(), 1);
    }

    #[test]
    fn v2_scene_without_kind_is_a_live_page() {
        let json = r#"{
            "schema_version": "scenecast.bundle.v2",
            "title": "Demo",
            "graph": { "start_scene": "start", "scenes": [{ "id": "start", "title": "Start" }] }
        }"#;

        let (manifest, _) = BundleManifest::from_json_str(json).unwrap();

        assert_eq!(manifest.graph.scenes[0].kind, SceneKind::LivePage);
    }

    #[test]
    fn live_validation_checks_apps_transitions_streams_and_focus() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.apps.push(App {
            id: "chat".to_owned(),
            title: "Chat".to_owned(),
            key: Some("F".to_owned()),
            url: None,
        });
        let start = &mut manifest.graph.scenes[0];
        start.live = Some(LivePage {
            app: "mail".to_owned(),
            snapshot: "data/snaps/start.html".to_owned(),
            title: None,
            reference: None,
            sha256: None,
        });
        start.transitions.push(StateTransition {
            trigger: StateTrigger::Click,
            target: SceneId::new("missing").unwrap(),
            matcher: None,
            stream: Some("s001".to_owned()),
            app: None,
            playback: None,
        });
        manifest.focus_points.push(FocusPoint {
            id: "cost".to_owned(),
            beat: 3,
            app: "chat".to_owned(),
            scenes: vec![SceneId::new("start").unwrap()],
            find: None,
            union: Vec::new(),
            mark: FocusMark::Box,
            dir: None,
            line: None,
        });
        manifest.beats.push(Beat {
            label: "Start".to_owned(),
            active: "chat".to_owned(),
            scenes: [("chat".to_owned(), SceneId::new("start").unwrap())].into(),
        });

        let errors: Vec<String> = manifest
            .validate()
            .errors
            .iter()
            .map(ToString::to_string)
            .collect();

        for expected in [
            "app `chat` key `F`",
            "scene `start` refers to unknown app `mail`",
            "transition to missing scene `missing`",
            "missing stream `s001`",
            "focus point `cost` is on beat 3, but there are only 1 beats",
            "focus point `cost` needs `find` text",
        ] {
            assert!(
                errors.iter().any(|e| e.contains(expected)),
                "{expected} not in {errors:#?}"
            );
        }
    }

    #[test]
    fn live_data_on_a_fallback_scene_is_an_error() {
        let mut manifest = BundleManifest::starter("Demo");
        manifest.graph.scenes[0].kind = SceneKind::Screenshot;
        manifest.graph.scenes[0].live = Some(LivePage {
            app: "chat".to_owned(),
            snapshot: "data/snaps/start.html".to_owned(),
            title: None,
            reference: None,
            sha256: None,
        });

        assert!(manifest.validate().errors.iter().any(|e| matches!(
            e,
            ValidationError::Live(LiveError::LiveDataOnFallbackScene { .. })
        )));
    }
}
