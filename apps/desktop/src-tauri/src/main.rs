// The Scenecast desktop app: a Tauri window over the scenecast-app library (the same Rust core as the CLI). Each
// command runs on a worker thread and reports its progress as `job` events; one job per demo at a time.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use scenecast_app::export::ExportKind;
use scenecast_app::files::FileScope;
use scenecast_app::library::{Demo, Library, NewDemo};
use scenecast_app::servers::{EditSession, PresentSession};
use scenecast_app::{AppError, Update};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Res<T> = Result<T, AppError>;

struct AppState {
    library: Library,
    files: FileScope,
    busy: Mutex<HashMap<String, String>>,
    recording: Mutex<HashSet<String>>,
    edits: Mutex<HashMap<String, EditSession>>,
    presents: Mutex<HashMap<String, PresentSession>>,
    /// The preflight running on each demo, and how to stop it (a newer one replaces it).
    preflights: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// The recorder extension's folder, and what happened when this app updated it.
    extension: Mutex<Value>,
    /// Demos the AI coach is coaching now (it runs beside the recording, not as the demo's one job).
    coaches: Mutex<HashSet<String>>,
    /// `.scenecast` files opened before the window was listening (a double-click that started the app).
    opens: Mutex<Vec<PathBuf>>,
}

type Shared = Arc<AppState>;

#[derive(Clone, Serialize)]
struct JobEvent<'a> {
    demo: &'a str,
    job: &'a str,
    update: &'a Update,
}

#[derive(Clone, Serialize)]
struct JobState<'a> {
    demo: &'a str,
    job: &'a str,
    running: bool,
}

/// While a job runs on a demo: no other job starts on it, and the window knows.
struct Busy {
    state: Shared,
    app: AppHandle,
    demo: String,
    job: String,
}

impl Busy {
    fn take(state: &Shared, app: &AppHandle, demo: &str, job: &str) -> Res<Self> {
        let mut busy = state.busy.lock().expect("busy lock");
        if let Some(running) = busy.get(demo) {
            return Err(AppError::Invalid(format!(
                "this demo is busy ({running}): wait for it to finish"
            )));
        }
        busy.insert(demo.to_owned(), job.to_owned());
        let _ = app.emit(
            "job-state",
            JobState {
                demo,
                job,
                running: true,
            },
        );
        Ok(Self {
            state: state.clone(),
            app: app.clone(),
            demo: demo.to_owned(),
            job: job.to_owned(),
        })
    }

    fn emit(&self, update: Update) {
        let _ = self.app.emit(
            "job",
            JobEvent {
                demo: &self.demo,
                job: &self.job,
                update: &update,
            },
        );
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.state
            .busy
            .lock()
            .expect("busy lock")
            .remove(&self.demo);
        let _ = self.app.emit(
            "job-state",
            JobState {
                demo: &self.demo,
                job: &self.job,
                running: false,
            },
        );
    }
}

fn emit(app: &AppHandle, demo: &str, job: &str, update: Update) {
    let _ = app.emit(
        "job",
        JobEvent {
            demo,
            job,
            update: &update,
        },
    );
}

/// Runs blocking work off the window's thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Invalid(format!("the app's worker stopped: {e}")))?
}

/// A job on a demo: its folder, the busy guard, and progress as `job` events.
async fn job<T: Send + 'static>(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    name: &'static str,
    f: impl FnOnce(&Path, &Busy) -> Res<T> + Send + 'static,
) -> Res<T> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = state.library.dir(&id)?;
        let busy = Busy::take(&state, &app, &id, name)?;
        let out = f(&dir, &busy);
        if let Err(e) = &out {
            scenecast_app::ai::app_log(&format!("{name} ({id})"), &e.to_string());
        }
        out
    })
    .await
}

// ---- The library -------------------------------------------------------------------------------------------------

#[tauri::command]
fn app_info(state: State<'_, Shared>, app: AppHandle) -> Value {
    let engine = scenecast_app::engine();
    json!({
        "version": app.package_info().version.to_string(),
        "os": scenecast_app::keys::this_os(),
        "library": state.library.root,
        "engine": engine.as_ref().map(|e| e.packages.display().to_string()).ok(),
        "engineError": engine.err().map(|e| e.to_string()),
        "noOpen": std::env::var_os("REPLICA_NO_OPEN").is_some(),
    })
}

#[tauri::command]
async fn list_demos(state: State<'_, Shared>) -> Res<Vec<Demo>> {
    let state = state.inner().clone();
    blocking(move || state.library.list()).await
}

#[tauri::command]
async fn get_demo(state: State<'_, Shared>, id: String) -> Res<Demo> {
    let state = state.inner().clone();
    blocking(move || state.library.get(&id)).await
}

#[tauri::command]
async fn create_demo(state: State<'_, Shared>, spec: NewDemo) -> Res<Demo> {
    let state = state.inner().clone();
    blocking(move || state.library.create(&spec)).await
}

#[tauri::command]
async fn duplicate_demo(state: State<'_, Shared>, id: String, title: Option<String>) -> Res<Demo> {
    let state = state.inner().clone();
    blocking(move || state.library.duplicate(&id, title.as_deref())).await
}

/// Moves the demo and its recording to the Trash (Recycle Bin on Windows); removes them if there's no trash.
#[tauri::command]
async fn delete_demo(state: State<'_, Shared>, id: String) -> Res<String> {
    let state = state.inner().clone();
    blocking(move || {
        if state.busy.lock().expect("busy lock").contains_key(&id) {
            return Err(AppError::Invalid(
                "this demo is busy: wait for it to finish".into(),
            ));
        }
        stop_servers(&state, &id);
        let dir = state.library.dir(&id)?;
        // Its recording too (real screens of real tenants), unless another demo records into the same folder.
        let raw = state.library.own_recording(&id);
        let how = match to_trash(&dir) {
            Ok(()) if cfg!(windows) => "moved to the Recycle Bin",
            Ok(()) => "moved to the Trash",
            Err(_) => state.library.remove(&id).map(|_| "deleted")?,
        };
        if let Some(raw) = raw
            && to_trash(&raw).is_err()
        {
            let _ = std::fs::remove_dir_all(&raw);
        }
        Ok(how.into())
    })
    .await
}

/// The Trash on the Mac through the file manager API (not Finder, which asks for automation permission).
fn to_trash(path: &Path) -> Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path)
    }
}

