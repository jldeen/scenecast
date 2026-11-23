//! The engine commands: the CLI side of `stuntdouble-build`. Each one runs the JavaScript engine (recorder, player,
//! checks) on a project folder, with the bundle manifest kept in step by Rust.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Args;
use stuntdouble_build::build::BuildProgress;
use stuntdouble_build::engine::with_demo;
use stuntdouble_build::{
    Engine, NewProject, Progress, SyncReport, create_project, fallback_scenes,
};

/// Arguments passed through to the engine as they are (`--demo <dir>` picks the project; else the folder you're in).
#[derive(Debug, Clone, Args)]
pub struct Passthrough {
    #[arg(
        trailing_var_arg = true,
        allow_hyphen_values = true,
        value_name = "ARGS"
    )]
    pub args: Vec<OsString>,
}

#[derive(Debug, Clone, Args)]
pub struct NewArgs {
    /// The project folder to create (a demo folder that is also a .scenecast bundle).
    pub path: PathBuf,
    /// Title. Defaults to the folder name.
    #[arg(long)]
    pub title: Option<String>,
    /// Create the folder inside this one.
    #[arg(long)]
    pub dir: Option<PathBuf>,
    /// An app the demo shows, as id=url (repeat for more). Its presenter key is a letter of its id.
    #[arg(long = "app", value_name = "ID=URL")]
    pub apps: Vec<stuntdouble_build::AppSpec>,
    /// The replica's localhost port. Defaults to one derived from the name.
    #[arg(long)]
    pub port: Option<u16>,
}

