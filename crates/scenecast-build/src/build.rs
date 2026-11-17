//! Build orchestration and structured progress for CLI and desktop callers.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::engine::{Engine, EngineError, Progress, with_demo};
use crate::fingerprint::{FingerprintError, fingerprint_tree};
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
    #[error("cannot resolve raw capture folder: HOME and USERPROFILE are unset")]
    MissingHome,
    #[error("raw capture folder is not UTF-8")]
    NonUtf8Raw,
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
    let unchanged = previous.as_ref().is_some_and(|p| {
        raw_hash.as_ref() == Some(&p.raw) && output_hash.as_ref() == Some(&p.output)
    });
    let mut args = args.to_vec();
    if !unchanged && !args.iter().any(|a| a == "--force") {
        args.push("--force".into());
    }
    on(BuildProgress::Stage("process"));
    let engine = Engine::locate()?;
    let code = engine.run_with_progress_env(
        with_demo("build", &args, dir),
        [("REPLICA_RAW", raw.as_os_str())],
        |p| on(BuildProgress::Engine(p)),
    )?;
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
                serde_json::to_string_pretty(&BuildFingerprint { raw, output })?
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
