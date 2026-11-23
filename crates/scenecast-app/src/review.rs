//! Review: the show's beats, each with the screens recorded in it (in the order they were reached), and how each one
//! compares with the real product, in a sentence when it differs. From the run of show (rundown.rs), the recording's
//! path (`recording.json`), the replica's beats (`manifest.json`: where each beat starts) and the last real-vs-replica
//! report (`.out/fidelity/report.json`).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One screen: what was recorded, and how the replica compares.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// The recorded state (`copilot-02-message-copilot`).
    pub id: String,
    pub app: String,
    /// What was recorded (the real product), when the recording's pictures are there.
    pub shot: Option<PathBuf>,
    /// A small copy of it for the filmstrip (the shot is about 3000 px wide; dozens of them in a row loaded the
    /// window's GPU for nothing). None: no shot, or it couldn't be made (the filmstrip uses the shot).
    #[serde(default)]
    pub thumb: Option<PathBuf>,
    /// Real and replica side by side, when it's been compared.
    pub side_by_side: Option<PathBuf>,
    /// Compared: the screen itself (at 100%, nothing open) within the threshold, as the report counts it. None: not
    /// compared yet. Its other views (zoom levels, menus) have their own verdicts in `views`.
    pub pass: Option<bool>,
    /// How different the screen itself is, in percent of pixels.
    pub pct: Option<f64>,
    /// Its other views that differ (each zoom level, each menu opened on it), each with its own verdict.
    #[serde(default)]
    pub views: Vec<View>,
    /// Why it differs, in a plain sentence each.
    pub why: Vec<String>,
    /// What the fixer found, in its own words (for Details).
    #[serde(default)]
    pub detail: Vec<String>,
    /// Where it differs, when the checker drew it in the browser it was recorded in: a spot or an area, in the
    /// picture's pixels: [x, y, w, h, picture width, picture height], to highlight.
    #[serde(default)]
    pub spot: Option<[i64; 6]>,
    /// Compared in the browser it was recorded in (only a real difference counts), not a headless one.
    #[serde(default)]
    pub real_checker: bool,
}

/// What a fixer cause means, in a sentence for anyone. Its own summary (selectors, file names) goes under Details.
fn plain_cause(cause: &str) -> Option<&'static str> {
    Some(match cause {
        "font-substituted" => {
            "Some text is in a different font: the replica doesn't have the font's file."
        }
        "missing-asset" => "A picture or icon is missing in the replica.",
        "late-style" => "A menu or panel opens without its look in the replica.",
        "script-pinned" => "Something the page places itself is in a different spot.",
        "script-sized" => "Something the page sizes to the window is a different size.",
        "virtualized" => "A long list ends early: only the rows on screen were recorded.",
        "size" => "The replica showed this screen at a different size.",
        "unexplained" => {
            "It still differs, and the reason isn't clear. If it looks wrong, record this screen again."
        }
        "error" => "Fix it for me hit a problem on this screen.",
        _ => return None,
    })
}

/// A view of a screen other than itself (a zoom level, a menu opened on it), compared on its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// In plain words: "at 110% zoom", "with Settings open".
    pub label: String,
    pub pass: bool,
    pub pct: Option<f64>,
    pub side_by_side: Option<PathBuf>,
}

