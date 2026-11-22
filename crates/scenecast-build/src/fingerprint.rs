//! Portable content fingerprints for incremental capture builds.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FingerprintError {
    #[error("cannot fingerprint {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot fingerprint symbolic link {0}")]
    Symlink(PathBuf),
    #[error("capture path is not UTF-8: {0}")]
    NonUtf8(PathBuf),
}

fn io_error(path: &Path, source: io::Error) -> FingerprintError {
    FingerprintError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// A file of a tree: its path relative to the tree (`/` between folders), size and SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHash {
    pub name: String,
    pub len: u64,
    pub sha256: [u8; 32],
}

/// What [`walk`] found that it won't go into.
pub(crate) enum WalkError {
    Io(PathBuf, io::Error),
    Symlink(PathBuf),
}

/// Every file under `root` (or `root` itself, if it's a file), in a stable order: names sorted in each folder.
/// Symbolic links are refused rather than followed.
pub(crate) fn walk(root: &Path) -> Result<Vec<PathBuf>, WalkError> {
    fn visit(path: &Path, out: &mut Vec<PathBuf>) -> Result<(), WalkError> {
        let meta = fs::symlink_metadata(path).map_err(|e| WalkError::Io(path.to_owned(), e))?;
        if meta.file_type().is_symlink() {
            return Err(WalkError::Symlink(path.to_owned()));
        }
        if meta.is_dir() {
            let mut entries = fs::read_dir(path)
                .map_err(|e| WalkError::Io(path.to_owned(), e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| WalkError::Io(path.to_owned(), e))?;
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                visit(&entry.path(), out)?;
            }
        } else if meta.is_file() {
            out.push(path.to_owned());
        }
        Ok(())
    }
    let mut out = Vec::new();
    visit(root, &mut out)?;
    Ok(out)
}

/// The fingerprint of a tree from its files' hashes (in [`walk`] order).
pub fn fingerprint_of(files: &[FileHash]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"scenecast-tree-v2");
    for f in files {
        hash.update((f.name.len() as u64).to_le_bytes());
        hash.update(f.name.as_bytes());
        hash.update(f.len.to_le_bytes());
        hash.update(f.sha256);
    }
    format!("{:x}", hash.finalize())
}

pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Hash file paths and contents, independently of timestamps and directory traversal order. Files are read and
/// hashed on several threads. The callback receives each relative file path, in order, as structured progress.
pub fn fingerprint_tree(
    root: &Path,
    mut progress: impl FnMut(&Path),
) -> Result<String, FingerprintError> {
    let paths = walk(root).map_err(|e| match e {
        WalkError::Io(path, source) => io_error(&path, source),
        WalkError::Symlink(path) => FingerprintError::Symlink(path),
    })?;
    let hashed = crate::par::map(&paths, |path| -> Result<FileHash, FingerprintError> {
        let relative = path.strip_prefix(root).expect("walk stays under root");
        let name = relative
            .to_str()
            .ok_or_else(|| FingerprintError::NonUtf8(path.to_path_buf()))?
            .replace('\\', "/");
        let mut file = File::open(path).map_err(|e| io_error(path, e))?;
        let (mut hash, mut len) = (Sha256::new(), 0u64);
        let mut buffer = vec![0; 1 << 20];
        loop {
            let n = file.read(&mut buffer).map_err(|e| io_error(path, e))?;
            if n == 0 {
                break;
            }
            len += n as u64;
            hash.update(&buffer[..n]);
        }
        Ok(FileHash {
            name,
            len,
            sha256: hash.finalize().into(),
        })
    });
    let mut files = Vec::with_capacity(hashed.len());
    for (path, file) in paths.iter().zip(hashed) {
        files.push(file?);
        progress(path.strip_prefix(root).expect("walk stays under root"));
    }
    Ok(fingerprint_of(&files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_content_and_names_not_just_sizes() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("capture.json");
        fs::write(&file, "first").unwrap();
        let mut visited = Vec::new();
        let before = fingerprint_tree(temp.path(), |p| visited.push(p.to_owned())).unwrap();
        assert_eq!(visited, [PathBuf::from("capture.json")]);
        fs::write(&file, "other").unwrap();
        let after = fingerprint_tree(temp.path(), |_| {}).unwrap();
        assert_ne!(before, after);
        fs::rename(&file, temp.path().join("renamed.json")).unwrap();
        assert_ne!(after, fingerprint_tree(temp.path(), |_| {}).unwrap());
    }
}