#[tauri::command]
async fn set_browser(state: State<'_, Shared>, id: String, browser: String) -> Res<()> {
    let state = state.inner().clone();
    blocking(move || scenecast_app::record::set_browser(&state.library.dir(&id)?, &browser)).await
}

// ---- Record ------------------------------------------------------------------------------------------------------

#[tauri::command]
async fn prepare_extension(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
) -> Res<scenecast_app::record::ExtensionSetup> {
    job(state, app, id, "extension", |dir, _| {
        scenecast_app::record::prepare_extension(dir)
    })
    .await
}

/// One preflight per demo: a newer one (Check pressed again, Check and fix, a Fix button) stops the one running and
/// takes its place, so the demo is never left "busy (preflight)".
fn run_preflight(
    state: &Shared,
    app: &AppHandle,
    id: &str,
    fix: bool,
) -> Res<scenecast_app::record::PreflightReport> {
    let dir = state.library.dir(id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = state
        .preflights
        .lock()
        .expect("preflights lock")
        .insert(id.to_owned(), cancel.clone())
    {
        old.store(true, Ordering::SeqCst);
    }
    let t = Instant::now();
    while state
        .busy
        .lock()
        .expect("busy lock")
        .get(id)
        .map(String::as_str)
        == Some("preflight")
        && t.elapsed() < Duration::from_secs(20)
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    let done = |state: &Shared| {
        let mut m = state.preflights.lock().expect("preflights lock");
        if m.get(id).is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
            m.remove(id);
        }
    };
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Invalid("replaced by a newer check".into()));
    }
    let busy = match Busy::take(state, app, id, "preflight") {
        Ok(b) => b,
        Err(e) => {
            done(state);
            return Err(e);
        }
    };
    let out =
        scenecast_app::record::preflight_with(&dir, fix, Some(cancel.clone()), |u| busy.emit(u));
    done(state);
    drop(busy);
    out
}

#[tauri::command]
async fn preflight(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    fix: bool,
) -> Res<scenecast_app::record::PreflightReport> {
    let state = state.inner().clone();
    blocking(move || run_preflight(&state, &app, &id, fix)).await
}

/// The receiver for this demo, started if it isn't running (opening a demo, its Fix button); the demo is
/// remembered so the next start of the app has its receiver up at once.
fn ensure_receiver(state: &Shared, id: &str) -> Res<Value> {
    let dir = state.library.dir(id)?;
    let _ = std::fs::write(state.library.root.join(".last-demo"), id);
    let _ = scenecast_app::record::migrate_profile(&dir);
    let started = scenecast_app::receiver::host().ensure(&dir);
    let mut out = receiver_json(state);
    if let Err(e) = started {
        out["error"] = Value::from(e.to_string());
    }
    Ok(out)
}

fn receiver_json(state: &Shared) -> Value {
    let r = scenecast_app::receiver::host().state();
    json!({ "receiver": r, "extension": state.extension.lock().expect("extension lock").clone() })
}

#[tauri::command]
async fn receiver_ensure(state: State<'_, Shared>, id: String) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || ensure_receiver(&state, &id)).await
}

#[tauri::command]
async fn receiver_status(state: State<'_, Shared>) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || Ok(receiver_json(&state))).await
}

/// Install recorder: the visible folder (current), the extensions page in the running browser and the demo's
/// profile, and the folder shown selected in Finder or File Explorer.
fn install_recorder_now(
    state: &Shared,
    app: &AppHandle,
    id: &str,
) -> Res<scenecast_app::record::InstallReport> {
    let dir = state.library.dir(id)?;
    let _ = ensure_receiver(state, id);
    let r = scenecast_app::record::install(&dir)?;
    if std::env::var_os("REPLICA_NO_OPEN").is_none() {
        let _ = app.opener().reveal_item_in_dir(&r.dir);
    }
    *state.extension.lock().expect("extension lock") =
        json!({ "dir": r.dir, "version": r.version });
    Ok(r)
}

#[tauri::command]
async fn install_recorder(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
) -> Res<scenecast_app::record::InstallReport> {
    let state = state.inner().clone();
    blocking(move || install_recorder_now(&state, &app, &id)).await
}

#[tauri::command]
async fn browser_profiles(
    state: State<'_, Shared>,
    id: Option<String>,
    browser: Option<String>,
) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = match id.as_deref() {
            Some(id) => Some(state.library.dir(id)?),
            None => None,
        };
        scenecast_app::record::profiles(dir.as_deref(), browser.as_deref())
    })
    .await
}

#[tauri::command]
async fn set_profile(state: State<'_, Shared>, id: String, profile: String) -> Res<()> {
    let state = state.inner().clone();
    blocking(move || scenecast_app::record::set_profile(&state.library.dir(&id)?, &profile)).await
}

/// The slot on stage, in seconds (none: no slot).
#[tauri::command]
async fn set_slot(state: State<'_, Shared>, id: String, slot: Option<u32>) -> Res<()> {
    let state = state.inner().clone();
    blocking(move || scenecast_app::library::set_slot(&state.library.dir(&id)?, slot)).await
}

