//! The run of show: a demo's beats in order, each with its key on stage, the app it's in, its planned time from the
//! talk track, and how long it took in the last rehearsal; with the slot and the totals. From the presenter guide's
//! notes when they're made (`presenter/notes.json`), otherwise from the talk track itself, otherwise from the
//! recording's beats. Rehearsal times come from the stage (`.out/rehearsal.json`, written while rehearsing).

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One beat of the show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    pub n: u32,
    pub title: String,
    /// Planned start and end in seconds from the talk track (`0:00–1:15`), when it says.
    pub start: Option<u32>,
    pub end: Option<u32>,
    /// The app the beat is in (the recording's), when it's recorded.
    pub app: Option<String>,
    /// Its key on stage, spelled for this OS (`⌥1`, `Ctrl+Alt+1`); none past 9.
    pub key: Option<String>,
    /// Seconds it took in the last rehearsal.
    pub took: Option<u32>,
}

/// The last rehearsal: when, and how long from the first beat to the end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rehearsal {
    pub at: u64,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rundown {
    /// Where the beats came from: `guide`, `script`, `recording` or `none`.
    pub source: String,
    pub slot: Option<u32>,
    /// The talk track's planned length: the last beat's end.
    pub planned: Option<u32>,
    pub beats: Vec<Beat>,
    pub rehearsal: Option<Rehearsal>,
}

pub fn rehearsal_file(dir: &Path) -> std::path::PathBuf {
    dir.join(".out").join("rehearsal.json")
}

/// A rehearsal the stage didn't close (the app stopped it): it ends now.
pub fn finish(dir: &Path) {
    let file = rehearsal_file(dir);
    let Some(mut r) = read_json(&file) else {
        return;
    };
    if r["live"] != true {
        return;
    }
    if r["end"].is_null() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default();
        r["end"] = Value::from(now);
    }
    r["live"] = Value::from(false);
    if let Ok(text) = serde_json::to_string_pretty(&r) {
        let _ = std::fs::write(&file, text + "\n");
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The demo's run of show, with keys spelled for `os` (`macos` or `windows`).
pub fn read(dir: &Path, os: &str) -> Rundown {
    let cfg = read_json(&dir.join("demo.json")).unwrap_or(Value::Null);
    let slot = cfg["presenter"]["slot"]
        .as_u64()
        .filter(|s| *s > 0)
        .map(|s| s as u32);
    let manifest = scenecast_core::read_manifest(dir).ok();
    let (source, mut beats) = if let Some(b) = from_notes(dir) {
        ("guide", b)
    } else if let Some(b) = crate::script::saved_script(dir)
        .and_then(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            Some(parse_script(&text, &p.to_string_lossy()))
        })
        .filter(|b| !b.is_empty())
    {
        ("script", b)
    } else if let Some(m) = manifest.as_ref().filter(|m| m.beats.len() > 1) {
        let b = m.beats[1..]
            .iter()
            .enumerate()
            .map(|(i, b)| Beat {
                n: i as u32 + 1,
                title: b.label.clone(),
                start: None,
                end: None,
                app: None,
                key: None,
                took: None,
            })
            .collect();
        ("recording", b)
    } else {
        ("none", Vec::new())
    };
    let modifier = if os == "macos" { "⌥" } else { "Ctrl+Alt+" };
    for b in &mut beats {
        if b.n <= 9 {
            b.key = Some(format!("{modifier}{}", b.n));
        }
        if let Some(m) = &manifest
            && let Some(mb) = m.beats.get(b.n as usize)
            && !mb.active.is_empty()
        {
            b.app = Some(mb.active.clone());
        }
    }
    let rehearsal = read_json(&rehearsal_file(dir)).and_then(|r| took(&r, &mut beats));
    Rundown {
        source: source.into(),
        slot,
        planned: beats.iter().filter_map(|b| b.end).max(),
        beats,
        rehearsal,
    }
}

/// The guide's beats: Start (0) and End (the last) left out.
fn from_notes(dir: &Path) -> Option<Vec<Beat>> {
    let notes = read_json(&dir.join("presenter").join("notes.json"))?;
    let all = notes["beats"].as_array()?;
    if all.len() < 3 {
        return None;
    }
    let secs = |v: &Value| v.as_u64().map(|s| s as u32);
    Some(
        all[1..all.len() - 1]
            .iter()
            .enumerate()
            .map(|(i, b)| Beat {
                n: b["n"].as_u64().map(|n| n as u32).unwrap_or(i as u32 + 1),
                title: b["title"].as_str().unwrap_or_default().to_owned(),
                start: secs(&b["start"]),
                end: secs(&b["end"]),
                app: None,
                key: None,
                took: None,
            })
            .collect(),
    )
}