fn view_label(it: &Value) -> String {
    match it["kind"].as_str() {
        Some("zoom") => format!("at {}% zoom", it["z"].as_u64().unwrap_or(100)),
        Some("click") => format!(
            "with {} open",
            it["click"]["name"].as_str().unwrap_or("a menu")
        ),
        Some("hover") => "with the pointer on a control".into(),
        _ => it["id"].as_str().unwrap_or("another view").to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBeat {
    pub n: u32,
    pub title: String,
    pub start: Option<u32>,
    pub end: Option<u32>,
    pub app: Option<String>,
    pub key: Option<String>,
    pub screens: Vec<Screen>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub beats: Vec<ReviewBeat>,
    /// Screens off the recorded path (menus, hovers, side screens) that differ: shown apart, so none is missed.
    pub others: Vec<Screen>,
    pub screens: u32,
    /// Compared with the real product (a report is there).
    pub compared: bool,
    /// A compare is under way: the screens compared so far have their verdicts, the rest are still to come.
    pub comparing: bool,
    pub matching: u32,
    pub differ: u32,
    /// Other views (zoom levels, menus) of the listed screens that differ, counted apart from the screens.
    #[serde(default)]
    pub views_differ: u32,
    /// Every font the real file.
    pub fonts_ok: bool,
    /// The full report, to open.
    pub report: Option<PathBuf>,
    /// The folder the pictures are in (for the app to serve them).
    pub pictures: Vec<PathBuf>,
}

/// The filmstrip's copy of a shot, 360 px wide, made once (again when the shot is newer).
const THUMB_WIDTH: u32 = 360;
fn thumb_of(shot: &Path, thumb: &Path) -> Option<PathBuf> {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let fresh = matches!((modified(thumb), modified(shot)), (Some(t), Some(s)) if t >= s);
    if !fresh {
        std::fs::create_dir_all(thumb.parent()?).ok()?;
        crate::guide::shrink_png(shot, thumb, THUMB_WIDTH).ok()?;
    }
    Some(thumb.to_owned())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The demo's review, with keys spelled for `os`.
pub fn read(dir: &Path, os: &str) -> Review {
    let raw = scenecast_build::build::raw_dir(dir).ok();
    let recording = read_json(&dir.join("recording.json"))
        .or_else(|| read_json(&raw.as_ref()?.join("recording.json")))
        .unwrap_or(Value::Null);
    let shots = raw.as_ref().map(|r| r.join("shots"));
    let thumbs = raw.as_ref().map(|r| r.join("thumbs"));
    let live = crate::fidelity::live(dir);
    let comparing = live.is_some();
    let fidelity = live.or_else(|| crate::fidelity::last(dir));
    let report = fidelity.as_ref().map(|f| &f.report);

    // Each state's views (zoom, click, the state itself) in the report.
    let mut views: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for it in report
        .and_then(|r| r["items"].as_array())
        .into_iter()
        .flatten()
    {
        let state = it["state"].as_str().or(it["id"].as_str()).unwrap_or("");
        views.entry(state.to_owned()).or_default().push(it);
    }
    let residual: BTreeMap<&str, Vec<String>> = report
        .and_then(|r| r["residual"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let why = r["why"].as_array()?.iter().filter_map(Value::as_str);
            Some((r["id"].as_str()?, why.map(str::to_owned).collect()))
        })
        .collect();
    let fid_dir = fidelity.as_ref().map(|f| f.dir.clone());
    let screen = |id: &str, app: &str| -> Screen {
        let snap = recording["states"][id]["snap"].as_str().unwrap_or(id);
        let shot = shots
            .as_ref()
            .map(|s| s.join(format!("{snap}.png")))
            .filter(|p| p.is_file());
        let thumb = shot
            .as_ref()
            .zip(thumbs.as_ref())
            .and_then(|(s, t)| thumb_of(s, &t.join(format!("{snap}.png"))));
        let mine = views.get(id).cloned().unwrap_or_default();
        let base = mine
            .iter()
            .find(|i| i["kind"] == "state" && i["z"].as_u64().unwrap_or(100) == 100)
            .or(mine.first());
        let side_by_side = base
            .and_then(|i| i["sideBySide"].as_str())
            .zip(fid_dir.as_ref())
            .map(|(rel, d)| d.join(rel));
        // The screen's own verdict is its own view's (as the report counts it); a zoom level or a menu that differs
        // is listed under it, not folded in (Nov 2026: a screen read "17.4% different", its 110% zoom's score).
        let pass = base.map(|i| i["pass"] == true);
        let pct = base.and_then(|i| i["pct"].as_f64());
        let spot = base.and_then(|i| {
            let a = &i["differs"]["at"];
            let size = &i["size"]["real"];
            Some([
                a["x"].as_i64()?,
                a["y"].as_i64()?,
                a["w"].as_i64()?,
                a["h"].as_i64()?,
                size[0].as_i64()?,
                size[1].as_i64()?,
            ])
        });
        let real_checker = base.is_some_and(|i| i["checker"] == "real");
        let views: Vec<View> = mine
            .iter()
            .filter(|i| base.is_none_or(|b| !std::ptr::eq(*i, b)) && i["pass"] != true)
            .map(|i| View {
                label: view_label(i),
                pass: false,
                pct: i["pct"].as_f64(),
                side_by_side: i["sideBySide"]
                    .as_str()
                    .zip(fid_dir.as_ref())
                    .map(|(rel, d)| d.join(rel)),
            })
            .collect();
        let (mut why, mut detail) = (Vec::new(), Vec::new());
        let add = |list: &mut Vec<String>, w: String| {
            if !list.contains(&w) {
                list.push(w);
            }
        };
        for i in mine.iter().filter(|i| i["pass"] != true) {
            let causes = i["causes"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            for c in causes {
                let summary = c["summary"].as_str().map(str::to_owned);
                match (c["cause"].as_str().and_then(plain_cause), summary) {
                    (Some(plain), summary) => {
                        add(&mut why, plain.to_owned());
                        if let Some(s) = summary {
                            add(&mut detail, s);
                        }
                    }
                    (None, Some(s)) => add(&mut why, s),
                    (None, None) => {}
                }
            }
            if causes.is_empty() {
                let left = i["id"].as_str().and_then(|x| residual.get(x));
                for w in left.into_iter().flatten() {
                    add(&mut why, w.clone());
                }
            }
        }
        Screen {
            id: id.to_owned(),
            app: app.to_owned(),
            shot,
            thumb,
            side_by_side,
            pass,
            pct,
            views,
            why,
            detail,
            spot,
            real_checker,
        }
    };

    // The recorded path: each screen once, in the order it was first reached.
    let mut seen = HashSet::new();
    let mut path: Vec<(String, String)> = Vec::new();
    let mut app = String::new();
    for p in recording["path"].as_array().into_iter().flatten() {
        if let Some(a) = p["app"].as_str() {
            app = a.to_owned();
        }
        let Some(id) = p["checkpoint"].as_str() else {
            continue;
        };
        let app_of = recording["states"][id]["app"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| app.clone());
        if seen.insert(id.to_owned()) {
            path.push((id.to_owned(), app_of));
        }
    }

    // Where each beat starts on the path (the replica's beat n starts on its active app's scene).
    let run = crate::rundown::read(dir, os);
    let manifest = scenecast_core::read_manifest(dir).ok();
    let mut starts: Vec<(u32, usize)> = Vec::new();
    let mut from = 0;
    for b in &run.beats {
        let at = manifest
            .as_ref()
            .and_then(|m| m.beats.get(b.n as usize))
            .and_then(|mb| mb.scenes.get(&mb.active))
            .and_then(|scene| {
                path.iter()
                    .skip(from)
                    .position(|(id, _)| id == scene.as_str())
                    .map(|i| i + from)
            });
        if let Some(i) = at {
            starts.push((b.n, i));
            from = i;
        }
    }
    let mut beats: Vec<ReviewBeat> = run
        .beats
        .iter()
        .map(|b| ReviewBeat {
            n: b.n,
            title: b.title.clone(),
            start: b.start,
            end: b.end,
            app: b.app.clone(),
            key: b.key.clone(),
            screens: Vec::new(),
        })
        .collect();
    if beats.is_empty() || starts.is_empty() {
        // No beats to cut it by: the whole show is one.
        beats = vec![ReviewBeat {
            n: 1,
            title: "The show".into(),
            start: None,
            end: None,
            app: None,
            key: None,
            screens: Vec::new(),
        }];
        starts = vec![(1, 0)];
    }
    // Screens before the first beat's start belong to it.
    starts[0].1 = 0;
    for (k, (n, i)) in starts.iter().enumerate() {
        let until = starts.get(k + 1).map_or(path.len(), |s| s.1);
        if let Some(b) = beats.iter_mut().find(|b| b.n == *n) {
            b.screens = path[*i..until.max(*i)]
                .iter()
                .map(|(id, app)| screen(id, app))
                .collect();
        }
    }

    // Each app's start screen that the path didn't pass through (the apps it never switched to before the first beat):
    // shown first, as their own group, not under "Menus and hovers".
    let mut starts_extra: Vec<Screen> = Vec::new();
    let start_states = &recording["beats"][0]["states"];
    let app_order: Vec<String> = recording["apps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["id"].as_str().map(str::to_owned))
        .collect();
    let mut start_apps: Vec<String> = app_order
        .iter()
        .filter(|a| start_states.get(a.as_str()).is_some())
        .cloned()
        .collect();
    for a in start_states
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, _)| k)
    {
        if !start_apps.contains(a) {
            start_apps.push(a.clone());
        }
    }
    for a in &start_apps {
        if let Some(id) = start_states[a.as_str()].as_str()
            && !seen.contains(id)
        {
            starts_extra.push(screen(id, a));
        }
    }
    if !starts_extra.is_empty() {
        beats.insert(
            0,
            ReviewBeat {
                n: 0,
                title: "Each app's start screen".into(),
                start: None,
                end: None,
                app: None,
                key: None,
                screens: starts_extra,
            },
        );
    }

    let on_path: HashSet<&str> = beats
        .iter()
        .flat_map(|b| b.screens.iter().map(|s| s.id.as_str()))
        .collect();
    let others: Vec<Screen> = views
        .keys()
        .filter(|id| !on_path.contains(id.as_str()))
        .map(|id| {
            let app = recording["states"][id.as_str()]["app"]
                .as_str()
                .unwrap_or_default();
            screen(id, app)
        })
        .filter(|s| s.pass == Some(false) || !s.views.is_empty())
        .collect();
    let all: Vec<&Screen> = beats.iter().flat_map(|b| &b.screens).collect();
    let fonts_ok = report
        .and_then(|r| r["fonts"].as_array())
        .is_none_or(|f| f.iter().all(|x| x["status"] == "match"));
    Review {
        screens: all.len() as u32,
        compared: report.is_some() && !comparing,
        comparing,
        matching: all.iter().filter(|s| s.pass == Some(true)).count() as u32,
        differ: all
            .iter()
            .copied()
            .chain(&others)
            .filter(|s| s.pass == Some(false))
            .count() as u32,
        views_differ: all
            .iter()
            .copied()
            .chain(&others)
            .map(|s| s.views.len() as u32)
            .sum(),
        fonts_ok,
        report: fidelity.as_ref().map(|f| f.html.clone()),
        pictures: [shots, thumbs, fid_dir].into_iter().flatten().collect(),
        beats,
        others,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, v: Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, v.to_string()).unwrap();
    }

    #[test]
    fn each_beat_has_the_screens_reached_in_it_and_how_they_compare() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let raw = dir.join("raw");
        write(
            &dir.join("demo.json"),
            serde_json::json!({ "name": "r", "title": "R", "raw": raw, "apps": [] }),
        );
        write(
            &dir.join("recording.json"),
            serde_json::json!({
                "states": {
                    "chat-start": { "app": "chat", "snap": "chat-start" },
                    "chat-01": { "app": "chat", "snap": "chat-01" },
                    "admin-start": { "app": "admin", "snap": "admin-start" },
                    "admin-01": { "app": "admin", "snap": "admin-01" },
                    "admin-01-menu": { "app": "admin", "snap": "admin-01-menu" },
                    "iq-start": { "app": "iq", "snap": "iq-start" }
                },
                "apps": [{ "id": "chat" }, { "id": "admin" }, { "id": "iq" }],
                "beats": [{ "label": "start", "active": "chat",
                    "states": { "chat": "chat-start", "admin": "admin-start", "iq": "iq-start" } }],
                "path": [
                    { "app": "chat", "checkpoint": "chat-start" },
                    { "click": {}, "checkpoint": "chat-01" },
                    { "app": "admin", "checkpoint": "admin-start" },
                    { "click": {}, "checkpoint": "admin-01" },
                    { "app": "chat", "checkpoint": "chat-01" }
                ]
            }),
        );
        std::fs::create_dir_all(raw.join("shots")).unwrap();
        std::fs::write(raw.join("shots").join("chat-01.png"), b"png").unwrap();
        // Two beats: the talk track's, the second starting on admin's start screen.
        std::fs::write(
            dir.join("script.md"),
            "## Ask in chat (0:00–1:00)\n> One.\n## Approve in admin (1:00–2:00)\n> Two.\n",
        )
        .unwrap();
        let mut m = scenecast_core::BundleManifest::starter("R");
        let beat = |label: &str, active: &str, scene: &str| scenecast_core::Beat {
            label: label.into(),
            active: active.into(),
            scenes: [(
                active.to_owned(),
                scenecast_core::SceneId::new(scene).unwrap(),
            )]
            .into(),
        };
        m.beats = vec![
            beat("0 Reset", "chat", "chat-start"),
            beat("1", "chat", "chat-start"),
            beat("2", "admin", "admin-start"),
        ];
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_string(&m).unwrap(),
        )
        .unwrap();
        write(
            &dir.join(".out").join("fidelity").join("report.json"),
            serde_json::json!({
                "pass": false, "fonts": [{ "status": "match" }],
                "items": [
                    { "id": "chat-start", "state": "chat-start", "kind": "state", "z": 100, "pass": true, "pct": 0.0, "sideBySide": "sbs/chat-start.png" },
                    { "id": "chat-01", "state": "chat-01", "kind": "state", "z": 100, "pass": true, "pct": 0.01 },
                    { "id": "admin-start", "state": "admin-start", "kind": "state", "z": 100, "pass": true, "pct": 0.0 },
                    { "id": "admin-01", "state": "admin-01", "kind": "state", "z": 100, "pass": true, "pct": 0.0 },
                    { "id": "admin-01@150", "state": "admin-01", "kind": "zoom", "z": 150, "pass": false, "pct": 2.8,
                      "causes": [{ "summary": "A date shows in a different font: the product loads it late." }] },
                    { "id": "admin-01-menu", "state": "admin-01-menu", "kind": "state", "z": 100, "pass": false, "pct": 1.2 },
                    { "id": "admin-01-menu@150", "state": "admin-01-menu", "kind": "zoom", "z": 150, "pass": false, "pct": 1.4,
                      "causes": [{ "cause": "virtualized", "summary": "div.list is virtualized: only the rows in view at 100% were captured" }] },
                    { "id": "iq-start", "state": "iq-start", "kind": "state", "z": 100, "pass": true, "pct": 0.0 },
                    { "id": "chat-02", "state": "chat-02", "kind": "state", "z": 100, "pass": false, "pct": 0.09, "checker": "real",
                      "size": { "real": [3024, 1612] }, "differs": { "why": "spot", "at": { "x": 100, "y": 200, "w": 64, "h": 32, "px": 900 } } }
                ],
                "residual": [{ "id": "admin-01-menu", "why": ["not diagnosed (compare only, or the round limit)"] }]
            }),
        );
        let r = read(dir, "macos");
        let ids = |b: &ReviewBeat| b.screens.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
        // An app the path never switched to before the first beat: its start screen comes first, on its own.
        assert_eq!(r.beats.len(), 3);
        assert_eq!(
            (r.beats[0].n, ids(&r.beats[0])),
            (0, vec!["iq-start".to_owned()])
        );
        assert_eq!(ids(&r.beats[1]), ["chat-start", "chat-01"]);
        assert_eq!(ids(&r.beats[2]), ["admin-start", "admin-01"]);
        assert_eq!(r.beats[2].key.as_deref(), Some("⌥2"));
        // The screen itself matches, as the report counts it; its 150% zoom differs, listed apart with its own
        // score and what was found, in a sentence.
        let admin = &r.beats[2].screens[1];
        assert_eq!(admin.pass, Some(true));
        assert_eq!(admin.pct, Some(0.0));
        assert_eq!(
            admin
                .views
                .iter()
                .map(|v| (v.label.as_str(), v.pct))
                .collect::<Vec<_>>(),
            [("at 150% zoom", Some(2.8))]
        );
        assert_eq!(
            admin.why,
            ["A date shows in a different font: the product loads it late."]
        );
        assert!(r.beats[1].screens[1].shot.is_some());
        assert!(
            r.beats[1].screens[0]
                .side_by_side
                .as_ref()
                .is_some_and(|p| p.ends_with("sbs/chat-start.png"))
        );
        // A menu off the path that differs is kept apart, so it isn't missed.
        assert_eq!(r.others.len(), 2);
        // A cause the fixer named reads plainly, with its own words under Details.
        let menu = r.others.iter().find(|s| s.id == "admin-01-menu").unwrap();
        assert_eq!(
            menu.why,
            [
                "not diagnosed (compare only, or the round limit)",
                "A long list ends early: only the rows on screen were recorded."
            ]
        );
        assert_eq!(
            menu.detail,
            ["div.list is virtualized: only the rows in view at 100% were captured"]
        );
        // Compared in the browser it was recorded in: under the 0.5% share, still differs, and where.
        let spot = r.others.iter().find(|s| s.id == "chat-02").unwrap();
        assert_eq!(
            (spot.pass, spot.spot, spot.real_checker),
            (Some(false), Some([100, 200, 64, 32, 3024, 1612]), true)
        );
        // The counts agree with the report: 5 of 5 on the path match, the menu off it differs, two zooms apart.
        assert_eq!(
            (r.screens, r.matching, r.differ, r.views_differ),
            (5, 5, 2, 2)
        );
        assert!(r.compared && r.fonts_ok);
    }

    #[test]
    fn the_filmstrip_gets_a_small_copy_of_each_shot() {
        let tmp = tempfile::tempdir().unwrap();
        let (shot, thumb) = (tmp.path().join("s.png"), tmp.path().join("t").join("s.png"));
        let mut enc = png::Encoder::new(std::fs::File::create(&shot).unwrap(), 3024, 40);
        enc.set_color(png::ColorType::Rgba);
        enc.write_header()
            .unwrap()
            .write_image_data(&vec![200; 3024 * 40 * 4])
            .unwrap();
        assert_eq!(thumb_of(&shot, &thumb), Some(thumb.clone()));
        let width = png::Decoder::new(std::io::BufReader::new(
            std::fs::File::open(&thumb).unwrap(),
        ))
        .read_info()
        .unwrap()
        .info()
        .width;
        assert!(width <= 2 * THUMB_WIDTH, "{width}");
        // Not a picture: no copy (the filmstrip shows the shot).
        std::fs::write(&shot, b"png").unwrap();
        std::fs::remove_file(&thumb).unwrap();
        assert_eq!(thumb_of(&shot, &thumb), None);
    }

    #[test]
    fn before_it_is_compared_every_screen_is_listed_and_none_judged() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write(
            &dir.join("demo.json"),
            serde_json::json!({ "name": "r", "title": "R", "raw": dir.join("raw"), "apps": [] }),
        );
        write(
            &dir.join("recording.json"),
            serde_json::json!({ "states": { "a-start": { "app": "a" } }, "path": [{ "app": "a", "checkpoint": "a-start" }] }),
        );
        let r = read(dir, "windows");
        assert_eq!(r.beats.len(), 1);
        assert_eq!(r.beats[0].screens[0].pass, None);
        assert!(!r.compared && r.differ == 0 && r.screens == 1);
    }
}
