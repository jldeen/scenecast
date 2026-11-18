// The Scenecast desktop app: a Tauri window over the scenecast-app library (the same Rust core as the CLI). Each
// command runs on a worker thread and reports its progress as `job` events; one job per demo at a time.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use scenecast_app::export::ExportKind;
use scenecast_app::files::FileServer;
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
    files: FileServer,
    busy: Mutex<HashMap<String, String>>,
    recording: Mutex<HashSet<String>>,
    edits: Mutex<HashMap<String, EditSession>>,
    presents: Mutex<HashMap<String, PresentSession>>,
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
        f(&dir, &busy)
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

/// Moves the demo to the Trash (Recycle Bin on Windows); removes it if there's no trash to move it to.
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
        match to_trash(&dir) {
            Ok(()) => Ok("moved to the Trash".into()),
            Err(_) => state.library.remove(&id).map(|_| "deleted".into()),
        }
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

#[tauri::command]
async fn preflight(
    state: State<'_, Shared>,
    app: AppHandle,
    id: String,
    fix: bool,
) -> Res<scenecast_app::record::PreflightReport> {
    job(state, app, id, "preflight", move |dir, busy| {
        scenecast_app::record::preflight(dir, fix, |u| busy.emit(u))
    })
    .await
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

/// Serves the replica for presenting and opens it full screen; this window steps out of the way.
#[tauri::command]
async fn present_start(state: State<'_, Shared>, app: AppHandle, id: String) -> Res<Value> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = state.library.dir(&id)?;
        if !state.library.get(&id)?.status.built {
            return Err(AppError::Invalid(
                "build the demo first: there's no replica to present yet".into(),
            ));
        }
        stop_servers(&state, &id);
        let mut session = PresentSession::start(&dir, true)?;
        let out = json!({ "url": session.url, "opened": session.opened });
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
) -> Res<scenecast_app::export::ExportOutcome> {
    let root = state.library.root.clone();
    job(state, app, id, "export", move |dir, busy| {
        busy.emit(Update::stage("export", "Exporting the replica"));
        let dest = dest
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| scenecast_app::export::default_dest(&root));
        scenecast_app::export::export(dir, &dest, kind)
    })
    .await
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

#[tauri::command]
fn file_url(state: State<'_, Shared>, path: String) -> Option<String> {
    state.files.url(Path::new(&path))
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
    let allowed = url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
        || url.starts_with("https://github.com/jldeen/scenecast");
    if !allowed {
        return Err(AppError::Invalid(format!("not opening {url}")));
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| AppError::Invalid(format!("can't open {url}: {e}")))
}

#[tauri::command]
fn check_updates(app: AppHandle) -> scenecast_app::updates::UpdateCheck {
    scenecast_app::updates::check(&app.package_info().version.to_string())
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
    let files = FileServer::start().expect("the app's file server");
    files.allow(&library.root);
    let state: Shared = Arc::new(AppState {
        library,
        files,
        busy: Mutex::default(),
        recording: Mutex::default(),
        edits: Mutex::default(),
        presents: Mutex::default(),
    });

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let app = builder
        .manage(state.clone())
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
            edit_start,
            edit_stop,
            key_reference,
            present_start,
            present_stop,
            servers,
            default_export_dir,
            export_demo,
            pick_folder,
            file_url,
            reveal,
            open_url,
            check_updates,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Scenecast app");
    app.run(move |_, event| {
        if let tauri::RunEvent::Exit = event {
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