pub fn new_project(args: NewArgs) -> Result<()> {
    let dir = match &args.dir {
        Some(parent) => parent.join(&args.path),
        None => args.path.clone(),
    };
    let created = create_project(&NewProject {
        dir,
        title: args.title,
        apps: args.apps,
        port: args.port,
    })?;
    println!("Created {}", created.dir.display());
    println!(
        "  scenes: live-page (recorded by {} record); apps: {}",
        crate::program(),
        created
            .apps
            .iter()
            .map(|a| format!(
                "{} (⌥{} / Ctrl+Alt+{}) {}",
                a.id,
                a.key.as_deref().unwrap_or("?"),
                a.key.as_deref().unwrap_or("?"),
                a.url.as_deref().unwrap_or("")
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!("  replica port: {}", created.port);
    println!(
        "next: edit demo.json (apps, browser profile, busy markers), then {} record start (docs/cli.md)",
        crate::program()
    );
    Ok(())
}

fn engine() -> Result<Engine> {
    Ok(Engine::locate()?)
}

/// The project a command works on: `--demo <dir>` in its args, or the nearest folder with a demo.json.
fn project_dir(args: &[OsString]) -> Result<PathBuf> {
    let given = args
        .iter()
        .position(|a| a == "--demo")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    let cwd = std::env::current_dir()?;
    stuntdouble_build::find_project_dir(given.as_deref(), &cwd).with_context(|| match &given {
        Some(dir) => format!("no demo.json in {}", dir.display()),
        None => format!(
            "no demo.json in {} or above it (pass --demo <dir>, or run {} new first)",
            cwd.display(),
            crate::program()
        ),
    })
}

/// The same, as the last thing this process does (servers, the receiver, the recorder): the engine takes over.
pub fn handover(sub: &str, args: &Passthrough, takes_project: bool) -> Result<i32> {
    run_engine(sub, args, takes_project)
}

pub fn present(args: &Passthrough) -> Result<i32> {
    let mut args = args.clone();
    // Presenting: no editor in the page at all.
    args.args.extend(["--open".into(), "--no-editor".into()]);
    handover("serve", &args, true)
}

fn run_engine(sub: &str, args: &Passthrough, takes_project: bool) -> Result<i32> {
    let engine = engine()?;
    let argv = if takes_project {
        with_demo(sub, &args.args, &project_dir(&args.args)?)
    } else {
        std::iter::once(OsString::from(sub))
            .chain(args.args.iter().cloned())
            .collect()
    };
    Ok(engine.exec_attached(argv)?)
}

/// `scenecast build`: the engine's build (flow, captures → data/, secret scan), then the manifest from it.
pub fn build(args: &Passthrough) -> Result<i32> {
    let dir = project_dir(&args.args)?;
    let result = stuntdouble_build::build::build(&dir, &args.args, |progress| match progress {
        BuildProgress::Engine(Progress::Stdout(line)) => println!("{line}"),
        BuildProgress::Engine(Progress::Stderr(line)) => eprintln!("{line}"),
        _ => {}
    })?;
    if let Some(source) = result.credentials_in {
        if source == "raw" {
            eprintln!("build stopped: credentials found in raw captures (see .out/scrub.json)");
        } else {
            eprintln!("build stopped: credentials or scripts found (see .out/scrub.json)");
        }
    }
    if let Some(report) = &result.sync {
        print_sync(report);
    }
    Ok(result.exit_code)
}

/// `scenecast sync`: the manifest from what was built.
pub fn sync(dir: &Path) -> Result<i32> {
    let report = stuntdouble_build::build::sync_with_baseline(dir)?;
    print_sync(&report);
    Ok(if report.is_valid() { 0 } else { 1 })
}

pub fn sync_cmd(args: &Passthrough) -> Result<i32> {
    sync(&project_dir(&args.args)?)
}

fn print_sync(r: &SyncReport) {
    println!(
        "manifest.json: {} live-page scene(s), {} stream(s), {} beat(s), {} focus point(s){}",
        r.live_scenes,
        r.streams,
        r.beats,
        r.focus_points,
        if r.written { "" } else { " (unchanged)" }
    );
    print_fallbacks(&r.fallback);
    for w in &r.warnings {
        eprintln!("warning: {w}");
    }
    for e in &r.errors {
        eprintln!("error: {e}");
    }
}

fn print_fallbacks(fallback: &[(String, String)]) {
    for (id, kind) in fallback {
        println!(
            "FALLBACK scene `{id}` is a {kind} scene, not a live page: it can't morph, zoom or replay like the real page"
        );
    }
    if !fallback.is_empty() {
        println!(
            "{} fallback scene(s): use them only for a screen that can't be captured live",
            fallback.len()
        );
    }
}

/// `scenecast check` / `quick`: the engine's fidelity checklist, with every fallback scene flagged first.
pub fn check(args: &Passthrough, quick: bool) -> Result<i32> {
    let dir = project_dir(&args.args)?;
    print_fallbacks(&fallback_scenes(&dir)?);
    handover(if quick { "quick" } else { "checklist" }, args, true)
}

#[derive(Debug, Clone, Args)]
pub struct FidelityArgs {
    /// The project folder (default: the one you're in, or above it).
    #[arg(long)]
    pub demo: Option<PathBuf>,
    /// Fix rounds at most (each: diagnose, patch, build, compare again).
    #[arg(long, default_value_t = 3)]
    pub rounds: u32,
    /// Share of pixels (percent) a state may differ from the real page by.
    #[arg(long, default_value_t = 0.5)]
    pub threshold: f64,
    /// Compare and report only: no diagnosis, no patches.
    #[arg(long)]
    pub no_fix: bool,
    /// The replica's URL (default: the demo's own server, started if it isn't running).
    #[arg(long)]
    pub url: Option<String>,
    /// Print the outcome as JSON at the end (and nothing else).
    #[arg(long, conflicts_with = "ndjson")]
    pub json: bool,
    /// Print each event as one line of JSON as it comes (what the desktop app shows).
    #[arg(long)]
    pub ndjson: bool,
}

/// `scenecast fidelity`: the loop (stuntdouble_build::fidelity), with its progress printed.
pub fn fidelity(args: &FidelityArgs) -> Result<i32> {
    use stuntdouble_build::fidelity::{FidelityOptions, FidelityProgress, run};
    let mut given = Vec::new();
    if let Some(d) = &args.demo {
        given.extend([OsString::from("--demo"), d.clone().into_os_string()]);
    }
    let dir = project_dir(&given)?;
    let human = !args.json && !args.ndjson;
    if human {
        print_fallbacks(&fallback_scenes(&dir)?);
    }
    let opts = FidelityOptions {
        rounds: args.rounds,
        threshold: args.threshold,
        fix: !args.no_fix,
        url: args.url.clone(),
        checker: None,
    };
    let str_of = |v: &serde_json::Value| {
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| v.to_string())
    };
    let outcome = run(&dir, &opts, |p| match p {
        FidelityProgress::Round(n) if args.ndjson => {
            println!("{}", serde_json::json!({"event": "round", "round": n}))
        }
        FidelityProgress::Building(n) if args.ndjson => {
            println!("{}", serde_json::json!({"event": "building", "round": n}))
        }
        FidelityProgress::Event(e) if args.ndjson => {
            println!("{}", serde_json::to_string(&e).unwrap_or_default())
        }
        FidelityProgress::Round(n) if human => println!("round {n}: real vs replica"),
        FidelityProgress::Building(n) if human => println!("  building round {n}'s fixes"),
        FidelityProgress::Event(e) if human => {
            // As a Value: a key an event doesn't have (an error row has no fonts) reads as null, not a panic.
            let d = &serde_json::Value::Object(e.data.clone());
            match e.event.as_str() {
                "compared" => println!(
                    "  {} {:<44} {}{}",
                    if d["pass"].as_bool() == Some(true) {
                        "ok  "
                    } else {
                        "OVER"
                    },
                    str_of(&d["id"]),
                    if d["pct"].is_null() {
                        "—".to_owned()
                    } else {
                        format!("{}%", d["pct"])
                    },
                    d["fonts"]
                        .as_array()
                        .filter(|f| !f.is_empty())
                        .map(|f| format!(
                            "  fonts: {}",
                            f.iter().map(str_of).collect::<Vec<_>>().join(", ")
                        ))
                        .unwrap_or_default()
                ),
                "diagnosed" => println!(
                    "  {}: {}{}\n      {}",
                    str_of(&d["finding"]),
                    str_of(&d["cause"]),
                    if d["patch"].is_null() {
                        String::new()
                    } else {
                        format!(" → {} ({})", str_of(&d["patch"]), str_of(&d["patchStatus"]))
                    },
                    str_of(&d["summary"])
                ),
                "fix-done" => println!("  {} fix(es) added to flow.fixes.json", d["added"]),
                _ => {}
            }
        }
        FidelityProgress::Build(BuildProgress::Engine(Progress::Stderr(line)))
        | FidelityProgress::Engine(Progress::Stderr(line))
            if !args.json =>
        {
            eprintln!("{line}")
        }
        _ => {}
    })?;
    let r = &outcome.report;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "pass": outcome.passed(), "stop": outcome.stop, "rounds": outcome.rounds,
                "fallbackBefore": outcome.fallback_before, "fallbackAfter": outcome.fallback_after,
                "report": r, "html": outcome.report_html, "json": outcome.report_json,
            }))?
        );
    } else if args.ndjson {
        println!(
            "{}",
            serde_json::json!({"event": "done", "pass": outcome.passed(), "stop": outcome.stop, "html": outcome.report_html})
        );
    } else {
        let within = r.items.iter().filter(|i| i.pass && i.pct.is_some()).count();
        let compared = r.items.iter().filter(|i| i.pct.is_some()).count();
        let worst = r
            .items
            .iter()
            .filter_map(|i| i.pct.map(|p| (p, &i.id)))
            .fold(None, |m: Option<(f64, &String)>, x| {
                if m.is_none_or(|m| x.0 > m.0) {
                    Some(x)
                } else {
                    m
                }
            });
        println!(
            "\n{} {within} of {compared} states within {}%{}; fonts {}; {} fix(es) in flow.fixes.json; {}",
            if outcome.passed() { "PASS" } else { "FAIL" },
            r.threshold,
            worst
                .map(|(p, id)| format!(" (worst {id} {p}%)"))
                .unwrap_or_default(),
            if r.fonts
                .iter()
                .all(|f| f.status == "match" || f.status == "unverified")
            {
                "match"
            } else {
                "differ"
            },
            r.fixes.len(),
            match outcome.stop {
                stuntdouble_build::fidelity::Stop::Within => "done".to_owned(),
                stuntdouble_build::fidelity::Stop::CompareOnly =>
                    "compared only (--no-fix)".to_owned(),
                stuntdouble_build::fidelity::Stop::NothingToPatch =>
                    "the rest has no patch (see the report)".to_owned(),
                stuntdouble_build::fidelity::Stop::RoundLimit =>
                    format!("stopped at the round limit ({})", args.rounds),
            }
        );
        if outcome.fallback_after > outcome.fallback_before {
            println!(
                "FAIL fallback scenes went from {} to {}: the loop never adds one",
                outcome.fallback_before, outcome.fallback_after
            );
        }
        println!("report: {}", outcome.report_html.display());
    }
    Ok(if outcome.passed() { 0 } else { 1 })
}