/// At start: the extension folder current (a loaded recorder whose files changed reloads itself once it connects),
/// and the receiver up for the demo open last.
fn start_recorder_side(state: Shared) {
    std::thread::spawn(move || {
        if let Ok(last) = std::fs::read_to_string(state.library.root.join(".last-demo"))
            && state.library.dir(last.trim()).is_ok()
        {
            let _ = ensure_receiver(&state, last.trim());
        }
        // The old hidden copy (0.3.0 and earlier): a stub until no browser has it loaded, then gone.
        scenecast_app::record::retire_old_extension();
        let (dir, updated) = match scenecast_app::record::ensure_extension() {
            Ok(x) => x,
            Err(e) => {
                *state.extension.lock().expect("extension lock") =
                    json!({ "error": e.to_string() });
                return;
            }
        };
        let version = scenecast_app::record::recorder_version();
        *state.extension.lock().expect("extension lock") =
            json!({ "dir": dir, "version": version, "updated": updated, "reloaded": false });
        if !updated {
            return;
        }
        // Updated: the loaded recorder still runs the old files until it reloads; it does that itself when asked.
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(600) {
            let r = scenecast_app::receiver::host().state();
            if r.connected
                && let Some(port) = r.port
                && scenecast_app::receiver::send_command(port, &json!({ "op": "reload" })).is_some()
            {
                state.extension.lock().expect("extension lock")["reloaded"] = Value::from(true);
                return;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

/// The packaged-app test's way in (no WebDriver in an installer): with `SCENECAST_SELFTEST=<folder>`, each
/// `<name>.request.json` there ({"action": "receiver"|"preflight"|"install"|"profiles"|"state"|"ai"|"record-start"|
/// "record-status"|"record-stop", "demo": id, "fix": bool, "args": [the `scenecast ai` arguments]}) runs through the
/// same code as the window's buttons, and its answer lands in `<name>.response.json`.
fn selftest_hook(state: Shared, app: AppHandle) {
    let Some(dir) = std::env::var_os("SCENECAST_SELFTEST").map(PathBuf::from) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                let path = e.path();
                let Some(name) = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.strip_suffix(".request.json"))
                    .map(str::to_owned)
                else {
                    continue;
                };
                let Ok(req) = std::fs::read(&path)
                    .map_err(|_| ())
                    .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|_| ()))
                else {
                    continue;
                };
                let _ = std::fs::remove_file(&path);
                let (state, app, dir) = (state.clone(), app.clone(), dir.clone());
                std::thread::spawn(move || {
                    let id = req["demo"].as_str().unwrap_or_default().to_owned();
                    let out: Res<Value> = match req["action"].as_str().unwrap_or_default() {
                        "receiver" => ensure_receiver(&state, &id),
                        "state" => Ok(receiver_json(&state)),
                        "preflight" => run_preflight(&state, &app, &id, req["fix"] == true)
                            .and_then(|r| Ok(serde_json::to_value(r)?)),
                        "install" => install_recorder_now(&state, &app, &id)
                            .and_then(|r| Ok(serde_json::to_value(r)?)),
                        "profiles" => state
                            .library
                            .dir(&id)
                            .and_then(|d| scenecast_app::record::profiles(Some(&d), None)),
                        "busy" => Ok(json!(state.busy.lock().expect("busy lock").clone())),
                        "ai" => {
                            let args: Vec<String> = req["args"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|x| x.as_str().map(str::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default();
                            let args: Vec<&str> = args.iter().map(String::as_str).collect();
                            scenecast_app::ai::run(None, &args, |_| {})
                        }
                        "record-start" => state.library.dir(&id).and_then(|d| {
                            let _ = scenecast_app::receiver::host().ensure(&d);
                            scenecast_app::record::start(&d, false)
                        }),
                        "record-status" => state.library.dir(&id).and_then(|d| {
                            Ok(serde_json::to_value(scenecast_app::record::status(&d)?)?)
                        }),
                        "record-stop" => state.library.dir(&id).and_then(|d| {
                            Ok(serde_json::to_value(scenecast_app::record::stop(&d)?)?)
                        }),
                        "version" => Ok(json!({
                            "version": app.package_info().version.to_string(),
                            "pid": std::process::id(),
                        })),
                        "create" => {
                            serde_json::from_value::<scenecast_app::NewDemo>(req["spec"].clone())
                                .map_err(AppError::from)
                                .and_then(|spec| {
                                    Ok(serde_json::to_value(state.library.create(&spec)?)?)
                                })
                        }
                        // The Copilot page's Sign in, as the window does it: the device code (each event in
                        // <name>.events.ndjson as it comes), the sign-in page opened as "Copy the code and open
                        // GitHub" opens it, then the wait for the code to be entered.
                        "sign-in" => {
                            let events = dir.join(format!("{name}.events.ndjson"));
                            let app2 = app.clone();
                            scenecast_app::ai::run(None, &["sign-in"], move |u| {
                                if let Update::Event { event, data, .. } = &u {
                                    if event == "device-code"
                                        && let Some(url) =
                                            data.get("verificationUri").and_then(Value::as_str)
                                        && let Err(e) = open_external(&app2, url)
                                    {
                                        scenecast_app::ai::app_log("sign-in open", &e.to_string());
                                    }
                                    use std::io::Write;
                                    if let Ok(mut f) = std::fs::OpenOptions::new()
                                        .create(true)
                                        .append(true)
                                        .open(&events)
                                    {
                                        let _ = writeln!(
                                            f,
                                            "{}",
                                            json!({ "event": event, "data": data })
                                        );
                                    }
                                }
                            })
                        }
                        "open-url" => open_external(&app, req["url"].as_str().unwrap_or_default())
                            .map(|_| Value::Null),
                        "update-check" => serde_json::to_value(tauri::async_runtime::block_on(
                            update_check_now(&app),
                        ))
                        .map_err(AppError::from),
                        "update-install" => {
                            let done = dir.join(format!("{name}.response.json"));
                            tauri::async_runtime::block_on(update_install_now(&app, move || {
                                let _ = std::fs::write(
                                    &done,
                                    json!({ "ok": true, "value": "restarting" }).to_string(),
                                );
                            }))
                            .map(|_| Value::Null)
                        }
                        other => Err(AppError::Invalid(format!("unknown action {other}"))),
                    };
                    let answer = match out {
                        Ok(v) => json!({ "ok": true, "value": v }),
                        Err(e) => json!({ "ok": false, "error": e.to_string() }),
                    };
                    let tmp = dir.join(format!("{name}.response.tmp"));
                    let _ = std::fs::write(&tmp, answer.to_string());
                    let _ = std::fs::rename(&tmp, dir.join(format!("{name}.response.json")));
                });
            }
        }
    });
}

/// Starts recording, then reports the recorder's status every second until it stops.
#[tauri::command]
async fn record_start(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    resume: bool,
) -> Res<Value> {
    let shared = state.inner().clone();
    let answer = job(state, app.clone(), id.clone(), "record", move |dir, _| {
        scenecast_app::record::start(dir, resume)
    })
    .await?;
    if shared
        .recording
        .lock()
        .expect("recording lock")
        .insert(id.clone())
    {
        std::thread::spawn(move || {
            while shared
                .recording
                .lock()
                .expect("recording lock")
                .contains(&id)
            {
                if let Ok(dir) = shared.library.dir(&id)
                    && let Ok(status) = scenecast_app::record::status(&dir)
                {
                    let recording = status.recording;
                    emit(&app, &id, "record", Update::Record { status });
                    if !recording {
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(1000));
            }
            shared.recording.lock().expect("recording lock").remove(&id);
        });
    }
    Ok(answer)
}

#[tauri::command]
async fn record_status(
    state: State<'_, Shared>,
    id: String,
) -> Res<scenecast_app::record::RecordStatus> {
    let state = state.inner().clone();
    blocking(move || scenecast_app::record::status(&state.library.dir(&id)?)).await
}

#[tauri::command]
async fn record_stop(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
) -> Res<scenecast_app::record::RecordSummary> {
    state.recording.lock().expect("recording lock").remove(&id);
    job(state, app, id, "record-stop", |dir, _| {
        scenecast_app::record::stop(dir)
    })
    .await
}

// ---- Build and check ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn build(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    force: bool,
) -> Res<scenecast_app::build::BuildOutcome> {
    job(state, app, id, "build", move |dir, busy| {
        scenecast_app::build::build(dir, force, |u| busy.emit(u))
    })
    .await
}

