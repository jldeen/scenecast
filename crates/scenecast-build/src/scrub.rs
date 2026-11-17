//! Detection and redaction of sensitive text in captured material.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Finding {
    pub kind: &'static str,
    pub line: usize,
    pub credential: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileFinding {
    pub source: &'static str,
    pub file: String,
    #[serde(flatten)]
    pub finding: Finding,
}

#[derive(Debug, Default, Serialize)]
pub struct ScrubReport {
    pub findings: Vec<FileFinding>,
}

impl ScrubReport {
    pub fn has_credentials(&self) -> bool {
        self.findings.iter().any(|f| f.finding.credential)
    }
}

#[derive(Debug, Error)]
pub enum ScrubError {
    #[error("scrub: {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("scrub: symbolic link not allowed: {0}")]
    Symlink(PathBuf),
    #[error("scrub: capture text is not valid UTF-8: {0}")]
    InvalidText(PathBuf),
}

fn io_error(path: &Path, source: std::io::Error) -> ScrubError {
    ScrubError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Inspect text in a tree, optionally replacing sensitive text in place.
/// Binary files are left untouched; symlinks are rejected rather than followed.
pub fn scrub_tree(
    root: &Path,
    source: &'static str,
    allowlist: &[String],
    redact: bool,
    report: &mut ScrubReport,
) -> Result<(), ScrubError> {
    fn walk(
        root: &Path,
        path: &Path,
        source: &'static str,
        allowlist: &[String],
        redact: bool,
        report: &mut ScrubReport,
    ) -> Result<(), ScrubError> {
        let metadata = fs::symlink_metadata(path).map_err(|e| io_error(path, e))?;
        if metadata.file_type().is_symlink() {
            return Err(ScrubError::Symlink(path.to_path_buf()));
        }
        if metadata.is_dir() {
            let mut entries = fs::read_dir(path)
                .map_err(|e| io_error(path, e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| io_error(path, e))?;
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                walk(root, &entry.path(), source, allowlist, redact, report)?;
            }
        } else if metadata.is_file() {
            let bytes = fs::read(path).map_err(|e| io_error(path, e))?;
            let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
            let text_capture = ["html", "htm", "svg", "json", "css", "js", "mjs"]
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate));
            let Ok(text) = std::str::from_utf8(&bytes) else {
                return if text_capture {
                    Err(ScrubError::InvalidText(path.to_path_buf()))
                } else {
                    Ok(())
                };
            };
            if text.contains('\0') {
                return if text_capture {
                    Err(ScrubError::InvalidText(path.to_path_buf()))
                } else {
                    Ok(())
                };
            }
            let (scrubbed, mut findings) = scrub_text(text, allowlist);
            if source == "built" && contains_script(ext, text) {
                findings.push(Finding {
                    kind: "script",
                    line: 0,
                    credential: true,
                });
            }
            let relative = path.strip_prefix(root).expect("walk stays under root");
            let relative = if relative.as_os_str().is_empty() {
                Path::new(path.file_name().unwrap_or_default())
            } else {
                relative
            };
            let file = relative.to_string_lossy().replace('\\', "/");
            report
                .findings
                .extend(findings.into_iter().map(|finding| FileFinding {
                    source,
                    file: file.clone(),
                    finding,
                }));
            if redact && scrubbed != text {
                fs::write(path, scrubbed).map_err(|e| io_error(path, e))?;
            }
        }
        Ok(())
    }
    walk(root, root, source, allowlist, redact, report)
}

fn contains_script(ext: &str, text: &str) -> bool {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    let pattern = SCRIPT.get_or_init(|| Regex::new(r"(?i)<script(?:\s|/|>)").unwrap());
    if ext.eq_ignore_ascii_case("js") || ext.eq_ignore_ascii_case("mjs") || pattern.is_match(text) {
        return true;
    }
    fn strings_contain_script(value: &serde_json::Value, pattern: &Regex) -> bool {
        match value {
            serde_json::Value::String(value) => pattern.is_match(value),
            serde_json::Value::Array(values) => {
                values.iter().any(|v| strings_contain_script(v, pattern))
            }
            serde_json::Value::Object(values) => {
                values.values().any(|v| strings_contain_script(v, pattern))
            }
            _ => false,
        }
    }
    ext.eq_ignore_ascii_case("json")
        && serde_json::from_str(text).is_ok_and(|value| strings_contain_script(&value, pattern))
}