/// How long each beat took in the rehearsal (`{ at, events: [{ beat, t }], end }`, times in ms): each stretch on a
/// beat counts towards it; the rehearsal runs from the first beat to the end (or the last event).
fn took(r: &Value, beats: &mut [Beat]) -> Option<Rehearsal> {
    let mut ev: Vec<(u32, u64)> = r["events"]
        .as_array()?
        .iter()
        .filter_map(|e| Some((e["beat"].as_u64()? as u32, e["t"].as_u64()?)))
        .collect();
    ev.sort_by_key(|e| e.1);
    let last = beats.iter().map(|b| b.n).max()?;
    let first = ev.iter().position(|(b, _)| *b >= 1 && *b <= last)?;
    let stop = r["end"].as_u64().unwrap_or(ev.last()?.1);
    let mut per = std::collections::BTreeMap::<u32, u64>::new();
    let mut total = 0u64;
    for (i, (beat, t)) in ev.iter().enumerate().skip(first) {
        let until = ev.get(i + 1).map_or(stop, |e| e.1).max(*t);
        if *beat >= 1 && *beat <= last {
            *per.entry(*beat).or_default() += until - t;
            total += until - t;
        }
    }
    for b in beats.iter_mut() {
        b.took = per.get(&b.n).map(|ms| (*ms as f64 / 1000.0).round() as u32);
    }
    Some(Rehearsal {
        at: r["at"].as_u64().unwrap_or(ev[first].1),
        total: (total as f64 / 1000.0).round() as u32,
    })
}

static RANGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d+:\d\d)\s*[–—-]\s*(\d+:\d\d)").expect("range"));
static MSS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[(·|]\s*(\d+:\d\d)\s*\)?\s*$").expect("m:ss"));
static DUR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)[(·|]\s*~?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes)\s*\)?\s*$",
    )
    .expect("duration")
});
static NUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:beat|scene|step)\s+)?(\d+)\s*[.:·)\-–—]?\s+(.*)$").expect("number")
});
static SPECIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(backstage|before( the talk)?|setup|set ?up|prep|if something goes wrong|watch[- ]?outs?|troubleshooting|if it goes wrong|after( the talk)?|afterwards|wrap[- ]?up)\b").expect("special")
});
static PLAIN_BEAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(beat|scene|step)\s+\d+\b").expect("plain beat"));

fn mss(t: &str) -> u32 {
    let (m, s) = t.split_once(':').unwrap_or(("0", t));
    m.parse::<u32>().unwrap_or(0) * 60 + s.parse::<u32>().unwrap_or(0)
}

/// A heading's number, title, start, end and length.
type Head = (Option<u32>, String, Option<u32>, Option<u32>, Option<u32>);

/// A beat heading: its number, title and time ("3. Sentry has it · 1:45–2:45", "Beat 3: Sentry has it (1:45)").
fn head(h: &str) -> Head {
    let mut s = h.split_whitespace().collect::<Vec<_>>().join(" ");
    let (mut start, mut end, mut dur) = (None, None, None);
    if let Some(c) = RANGE.captures(&s) {
        start = Some(mss(&c[1]));
        end = Some(mss(&c[2]));
        s = s.replacen(&c[0], "", 1);
    } else if let Some(c) = MSS.captures(&s) {
        dur = Some(mss(&c[1]));
        s.truncate(c.get(0).expect("match").start());
    } else if let Some(c) = DUR.captures(&s) {
        let n: f64 = c[1].parse().unwrap_or(0.0);
        dur = Some(
            (n * if c[2].to_lowercase().starts_with('m') {
                60.0
            } else {
                1.0
            })
            .round() as u32,
        );
        s.truncate(c.get(0).expect("match").start());
    }
    let mut n = None;
    if let Some(c) = NUM.captures(s.trim()) {
        n = c[1].parse().ok();
        s = c[2].to_owned();
    }
    let trim: &[char] = &[' ', '·', '|', '(', ')', ':', '–', '—', '-'];
    let title = s.trim_matches(trim).to_owned();
    (n, title, start, end, dur)
}

