//! One file for another presenter: `<demo>.scenecast`, a zip of the demo as it presents (the built pages, the
//! presenter guide, the talk track, the focus points, the edits) with `scenecast.json` saying what it is. Scenecast
//! opens it into the library, ready to rehearse. The recording stays behind (it isn't in the demo folder), and so do
//! the reports with real screenshots (`.out`, except the fidelity and checklist results) and what was sent to
//! Copilot (`ai.json`).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::AppError;
use crate::library::{Demo, Library};

pub const EXT: &str = "scenecast";
const FORMAT: &str = "scenecast-demo";
/// What Review and the library read the checks from: real vs replica (`fidelity/report.json`), and the checklist, whole
/// (`fidelity.json`) or quick (`quick.json`, the one there is when it was shared without the whole one).
const KEPT_FROM_OUT: [&str; 3] = [
    ".out/fidelity/report.json",
    ".out/fidelity.json",
    ".out/quick.json",
];

/// What goes in: the demo folder, less the presenter's own things.
fn shared(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or_default();
    if KEPT_FROM_OUT.contains(&rel) {
        return true;
    }
    !(first.starts_with('.')
        || first == "ai.json"
        || first == "node_modules"
        || rel.ends_with(".log")
        || rel.ends_with(".DS_Store"))
}

