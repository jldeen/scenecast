//! The presenter's one-page key reference, from the demo's manifest: shown before presenting starts, never while.

use std::path::Path;

use scenecast_core::{BundleManifest, read_manifest};
use serde::{Deserialize, Serialize};

use crate::AppError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyRow {
    /// The keys, spelled out for this OS (`⌥1`, `Ctrl+Alt+1`).
    pub keys: String,
    pub what: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyGroup {
    pub title: String,
    pub rows: Vec<KeyRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReference {
    pub title: String,
    /// `macos` or `windows`.
    pub os: String,
    /// `⌥` or `Ctrl+Alt`.
    pub modifier: String,
    pub groups: Vec<KeyGroup>,
    /// How to leave full screen and stop.
    pub exit: String,
}

/// `macos` on a Mac, `windows` everywhere else (Ctrl+Alt works on any OS).
pub fn this_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    }
}

pub fn reference(dir: &Path, os: &str) -> Result<KeyReference, AppError> {
    let manifest = read_manifest(dir)?;
    // The script and the editor write focus.json; the manifest has them only after the next build.
    let points = crate::library::status(dir, Some(&manifest)).focus_points;
    Ok(reference_for(&manifest, os, points))
}

/// A beat's label without the beat number the recorder puts in front (`2 chat: chat-01-message` → `chat: …`).
fn beat_label(label: &str, n: usize) -> &str {
    label
        .strip_prefix(&format!("{n} "))
        .map(str::trim_start)
        .filter(|rest| !rest.is_empty())
        .unwrap_or(label)
}

pub fn reference_for(m: &BundleManifest, os: &str, focus_points: usize) -> KeyReference {
    let mac = os == "macos";
    let modifier = if mac { "⌥" } else { "Ctrl+Alt+" };
    let k = |key: &str| format!("{modifier}{key}");
    let p = &m.presenter;
    let mut beats = Vec::new();
    for (i, beat) in m.beats.iter().enumerate().take(10) {
        let what = if i == 0 {
            "Back to the start".to_owned()
        } else {
            beat_label(&beat.label, i).to_owned()
        };
        beats.push(KeyRow {
            keys: k(&i.to_string()),
            what,
        });
    }
    if beats.is_empty() {
        beats.push(KeyRow {
            keys: k("0"),
            what: "Back to the start".into(),
        });
    }
    let mut apps: Vec<KeyRow> = m
        .apps
        .iter()
        .filter_map(|a| {
            Some(KeyRow {
                keys: k(&a.key.as_ref()?.to_uppercase()),
                what: format!("Show {}", if a.title.is_empty() { &a.id } else { &a.title }),
            })
        })
        .collect();
    if m.apps.len() > 1 {
        apps.push(KeyRow {
            keys: format!("{} / {}", k("←"), k("→")),
            what: "The app before / after".into(),
        });
    }
    let focus = p.focus_key.to_uppercase();
    let mut groups = vec![
        KeyGroup {
            title: "Beats".into(),
            rows: beats,
        },
        KeyGroup {
            title: "Focus points".into(),
            rows: vec![
                KeyRow {
                    keys: k(&focus),
                    what: format!("Zoom to the next focus point ({focus_points} in this demo)"),
                },
                KeyRow {
                    keys: format!("{}⇧{focus}", if mac { "⌥" } else { "Ctrl+Alt+" }),
                    what: "The focus point before".into(),
                },
                KeyRow {
                    keys: "Esc".into(),
                    what: "Zoom back out (or close a menu)".into(),
                },
            ],
        },
        KeyGroup {
            title: "On a screen".into(),
            rows: vec![
                KeyRow {
                    keys: k(&p.fill_key.to_uppercase()),
                    what: "Type the scripted text into the box".into(),
                },
                KeyRow {
                    keys: k(&p.next_key.to_uppercase()),
                    what: "The screen's next step".into(),
                },
                KeyRow {
                    keys: "Click, type, Enter".into(),
                    what: "Work it like the real product".into(),
                },
            ],
        },
    ];
    if !apps.is_empty() {
        groups.insert(
            1,
            KeyGroup {
                title: "Apps".into(),
                rows: apps,
            },
        );
    }
    KeyReference {
        title: m.title.clone(),
        os: os.to_owned(),
        modifier: if mac { "⌥" } else { "Ctrl+Alt" }.to_owned(),
        exit: if mac {
            "⌃⌘F leaves full screen; ⌘W closes the window. Then Stop presenting here."
        } else {
            "F11 leaves full screen; Ctrl+W closes the window. Then Stop presenting here."
        }
        .to_owned(),
        groups,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> BundleManifest {
        serde_json::from_value(serde_json::json!({
            "schema_version": "scenecast.bundle.v2",
            "title": "Fixture",
            "apps": [{"id": "chat", "title": "Chat", "key": "c"}, {"id": "admin", "title": "", "key": "a"}],
            "graph": {"start_scene": "chat-start", "scenes": []},
            "beats": [{"label": "0 Reset", "active": "chat"}, {"label": "1 Ask", "active": "chat"}, {"label": "2026 plan", "active": "chat"}],
        }))
        .unwrap()
    }

    #[test]
    fn spells_the_keys_for_each_os() {
        let mac = reference_for(&manifest(), "macos", 4);
        let win = reference_for(&manifest(), "windows", 4);
        assert_eq!(mac.modifier, "⌥");
        assert_eq!(
            mac.groups[0].rows[1],
            KeyRow {
                keys: "⌥1".into(),
                what: "Ask".into()
            }
        );
        assert_eq!(win.groups[0].rows[0].keys, "Ctrl+Alt+0");
        assert_eq!(win.groups[0].rows[0].what, "Back to the start");
        assert_eq!(win.groups[0].rows[2].what, "2026 plan");
        assert!(mac.groups[2].rows[0].what.contains("4 in this demo"));
        let apps = &mac.groups[1];
        assert_eq!(apps.title, "Apps");
        assert_eq!(
            apps.rows[0],
            KeyRow {
                keys: "⌥C".into(),
                what: "Show Chat".into()
            }
        );
        assert_eq!(apps.rows[1].what, "Show admin");
        assert_eq!(apps.rows.len(), 3);
        assert!(
            mac.groups
                .iter()
                .flat_map(|g| &g.rows)
                .any(|r| r.keys == "⌥F")
        );
        assert!(win.exit.contains("F11"));
    }
}