#[tauri::command]
async fn last_scrub(
    state: State<'_, Shared>,
    id: String,
) -> Res<Option<scenecast_app::build::ScrubSummary>> {
    let state = state.inner().clone();
    blocking(move || Ok(scenecast_app::build::last_scrub(&state.library.dir(&id)?))).await
}

#[tauri::command]
async fn run_checks(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    quick: bool,
) -> Res<scenecast_app::build::ChecksOutcome> {
    job(state, app, id, "checks", move |dir, busy| {
        scenecast_app::build::checks(dir, quick, |u| busy.emit(u))
    })
    .await
}

// ---- Fidelity ----------------------------------------------------------------------------------------------------

#[tauri::command]
async fn fidelity_last(
    state: State<'_, Shared>,
    id: String,
) -> Res<Option<scenecast_app::fidelity::FidelityView>> {
    let state = state.inner().clone();
    blocking(move || Ok(scenecast_app::fidelity::last(&state.library.dir(&id)?))).await
}

#[tauri::command]
async fn fidelity_run(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    fix: bool,
) -> Res<scenecast_app::fidelity::FidelityView> {
    job(state, app, id, "fidelity", move |dir, busy| {
        scenecast_app::fidelity::run(dir, fix, |u| busy.emit(u))
    })
    .await
}

// ---- Script ------------------------------------------------------------------------------------------------------

#[tauri::command]
async fn script_get(state: State<'_, Shared>, id: String) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = state.library.dir(&id)?;
        let saved = scenecast_app::script::read(&dir);
        Ok(json!({
            "text": saved.as_ref().map(|s| s.0.clone()),
            "name": saved.as_ref().map(|s| s.1.clone()),
            "view": scenecast_app::script::last(&dir),
        }))
    })
    .await
}

#[tauri::command]
async fn script_save(
    state: State<'_, Shared>,
    id: String,
    text: String,
    kind: String,
) -> Res<String> {
    let state = state.inner().clone();
    blocking(move || {
        let path = scenecast_app::script::save(&state.library.dir(&id)?, &text, &kind)?;
        Ok(path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default())
    })
    .await
}

/// Opens a script file (text, Markdown or RunLines .sk) and keeps a copy with the demo.
#[tauri::command]
async fn script_open(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<Option<Value>> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = state.library.dir(&id)?;
        let Some(file) = app
            .dialog()
            .file()
            .set_title("Open a script")
            .add_filter("Scripts", &["md", "markdown", "txt", "sk"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
        else {
            return Ok(None);
        };
        let (text, path) = scenecast_app::script::import(&dir, &file)?;
        Ok(Some(json!({
            "text": text,
            "name": path.file_name().map(|n| n.to_string_lossy().into_owned()),
            "kind": scenecast_app::script::kind_of(&path),
        })))
    })
    .await
}

#[tauri::command]
async fn script_run(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
) -> Res<scenecast_app::script::ScriptView> {
    job(state, app, id, "script", |dir, busy| {
        scenecast_app::script::run(dir, |u| busy.emit(u))
    })
    .await
}

// ---- AI-assisted recording (GitHub Copilot) ----------------------------------------------------------------------

/// Signed in to GitHub? The model, the settings, whether Copilot's runtime is here yet.
#[tauri::command]
async fn ai_status() -> Res<Value> {
    blocking(|| scenecast_app::ai::run(None, &["status"], |_| {})).await
}

/// Sign in with GitHub (device flow): `job` events on job `ai-sign-in` carry the code to enter, then it waits.
#[tauri::command]
async fn ai_sign_in(app: AppHandle) -> Res<Value> {
    blocking(move || {
        scenecast_app::ai::run(None, &["sign-in"], |u| emit(&app, "", "ai-sign-in", u))
    })
    .await
}

#[tauri::command]
fn logs_dir() -> PathBuf {
    let d = scenecast_app::ai::logs_dir();
    let _ = std::fs::create_dir_all(&d);
    d
}

#[tauri::command]
async fn ai_sign_out() -> Res<Value> {
    blocking(|| scenecast_app::ai::run(None, &["sign-out"], |_| {})).await
}

#[tauri::command]
async fn ai_models() -> Res<Value> {
    blocking(|| scenecast_app::ai::run(None, &["models"], |_| {})).await
}

/// The presenter's AI settings (`model`, `pageText`); `set` changes some.
#[tauri::command]
async fn ai_settings(set: Option<serde_json::Map<String, Value>>) -> Res<Value> {
    blocking(move || {
        let pairs: Vec<String> = set
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| {
                format!(
                    "{k}={}",
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string())
                )
            })
            .collect();
        let mut args = vec!["settings"];
        for p in &pairs {
            args.push("--set");
            args.push(p);
        }
        scenecast_app::ai::run(None, &args, |_| {})
    })
    .await
}

#[tauri::command]
async fn ai_get(state: State<'_, Shared>, id: String) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || Ok(scenecast_app::ai::get(&state.library.dir(&id)?))).await
}

/// Keeps the demo's mode, goal, material and plan (whichever are given).
#[tauri::command]
async fn ai_save(
    state: State<'_, Shared>,
    id: String,
    mode: Option<String>,
    goal: Option<String>,
    source: Option<String>,
    plan: Option<String>,
) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = state.library.dir(&id)?;
        scenecast_app::ai::save(&dir, mode.as_deref(), goal.as_deref(), source.as_deref())?;
        if let Some(p) = plan {
            scenecast_app::ai::save_plan(&dir, &p)?;
        }
        Ok(scenecast_app::ai::get(&dir))
    })
    .await
}