#[derive(Debug, Clone, Args)]
pub struct ScriptArgs {
    /// The presenter's script: plain text, Markdown (> quotes are the lines, ## headings the beats) or RunLines (.sk).
    pub file: PathBuf,
    /// The project folder (default: the one you're in, or above it).
    #[arg(long)]
    pub demo: Option<PathBuf>,
    /// A replica already served for authoring (default: one is started for the run).
    #[arg(long)]
    pub url: Option<String>,
    /// `text` (deterministic, the default) or a matcher module of the demo's own.
    #[arg(long)]
    pub matcher: Option<String>,
    /// The sheets only: leave focus.json as it is.
    #[arg(long)]
    pub no_write: bool,
    /// No PDF of the sheet.
    #[arg(long)]
    pub no_pdf: bool,
    /// Exit 1 when any line is not backed.
    #[arg(long)]
    pub strict: bool,
    /// Print the outcome as JSON at the end (and nothing else).
    #[arg(long, conflicts_with = "ndjson")]
    pub json: bool,
    /// Print each event as one line of JSON as it comes (what the desktop app shows).
    #[arg(long)]
    pub ndjson: bool,
}

/// `scenecast script <file>`: script to focus (stuntdouble_build::script), with its progress printed.
pub fn script(args: &ScriptArgs) -> Result<i32> {
    use stuntdouble_build::script::{LineStatus, ScriptOptions, ScriptProgress, run};
    let mut given = Vec::new();
    if let Some(d) = &args.demo {
        given.extend([OsString::from("--demo"), d.clone().into_os_string()]);
    }
    let dir = project_dir(&given)?;
    let human = !args.json && !args.ndjson;
    let opts = ScriptOptions {
        file: args.file.clone(),
        url: args.url.clone(),
        matcher: args.matcher.clone(),
        write: !args.no_write,
        pdf: !args.no_pdf,
    };
    let s = |v: &serde_json::Value| {
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| v.to_string())
    };
    let outcome = run(&dir, &opts, |p| match p {
        ScriptProgress::Event(e) if args.ndjson => {
            println!("{}", serde_json::to_string(&e).unwrap_or_default())
        }
        ScriptProgress::Event(e) if human => {
            let d = &e.data;
            match e.event.as_str() {
                "parsed" => println!("{} lines, {} beats", d["lines"], d["beats"]),
                "indexed" => println!(
                    "  screen {}/{} {} ({} items)",
                    d["n"],
                    d["of"],
                    s(&d["state"]),
                    d["items"]
                ),
                "matched" => println!(
                    "  {} {:<6} {:<28} {} focus point(s){}",
                    match s(&d["status"]).as_str() {
                        "backed" => "ok  ",
                        "partial" => "PART",
                        _ => "GAP ",
                    },
                    s(&d["line"]),
                    s(&d["state"]),
                    d["points"],
                    d["missing"]
                        .as_array()
                        .filter(|m| !m.is_empty())
                        .map(|m| format!(
                            " (not on screen: {})",
                            m.iter().map(s).collect::<Vec<_>>().join(", ")
                        ))
                        .unwrap_or_default()
                ),
                _ => {}
            }
        }
        ScriptProgress::Engine(Progress::Stderr(line)) if !args.json => eprintln!("{line}"),
        _ => {}
    })?;
    let r = &outcome.report;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "summary": r.summary, "lines": r.lines, "sheet": outcome.sheet_html, "pdf": outcome.sheet_pdf,
                "cues": outcome.cues, "focus": outcome.focus_json, "json": outcome.report_json,
            }))?
        );
    } else if human {
        for l in r.lines.iter().filter(|l| l.status != LineStatus::Backed) {
            println!(
                "{} {} {}",
                if l.status == LineStatus::Unbacked {
                    "NOT BACKED"
                } else {
                    "PARTLY    "
                },
                l.id,
                l.text.chars().take(90).collect::<String>()
            );
        }
        println!(
            "{} lines: {} backed, {} partly, {} not backed; {} focus points{}",
            r.summary.lines,
            r.summary.backed,
            r.summary.partial,
            r.summary.unbacked,
            r.summary.points,
            if outcome.focus_json.is_some() {
                " in focus.json"
            } else {
                " (focus.json not written)"
            }
        );
        println!("sheet: {}", outcome.sheet_html.display());
        if let Some(pdf) = &outcome.sheet_pdf {
            println!("pdf:   {}", pdf.display());
        }
        println!("cues:  {}", outcome.cues.display());
    }
    Ok(if args.strict && r.summary.unbacked > 0 {
        1
    } else {
        0
    })
}

