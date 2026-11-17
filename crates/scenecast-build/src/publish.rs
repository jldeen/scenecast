//! Publish staged capture files without rewriting unchanged output.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PublishError {
    #[error("capture publication failed at {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("capture publication does not allow symbolic links: {0}")]
    Symlink(PathBuf),
    #[error("capture output path is not UTF-8: {0}")]
    NonUtf8(PathBuf),
}

fn io(path: &Path, source: std::io::Error) -> PublishError {
    PublishError::Io {
        path: path.to_owned(),
        source,
    }
}

#[derive(Debug, Serialize)]
pub struct Published {
    pub changed: Vec<String>,
    pub files: BTreeMap<String, String>,
}

fn files(root: &Path) -> Result<BTreeSet<String>, PublishError> {
    fn walk(root: &Path, path: &Path, result: &mut BTreeSet<String>) -> Result<(), PublishError> {
        let meta = fs::symlink_metadata(path).map_err(|e| io(path, e))?;
        if meta.file_type().is_symlink() {
            return Err(PublishError::Symlink(path.to_owned()));
        }
        if meta.is_dir() {
            for entry in fs::read_dir(path).map_err(|e| io(path, e))? {
                let entry = entry.map_err(|e| io(path, e))?;
                walk(root, &entry.path(), result)?;
            }
        } else if meta.is_file() {
            let relative = path.strip_prefix(root).expect("walk stays under root");
            let name = relative
                .to_str()
                .ok_or_else(|| PublishError::NonUtf8(path.to_owned()))?
                .replace('\\', "/");
            result.insert(name);
        }
        Ok(())
    }
    let mut result = BTreeSet::new();
    match fs::symlink_metadata(root) {
        Ok(_) => walk(root, root, &mut result)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io(root, e)),
    }
    Ok(result)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))[..16].to_owned()
}

/// Publish staged capture files into `data`, retaining unchanged files.
pub fn publish(data: &Path, staged_assets: bool) -> Result<Published, PublishError> {
    let next = data.join(".next");
    let metadata = fs::symlink_metadata(&next).map_err(|e| io(&next, e))?;
    if metadata.file_type().is_symlink() {
        return Err(PublishError::Symlink(next));
    }
    if !metadata.is_dir() {
        return Err(io(
            &next,
            std::io::Error::new(std::io::ErrorKind::InvalidData, "expected a directory"),
        ));
    }
    let dirs: &[&str] = if staged_assets {
        &["snaps", "streams", "assets"]
    } else {
        &["snaps", "streams"]
    };
    for dir in dirs {
        let from = next.join(dir);
        let metadata = fs::symlink_metadata(&from).map_err(|e| io(&from, e))?;
        if metadata.file_type().is_symlink() {
            return Err(PublishError::Symlink(from));
        }
        if !metadata.is_dir() {
            return Err(io(
                &from,
                std::io::Error::new(std::io::ErrorKind::InvalidData, "expected a directory"),
            ));
        }
    }
    let mut changed = Vec::new();
    let mut output = BTreeMap::new();
    for dir in dirs {
        let from = next.join(dir);
        let to = data.join(dir);
        let staged = files(&from)?;
        let previous = files(&to)?;
        for name in &staged {
            let src = from.join(name);
            let dst = to.join(name);
            let bytes = fs::read(&src).map_err(|e| io(&src, e))?;
            let digest = hash(&bytes);
            if *dir != "assets" {
                output.insert(format!("{dir}/{name}"), digest.clone());
            }
            if previous.contains(name) {
                let old = fs::read(&dst).map_err(|e| io(&dst, e))?;
                if hash(&old) == digest {
                    continue;
                }
            }
            let parent = dst.parent().expect("file has a parent");
            fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
            fs::write(&dst, bytes).map_err(|e| io(&dst, e))?;
            if *dir != "assets" {
                changed.push(format!("{dir}/{name}"));
            }
        }
        if *dir != "assets" {
            for name in previous.difference(&staged) {
                let dst = to.join(name);
                fs::remove_file(&dst).map_err(|e| io(&dst, e))?;
                changed.push(format!("{dir}/{name} (removed)"));
            }
        }
        if to.is_dir() {
            for entry in fs::read_dir(&to).map_err(|e| io(&to, e))? {
                let entry = entry.map_err(|e| io(&to, e))?;
                let path = entry.path();
                if path.is_dir()
                    && fs::read_dir(&path)
                        .map_err(|e| io(&path, e))?
                        .next()
                        .is_none()
                {
                    fs::remove_dir(&path).map_err(|e| io(&path, e))?;
                }
            }
        }
    }
    fs::remove_dir_all(&next).map_err(|e| io(&next, e))?;
    Ok(Published {
        changed,
        files: output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_changed_and_removed_files_without_rewriting_unchanged_files() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        for dir in [".next/snaps", ".next/streams", "snaps", "streams/old"] {
            fs::create_dir_all(data.join(dir)).unwrap();
        }
        fs::write(data.join("snaps/same.html"), "same").unwrap();
        fs::write(data.join(".next/snaps/same.html"), "same").unwrap();
        fs::write(data.join(".next/snaps/new.html"), "new").unwrap();
        fs::write(data.join("streams/old/frame.html"), "old").unwrap();
        let before = fs::metadata(data.join("snaps/same.html"))
            .unwrap()
            .modified()
            .unwrap();
        let result = publish(data, false).unwrap();
        assert_eq!(
            result.changed,
            ["snaps/new.html", "streams/old/frame.html (removed)"]
        );
        assert_eq!(result.files["snaps/same.html"], hash(b"same"));
        assert_eq!(
            fs::metadata(data.join("snaps/same.html"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        assert!(!data.join("streams/old").exists());
        assert!(!data.join(".next").exists());
    }

    #[test]
    fn missing_staged_directory_does_not_remove_existing_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".next/snaps")).unwrap();
        fs::create_dir_all(temp.path().join("snaps")).unwrap();
        let existing = temp.path().join("snaps/existing.html");
        fs::write(&existing, "existing").unwrap();
        assert!(publish(temp.path(), false).is_err());
        assert_eq!(fs::read_to_string(existing).unwrap(), "existing");
    }

    #[test]
    fn publishes_assets_without_removing_unstaged_files() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        for dir in [".next/snaps", ".next/streams", ".next/assets", "assets"] {
            fs::create_dir_all(data.join(dir)).unwrap();
        }
        fs::write(data.join(".next/assets/new.png"), "image").unwrap();
        fs::write(data.join("assets/old.png"), "old").unwrap();
        let result = publish(data, true).unwrap();
        assert_eq!(fs::read(data.join("assets/new.png")).unwrap(), b"image");
        assert!(data.join("assets/old.png").exists());
        assert!(result.changed.is_empty());
        assert!(result.files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_in_staged_output() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".next/snaps")).unwrap();
        fs::create_dir_all(temp.path().join(".next/streams")).unwrap();
        std::os::unix::fs::symlink("missing", temp.path().join(".next/snaps/link")).unwrap();
        assert!(matches!(
            publish(temp.path(), false),
            Err(PublishError::Symlink(_))
        ));
    }
}
