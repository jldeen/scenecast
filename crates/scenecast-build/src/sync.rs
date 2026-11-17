//! The bundle manifest (v2) from what the engine built: every state in `flow.json` is a `live-page` scene whose
//! page is `data/snaps/<snap>.html`, with its transitions, the streams, beats and focus points. Fallback scenes
//! already in the manifest (screenshot, video-frame) are kept as they are, and reported.
//!
//! Content-hashed: each page's SHA-256 goes in the manifest, and the manifest is only rewritten when it changes.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use scenecast_core::{
    App, Beat, BundleManifest, FocusMark, FocusPoint, LivePage, PlaybackAction, PlaybackData,
    Scene, SceneId, ScenePlayback, Section, StateTransition, StateTrigger, Stream, StreamTiming,
    TransitionPlayback, Viewport, manifest_path, read_manifest, validate_referenced_files,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("failed to read `{path}`")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("`{path}` is not valid JSON")]
    Json {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("flow.json: {0}")]
    Flow(String),
    #[error(transparent)]
    Manifest(#[from] scenecast_core::BundleIoError),
}

/// What a sync found and wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Whether manifest.json changed.
    pub written: bool,
    pub live_scenes: usize,
    /// Fallback scenes (id, kind): screenshot or video-frame scenes kept from before. Each one is flagged.
    pub fallback: Vec<(String, String)>,
    pub streams: usize,
    pub beats: usize,
    pub focus_points: usize,
    /// Validation and missing-file errors: the build fails on any.
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl SyncReport {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }
}

/// The fallback scenes of a bundle (id, kind), for checks to flag.
pub fn fallback_scenes(dir: &Path) -> Result<Vec<(String, String)>, SyncError> {
    if !manifest_path(dir).is_file() {
        return Ok(Vec::new());
    }
    Ok(read_manifest(dir)?
        .fallback_scenes()
        .map(|s| (s.id.to_string(), s.kind.as_str().to_owned()))
        .collect())
}