#[tauri::command]
async fn ai_plan(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<Value> {
    job(state, app, id, "ai-plan", |dir, busy| {
        scenecast_app::ai::run(Some(dir), &["plan"], |u| busy.emit(u))
    })
    .await
}

/// Record for me: the approved plan, in the presenter's browser, while it records; then the talk track.
#[tauri::command]
async fn ai_record(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<Value> {
    let _ = scenecast_app::receiver::host().ensure(&state.library.dir(&id)?);
    job(state, app, id, "ai-record", |dir, busy| {
        scenecast_app::ai::run(Some(dir), &["record"], |u| busy.emit(u))
    })
    .await
}

/// The talk track from the recording (I'll click, you script it; Coach me).
#[tauri::command]
async fn ai_script(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<Value> {
    job(state, app, id, "ai-script", |dir, busy| {
        scenecast_app::ai::run(Some(dir), &["script"], |u| busy.emit(u))
    })
    .await
}

#[tauri::command]
async fn ai_answer(
    state: State<'_, Shared>,
    id: String,
    question: String,
    answer: String,
    text: Option<String>,
) -> Res<()> {
    scenecast_app::ai::answer(
        &state.library.dir(&id)?,
        &question,
        &answer,
        text.as_deref(),
    )
}

#[tauri::command]
async fn ai_stop(state: State<'_, Shared>, id: String) -> Res<()> {
    scenecast_app::ai::stop(&state.library.dir(&id)?)
}

/// Coach me: runs beside the recording (the presenter starts and stops it as usual) until the recording ends or
/// ai_stop; its suggestions are `job` events on job `coach`.
#[tauri::command]
async fn ai_coach(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<()> {
    let shared = state.inner().clone();
    let dir = shared.library.dir(&id)?;
    if !shared
        .coaches
        .lock()
        .expect("coaches lock")
        .insert(id.clone())
    {
        return Ok(());
    }
    let _ = scenecast_app::receiver::host().ensure(&dir);
    let _ = app.emit(
        "job-state",
        JobState {
            demo: &id,
            job: "coach",
            running: true,
        },
    );
    std::thread::spawn(move || {
        let r = scenecast_app::ai::run(Some(&dir), &["coach"], |u| emit(&app, &id, "coach", u));
        if let Err(e) = r {
            emit(
                &app,
                &id,
                "coach",
                Update::Line {
                    text: e.to_string(),
                    error: true,
                },
            );
        }
        shared.coaches.lock().expect("coaches lock").remove(&id);
        let _ = app.emit(
            "job-state",
            JobState {
                demo: &id,
                job: "coach",
                running: false,
            },
        );
    });
    Ok(())
}

/// A text file the presenter picks (notes, a doc saved as text or Markdown, an email, a script, a RunLines .sk):
/// `{ name, text }`, or nothing when they cancel.
#[tauri::command]
async fn pick_text_file(app: AppHandle) -> Res<Option<Value>> {
    blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("Open your material")
            .add_filter(
                "Text",
                &["md", "markdown", "txt", "sk", "eml", "json", "html"],
            )
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
        else {
            return Ok(None);
        };
        let bytes = std::fs::read(&file)?;
        if bytes.len() > 2_000_000 {
            return Err(AppError::Invalid(
                "that file is too big to work from (2 MB at most)".into(),
            ));
        }
        Ok(Some(json!({
            "name": file.file_name().map(|n| n.to_string_lossy().into_owned()),
            "text": String::from_utf8_lossy(&bytes),
        })))
    })
    .await
}

#[tauri::command]
async fn ai_coach_window(state: State<'_, Shared>, id: String) -> Res<String> {
    let state = state.inner().clone();
    blocking(move || scenecast_app::ai::open_coach(&state.library.dir(&id)?)).await
}

// ---- Edit and present --------------------------------------------------------------------------------------------

fn stop_servers(state: &AppState, id: &str) {
    if let Some(mut s) = state.edits.lock().expect("edits lock").remove(id) {
        let _ = s.stop();
    }
    if let Some(mut s) = state.presents.lock().expect("presents lock").remove(id) {
        let _ = s.stop();
    }
}

#[tauri::command]
async fn edit_start(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<String> {
    let state = state.inner().clone();
    blocking(move || {
        if let Some(s) = state.edits.lock().expect("edits lock").get(&id) {
            return Ok(s.url().to_owned());
        }
        stop_servers(&state, &id);
        let mut session = EditSession::start(&state.library.dir(&id)?)?;
        let url = session.url().to_owned();
        let updates = session.updates();
        let (app2, id2) = (app.clone(), id.clone());
        std::thread::spawn(move || {
            for u in updates {
                emit(&app2, &id2, "edit", u);
            }
        });
        state.edits.lock().expect("edits lock").insert(id, session);
        Ok(url)
    })
    .await
}

#[tauri::command]
async fn edit_stop(state: State<'_, Shared>, id: String) -> Res<()> {
    let state = state.inner().clone();
    blocking(move || {
        if let Some(mut s) = state.edits.lock().expect("edits lock").remove(&id) {
            s.stop()?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn key_reference(
    state: State<'_, Shared>,
    id: String,
) -> Res<scenecast_app::keys::KeyReference> {
    let state = state.inner().clone();
    blocking(move || {
        scenecast_app::keys::reference(&state.library.dir(&id)?, scenecast_app::keys::this_os())
    })
    .await
}

/// Where the presenter guide goes: the screen this window is on (the laptop's), in the screen points browsers use.
fn laptop_screen(app: &AppHandle) -> Option<scenecast_app::guide::Place> {
    let w = app.get_webview_window("main")?;
    let m = w.current_monitor().ok().flatten()?;
    let area = m.work_area();
    let scale = m.scale_factor();
    Some(scenecast_app::guide::Place {
        x: (area.position.x as f64 / scale).round() as i32,
        y: (area.position.y as f64 / scale).round() as i32,
        width: (area.size.width as f64 / scale).round() as u32,
        height: (area.size.height as f64 / scale).round() as u32,
    })
}

#[tauri::command]
async fn guide_status(
    state: State<'_, Shared>,
    id: String,
) -> Res<Option<scenecast_app::guide::GuideStatus>> {
    let state = state.inner().clone();
    blocking(move || Ok(scenecast_app::guide::status(&state.library.dir(&id)?))).await
}

/// Opens the presenter guide next to the stage, on this window's screen (the laptop's), in the stage's browser.
#[tauri::command]
async fn present_guide(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<String> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = state.library.dir(&id)?;
        let url = state
            .presents
            .lock()
            .expect("presents lock")
            .get_mut(&id)
            .and_then(|s| s.running().then(|| s.url.clone()))
            .ok_or_else(|| {
                AppError::Invalid("start presenting first: the guide follows the stage".into())
            })?;
        scenecast_app::guide::open(&dir, &url, laptop_screen(&app))
    })
    .await
}

/// Serves the replica for presenting and opens it full screen, with the presenter guide on this window's screen when
/// `guide` and the demo has one; this window steps out of the way.
/// The screens this computer has, in the points browsers use: each one's bounds and work area, which one this window
/// is on (the laptop's, where the guide goes) and the primary one.
#[tauri::command]
fn displays(app: AppHandle) -> Res<Value> {
    let monitors = app
        .available_monitors()
        .map_err(|e| AppError::Invalid(format!("couldn't list the screens: {e}")))?;
    let here = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten());
    let primary = app.primary_monitor().ok().flatten();
    let same = |a: &tauri::Monitor, b: &Option<tauri::Monitor>| {
        b.as_ref()
            .is_some_and(|b| a.name() == b.name() && a.position() == b.position())
    };
    let pts = |v: f64, scale: f64| (v / scale).round();
    let list: Vec<Value> = monitors
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            let (p, z, w) = (m.position(), m.size(), m.work_area());
            json!({
                "name": m.name().cloned().unwrap_or_else(|| "Screen".into()),
                "x": pts(p.x as f64, s), "y": pts(p.y as f64, s),
                "width": pts(z.width as f64, s), "height": pts(z.height as f64, s),
                "work": {
                    "x": pts(w.position.x as f64, s), "y": pts(w.position.y as f64, s),
                    "width": pts(w.size.width as f64, s), "height": pts(w.size.height as f64, s),
                },
                "scale": s,
                "here": same(m, &here),
                "primary": same(m, &primary),
            })
        })
        .collect();
    Ok(json!({ "displays": list }))
}

/// The run of show: beats, their keys on this OS, planned and rehearsed times, the slot.
#[tauri::command]
async fn rundown(state: State<'_, Shared>, id: String) -> Res<scenecast_app::rundown::Rundown> {
    let state = state.inner().clone();
    blocking(move || {
        Ok(scenecast_app::rundown::read(
            &state.library.dir(&id)?,
            scenecast_app::keys::this_os(),
        ))
    })
    .await
}

/// Present (or Rehearse: each beat's time is kept): the stage full screen on `stage` (the projector) when it's
/// given, and the guide on `guide_place` (else the screen this window is on).
#[tauri::command]
async fn present_start(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    guide: Option<bool>,
    stage: Option<scenecast_app::guide::Place>,
    guide_place: Option<scenecast_app::guide::Place>,
    rehearse: Option<bool>,
) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = state.library.dir(&id)?;
        if !state.library.get(&id)?.status.built {
            return Err(AppError::Invalid(
                "build the demo first: there's no replica to present yet".into(),
            ));
        }
        stop_servers(&state, &id);
        let rehearse = rehearse.unwrap_or(false);
        let mut session = PresentSession::start_at(&dir, true, stage, rehearse)?;
        let guide_url = if guide.unwrap_or(true) && scenecast_app::guide::status(&dir).is_some() {
            // The browser the stage just opened in gets a moment to start: the guide must open in that same browser.
            if session.opened {
                std::thread::sleep(Duration::from_millis(1500));
            }
            Some(scenecast_app::guide::open(
                &dir,
                &session.url,
                guide_place.or_else(|| laptop_screen(&app)),
            )?)
        } else {
            None
        };
        let out = json!({ "url": session.url, "opened": session.opened, "guide": guide_url, "rehearse": rehearse });
        let updates = session.updates();
        std::thread::spawn(move || for _ in updates {});
        if session.opened
            && let Some(w) = app.get_webview_window("main")
        {
            let _ = w.minimize();
        }
        state
            .presents
            .lock()
            .expect("presents lock")
            .insert(id, session);
        Ok(out)
    })
    .await
}