#[derive(Debug, Clone, Args)]
pub struct EditArgs {
    /// The project folder (default: the one you're in, or above it).
    #[arg(long)]
    pub demo: Option<PathBuf>,
    /// The port (default: the demo's own).
    #[arg(long)]
    pub port: Option<u16>,
    /// Only print the URL; don't open a window.
    #[arg(long)]
    pub no_open: bool,
    /// Print each event as one line of JSON (what the desktop app shows).
    #[arg(long)]
    pub ndjson: bool,
}

/// `scenecast edit`: the editor's server (stuntdouble_build::edit), each saved change printed, until stopped.
pub fn edit(args: &EditArgs) -> Result<i32> {
    use stuntdouble_build::edit::{EditOptions, EditProgress, start};
    let mut given = Vec::new();
    if let Some(d) = &args.demo {
        given.extend([OsString::from("--demo"), d.clone().into_os_string()]);
    }
    let dir = project_dir(&given)?;
    let mut server = start(
        &dir,
        &EditOptions {
            port: args.port,
            open: !args.no_open,
        },
    )?;
    if args.ndjson {
        println!(
            "{}",
            serde_json::json!({"event": "ready", "url": server.url})
        );
    } else {
        println!(
            "@edit {}",
            serde_json::json!({"event": "ready", "url": server.url})
        );
        println!(
            "editor: {}  (⌥⇧E / Ctrl+Alt+Shift+E toggles it; Ctrl+C stops)",
            server.url
        );
    }
    for p in server.events() {
        match p {
            EditProgress::Saved(e) if args.ndjson => {
                println!("{}", serde_json::to_string(&e).unwrap_or_default())
            }
            EditProgress::Saved(e) => {
                println!("@edit {}", serde_json::to_string(&e).unwrap_or_default());
            }
            EditProgress::Engine(Progress::Stdout(line)) if !args.ndjson => println!("{line}"),
            EditProgress::Engine(Progress::Stderr(line)) => eprintln!("{line}"),
            _ => {}
        }
    }
    Ok(server.wait()?)
}