pub fn sync_manifest(dir: &Path) -> Result<SyncReport, SyncError> {
    let demo = read_json(&dir.join("demo.json"))?;
    let flow = read_json(&dir.join("flow.json"))?;
    let previous = if manifest_path(dir).is_file() {
        Some(read_manifest(dir)?)
    } else {
        None
    };
    let title = str_of(&flow, "title")
        .or_else(|| str_of(&demo, "title"))
        .or_else(|| str_of(&demo, "name"))
        .unwrap_or("Untitled")
        .to_owned();
    let mut manifest = previous
        .clone()
        .unwrap_or_else(|| BundleManifest::starter(&title));
    manifest.schema_version = scenecast_core::SCHEMA_VERSION.to_owned();
    manifest.title = title;

    // Apps: flow.json's (ids, keys, titles), with the start URL from demo.json (origin and path only).
    let demo_apps = demo
        .get("apps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    manifest.apps = arr(&flow, "apps")
        .iter()
        .filter_map(|a| {
            let id = str_of(a, "id")?.to_owned();
            let url = demo_apps
                .iter()
                .find(|d| str_of(d, "id") == Some(id.as_str()))
                .and_then(|d| str_of(d, "url"))
                .map(|u| u.split(['?', '#']).next().unwrap_or(u).to_owned());
            Some(App {
                title: str_of(a, "title").unwrap_or(&id).to_owned(),
                key: str_of(a, "key").map(str::to_owned),
                url,
                id,
            })
        })
        .collect();
    if let Some(v) = demo.get("viewport") {
        manifest.viewport = Some(Viewport {
            width: v.get("width").and_then(Value::as_u64).unwrap_or(1920) as u32,
            height: v.get("height").and_then(Value::as_u64).unwrap_or(1080) as u32,
            dpr: v.get("dpr").and_then(Value::as_f64).unwrap_or(1.0) as f32,
        });
    }

    let states = flow
        .get("states")
        .and_then(Value::as_object)
        .ok_or_else(|| SyncError::Flow("no states".to_owned()))?;
    let mut live = Vec::new();
    let mut scene_playback = BTreeMap::new();
    for (id, state) in states {
        let (scene, playback) = live_scene(dir, id, state, &flow)?;
        live.push(scene);
        scene_playback.insert(id.clone(), playback);
    }

    // Fallback scenes stay; the live ones are replaced by what was recorded.
    let fallback: Vec<Scene> = manifest
        .graph
        .scenes
        .iter()
        .filter(|s| s.kind.is_fallback())
        .cloned()
        .collect();

    manifest.streams = flow
        .get("streams")
        .and_then(Value::as_object)
        .map(|streams| {
            streams
                .iter()
                .filter_map(|(id, s)| {
                    let frames = s.get("frames").and_then(Value::as_array);
                    let count = match frames.map(|f| f.as_slice()) {
                        Some([a, b]) => b.as_u64()?.saturating_sub(a.as_u64()?) + 1,
                        _ => 0,
                    };
                    Some(Stream {
                        id: id.clone(),
                        target: scene_id(str_of(s, "to")?).ok()?,
                        frames: count as u32,
                        timing: if str_of(s, "timing") == Some("real") {
                            StreamTiming::Real
                        } else {
                            StreamTiming::Even
                        },
                        duration_ms: s.get("ms").and_then(Value::as_u64),
                        prompt: str_of(s, "prompt").map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    manifest.beats = arr(&flow, "beats")
        .iter()
        .map(|b| Beat {
            label: str_of(b, "label").unwrap_or_default().to_owned(),
            active: str_of(b, "active").unwrap_or_default().to_owned(),
            scenes: b
                .get("states")
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .filter_map(|(app, st)| Some((app.clone(), scene_id(st.as_str()?).ok()?)))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default(),
        })
        .collect();

    manifest.focus_points = arr(&flow, "focus")
        .iter()
        .enumerate()
        .map(|(i, p)| FocusPoint {
            id: str_of(p, "id")
                .map(str::to_owned)
                .unwrap_or_else(|| format!("focus-{}", i + 1)),
            beat: p.get("beat").and_then(Value::as_u64).unwrap_or(0) as u32,
            app: str_of(p, "app").unwrap_or_default().to_owned(),
            scenes: p
                .get("states")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|s| scene_id(s.as_str()?).ok())
                        .collect()
                })
                .unwrap_or_default(),
            find: str_of(p, "find").map(str::to_owned),
            union: arr(p, "union"),
            mark: match str_of(p, "mark") {
                Some("arrow") => FocusMark::Arrow,
                Some("zoom") | Some("none") => FocusMark::Zoom,
                _ => FocusMark::Box,
            },
            dir: str_of(p, "dir").map(str::to_owned),
            line: p.get("line").map(|l| match l {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            }),
        })
        .collect();

    manifest.playback = Some(PlaybackData {
        options: without(
            &flow,
            &["title", "apps", "states", "streams", "beats", "focus"],
        ),
        apps: arr(&flow, "apps")
            .into_iter()
            .filter_map(|app| {
                let id = str_of(&app, "id")?.to_owned();
                Some((id, without(&app, &["id", "key", "title"])))
            })
            .collect(),
        scenes: scene_playback,
        streams: flow
            .get("streams")
            .and_then(Value::as_object)
            .map(|streams| {
                streams
                    .iter()
                    .map(|(id, stream)| {
                        let mut options =
                            without(stream, &["frames", "to", "timing", "ms", "prompt"]);
                        if let Some(first) = stream
                            .get("frames")
                            .and_then(Value::as_array)
                            .and_then(|f| f.first())
                        {
                            options["first_frame"] = first.clone();
                        }
                        (id.clone(), options)
                    })
                    .collect()
            })
            .unwrap_or_default(),
        focus_points: arr(&flow, "focus")
            .into_iter()
            .enumerate()
            .map(|(i, point)| {
                let id = str_of(&point, "id")
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("focus-{}", i + 1));
                (
                    id,
                    without(
                        &point,
                        &[
                            "id", "beat", "app", "states", "find", "union", "mark", "dir", "line",
                        ],
                    ),
                )
            })
            .collect(),
    });

    // Start: where reset (beat 0) puts the active app; else the first recorded scene.
    let start = manifest
        .beats
        .first()
        .and_then(|b| b.scenes.get(&b.active).cloned())
        .or_else(|| live.first().map(|s: &Scene| s.id.clone()));
    // A section per app, its scenes in recorded order.
    let mut sections: Vec<Section> = manifest
        .apps
        .iter()
        .map(|a| Section {
            id: a.id.clone(),
            title: a.title.clone(),
            scenes: live
                .iter()
                .filter(|s| s.live.as_ref().is_some_and(|l| l.app == a.id))
                .map(|s| s.id.clone())
                .collect(),
        })
        .filter(|s| !s.scenes.is_empty())
        .collect();
    if !fallback.is_empty() {
        sections.push(Section {
            id: "fallback".to_owned(),
            title: "Fallback scenes".to_owned(),
            scenes: fallback.iter().map(|s| s.id.clone()).collect(),
        });
    }
    manifest.sections = sections;
    manifest.graph.scenes = live.into_iter().chain(fallback).collect();
    if let Some(start) = start {
        manifest.graph.start_scene = start;
    }

    let mut report = SyncReport {
        live_scenes: manifest
            .graph
            .scenes
            .iter()
            .filter(|s| !s.kind.is_fallback())
            .count(),
        fallback: manifest
            .fallback_scenes()
            .map(|s| (s.id.to_string(), s.kind.as_str().to_owned()))
            .collect(),
        streams: manifest.streams.len(),
        beats: manifest.beats.len(),
        focus_points: manifest.focus_points.len(),
        ..SyncReport::default()
    };
    let validation = manifest.validate();
    report.errors = validation.errors.iter().map(ToString::to_string).collect();
    report.warnings = validation
        .warnings
        .iter()
        .map(ToString::to_string)
        .collect();
    report.errors.extend(
        validate_referenced_files(dir, &manifest)
            .missing_files
            .iter()
            .map(ToString::to_string),
    );

    let before = fs::read_to_string(manifest_path(dir)).unwrap_or_default();
    let after = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest).map_err(scenecast_core::BundleIoError::from)?
    );
    if before != after {
        scenecast_core::write_manifest(dir, &manifest)?;
        report.written = true;
    }
    Ok(report)
}

fn live_scene(
    dir: &Path,
    id: &str,
    state: &Value,
    flow: &Value,
) -> Result<(Scene, ScenePlayback), SyncError> {
    let bad = |what: &str| SyncError::Flow(format!("state `{id}`: {what}"));
    let sid = scene_id(id).map_err(|e| bad(&e))?;
    let app = str_of(state, "app").ok_or_else(|| bad("no app"))?;
    let snap = str_of(state, "snap").unwrap_or(id);
    let snapshot = format!("data/snaps/{snap}.html");
    let sha256 = fs::read(dir.join("data").join("snaps").join(format!("{snap}.html")))
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
    let mut transitions = Vec::new();
    let mut actions = Vec::new();
    for (order, t) in arr(state, "on").into_iter().enumerate() {
        let Some((trigger, matcher)) = [
            ("click", StateTrigger::Click),
            ("enter", StateTrigger::Enter),
            ("type", StateTrigger::Type),
            ("hover", StateTrigger::Hover),
        ]
        .into_iter()
        .find_map(|(k, trig)| t.get(k).map(|m| (trig, m.clone()))) else {
            actions.push(PlaybackAction {
                order: order as u32,
                action: t,
            });
            continue;
        };
        // A streamed answer lands where its stream ends; a search box's Enter can go to several states, by what
        // was typed.
        let stream_end = str_of(&t, "stream")
            .and_then(|name| flow.get("streams")?.get(name))
            .and_then(|st| str_of(st, "to"));
        let targets: Vec<(Option<String>, &str)> = match (
            stream_end,
            t.get("query").and_then(Value::as_object),
            str_of(&t, "to"),
        ) {
            (Some(to), _, _) => vec![(None, to)],
            (None, Some(q), _) => q
                .iter()
                .filter_map(|(k, v)| Some((Some(k.clone()), v.as_str()?)))
                .collect(),
            (None, None, Some(to)) => vec![(None, to)],
            _ => Vec::new(),
        };
        if targets.is_empty() {
            actions.push(PlaybackAction {
                order: order as u32,
                action: t,
            });
            continue;
        }
        for (query_key, target) in targets {
            transitions.push(StateTransition {
                trigger,
                target: scene_id(target).map_err(|e| bad(&e))?,
                matcher: Some(matcher.clone()),
                stream: str_of(&t, "stream").map(str::to_owned),
                app: str_of(&t, "app").map(str::to_owned),
                playback: Some(TransitionPlayback {
                    order: order as u32,
                    query_key,
                    options: without(
                        &t,
                        &[
                            "click", "enter", "type", "hover", "to", "stream", "app", "query",
                        ],
                    ),
                }),
            });
        }
    }
    if let Some(esc) = str_of(state, "esc") {
        transitions.push(StateTransition {
            trigger: StateTrigger::Escape,
            target: scene_id(esc).map_err(|e| bad(&e))?,
            matcher: None,
            stream: None,
            app: None,
            playback: None,
        });
    }
    let title = str_of(state, "title").unwrap_or(id).to_owned();
    let scene = Scene {
        transitions,
        ..Scene::live_page(
            sid,
            title.clone(),
            Some(LivePage {
                app: app.to_owned(),
                snapshot,
                title: Some(title),
                reference: None,
                sha256,
            }),
        )
    };
    Ok((
        scene,
        ScenePlayback {
            options: without(state, &["app", "snap", "title", "on", "esc"]),
            actions,
        },
    ))
}

fn scene_id(id: &str) -> Result<SceneId, String> {
    SceneId::new(id).map_err(|e| e.to_string())
}

fn read_json(path: &Path) -> Result<Value, SyncError> {
    let text = fs::read_to_string(path).map_err(|source| SyncError::Read {
        path: path.display().to_string(),
        source,
    })?;
    serde_json::from_str(&text).map_err(|source| SyncError::Json {
        path: path.display().to_string(),
        source,
    })
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn arr(v: &Value, key: &str) -> Vec<Value> {
    v.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn without(value: &Value, keys: &[&str]) -> Value {
    let mut map = value.as_object().cloned().unwrap_or_default();
    for key in keys {
        map.remove(*key);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use scenecast_core::{Scene, SceneKind, write_manifest};

    fn project() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let d = temp.path();
        fs::create_dir_all(d.join("data/snaps")).unwrap();
        for s in ["chat-start", "chat-01"] {
            fs::write(
                d.join(format!("data/snaps/{s}.html")),
                format!("<p>{s}</p>"),
            )
            .unwrap();
        }
        fs::write(
            d.join("demo.json"),
            r#"{"name":"fx","title":"Fixture","viewport":{"width":1600,"height":900,"dpr":1},
                "apps":[{"id":"chat","key":"C","url":"https://chat.example.test/x?token=abc"}]}"#,
        )
        .unwrap();
        fs::write(
            d.join("flow.json"),
            r#"{"title":"Fixture","apps":[{"id":"chat","key":"C","title":"Chat"}],
                "states":{
                  "chat-start":{"app":"chat","snap":"chat-start","on":[{"enter":{"sel":"[aria-label=\"Message\"]"},"stream":"s001"}]},
                  "chat-01":{"app":"chat","snap":"chat-01","esc":"chat-start"}},
                "streams":{"s001":{"frames":[0,14],"to":"chat-01","timing":"real","ms":4211,"prompt":"Hi"}},
                "beats":[{"label":"0 Reset","active":"chat","states":{"chat":"chat-start"}}],
                "focus":[{"id":"answer","beat":0,"app":"chat","states":["chat-01"],"find":"Two builds"}]}"#,
        )
        .unwrap();
        temp
    }

    #[test]
    fn flow_becomes_live_page_scenes_and_keeps_fallbacks() {
        let temp = project();
        let d = temp.path();
        let mut m = BundleManifest::starter("Fixture");
        m.graph.scenes.push(Scene::screenshot(
            SceneId::new("native").unwrap(),
            "Native",
            None,
        ));
        write_manifest(d, &m).unwrap();

        let r = sync_manifest(d).unwrap();

        assert!(r.is_valid(), "{:?}", r.errors);
        assert!(r.written);
        assert_eq!(r.live_scenes, 2);
        assert_eq!(r.fallback, [("native".to_owned(), "screenshot".to_owned())]);
        let m = read_manifest(d).unwrap();
        assert_eq!(m.graph.start_scene.as_str(), "chat-start");
        assert!(m.graph.scene(&SceneId::new("start").unwrap()).is_none());
        let start = m.graph.scene(&SceneId::new("chat-start").unwrap()).unwrap();
        assert_eq!(start.kind, SceneKind::LivePage);
        assert_eq!(start.transitions[0].stream.as_deref(), Some("s001"));
        assert_eq!(start.transitions[0].target.as_str(), "chat-01");
        assert_eq!(
            start.live.as_ref().unwrap().sha256.as_ref().unwrap().len(),
            64
        );
        assert_eq!(m.streams[0].frames, 15);
        assert_eq!(
            m.apps[0].url.as_deref(),
            Some("https://chat.example.test/x")
        );
        assert_eq!(m.focus_points[0].find.as_deref(), Some("Two builds"));

        // Unchanged inputs: nothing rewritten.
        assert!(!sync_manifest(d).unwrap().written);
    }

    #[test]
    fn a_missing_page_fails_the_sync() {
        let temp = project();
        fs::remove_file(temp.path().join("data/snaps/chat-01.html")).unwrap();
        let r = sync_manifest(temp.path()).unwrap();
        assert!(
            r.errors
                .iter()
                .any(|e| e.contains("data/snaps/chat-01.html")),
            "{:?}",
            r.errors
        );
    }

    #[test]
    fn playback_keeps_runtime_options_and_query_targets() {
        let temp = project();
        let path = temp.path().join("flow.json");
        let mut flow: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        flow["pace"] = 7.into();
        flow["apps"][0]["layout"] = serde_json::json!({"chips": [{"rows": 2}]});
        flow["states"]["chat-start"]["fill"] =
            serde_json::json!([{"sel":"input", "value":"hello"}]);
        flow["states"]["chat-start"]["on"] = serde_json::json!([
            {"enter":{"sel":"input"},"query":{"one":"chat-start","two":"chat-01"},"scroll":"keep"},
            {"click":{"sel":"button"},"flag":"open"}
        ]);
        flow["streams"]["s001"]["frames"] = serde_json::json!([5, 14]);
        flow["streams"]["s001"]["raw"] = "raw-answer".into();
        fs::write(&path, serde_json::to_vec(&flow).unwrap()).unwrap();
        assert!(sync_manifest(temp.path()).unwrap().is_valid());
        let manifest = read_manifest(temp.path()).unwrap();
        let playback = manifest.playback.as_ref().unwrap();
        assert_eq!(playback.options["pace"], 7);
        assert_eq!(playback.apps["chat"]["layout"]["chips"][0]["rows"], 2);
        assert_eq!(
            playback.scenes["chat-start"].options["fill"][0]["value"],
            "hello"
        );
        assert_eq!(
            playback.scenes["chat-start"].actions[0].action["flag"],
            "open"
        );
        assert_eq!(playback.streams["s001"]["first_frame"], 5);
        assert_eq!(playback.streams["s001"]["raw"], "raw-answer");
        let transitions = &manifest
            .graph
            .scene(&SceneId::new("chat-start").unwrap())
            .unwrap()
            .transitions;
        assert_eq!(transitions.len(), 2);
        assert_eq!(
            transitions[0]
                .playback
                .as_ref()
                .unwrap()
                .query_key
                .as_deref(),
            Some("one")
        );
        assert_eq!(
            transitions[0].playback.as_ref().unwrap().options["scroll"],
            "keep"
        );
        assert_eq!(
            transitions[1]
                .playback
                .as_ref()
                .unwrap()
                .query_key
                .as_deref(),
            Some("two")
        );
    }
}