#[tauri::command]
async fn present_stop(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<()> {
    let state = state.inner().clone();
    blocking(move || {
        if let Some(mut s) = state.presents.lock().expect("presents lock").remove(&id) {
            s.stop()?;
            scenecast_app::rundown::finish(&state.library.dir(&id)?);
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        Ok(())
    })
    .await
}

#[tauri::command]
fn servers(state: State<'_, Shared>) -> Value {
    let edits: HashMap<String, String> = state
        .edits
        .lock()
        .expect("edits lock")
        .iter()
        .map(|(k, v)| (k.clone(), v.url().to_owned()))
        .collect();
    let presents: HashMap<String, String> = state
        .presents
        .lock()
        .expect("presents lock")
        .iter_mut()
        .filter_map(|(k, v)| v.running().then(|| (k.clone(), v.url.clone())))
        .collect();
    json!({ "edit": edits, "present": presents })
}

// ---- Export ------------------------------------------------------------------------------------------------------

#[tauri::command]
fn default_export_dir(state: State<'_, Shared>) -> PathBuf {
    scenecast_app::export::default_dest(&state.library.root)
}

#[tauri::command]
async fn export_demo(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    kind: ExportKind,
    dest: Option<String>,
    anyway: Option<bool>,
) -> Res<scenecast_app::export::CheckedExport> {
    let root = state.library.root.clone();
    job(state, app, id, "export", move |dir, busy| {
        let dest = dest
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| scenecast_app::export::default_dest(&root));
        // The whole checklist runs here, before the replica leaves (unless it passed and nothing changed since).
        scenecast_app::export::export_checked(dir, &dest, kind, anyway.unwrap_or(false), |u| {
            busy.emit(u)
        })
    })
    .await
}

// ---- A shared demo file ----------------------------------------------------------------------------------------

/// Opens a `.scenecast` file into the library, ready to rehearse.
#[tauri::command]
async fn share_import(state: State<'_, Shared>, path: String) -> Res<scenecast_app::Demo> {
    let state = state.inner().clone();
    blocking(move || scenecast_app::share::import(&state.library, Path::new(&path))).await
}

/// "Open a demo file…": a `.scenecast` someone sent.
#[tauri::command]
async fn pick_share_file(app: AppHandle) -> Res<Option<String>> {
    blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("Open a demo file")
            .add_filter("Scenecast demo", &[scenecast_app::share::EXT])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.display().to_string()))
    })
    .await
}

