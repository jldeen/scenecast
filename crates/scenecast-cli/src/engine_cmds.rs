//! The engine commands: the CLI side of `scenecast-build`. Each one runs the JavaScript engine (recorder, player,
//! checks) on a project folder, with the bundle manifest kept in step by Rust.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Args;
use scenecast_build::build::BuildProgress;
use scenecast_build::engine::with_demo;
use scenecast_build::{Engine, NewProject, Progress, SyncReport, create_project, fallback_scenes};

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
    pub apps: Vec<scenecast_build::AppSpec>,
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
        "  scenes: live-page (recorded by scenecast record); apps: {}",
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
        "next: edit demo.json (apps, browser profile, busy markers), then scenecast record start (docs/cli.md)"
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
    scenecast_build::find_project_dir(given.as_deref(), &cwd).with_context(|| match &given {
        Some(dir) => format!("no demo.json in {}", dir.display()),
        None => format!(
            "no demo.json in {} or above it (pass --demo <dir>, or run scenecast new first)",
            cwd.display()
        ),
    })
}

/// The same, as the last thing this process does (servers, the receiver, the recorder): the engine takes over.
pub fn handover(sub: &str, args: &Passthrough, takes_project: bool) -> Result<i32> {
    run_engine(sub, args, takes_project)
}

pub fn present(args: &Passthrough) -> Result<i32> {
    let mut args = args.clone();
    args.args.push("--open".into());
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
    let result = scenecast_build::build::build(&dir, &args.args, |progress| match progress {
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
    let report = scenecast_build::build::sync_with_baseline(dir)?;
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
    handover(if quick { "quick" } else { "fidelity" }, args, true)
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