/// The talk track's beats: `##` headings in Markdown, "Beat N" lines in plain text, rows in a RunLines `.sk`. Times
/// as written; durations add up from 0:00.
pub fn parse_script(text: &str, name: &str) -> Vec<Beat> {
    let mut out: Vec<Head> = Vec::new();
    let lower = name.to_lowercase();
    let sk = lower.ends_with(".sk") || text.trim_start().starts_with('{');
    if sk {
        let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        for (i, row) in v["rows"].as_array().into_iter().flatten().enumerate() {
            let t = row["time"].as_str().unwrap_or_default();
            let (_, _, _, _, dur) = head(&format!("x ({t})"));
            let title = row["title"]
                .as_str()
                .or_else(|| row["narrative"].as_str().and_then(|n| n.lines().next()))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Beat {}", i + 1));
            out.push((None, title, None, None, dur));
        }
    } else if lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || text
            .lines()
            .any(|l| l.starts_with("# ") || l.starts_with("## "))
    {
        for l in text.lines() {
            if let Some(h) = l.strip_prefix("## ") {
                let h = h.trim();
                if !SPECIAL.is_match(h) {
                    out.push(head(h));
                }
            }
        }
    } else {
        for l in text.lines().map(str::trim) {
            if PLAIN_BEAT.is_match(l) {
                out.push(head(l));
            }
        }
    }
    let numbered = out
        .iter()
        .enumerate()
        .all(|(i, b)| b.0 == Some(i as u32 + 1));
    let mut t = 0;
    out.into_iter()
        .enumerate()
        .map(|(i, (n, title, mut start, mut end, dur))| {
            if start.is_none()
                && let Some(d) = dur
            {
                start = Some(t);
                end = Some(t + d);
            }
            if let Some(e) = end {
                t = e;
            }
            Beat {
                n: if numbered {
                    n.unwrap_or(i as u32 + 1)
                } else {
                    i as u32 + 1
                },
                title: if title.is_empty() {
                    format!("Beat {}", i + 1)
                } else {
                    title
                },
                start,
                end,
                app: None,
                key: None,
                took: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_beats_and_times_from_a_talk_track() {
        let md = "# Innovation\n\n## Backstage\n- open Teams\n\n## The late shipment lands in Teams (0:00–1:15)\n> Kestrel…\n\n## 2. Ask Copilot · 1:15–3:30\n\n## Who can approve (2:15)\n\n## IT turns it on · 90 s\n\n## After the talk\n";
        let b = parse_script(md, "script.md");
        let got: Vec<_> = b
            .iter()
            .map(|b| (b.n, b.title.as_str(), b.start, b.end))
            .collect();
        assert_eq!(
            got,
            [
                (1, "The late shipment lands in Teams", Some(0), Some(75)),
                (2, "Ask Copilot", Some(75), Some(210)),
                (3, "Who can approve", Some(210), Some(345)),
                (4, "IT turns it on", Some(345), Some(435)),
            ]
        );
        let fixture = "## Beat 1 · The question\n> Hi.\n## Beat 2 · Plugins\n";
        let b = parse_script(fixture, "script.md");
        assert_eq!(
            (b[0].n, b[0].title.as_str(), b[0].start),
            (1, "The question", None)
        );
        let txt = parse_script(
            "Beat 1: Hello (0:30)\nsay this\nBeat 2: Bye (0:45)\n",
            "script.txt",
        );
        assert_eq!(
            txt.iter()
                .map(|b| (b.title.as_str(), b.end))
                .collect::<Vec<_>>(),
            [("Hello", Some(30)), ("Bye", Some(75))]
        );
    }

    #[test]
    fn counts_each_beats_rehearsal_time_from_the_first_beat() {
        let mut beats = parse_script("## A (0:00–1:00)\n## B (1:00–2:00)\n", "s.md");
        let r = json!({ "at": 5, "events": [
            { "beat": 0, "t": 1000 }, { "beat": 1, "t": 3000 }, { "beat": 2, "t": 63000 },
            { "beat": 1, "t": 70000 }, { "beat": 2, "t": 75000 }, { "beat": 3, "t": 140000 }
        ], "end": 150000 });
        let got = took(&r, &mut beats).unwrap();
        assert_eq!(got, Rehearsal { at: 5, total: 137 });
        assert_eq!(
            beats.iter().map(|b| b.took).collect::<Vec<_>>(),
            [Some(65), Some(72)]
        );
    }

    #[test]
    fn a_demo_without_a_talk_track_has_no_beats_yet() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("demo.json"),
            r#"{"presenter":{"slot":480}}"#,
        )
        .unwrap();
        let r = read(tmp.path(), "windows");
        assert_eq!(
            (r.source.as_str(), r.slot, r.beats.len()),
            ("none", Some(480), 0)
        );
        std::fs::write(
            tmp.path().join("script.md"),
            "## One (1:00)\n## Two (2:00)\n",
        )
        .unwrap();
        let r = read(tmp.path(), "windows");
        assert_eq!(r.source, "script");
        assert_eq!(r.planned, Some(180));
        assert_eq!(r.beats[1].key.as_deref(), Some("Ctrl+Alt+2"));
        assert_eq!(
            read(tmp.path(), "macos").beats[0].key.as_deref(),
            Some("⌥1")
        );
    }
}