/// The files opened before the window was listening; each is returned once.
#[tauri::command]
fn pending_opens(state: State<'_, Shared>) -> Vec<String> {
    std::mem::take(&mut *state.opens.lock().expect("opens lock"))
        .into_iter()
        .map(|p| p.display().to_string())
        .collect()
}

/// A file to open: kept for the window and sent to it, and the window comes to the front.
fn opened(app: &AppHandle, state: &Shared, path: PathBuf) {
    state.opens.lock().expect("opens lock").push(path.clone());
    let _ = app.emit("open-file", path.display().to_string());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// One Scenecast at a time for opened files: the first listens on a local port; a later one started with files sends
/// them there and ends. Without files, a later one just runs (a test build next to the installed app).
fn instance_listener(files: &[PathBuf]) -> Option<std::net::TcpListener> {
    let port: u16 = std::env::var("SCENECAST_INSTANCE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(47598);
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => Some(l),
        Err(_) if !files.is_empty() => {
            if let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                use std::io::Write as _;
                let text: Vec<String> = files.iter().map(|p| p.display().to_string()).collect();
                if s.write_all((text.join("\n") + "\n").as_bytes()).is_ok() {
                    std::process::exit(0);
                }
            }
            None
        }
        Err(_) => None,
    }
}

fn serve_instance(listener: std::net::TcpListener, app: AppHandle, state: Shared) {
    std::thread::spawn(move || {
        use std::io::BufRead as _;
        for stream in listener.incoming().flatten() {
            let lines: Vec<String> = std::io::BufReader::new(stream)
                .lines()
                .map_while(Result::ok)
                .collect();
            for p in scenecast_app::share::files_in_args(lines) {
                opened(&app, &state, p);
            }
        }
    });
}

// ---- Files, folders, links -------------------------------------------------------------------------------------

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Res<Option<String>> {
    blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("Choose where to export")
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.display().to_string()))
    })
    .await
}

/// The app's own protocol for files from the library: `scenecast://localhost/…` (`http://scenecast.localhost/…` on
/// Windows, where WebView2 serves custom protocols that way).
const FILES_BASE: &str = if cfg!(windows) {
    "http://scenecast.localhost"
} else {
    "scenecast://localhost"
};

#[tauri::command]
fn file_url(state: State<'_, Shared>, path: String) -> Option<String> {
    state
        .files
        .url_path(Path::new(&path))
        .map(|p| format!("{FILES_BASE}{p}"))
}

fn serve_file(
    state: &AppState,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let found = state
        .files
        .resolve(request.uri().path())
        .and_then(|p| Some((std::fs::read(&p).ok()?, p)));
    match found {
        Some((body, path)) => tauri::http::Response::builder()
            .header("Content-Type", scenecast_app::files::content_type(&path))
            .header("Cache-Control", "no-cache")
            .body(body),
        None => tauri::http::Response::builder()
            .status(404)
            .body(b"not found".to_vec()),
    }
    .expect("a static response")
}

/// Opens a report from the library in the default browser (its pictures beside it, as on disk).
#[tauri::command]
fn open_file(state: State<'_, Shared>, app: AppHandle, path: String) -> Res<()> {
    let path = PathBuf::from(path);
    if state.files.url_path(&path).is_none() || !path.is_file() {
        return Err(AppError::Invalid(format!("not opening {}", path.display())));
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Invalid(format!("can't open {}: {e}", path.display())))
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Res<()> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::Invalid(format!("can't show {path}: {e}")))
}

/// Opens a web page (the replica, a report) in the browser; only http(s) on this machine or the docs.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Res<()> {
    open_external(&app, &url)
}

/// Opens an allowed address in the presenter's browser. With `SCENECAST_OPENED=<file>` (the packaged-app test) the
/// address is written there instead, after the same check, so the test sees exactly what would open.
fn open_external(app: &AppHandle, url: &str) -> Res<()> {
    if !scenecast_app::files::may_open_url(url) {
        scenecast_app::ai::app_log("open-url refused", url);
        return Err(AppError::Invalid(format!("not opening {url}")));
    }
    if let Some(f) = std::env::var_os("SCENECAST_OPENED") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(f)?;
        writeln!(file, "{url}")?;
        return Ok(());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| {
        scenecast_app::ai::app_log("open-url failed", &format!("{url}: {e}"));
        AppError::Invalid(format!("can't open {url}: {e}"))
    })
}

// ---- Updates -----------------------------------------------------------------------------------------------------

/// What the update check found.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    current: String,
    available: Option<String>,
    notes: Option<String>,
    error: Option<String>,
}

/// The updater: the release feed in tauri.conf.json, or `SCENECAST_UPDATE_URL` (the update test's local server).
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
    use tauri_plugin_updater::UpdaterExt;
    let mut b = app.updater_builder();
    if let Some(url) = std::env::var("SCENECAST_UPDATE_URL")
        .ok()
        .and_then(|u| u.parse().ok())
    {
        b = b.endpoints(vec![url])?;
    }
    b.build()
}

