//! Build orchestration and structured progress for CLI and desktop callers.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::assets::{AssetError, AssetResolver};
use crate::engine::{Engine, EngineError, Progress, with_demo};
use crate::fingerprint::{FingerprintError, fingerprint_tree};
use crate::flow::{FlowError, compile_recording};
use crate::publish::{PublishError, PublishMode, publish};
use crate::scrub::{ScrubError, ScrubReport, scrub_tree};
use crate::sync::{SyncError, SyncReport, sync_manifest};

#[derive(Debug, Error)]
pub enum BuildError {
    #[error("build I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("build JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Scrub(#[from] ScrubError),
    #[error(transparent)]
    Fingerprint(#[from] FingerprintError),
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Sync(#[from] SyncError),
    #[error(transparent)]
    Flow(#[from] FlowError),
    #[error(transparent)]
    Publish(#[from] PublishError),
    #[error(transparent)]
    Asset(#[from] AssetError),
    #[error("cannot resolve raw capture folder: HOME and USERPROFILE are unset")]
    MissingHome,
    #[error("raw capture folder is not UTF-8")]
    NonUtf8Raw,
    #[error("no recording: {} (record the demo first: scenecast record start)", .0.display())]
    MissingRecording(PathBuf),
    #[error("the --compiled-flow flag is reserved for the build")]
    ReservedFlag,
}

#[derive(Debug, Clone)]
pub enum BuildProgress {
    Stage(&'static str),
    Fingerprint { tree: &'static str, path: PathBuf },
    Engine(Progress),
}

#[derive(Debug)]
pub struct BuildResult {
    pub exit_code: i32,
    pub credentials_in: Option<&'static str>,
    pub scrub: ScrubReport,
    pub sync: Option<SyncReport>,
}

#[derive(Serialize, Deserialize)]
struct BuildFingerprint {
    raw: String,
    output: String,
    #[serde(default)]
    algorithm: String,
}

fn algorithm_hash() -> String {
    let mut hash = Sha256::new();
    for source in [
        include_bytes!("assets.rs").as_slice(),
        include_bytes!("publish.rs").as_slice(),
    ] {
        hash.update((source.len() as u64).to_le_bytes());
        hash.update(source);
    }
    format!("{:x}", hash.finalize())
}

fn compile_base(
    dir: &Path,
    raw: &Path,
    config: &serde_json::Value,
    from_raw: bool,
    kit_version: &str,
) -> Result<Option<tempfile::TempPath>, BuildError> {
    let recording_file = dir.join("recording.json");
    let raw_recording = raw.join("recording.json");
    if !from_raw
        && !recording_file.exists()
        && !raw_recording.exists()
        && dir.join("flow.json").exists()
    {
        return Ok(None);
    }
    if from_raw || !recording_file.exists() {
        if !raw_recording.is_file() {
            return Err(BuildError::MissingRecording(raw_recording));
        }
        let mut recording: serde_json::Value = serde_json::from_slice(&fs::read(&raw_recording)?)?;
        if let Some(fields) = recording.as_object_mut() {
            fields.remove("log");
        }
        if let Some(apps) = recording
            .get_mut("apps")
            .and_then(serde_json::Value::as_array_mut)
        {
            for app in apps {
                if let Some(fields) = app.as_object_mut() {
                    fields.remove("url");
                }
            }
        }
        fs::write(
            &recording_file,
            format!("{}\n", serde_json::to_string_pretty(&recording)?),
        )?;
    }
    let recording = serde_json::from_slice(&fs::read(&recording_file)?)?;
    let flow = compile_recording(config, &recording, kit_version)?;
    let path = tempfile::NamedTempFile::new()?.into_temp_path();
    fs::write(&path, serde_json::to_vec(&flow)?)?;
    Ok(Some(path))
}

fn write_report(dir: &Path, report: &ScrubReport) -> Result<(), BuildError> {
    let out = dir.join(".out");
    fs::create_dir_all(&out)?;
    fs::write(
        out.join("scrub.json"),
        format!("{}\n", serde_json::to_string_pretty(report)?),
    )?;
    Ok(())
}

/// Synchronize the bundle and persist the development-override baseline after a valid sync.
pub fn sync_with_baseline(dir: &Path) -> Result<SyncReport, BuildError> {
    let report = sync_manifest(dir)?;
    if report.is_valid() {
        let out = dir.join(".out");
        fs::create_dir_all(&out)?;
        fs::copy(dir.join("flow.json"), out.join("live-base.json"))?;
    }
    Ok(report)
}

/// Build a project, emitting structured stages, per-file fingerprint progress, and engine output.
pub fn build(
    dir: &Path,
    args: &[OsString],
    on: impl FnMut(BuildProgress),
) -> Result<BuildResult, BuildError> {
    build_with_raw(
        dir,
        args,
        std::env::var_os("REPLICA_RAW").map(PathBuf::from),
        on,
    )
}

fn build_with_raw(
    dir: &Path,
    args: &[OsString],
    raw_override: Option<PathBuf>,
    mut on: impl FnMut(BuildProgress),
) -> Result<BuildResult, BuildError> {
    let dir = &crate::engine::dunce(fs::canonicalize(dir)?);
    let config: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("demo.json"))?)?;
    let raw = raw_override
        .or_else(|| config["raw"].as_str().map(PathBuf::from))
        .unwrap_or_else(|| {
            PathBuf::from(format!(
                "~/.scenecast/{}/raw",
                config["name"].as_str().unwrap_or("demo")
            ))
        });
    let raw_text = raw.to_str().ok_or(BuildError::NonUtf8Raw)?;
    let raw = if raw_text.starts_with("~/") {
        let rest = raw.strip_prefix("~").expect("checked raw path prefix");
        let home = if cfg!(windows) {
            std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
        } else {
            std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
        }
        .ok_or(BuildError::MissingHome)?;
        PathBuf::from(home).join(rest)
    } else if raw.is_absolute() {
        raw
    } else {
        dir.join(raw)
    };
    let allowlist = config
        .pointer("/scrub/allowlist")
        .map(|v| serde_json::from_value::<Vec<String>>(v.clone()))
        .transpose()?
        .unwrap_or_default();
    let mut report = ScrubReport::default();
    on(BuildProgress::Stage("scrub-raw"));
    if raw.exists() {
        scrub_tree(&raw, "raw", &allowlist, false, &mut report)?;
    }
    if report.has_credentials() {
        write_report(dir, &report)?;
        return Ok(BuildResult {
            exit_code: 1,
            credentials_in: Some("raw"),
            scrub: report,
            sync: None,
        });
    }
    on(BuildProgress::Stage("fingerprint"));
    let raw_hash = if raw.is_dir() {
        Some(fingerprint_tree(&raw, |path| {
            on(BuildProgress::Fingerprint {
                tree: "raw",
                path: path.to_owned(),
            })
        })?)
    } else {
        None
    };
    let cache_path = dir.join(".out/build-fingerprint.json");
    let previous: Option<BuildFingerprint> = match fs::read(&cache_path) {
        Ok(bytes) => Some(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let data = dir.join("data");
    let output_hash = if data.is_dir() {
        Some(fingerprint_tree(&data, |path| {
            on(BuildProgress::Fingerprint {
                tree: "output",
                path: path.to_owned(),
            })
        })?)
    } else {
        None
    };
    let algorithm = algorithm_hash();
    let unchanged = previous.as_ref().is_some_and(|p| {
        raw_hash.as_ref() == Some(&p.raw)
            && output_hash.as_ref() == Some(&p.output)
            && p.algorithm == algorithm
    });
    let mut args = args.to_vec();
    if args.iter().any(|a| a == "--compiled-flow") {
        return Err(BuildError::ReservedFlag);
    }
    if !unchanged && !args.iter().any(|a| a == "--force") {
        args.push("--force".into());
    }
    on(BuildProgress::Stage("compile-flow"));
    let engine = Engine::locate()?;
    let kit: serde_json::Value =
        serde_json::from_slice(&fs::read(engine.packages.join("kit/package.json"))?)?;
    let kit_version = kit
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| FlowError::Invalid("kit version must be a string".into()))?;
    let base = compile_base(
        dir,
        &raw,
        &config,
        args.iter().any(|a| a == "--from-raw"),
        kit_version,
    )?;
    if base.is_some() {
        args.push("--compiled-flow".into());
    }
    on(BuildProgress::Stage("process"));
    let mut env = vec![
        (OsString::from("REPLICA_RAW"), raw.as_os_str().to_owned()),
        (
            OsString::from("SCENECAST_RUST_PUBLISH"),
            OsString::from("1"),
        ),
        (OsString::from("SCENECAST_RUST_ASSETS"), OsString::from("1")),
    ];
    if let Some(path) = &base {
        env.push((
            OsString::from("SCENECAST_FLOW_BASE"),
            path.as_os_str().to_owned(),
        ));
    }
    let mut publication_error = None;
    let mut asset_error = None;
    let mut resolver = None;
    let mut published = false;
    let mut control = |line: &str| {
        if let Some(request) = line.strip_prefix("SCENECAST_ASSET_V1 ") {
            #[derive(Deserialize)]
            struct Request {
                op: String,
                value: String,
                inline: Option<String>,
            }
            let response = (|| {
                let request: Request = serde_json::from_str(request)?;
                if resolver.is_none() {
                    resolver = Some(AssetResolver::new(&raw, &data.join(".next/assets"))?);
                }
                resolver.as_mut().expect("resolver initialized").resolve(
                    &request.op,
                    &request.value,
                    request.inline.as_deref(),
                )
            })();
            return Some(match response {
                Ok(result) => serde_json::to_string(&result).expect("resolution serializes"),
                Err(error) => {
                    let message = error.to_string();
                    asset_error = Some(error);
                    serde_json::json!({"error": message}).to_string()
                }
            });
        }
        let mode = match line {
            "SCENECAST_PUBLISH_V1" => PublishMode::Captures,
            "SCENECAST_PUBLISH_V2" => PublishMode::Assets,
            "SCENECAST_PUBLISH_V3" => PublishMode::AssetsAndPrune,
            _ => return None,
        };
        if published {
            return Some(
                serde_json::json!({"error": "capture output already published"}).to_string(),
            );
        }
        published = true;
        Some(match publish(&data, mode) {
            Ok(result) => serde_json::json!({
                "changed": result.changed, "files": result.files, "prunedAssets": result.pruned_assets
            }).to_string(),
            Err(error) => {
                let message = error.to_string();
                publication_error = Some(error);
                serde_json::json!({"error": message}).to_string()
            }
        })
    };
    let code = engine.run_with_progress_control(
        with_demo("build", &args, dir),
        env,
        |p| on(BuildProgress::Engine(p)),
        Some(&mut control),
    );
    drop(base);
    on(BuildProgress::Stage("scrub-built"));
    for path in [
        dir.join("data"),
        dir.join("recording.json"),
        dir.join("flow.json"),
    ] {
        if path.exists() {
            scrub_tree(&path, "built", &allowlist, true, &mut report)?;
        }
    }
    write_report(dir, &report)?;
    if let Some(error) = publication_error {
        return Err(error.into());
    }
    if let Some(error) = asset_error {
        return Err(error.into());
    }
    let code = code?;
    if report.has_credentials() {
        return Ok(BuildResult {
            exit_code: 1,
            credentials_in: Some("built"),
            scrub: report,
            sync: None,
        });
    }
    if code != 0 {
        return Ok(BuildResult {
            exit_code: code,
            credentials_in: None,
            scrub: report,
            sync: None,
        });
    }
    on(BuildProgress::Stage("sync"));
    let synced = sync_with_baseline(dir)?;
    let code = if synced.is_valid() { 0 } else { 1 };
    if code == 0
        && let Some(raw) = raw_hash
    {
        let output = fingerprint_tree(&data, |path| {
            on(BuildProgress::Fingerprint {
                tree: "output",
                path: path.to_owned(),
            })
        })?;
        fs::write(
            cache_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&BuildFingerprint {
                    raw,
                    output,
                    algorithm
                })?
            ),
        )?;
    }
    Ok(BuildResult {
        exit_code: code,
        credentials_in: None,
        scrub: report,
        sync: Some(synced),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_raw_scrub_failure_and_progress_before_running_engine() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let raw = dir.join("raw");
        fs::create_dir_all(&raw).unwrap();
        fs::write(dir.join("demo.json"), r#"{"name":"fixture"}"#).unwrap();
        fs::write(raw.join("capture.json"), r#"{"client_secret":"synthetic"}"#).unwrap();
        let mut events = Vec::new();
        let result = build_with_raw(dir, &[], Some(raw), |event| events.push(event)).unwrap();
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.credentials_in, Some("raw"));
        assert!(matches!(
            events.as_slice(),
            [BuildProgress::Stage("scrub-raw")]
        ));
        let report = fs::read_to_string(dir.join(".out/scrub.json")).unwrap();
        assert!(!report.contains("synthetic"));
        assert!(report.contains("credential"));
    }
}