/// `scenecast release`: build, manifest, then the engine's full checklist, secret scan and commit (and push).
pub fn release(args: &Passthrough) -> Result<i32> {
    let dir = project_dir(&args.args)?;
    let mut build_args: Vec<OsString> = args
        .args
        .iter()
        .filter(|a| *a == "--force")
        .cloned()
        .collect();
    build_args.extend(["--demo".into(), dir.into_os_string()]);
    if build(&Passthrough { args: build_args })? != 0 {
        bail!("release stopped: the build or the manifest failed");
    }
    let mut rest = args.args.clone();
    rest.push("--skip-build".into());
    handover("release", &Passthrough { args: rest }, true)
}

#[derive(Debug, Clone, Args)]
pub struct InstallSkillArgs {
    /// Where to put the skill (default: ~/.copilot/skills/scenecast-replicate-demo).
    #[arg(long)]
    pub dest: Option<PathBuf>,
}

/// The "replicate a demo" skill and its references, carried in the binary so it installs from anywhere.
const SKILL_FILES: [(&str, &str); 7] = [
    ("SKILL.md", include_str!("../../../skill/SKILL.md")),
    (
        "references/guide.md",
        include_str!("../../../docs/guide.md"),
    ),
    ("references/cli.md", include_str!("../../../docs/cli.md")),
    (
        "references/presenter.md",
        include_str!("../../../docs/presenter.md"),
    ),
    (
        "references/checklist.md",
        include_str!("../../../docs/engine/checklist.md"),
    ),
    (
        "references/flow-format.md",
        include_str!("../../../docs/engine/flow-format.md"),
    ),
    (
        "references/lessons.md",
        include_str!("../../../docs/engine/lessons.md"),
    ),
];

/// `scenecast install-skill`: the skill for Copilot (and any agent that reads ~/.copilot/skills).
pub fn install_skill(args: &InstallSkillArgs) -> Result<()> {
    let dest = match &args.dest {
        Some(d) => d.clone(),
        None => {
            let home = if cfg!(windows) {
                std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            } else {
                std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
            }
            .context("HOME and USERPROFILE are unset: pass --dest <dir>")?;
            PathBuf::from(home)
                .join(".copilot")
                .join("skills")
                .join("scenecast-replicate-demo")
        }
    };
    write_skill(&dest)?;
    println!("installed the scenecast skill to {}", dest.display());
    println!("ask Copilot to \"replicate a demo with scenecast\" (it runs the scenecast CLI)");
    Ok(())
}

fn write_skill(dest: &Path) -> Result<()> {
    for (name, text) in SKILL_FILES {
        let path = dest.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_skill_and_its_references() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(tmp.path()).unwrap();
        let skill = std::fs::read_to_string(tmp.path().join("SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: scenecast-replicate-demo"));
        assert!(tmp.path().join("references/presenter.md").is_file());
        for (name, _) in SKILL_FILES.iter().skip(1) {
            let link = format!("({name})");
            assert!(skill.contains(&link), "SKILL.md links {name}");
        }
    }
}
