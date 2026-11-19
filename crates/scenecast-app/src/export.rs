//! A demo for another presenter: the replica as a plain folder (open `index.html`, or serve it), or that folder
//! zipped.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    Folder,
    Zip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    /// The folder or the zip.
    pub path: PathBuf,
    pub kind: ExportKind,
    pub files: usize,
    pub bytes: u64,
}

/// Where exports go unless the presenter picks somewhere: `Exports` in the library.
pub fn default_dest(library_root: &Path) -> PathBuf {
    library_root.join("Exports")
}

fn free_path(parent: &Path, base: &str, ext: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{base}{ext}")
        } else {
            format!("{base}-{n}{ext}")
        };
        let path = parent.join(name);
        if !path.exists() {
            return path;
        }
        n += 1;
    }
}

/// Exports the built replica of the demo in `dir` into `dest` (a new folder or zip named after the demo).
pub fn export(dir: &Path, dest: &Path, kind: ExportKind) -> Result<ExportOutcome, AppError> {
    let manifest = scenecast_core::read_manifest(dir)?;
    if !manifest.graph.scenes.iter().any(|s| {
        s.live
            .as_ref()
            .is_some_and(|l| dir.join(&l.snapshot).is_file())
    }) {
        return Err(AppError::Invalid(
            "build the demo first: there's no replica to export yet".into(),
        ));
    }
    fs::create_dir_all(dest)?;
    let base = format!(
        "{}-replica",
        dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "demo".into())
    );
    match kind {
        ExportKind::Folder => {
            let folder = free_path(dest, &base, "");
            scenecast_build::export::export_live(dir, &folder, &manifest)?;
            let (files, bytes) = tally(&folder)?;
            Ok(ExportOutcome {
                path: folder,
                kind,
                files,
                bytes,
            })
        }
        ExportKind::Zip => {
            let zip_path = free_path(dest, &base, ".zip");
            let staging = tempfile_dir(dest)?;
            let folder = staging.join(&base);
            let result = scenecast_build::export::export_live(dir, &folder, &manifest)
                .map_err(AppError::from)
                .and_then(|()| zip_dir(&folder, &base, &zip_path));
            let _ = fs::remove_dir_all(&staging);
            let files = result?;
            Ok(ExportOutcome {
                bytes: fs::metadata(&zip_path)?.len(),
                path: zip_path,
                kind,
                files,
            })
        }
    }
}

/// An export with the whole checklist first: the one time it runs (quick checks cover each change before it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedExport {
    /// What was exported; `None` when the checks failed and the export waited.
    pub exported: Option<ExportOutcome>,
    /// The checklist, when it ran.
    pub checks: Option<crate::build::ChecksOutcome>,
    /// `ran`: it ran now; `current`: it passed already and nothing it covers changed since; `skipped`: exported anyway.
    pub checked: &'static str,
}

/// Runs the whole checklist unless it already passed on the replica as it is now, then exports. A failing check stops
/// the export unless `anyway` (the presenter saw the failures and chose to export).
pub fn export_checked(
    dir: &Path,
    dest: &Path,
    kind: ExportKind,
    anyway: bool,
    mut on: impl FnMut(crate::Update),
) -> Result<CheckedExport, AppError> {
    let (checks, checked) = if anyway {
        (None, "skipped")
    } else if crate::build::needs_full_check(dir) {
        let c = crate::build::checks(dir, false, &mut on)?;
        if !c.pass {
            return Ok(CheckedExport {
                exported: None,
                checks: Some(c),
                checked: "ran",
            });
        }
        (Some(c), "ran")
    } else {
        (None, "current")
    };
    on(crate::Update::stage("export", "Exporting the replica"));
    Ok(CheckedExport {
        exported: Some(export(dir, dest, kind)?),
        checks,
        checked,
    })
}

fn tempfile_dir(near: &Path) -> std::io::Result<PathBuf> {
    let mut n = 0u32;
    loop {
        let dir = near.join(format!(".export-{}-{n}", std::process::id()));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    }
}

fn tally(dir: &Path) -> std::io::Result<(usize, u64)> {
    let mut files = 0;
    let mut bytes = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let (f, b) = tally(&entry.path())?;
            files += f;
            bytes += b;
        } else {
            files += 1;
            bytes += entry.metadata()?.len();
        }
    }
    Ok((files, bytes))
}

/// Zips `folder` with its files under `top/` (forward slashes, so it opens the same on macOS and Windows).
pub fn zip_dir(folder: &Path, top: &str, zip_path: &Path) -> Result<usize, AppError> {
    let file = fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut stack = vec![folder.to_path_buf()];
    let mut files = 0;
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let rel = path
                .strip_prefix(folder)
                .expect("walked from the folder")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if entry.file_type()?.is_dir() {
                zip.add_directory(format!("{top}/{rel}/"), options)?;
                stack.push(path);
            } else {
                zip.start_file(format!("{top}/{rel}"), options)?;
                zip.write_all(&fs::read(&path)?)?;
                files += 1;
            }
        }
    }
    zip.finish()?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn zips_a_folder_with_forward_slashes_under_one_top_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("x");
        fs::create_dir_all(folder.join("data/snaps")).unwrap();
        fs::write(folder.join("index.html"), "<html>").unwrap();
        fs::write(folder.join("data/snaps/a.html"), "a").unwrap();
        let zip_path = tmp.path().join("x.zip");
        assert_eq!(zip_dir(&folder, "demo-replica", &zip_path).unwrap(), 2);
        let mut zip = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
        let mut names: Vec<String> = zip.file_names().map(str::to_owned).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "demo-replica/data/",
                "demo-replica/data/snaps/",
                "demo-replica/data/snaps/a.html",
                "demo-replica/index.html"
            ]
        );
        let mut text = String::new();
        zip.by_name("demo-replica/data/snaps/a.html")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "a");
    }

    #[test]
    fn refuses_a_demo_that_isnt_built() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = crate::Library::new(tmp.path().join("lib"));
        let demo = lib
            .create(&crate::NewDemo {
                title: "Unbuilt".into(),
                apps: vec![crate::NewApp {
                    id: "chat".into(),
                    url: "https://chat.example.com/".into(),
                }],
                browser: None,
                profile: None,
            })
            .unwrap();
        let err = export(&demo.dir, &default_dest(&lib.root), ExportKind::Folder).unwrap_err();
        assert!(err.to_string().contains("build the demo first"));
    }

    #[test]
    fn never_overwrites_an_earlier_export() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("d-replica")).unwrap();
        fs::write(tmp.path().join("d-replica-2.zip"), "").unwrap();
        assert_eq!(
            free_path(tmp.path(), "d-replica", ""),
            tmp.path().join("d-replica-2")
        );
        assert_eq!(
            free_path(tmp.path(), "d-replica", ".zip"),
            tmp.path().join("d-replica.zip")
        );
        fs::write(tmp.path().join("d-replica.zip"), "").unwrap();
        assert_eq!(
            free_path(tmp.path(), "d-replica", ".zip"),
            tmp.path().join("d-replica-3.zip")
        );
    }
}
