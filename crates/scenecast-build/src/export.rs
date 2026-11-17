//! Export a live-page bundle for a static HTTP host.

use std::fs;
use std::path::{Path, PathBuf};

use scenecast_core::{BundleManifest, SceneKind, validate_referenced_files};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::scrub::{ScrubError, ScrubReport, scrub_tree};

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("static export: {0}")]
    Invalid(String),
    #[error("static export: {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("static export: {0}")]
    Json(#[from] serde_json::Error),
    #[error("static export: {0}")]
    Scrub(#[from] ScrubError),
}

fn io(path: &Path, source: std::io::Error) -> ExportError {
    ExportError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), ExportError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    fs::write(path, bytes).map_err(|e| io(path, e))
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), ExportError> {
    if !source.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source).map_err(|e| io(source, e))?;
    if metadata.file_type().is_symlink() {
        return Err(ExportError::Invalid(format!(
            "symbolic link not allowed: {}",
            source.display()
        )));
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|e| io(destination, e))?;
        for entry in fs::read_dir(source).map_err(|e| io(source, e))? {
            let entry = entry.map_err(|e| io(source, e))?;
            copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        let bytes = fs::read(source).map_err(|e| io(source, e))?;
        let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("");
        let bytes = if ["html", "css", "json", "svg"]
            .iter()
            .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        {
            let text = std::str::from_utf8(&bytes).map_err(|_| {
                ExportError::Invalid(format!("invalid UTF-8: {}", source.display()))
            })?;
            text.replace("/assets/", "../assets/")
                .replace("/snaps/", "../snaps/")
                .replace("/streams/", "../streams/")
                .into_bytes()
        } else {
            bytes
        };
        write(destination, &bytes)?;
    }
    Ok(())
}

/// Exports standard live-page captures. The destination must be empty.
/// Static browsers need an HTTP host because module and fetch requests cannot use `file://`.
pub fn export_live(
    bundle: &Path,
    output: &Path,
    manifest: &BundleManifest,
) -> Result<(), ExportError> {
    for scene in &manifest.graph.scenes {
        if scene.kind != SceneKind::LivePage {
            return Err(ExportError::Invalid(
                "mixed fallback scenes are not supported by the live player".into(),
            ));
        }
        let snapshot = scene
            .live
            .as_ref()
            .map(|live| live.snapshot.as_str())
            .unwrap_or("");
        let name = snapshot
            .strip_prefix("data/snaps/")
            .and_then(|s| s.strip_suffix(".html"));
        if !name.is_some_and(|s| !s.is_empty() && !s.contains('/')) {
            return Err(ExportError::Invalid(format!(
                "nonstandard snapshot path: {snapshot}"
            )));
        }
    }
    let value = serde_json::to_value(manifest)?;
    let modules = value
        .pointer("/playback/options/modules")
        .and_then(|v| v.as_array());
    if modules.is_some_and(|list| {
        list.iter()
            .any(|m| !m.as_str().is_some_and(|s| s.starts_with("/app/")))
    }) {
        return Err(ExportError::Invalid(
            "custom player modules are not supported by static export".into(),
        ));
    }
    if output.exists()
        && fs::read_dir(output)
            .map_err(|e| io(output, e))?
            .next()
            .is_some()
    {
        return Err(ExportError::Invalid(format!(
            "output directory is not empty: {}",
            output.display()
        )));
    }
    fs::create_dir_all(output).map_err(|e| io(output, e))?;
    let bundle_root = fs::canonicalize(bundle).map_err(|e| io(bundle, e))?;
    let output_root = fs::canonicalize(output).map_err(|e| io(output, e))?;
    if output_root.starts_with(&bundle_root) {
        return Err(ExportError::Invalid(
            "output must be outside the source bundle".into(),
        ));
    }
    let config = bundle.join("demo.json");
    let allowlist = if config.is_file() {
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&config).map_err(|e| io(&config, e))?)?;
        value
            .pointer("/scrub/allowlist")
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()?
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let data = bundle.join("data");
    if data.is_dir() {
        let mut report = ScrubReport::default();
        scrub_tree(&data, "built", &allowlist, false, &mut report)?;
        if !report.findings.is_empty() {
            return Err(ExportError::Invalid("built data contains sensitive text or scripts; run scenecast build and inspect its scrub report".into()));
        }
    }
    for (name, content) in [
        (
            "index.html",
            include_bytes!("../../../packages/player/app/index.html").as_slice(),
        ),
        (
            "app/shell.js",
            include_bytes!("../../../packages/player/app/shell.js").as_slice(),
        ),
        (
            "app/bundle-flow.js",
            include_bytes!("../../../packages/player/app/bundle-flow.js").as_slice(),
        ),
        (
            "app/morph.js",
            include_bytes!("../../../packages/player/app/morph.js").as_slice(),
        ),
        (
            "app/presenter-key.js",
            include_bytes!("../../../packages/player/app/presenter-key.js").as_slice(),
        ),
        (
            "app/focus-module.js",
            include_bytes!("../../../packages/player/app/focus-module.js").as_slice(),
        ),
        (
            "app/focus.js",
            include_bytes!("../../../packages/player/app/focus.js").as_slice(),
        ),
    ] {
        write(&output.join(name), content)?;
    }
    for dir in ["snaps", "streams", "assets"] {
        copy_tree(&bundle.join("data").join(dir), &output.join(dir))?;
    }
    let mut exported = manifest.clone();
    for scene in &mut exported.graph.scenes {
        let live = scene.live.as_mut().expect("live scenes checked above");
        live.snapshot = live.snapshot.strip_prefix("data/").unwrap().to_owned();
        let path = output.join(&live.snapshot);
        let bytes = fs::read(&path).map_err(|e| io(&path, e))?;
        live.sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
    }
    let files = validate_referenced_files(output, &exported);
    if !files.is_valid() {
        return Err(ExportError::Invalid(format!(
            "exported bundle has missing references: {}",
            files
                .missing_files
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    write(
        &output.join("manifest.json"),
        &serde_json::to_vec_pretty(&exported)?,
    )?;
    let assets = output.join("assets");
    let mut fonts = Vec::new();
    if assets.is_dir() {
        for entry in fs::read_dir(&assets).map_err(|e| io(&assets, e))? {
            let entry = entry.map_err(|e| io(&assets, e))?;
            let path = entry.path();
            if entry.metadata().map_err(|e| io(&path, e))?.len() > 0
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| ["woff", "woff2", "ttf", "otf"].contains(&e))
            {
                fonts.push(format!("/assets/{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    fonts.sort();
    write(
        &output.join("__replica/fonts"),
        &serde_json::to_vec(&fonts)?,
    )?;
    Ok(())
}