fn files(root: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .expect("walked from the root")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if entry.file_type()?.is_dir() {
                if shared(&rel)
                    || KEPT_FROM_OUT
                        .iter()
                        .any(|k| k.starts_with(&format!("{rel}/")))
                {
                    stack.push(path);
                }
            } else if shared(&rel) {
                out.push((rel, path));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Writes `<file>` (a new `.scenecast`): `scenecast.json` and the demo under `demo/`. Returns the files and bytes.
pub fn write(dir: &Path, file: &Path, made_by: &str) -> Result<(usize, u64), AppError> {
    let demo = crate::library::load(dir)?;
    let list = files(dir)?;
    // Written next to it under another name, then renamed: the file never shows half-written under its own name
    // (a 40 MB demo takes a few seconds, and someone could send it meanwhile).
    let part = file.with_extension(format!("{EXT}.part"));
    let out = fs::File::create(&part)?;
    let mut zip = zip::ZipWriter::new(out);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let about = json!({
        "format": FORMAT, "version": 1, "id": demo.id, "title": demo.title, "slot": demo.slot,
        "madeBy": made_by, "files": list.len(),
    });
    zip.start_file("scenecast.json", options)?;
    zip.write_all(serde_json::to_string_pretty(&about)?.as_bytes())?;
    for (rel, path) in &list {
        zip.start_file(format!("demo/{rel}"), options)?;
        zip.write_all(&fs::read(path)?)?;
    }
    zip.finish()?;
    fs::rename(&part, file)?;
    Ok((list.len(), fs::metadata(file)?.len()))
}

/// Opens a `.scenecast` into the library under its own name (a second copy gets "-2"), its own port and recording
/// folder, in this computer's default browser and profile.
pub fn import(library: &Library, file: &Path) -> Result<Demo, AppError> {
    let bad = |why: &str| AppError::Invalid(format!("this isn't a Scenecast demo file ({why})"));
    let mut zip = zip::ZipArchive::new(fs::File::open(file)?).map_err(|_| bad("not a zip"))?;
    let about: Value = {
        let mut f = zip
            .by_name("scenecast.json")
            .map_err(|_| bad("no scenecast.json"))?;
        let mut text = String::new();
        f.read_to_string(&mut text)?;
        serde_json::from_str(&text).map_err(|_| bad("scenecast.json can't be read"))?
    };
    if about["format"] != FORMAT {
        return Err(bad("another format"));
    }
    if about["version"].as_u64().unwrap_or(0) > 1 {
        return Err(AppError::Invalid(
            "this demo file is from a newer Scenecast: update Scenecast, then open it again".into(),
        ));
    }
    let title = about["title"].as_str().unwrap_or("Shared demo").to_owned();
    fs::create_dir_all(&library.root)?;
    let id = library.free_id(&crate::library::slug(&title));
    let to = library.root.join(&id);
    let staging = library.root.join(format!(".import-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let result = (|| -> Result<(), AppError> {
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|_| bad("a damaged entry"))?;
            let Some(name) = entry.enclosed_name() else {
                return Err(bad("a file outside the demo"));
            };
            let Ok(rel) = name.strip_prefix("demo") else {
                continue;
            };
            if rel.as_os_str().is_empty() {
                continue;
            }
            let dest = staging.join(rel);
            if entry.is_dir() {
                fs::create_dir_all(&dest)?;
                continue;
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = fs::File::create(&dest)?;
            std::io::copy(&mut entry, &mut out)?;
        }
        let cfg_file = staging.join("demo.json");
        let mut cfg: Value =
            serde_json::from_slice(&fs::read(&cfg_file).map_err(|_| bad("no demo.json"))?)?;
        cfg["name"] = Value::from(id.clone());
        cfg["port"] = Value::from(scenecast_build::project::default_port(&id));
        cfg["raw"] = Value::from(format!("~/.scenecast/{id}/raw"));
        if let Some(chrome) = cfg["chrome"].as_object_mut() {
            chrome.remove("profile");
            chrome.remove("browser");
        }
        cfg["shared"] = json!({ "from": about["madeBy"], "file": file.file_name().map(|n| n.to_string_lossy().into_owned()) });
        fs::write(&cfg_file, serde_json::to_string_pretty(&cfg)? + "\n")?;
        if scenecast_core::read_manifest(&staging).is_err() {
            return Err(bad("no replica in it"));
        }
        fs::rename(&staging, &to)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    library.get(&id)
}

/// The `.scenecast` files among a launch's arguments (Windows and Linux pass the file that was opened).
pub fn files_in_args(args: impl IntoIterator<Item = String>) -> Vec<PathBuf> {
    args.into_iter()
        .map(PathBuf::from)
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(EXT)) && p.is_file())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{NewApp, NewDemo};

    #[test]
    fn a_shared_demo_opens_ready_to_rehearse_without_the_presenters_own_things() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = Library::new(tmp.path().join("mine"));
        let d = mine
            .create(&NewDemo {
                title: "Supplier delay".into(),
                apps: vec![NewApp {
                    id: "chat".into(),
                    url: "https://chat.example.com/".into(),
                }],
                profile: Some("Profile 10".into()),
                slot: Some(480),
                ..Default::default()
            })
            .unwrap();
        fs::create_dir_all(d.dir.join(".out/fidelity/side")).unwrap();
        fs::write(
            d.dir.join(".out/fidelity/report.json"),
            r#"{"pass":true,"items":[]}"#,
        )
        .unwrap();
        fs::write(
            d.dir.join(".out/fidelity/side/real.png"),
            b"real screenshot",
        )
        .unwrap();
        fs::write(
            d.dir.join(".out/quick.json"),
            r#"{"pass":true,"items":[{"id":"links","status":"pass"}]}"#,
        )
        .unwrap();
        fs::write(d.dir.join("ai.json"), r#"{"goal":"private"}"#).unwrap();
        fs::create_dir_all(d.dir.join("presenter")).unwrap();
        fs::write(d.dir.join("presenter/notes.json"), "{}").unwrap();
        let file = tmp.path().join("supplier-delay.scenecast");
        let (n, bytes) = write(&d.dir, &file, "Scenecast 0.5.0 on macos").unwrap();
        assert!(n >= 3 && bytes > 0);
        // Written under another name, then renamed: nothing half-written left beside it.
        assert!(!tmp.path().join("supplier-delay.scenecast.part").exists());
        let names: Vec<String> = {
            let z = zip::ZipArchive::new(fs::File::open(&file).unwrap()).unwrap();
            z.file_names().map(str::to_owned).collect()
        };
        assert!(names.contains(&"scenecast.json".to_owned()));
        assert!(names.contains(&"demo/presenter/notes.json".to_owned()));
        assert!(names.contains(&"demo/.out/fidelity/report.json".to_owned()));
        assert!(names.contains(&"demo/.out/quick.json".to_owned()));
        assert!(
            !names
                .iter()
                .any(|n| n.contains("real.png") || n.ends_with("ai.json")),
            "{names:?}"
        );

        let theirs = Library::new(tmp.path().join("theirs"));
        let a = import(&theirs, &file).unwrap();
        let b = import(&theirs, &file).unwrap();
        assert_eq!(
            (a.id.as_str(), b.id.as_str()),
            ("supplier-delay", "supplier-delay-2")
        );
        assert_eq!(
            (a.title.as_str(), a.slot, a.profile.clone()),
            ("Supplier delay", Some(480), None)
        );
        assert_ne!(a.port, b.port);
        let cfg: Value =
            serde_json::from_slice(&fs::read(a.dir.join("demo.json")).unwrap()).unwrap();
        assert_eq!(cfg["raw"], "~/.scenecast/supplier-delay/raw");
        assert!(a.dir.join("presenter/notes.json").is_file());
        // Compared with the real product and checked, as it was when it was shared.
        assert!(a.status.fidelity.as_ref().is_some_and(|f| f.pass));
        assert!(
            a.status
                .checks
                .as_ref()
                .is_some_and(|c| c.pass && c.passed == 1)
        );
        assert!(!theirs.root.read_dir().unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".import")
        }));
    }

    #[test]
    fn refuses_other_files_and_paths_outside_the_demo() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path().join("lib"));
        let not_zip = tmp.path().join("x.scenecast");
        fs::write(&not_zip, b"hello").unwrap();
        assert!(
            import(&lib, &not_zip)
                .unwrap_err()
                .to_string()
                .contains("isn't a Scenecast demo file")
        );
        let evil = tmp.path().join("evil.scenecast");
        {
            let mut z = zip::ZipWriter::new(fs::File::create(&evil).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("scenecast.json", o).unwrap();
            z.write_all(br#"{"format":"scenecast-demo","version":1,"title":"Evil"}"#)
                .unwrap();
            z.start_file("demo/../../escape.txt", o).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        assert!(import(&lib, &evil).is_err());
        assert!(!tmp.path().join("escape.txt").exists());
        assert!(lib.get("evil").is_err());
    }
}