async fn update_check_now(app: &AppHandle) -> UpdateCheck {
    let current = app.package_info().version.to_string();
    match updater(app) {
        Ok(u) => match u.check().await {
            Ok(Some(up)) => UpdateCheck {
                current,
                available: Some(up.version.clone()),
                notes: up.body.clone(),
                error: None,
            },
            Ok(None) => UpdateCheck {
                current,
                available: None,
                notes: None,
                error: None,
            },
            Err(e) => UpdateCheck {
                current,
                available: None,
                notes: None,
                error: Some(e.to_string()),
            },
        },
        Err(e) => UpdateCheck {
            current,
            available: None,
            notes: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
async fn check_updates(app: AppHandle) -> UpdateCheck {
    update_check_now(&app).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    stage: &'static str,
}

/// Downloads the update (progress as `update-progress` events), installs it, and restarts on it. Demos and settings
/// stay where they are (the library is in Documents, apart from the app).
async fn update_install_now(
    app: &AppHandle,
    before_install: impl FnOnce() + Send + 'static,
) -> Res<()> {
    let err = |e: tauri_plugin_updater::Error| AppError::Invalid(format!("update: {e}"));
    let Some(up) = updater(app).map_err(err)?.check().await.map_err(err)? else {
        return Err(AppError::Invalid(
            "no update: this is the newest Scenecast".into(),
        ));
    };
    let mut downloaded = 0u64;
    let (a1, a2) = (app.clone(), app.clone());
    up.download_and_install(
        move |chunk, total| {
            downloaded += chunk as u64;
            let _ = a1.emit(
                "update-progress",
                UpdateProgress {
                    downloaded,
                    total,
                    stage: "download",
                },
            );
        },
        // Downloaded and checked: it installs now (on Windows the installer takes over and this process ends).
        move || {
            scenecast_app::receiver::host().stop();
            before_install();
            let _ = a2.emit(
                "update-progress",
                UpdateProgress {
                    downloaded: 0,
                    total: None,
                    stage: "install",
                },
            );
        },
    )
    .await
    .map_err(err)?;
    app.restart();
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Res<()> {
    update_install_now(&app, || {}).await
}

/// In an installed app, the engine (`packages/`, its `node_modules`) and Node come with it, as resources: point the
/// engine at them unless the environment already does. Runs before any thread starts.
fn use_bundled_engine() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(exe_dir) = exe.parent() else { return };
    let candidates = [
        exe_dir.join("../Resources"),
        exe_dir.to_path_buf(),
        exe_dir.join("../lib/scenecast"),
        exe_dir.join("../lib/Scenecast"),
    ];
    let Some(res) = candidates
        .iter()
        .find(|d| d.join("packages/kit/bin/scenecast.mjs").is_file())
    else {
        return;
    };
    let node = res
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    // SAFETY: called first thing in main, before the runtime or any other thread exists.
    unsafe {
        if std::env::var_os("SCENECAST_JS").is_none() {
            std::env::set_var("SCENECAST_JS", res.join("packages"));
        }
        if std::env::var_os("SCENECAST_NODE").is_none() && node.is_file() {
            std::env::set_var("SCENECAST_NODE", &node);
        }
    }
}

/// The checks' headless browser: the one presenters have (Edge on Windows, Chrome on the Mac) unless set.
fn default_check_browser() {
    if std::env::var_os("REPLICA_CHROME_CHANNEL").is_none() {
        // SAFETY: as above.
        unsafe {
            std::env::set_var(
                "REPLICA_CHROME_CHANNEL",
                if cfg!(windows) { "msedge" } else { "chrome" },
            );
        }
    }
}

fn main() {
    use_bundled_engine();
    default_check_browser();
    let library = Library::new(Library::default_root());
    let _ = std::fs::create_dir_all(&library.root);
    let files = FileScope::default();
    files.allow(&library.root);
    let state: Shared = Arc::new(AppState {
        library,
        files,
        busy: Mutex::default(),
        recording: Mutex::default(),
        edits: Mutex::default(),
        presents: Mutex::default(),
        preflights: Mutex::default(),
        extension: Mutex::new(Value::Null),
        coaches: Mutex::default(),
        opens: Mutex::new(scenecast_app::share::files_in_args(
            std::env::args().skip(1),
        )),
    });
    // A second Scenecast started by opening a file (Windows, Linux) hands it to the one that's running, and ends.
    let instance = instance_listener(&state.opens.lock().expect("opens lock"));
    start_recorder_side(state.clone());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    #[cfg(feature = "auditaur")]
    let builder = {
        use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
        let _ = tracing_subscriber::registry()
            .with(tauri_plugin_auditaur::tracing_layer())
            .try_init();
        builder
            .plugin(
                tauri_plugin_auditaur::Builder::new()
                    .service_name("scenecast-desktop")
                    .session_name("dev")
                    .redact_defaults(true)
                    .build(),
            )
            // The frontend collector in front of invoke and listen (apps/desktop/auditaur, built by the smoke script).
            .plugin(
                tauri::plugin::Builder::<tauri::Wry>::new("scenecast-auditaur")
                    .js_init_script(
                        include_str!(concat!(
                            env!("CARGO_MANIFEST_DIR"),
                            "/../auditaur/dist/bridge.js"
                        ))
                        .to_owned(),
                    )
                    .build(),
            )
    };
    let app = builder
        .manage(state.clone())
        .register_uri_scheme_protocol("scenecast", {
            let state = state.clone();
            move |_ctx, request| serve_file(&state, &request)
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_demos,
            get_demo,
            create_demo,
            duplicate_demo,
            delete_demo,
            set_browser,
            prepare_extension,
            preflight,
            receiver_ensure,
            receiver_status,
            install_recorder,
            browser_profiles,
            set_profile,
            set_slot,
            displays,
            rundown,
            share_import,
            pick_share_file,
            pending_opens,
            record_start,
            record_status,
            record_stop,
            build,
            last_scrub,
            run_checks,
            fidelity_last,
            fidelity_run,
            script_get,
            script_save,
            script_open,
            script_run,
            ai_status,
            ai_sign_in,
            ai_sign_out,
            ai_models,
            ai_settings,
            ai_get,
            ai_save,
            ai_plan,
            ai_record,
            ai_script,
            ai_answer,
            ai_stop,
            ai_coach,
            ai_coach_window,
            pick_text_file,
            logs_dir,
            edit_start,
            edit_stop,
            key_reference,
            present_start,
            present_stop,
            present_guide,
            guide_status,
            servers,
            default_export_dir,
            export_demo,
            pick_folder,
            file_url,
            open_file,
            reveal,
            open_url,
            check_updates,
            install_update,
        ])
        .setup({
            let state = state.clone();
            move |app| {
                #[cfg(feature = "auditaur")]
                app.add_capability(
                    r#"{"identifier":"auditaur","windows":["main"],"permissions":["auditaur:default"]}"#,
                )?;
                selftest_hook(state.clone(), app.handle().clone());
                if let Some(l) = instance {
                    serve_instance(l, app.handle().clone(), state);
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Scenecast app");
    app.run(move |app, event| {
        // Windows and Linux get opened files as arguments (instance_listener), not as an event.
        #[cfg(not(target_os = "macos"))]
        let _ = app;
        // macOS: a double-clicked .scenecast, at launch or while running.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls {
                if let Ok(p) = url.to_file_path()
                    && p.extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case(scenecast_app::share::EXT))
                {
                    opened(app, &state, p);
                }
            }
        }
        if let tauri::RunEvent::Exit = event {
            scenecast_app::receiver::host().stop();
            let ids: Vec<String> = state
                .edits
                .lock()
                .expect("edits lock")
                .keys()
                .chain(state.presents.lock().expect("presents lock").keys())
                .cloned()
                .collect();
            for id in ids {
                stop_servers(&state, &id);
            }
        }
    });
}
