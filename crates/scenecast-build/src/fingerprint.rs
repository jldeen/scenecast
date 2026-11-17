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

/// Hash file paths and contents, independently of timestamps and directory traversal order.
/// The callback receives each relative file path as structured progress.
pub fn fingerprint_tree(
    root: &Path,
    mut progress: impl FnMut(&Path),
) -> Result<String, FingerprintError> {
    fn walk(
        root: &Path,
        path: &Path,
        hash: &mut Sha256,
        progress: &mut impl FnMut(&Path),
    ) -> Result<(), FingerprintError> {
        let meta = fs::symlink_metadata(path).map_err(|e| io_error(path, e))?;
        if meta.file_type().is_symlink() {
            return Err(FingerprintError::Symlink(path.to_path_buf()));
        }
        if meta.is_dir() {
            let mut entries = fs::read_dir(path)
                .map_err(|e| io_error(path, e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| io_error(path, e))?;
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                walk(root, &entry.path(), hash, progress)?;
            }
        } else if meta.is_file() {
            let relative = path.strip_prefix(root).expect("walk stays under root");
            let name = relative
                .to_str()
                .ok_or_else(|| FingerprintError::NonUtf8(path.to_path_buf()))?
                .replace('\\', "/");
            hash.update((name.len() as u64).to_le_bytes());
            hash.update(name.as_bytes());
            hash.update(meta.len().to_le_bytes());
            let mut file = File::open(path).map_err(|e| io_error(path, e))?;
            let mut buffer = [0; 65536];
            loop {
                let n = file.read(&mut buffer).map_err(|e| io_error(path, e))?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            progress(relative);
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    walk(root, root, &mut hash, &mut progress)?;
    Ok(format!("{:x}", hash.finalize()))
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