struct Rule {
    kind: &'static str,
    pattern: Regex,
    credential: bool,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            ("jwt", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b", true),
            ("bearer-token", r"(?i)\bbearer\s+[a-z0-9._~+/\-]{16,}", true),
            ("credential", r#"(?i)\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|accountkey|sharedaccesssignature|authorization|set-cookie|cookie)\b["'\\]*\s*[:=]\s*["'\\]*(?P<value>[a-z0-9%._~+/\-=]+)"#, true),
            ("sas-signature", r"(?i)[?&;](?:sig|signature)=(?P<value>[a-z0-9%._~+/\-=]+)", true),
            ("private-key", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----", true),
            ("github-token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b", true),
            ("aws-access-key", r"\bAKIA[0-9A-Z]{16}\b", true),
            ("email", r"(?i)\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b", false),
            ("tenant-id", r#"(?i)\b(?:tenant[_-]?id|tenantid|tid)\b[\s"'\\:=]+(?P<value>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b"#, false),
        ]
        .into_iter()
        .map(|(kind, pattern, credential)| Rule {
            kind,
            pattern: Regex::new(pattern).expect("static scrub pattern"),
            credential,
        })
        .collect()
    })
}

/// Redacts detected text. Allowlisted values apply to PII only, never credentials.
/// Findings deliberately contain neither the matched value nor a preview.
pub fn scrub_text(text: &str, allowlist: &[String]) -> (String, Vec<Finding>) {
    let mut output = text.to_owned();
    let mut findings = Vec::new();
    for rule in rules() {
        let current = output.clone();
        let mut next = String::with_capacity(current.len());
        let mut start = 0;
        for captures in rule.pattern.captures_iter(&current) {
            let m = captures
                .name("value")
                .unwrap_or_else(|| captures.get(0).unwrap());
            if !rule.credential
                && allowlist
                    .iter()
                    .any(|value| m.as_str().eq_ignore_ascii_case(value))
            {
                continue;
            }
            next.push_str(&current[start..m.start()]);
            next.push_str("[REDACTED]");
            start = m.end();
            findings.push(Finding {
                kind: rule.kind,
                line: current[..m.start()].bytes().filter(|b| *b == b'\n').count() + 1,
                credential: rule.credential,
            });
        }
        next.push_str(&current[start..]);
        output = next;
    }
    (output, findings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_sensitive_values_without_reporting_them() {
        let text = concat!(
            "email: person@example.test\n",
            "client_secret=abcdefghijklmnop12345\n",
            "tenant_id=12345678-1234-1234-1234-123456789abc"
        );
        let (output, findings) = scrub_text(text, &[]);
        assert_eq!(findings.len(), 3);
        assert!(
            findings
                .iter()
                .any(|f| f.kind == "credential" && f.credential)
        );
        assert!(!output.contains("person@example.test"));
        assert!(!output.contains("abcdefghijklmnop12345"));
        assert!(!output.contains("12345678-1234"));
        assert!(
            !serde_json::to_string(&findings)
                .unwrap()
                .contains("abcdefghijklmnop12345")
        );
    }

    #[test]
    fn allowlist_never_allows_credentials() {
        let input = "person@example.test client_secret=abcdefghijklmnop12345";
        let (output, findings) = scrub_text(
            input,
            &[
                "person@example.test".into(),
                "client_secret=abcdefghijklmnop12345".into(),
            ],
        );
        assert!(output.contains("person@example.test"));
        assert!(!output.contains("abcdefghijklmnop12345"));
        assert_eq!(findings.len(), 1);
        assert!(findings[0].credential);
    }

    #[test]
    fn catches_cookie_sas_and_connection_key_without_flagging_cookie_prose() {
        let (_, prose) = scrub_text("A cookie preference controls this banner.", &[]);
        assert!(prose.is_empty());
        for value in [
            "Cookie: session=abcdefghijklmnop".to_owned(),
            "Cookie: a=1".to_owned(),
            "client_secret=x".to_owned(),
            "Authorization: Basic eA==".to_owned(),
            format!("https://example.test/?{}={}", "sig", "abcdefghijklmnop"),
            "AccountKey=abcdefghijklmnop12345".to_owned(),
        ] {
            let (_, findings) = scrub_text(&value, &[]);
            assert!(findings.iter().any(|f| f.credential), "{value}");
        }
    }

    #[test]
    fn tree_report_flags_credentials_and_scripts_and_redacts_pii() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("page.html"),
            "<p>person@example.test</p><script>doSomething()</script>",
        )
        .unwrap();
        fs::write(
            dir.path().join("capture.json"),
            r#"{"client_secret":"abcdefghijklmnop12345"}"#,
        )
        .unwrap();
        let mut report = ScrubReport::default();
        scrub_tree(dir.path(), "built", &[], true, &mut report).unwrap();
        assert!(report.has_credentials());
        assert!(report.findings.iter().any(|f| f.finding.kind == "script"));
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.finding.kind == "credential")
        );
        assert!(
            !fs::read_to_string(dir.path().join("page.html"))
                .unwrap()
                .contains("person@example.test")
        );
        let json = fs::read_to_string(dir.path().join("capture.json")).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&json).is_ok());
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("abcdefghijklmnop12345")
        );
    }

    #[test]
    fn detects_scripts_in_svg_and_json_and_rejects_invalid_capture_text() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("page.svg"), "<svg><script/></svg>").unwrap();
        fs::write(
            dir.path().join("capture.json"),
            r#"{"html":"\u003cscript\u003ealert(1)\u003c/script\u003e"}"#,
        )
        .unwrap();
        let mut report = ScrubReport::default();
        scrub_tree(dir.path(), "built", &[], false, &mut report).unwrap();
        assert_eq!(
            report
                .findings
                .iter()
                .filter(|f| f.finding.kind == "script")
                .count(),
            2
        );
        fs::write(dir.path().join("bad.html"), [0xff]).unwrap();
        assert!(matches!(
            scrub_tree(dir.path(), "built", &[], false, &mut report),
            Err(ScrubError::InvalidText(_))
        ));
    }
}
