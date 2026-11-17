//! Export a live-page bundle for a static HTTP host.

use std::collections::HashSet;
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

/// Exports live-page captures. The destination must be empty.
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
        if !snapshot.ends_with(".html")
            || snapshot.contains('\\')
            || snapshot.contains(':')
            || snapshot
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(ExportError::Invalid(format!(
                "invalid snapshot path: {snapshot}"
            )));
        }
    }
    let value = serde_json::to_value(manifest)?;
    let modules = value
        .pointer("/playback/options/modules")
        .and_then(|v| v.as_array());
    let modules = modules.cloned().unwrap_or_default();
    for module in &modules {
        let module = module
            .as_str()
            .ok_or_else(|| ExportError::Invalid("invalid player module".into()))?;
        if ![
            "/app/focus-module.js",
            "/app/focus.js",
            "/app/morph.js",
            "/app/presenter-key.js",
            "/app/bundle-flow.js",
        ]
        .contains(&module)
            && !module.starts_with("/demo/")
        {
            return Err(ExportError::Invalid(format!(
                "unsupported player module: {module}"
            )));
        }
        if module.contains('\\')
            || module.contains(':')
            || module
                .split('/')
                .skip(1)
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return Err(ExportError::Invalid(format!(
                "invalid player module: {module}"
            )));
        }
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
    let config_value: Option<serde_json::Value> = if config.is_file() {
        Some(serde_json::from_slice(
            &fs::read(&config).map_err(|e| io(&config, e))?,
        )?)
    } else {
        None
    };
    let allowlist = if let Some(value) = &config_value {
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
    if modules
        .iter()
        .any(|m| m.as_str().is_some_and(|s| s.starts_with("/demo/")))
    {
        let dir = config_value
            .as_ref()
            .and_then(|v| v.pointer("/engine/dir"))
            .and_then(|v| v.as_str())
            .unwrap_or("app");
        if dir.is_empty()
            || dir.contains('\\')
            || dir.contains(':')
            || dir
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return Err(ExportError::Invalid(
                "invalid custom engine directory".into(),
            ));
        }
        let source = bundle.join(dir);
        let real = fs::canonicalize(&source).map_err(|e| io(&source, e))?;
        if !real.starts_with(&bundle_root) || !real.is_dir() {
            return Err(ExportError::Invalid(
                "custom engine directory leaves bundle".into(),
            ));
        }
        for module in &modules {
            if let Some(path) = module.as_str().and_then(|m| m.strip_prefix("/demo/"))
                && !source.join(path).is_file()
            {
                return Err(ExportError::Invalid(format!(
                    "missing player module: /demo/{path}"
                )));
            }
        }
        let mut report = ScrubReport::default();
        scrub_tree(&source, "raw", &allowlist, false, &mut report)?;
        if !report.findings.is_empty() {
            return Err(ExportError::Invalid(
                "custom engine contains sensitive text".into(),
            ));
        }
        copy_tree(&source, &output.join("demo"))?;
    }
    let mut exported = manifest.clone();
    for (index, scene) in exported.graph.scenes.iter_mut().enumerate() {
        let live = scene.live.as_mut().expect("live scenes checked above");
        let standard = live
            .snapshot
            .strip_prefix("data/snaps/")
            .is_some_and(|name| !name.contains('/'));
        if standard {
            live.snapshot = live.snapshot.strip_prefix("data/").unwrap().to_owned();
        } else {
            let source = bundle.join(&live.snapshot);
            let real = fs::canonicalize(&source).map_err(|e| io(&source, e))?;
            if !real.starts_with(&bundle_root) {
                return Err(ExportError::Invalid(format!(
                    "snapshot leaves bundle: {}",
                    live.snapshot
                )));
            }
            let parent = source.parent().expect("snapshot has a parent");
            let stem = source.file_stem().and_then(|s| s.to_str()).ok_or_else(|| {
                ExportError::Invalid(format!("invalid snapshot filename: {}", live.snapshot))
            })?;
            let mut name = format!("scenecast-export-{index}");
            let snaps = output.join("snaps");
            let existing = if snaps.is_dir() {
                fs::read_dir(&snaps)
                    .map_err(|e| io(&snaps, e))?
                    .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| io(&snaps, e))?
            } else {
                Vec::new()
            };
            while existing
                .iter()
                .any(|file| file.starts_with(&format!("{name}.")))
            {
                name.push('_');
            }
            let mut related = vec![(source.clone(), format!("{name}.html"))];
            for entry in fs::read_dir(parent).map_err(|e| io(parent, e))? {
                let entry = entry.map_err(|e| io(parent, e))?;
                let file = entry.file_name().to_string_lossy().into_owned();
                if file == format!("{stem}.json") {
                    related.push((entry.path(), format!("{name}.json")));
                } else if let Some(key) = file
                    .strip_prefix(&format!("{stem}."))
                    .and_then(|s| s.strip_suffix(".html"))
                    && !key.is_empty()
                    && key
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    related.push((entry.path(), format!("{name}.{key}.html")));
                }
            }
            for (file, dest) in related {
                let real = fs::canonicalize(&file).map_err(|e| io(&file, e))?;
                if !real.starts_with(&bundle_root) {
                    return Err(ExportError::Invalid(format!(
                        "snapshot file leaves bundle: {}",
                        file.display()
                    )));
                }
                let mut report = ScrubReport::default();
                scrub_tree(&file, "built", &allowlist, false, &mut report)?;
                if !report.findings.is_empty() {
                    return Err(ExportError::Invalid(format!(
                        "snapshot contains sensitive text or scripts: {}",
                        file.display()
                    )));
                }
                let dest = output.join("snaps").join(dest);
                copy_tree(&file, &dest)?;
                if dest.extension().is_some_and(|e| e == "html") {
                    let html = fs::read_to_string(&dest).map_err(|e| io(&dest, e))?;
                    let html = html
                        .replace(&format!("../snaps/{stem}."), &format!("../snaps/{name}."))
                        .replace(
                            &format!("/bundle/{}.", live.snapshot.trim_end_matches(".html")),
                            &format!("../snaps/{name}."),
                        );
                    write(&dest, html.as_bytes())?;
                }
            }
            live.snapshot = format!("snaps/{name}.html");
        }
        let path = output.join(&live.snapshot);
        let bytes = fs::read(&path).map_err(|e| io(&path, e))?;
        live.sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
    }
    let snapshots: Vec<&str> = exported
        .graph
        .scenes
        .iter()
        .filter_map(|scene| scene.live.as_ref().map(|live| live.snapshot.as_str()))
        .collect();
    let mut seen = HashSet::new();
    for path in exported.referenced_asset_paths() {
        if snapshots.contains(&path) || !seen.insert(path) {
            continue;
        }
        let source = bundle.join(path);
        let destination = output.join(path);
        if destination.exists() {
            return Err(ExportError::Invalid(format!(
                "asset conflicts with player output: {path}"
            )));
        }
        let mut report = ScrubReport::default();
        scrub_tree(&source, "built", &allowlist, false, &mut report)?;
        if !report.findings.is_empty() {
            return Err(ExportError::Invalid(format!(
                "referenced asset contains sensitive text or scripts: {path}"
            )));
        }
        copy_tree(&source, &destination)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use scenecast_core::{LivePage, PlaybackData, read_manifest};

    #[test]
    fn exports_valid_references_and_rehashes_rewritten_snapshots() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let output = tmp.path().join("output");
        fs::create_dir_all(bundle.join("data/snaps")).unwrap();
        fs::create_dir_all(bundle.join("captures")).unwrap();
        fs::write(
            bundle.join("data/snaps/start.html"),
            r#"<img src="/assets/example.png">"#,
        )
        .unwrap();
        fs::write(
            bundle.join("captures/reference.png"),
            [0x89, b'P', b'N', b'G'],
        )
        .unwrap();
        let mut manifest = BundleManifest::starter("Fixture");
        manifest.graph.scenes[0].live = Some(LivePage {
            app: "fixture".into(),
            snapshot: "data/snaps/start.html".into(),
            title: None,
            reference: Some("captures/reference.png".into()),
            sha256: Some("old".into()),
        });
        export_live(&bundle, &output, &manifest).unwrap();
        let exported = read_manifest(&output).unwrap();
        assert!(validate_referenced_files(&output, &exported).is_valid());
        let live = exported.graph.scenes[0].live.as_ref().unwrap();
        let bytes = fs::read(output.join(&live.snapshot)).unwrap();
        assert_eq!(
            live.sha256.as_deref(),
            Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
        );
        assert_eq!(
            fs::read(output.join("captures/reference.png")).unwrap(),
            [0x89, b'P', b'N', b'G']
        );
    }

    #[test]
    fn rejects_sensitive_referenced_assets() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        fs::create_dir_all(bundle.join("data/snaps")).unwrap();
        fs::write(bundle.join("data/snaps/start.html"), "<p>clean</p>").unwrap();
        fs::write(bundle.join("reference.txt"), "client_secret=short").unwrap();
        let mut manifest = BundleManifest::starter("Fixture");
        manifest.graph.scenes[0].live = Some(LivePage {
            app: "fixture".into(),
            snapshot: "data/snaps/start.html".into(),
            title: None,
            reference: Some("reference.txt".into()),
            sha256: None,
        });
        assert!(matches!(
            export_live(&bundle, &tmp.path().join("output"), &manifest),
            Err(ExportError::Invalid(_))
        ));
    }

    #[test]
    fn exports_custom_snapshots_and_their_frames() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let output = tmp.path().join("output");
        fs::create_dir_all(bundle.join("custom")).unwrap();
        fs::write(
            bundle.join("custom/page.html"),
            r#"<iframe src="/snaps/page.f1.html"></iframe>"#,
        )
        .unwrap();
        fs::write(bundle.join("custom/page.f1.html"), "<p>frame</p>").unwrap();
        fs::write(
            bundle.join("custom/page.json"),
            r#"{"frames":[{"key":"f1"}]}"#,
        )
        .unwrap();
        let mut manifest = BundleManifest::starter("Fixture");
        manifest.graph.scenes[0].live = Some(LivePage {
            app: "fixture".into(),
            snapshot: "custom/page.html".into(),
            title: None,
            reference: None,
            sha256: None,
        });
        export_live(&bundle, &output, &manifest).unwrap();
        let exported = read_manifest(&output).unwrap();
        let snapshot = &exported.graph.scenes[0].live.as_ref().unwrap().snapshot;
        assert_eq!(snapshot, "snaps/scenecast-export-0.html");
        assert!(
            fs::read_to_string(output.join(snapshot))
                .unwrap()
                .contains("../snaps/scenecast-export-0.f1.html")
        );
        assert!(output.join("snaps/scenecast-export-0.f1.html").exists());
        assert!(output.join("snaps/scenecast-export-0.json").exists());
        assert!(validate_referenced_files(&output, &exported).is_valid());
    }

    #[test]
    fn exports_custom_engine_modules_and_dependencies() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let output = tmp.path().join("output");
        fs::create_dir_all(bundle.join("data/snaps")).unwrap();
        fs::create_dir_all(bundle.join("engine")).unwrap();
        fs::write(bundle.join("data/snaps/start.html"), "<p>clean</p>").unwrap();
        fs::write(bundle.join("demo.json"), r#"{"engine":{"dir":"engine"}}"#).unwrap();
        fs::write(
            bundle.join("engine/main.js"),
            "import './helper.js'; export default () => {};",
        )
        .unwrap();
        fs::write(
            bundle.join("engine/helper.js"),
            "export const helper = true;",
        )
        .unwrap();
        let mut manifest = BundleManifest::starter("Fixture");
        manifest.graph.scenes[0].live = Some(LivePage {
            app: "fixture".into(),
            snapshot: "data/snaps/start.html".into(),
            title: None,
            reference: None,
            sha256: None,
        });
        manifest.playback = Some(PlaybackData {
            options: serde_json::json!({"modules": ["/demo/main.js"]}),
            ..Default::default()
        });
        export_live(&bundle, &output, &manifest).unwrap();
        assert!(output.join("demo/main.js").is_file());
        assert!(output.join("demo/helper.js").is_file());
        fs::remove_file(bundle.join("engine/main.js")).unwrap();
        assert!(matches!(
            export_live(&bundle, &tmp.path().join("missing"), &manifest),
            Err(ExportError::Invalid(_))
        ));
    }
}
