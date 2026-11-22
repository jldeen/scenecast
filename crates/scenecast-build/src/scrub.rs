//! Detection and redaction of sensitive text in captured material.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::fingerprint::{FileHash, WalkError, sha256, walk};

/// What the scrub has already found in a file, by its content: the SHA-256 of its bytes with its extension, raw or
/// built, the allowlist and this scrubber's own source (so a change to any of them scans everything again). A raw
/// capture's findings are kept (kind and line only, never the text), since raw is only reported on. A built file is
/// kept only when it's clean: one with a finding is scanned and redacted every time. The cache is a text file, one
/// line per file content, written whole per line (a line cut short by a crash is ignored, never half-read).
/// `SCENECAST_SCRUB_CACHE=off` turns it off.
pub struct ScrubCache {
    path: Option<PathBuf>,
    salt: [u8; 32],
    known: HashMap<String, Vec<Finding>>,
    added: Vec<(String, Vec<Finding>)>,
    used: HashSet<String>,
    pub hits: usize,
    pub scanned: usize,
}

/// A cache file over this size is written again with only what the last build used.
const CACHE_COMPACT_BYTES: u64 = 4 << 20;

impl ScrubCache {
    /// The demo's cache (`.out/scrub-cache.txt`), or none when `SCENECAST_SCRUB_CACHE=off`.
    pub fn for_demo(dir: &Path, allowlist: &[String]) -> Option<Self> {
        if std::env::var_os("SCENECAST_SCRUB_CACHE").is_some_and(|v| v == "off") {
            return None;
        }
        Some(Self::at(
            Some(dir.join(".out").join("scrub-cache.txt")),
            allowlist,
        ))
    }

    /// A cache kept in `path` (`None`: in memory only).
    pub fn at(path: Option<PathBuf>, allowlist: &[String]) -> Self {
        let mut salt = Sha256::new();
        salt.update(include_bytes!("scrub.rs"));
        for a in allowlist {
            salt.update((a.len() as u64).to_le_bytes());
            salt.update(a.as_bytes());
        }
        let known = path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .map(|s| parse_cache(&s))
            .unwrap_or_default();
        Self {
            path,
            salt: salt.finalize().into(),
            known,
            added: Vec::new(),
            used: HashSet::new(),
            hits: 0,
            scanned: 0,
        }
    }

    fn key(&self, source: &str, ext: &str, content: &[u8; 32]) -> String {
        let mut h = Sha256::new();
        h.update(self.salt);
        h.update(source.as_bytes());
        h.update([0]);
        h.update(ext.to_ascii_lowercase().as_bytes());
        h.update([0]);
        h.update(content);
        format!("{:x}", h.finalize())
    }

    fn remember(&mut self, key: String, findings: Vec<Finding>) {
        self.used.insert(key.clone());
        if !self.known.contains_key(&key) {
            self.known.insert(key.clone(), findings.clone());
            self.added.push((key, findings));
        }
    }

    /// Writes what this build found that the cache didn't have.
    pub fn save(&mut self) -> std::io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if self.added.is_empty() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let big = fs::metadata(path).is_ok_and(|m| m.len() > CACHE_COMPACT_BYTES);
        if big {
            // Only what this build used: written aside, then put in place whole.
            let mut text = String::new();
            for (key, findings) in self.known.iter().filter(|(k, _)| self.used.contains(*k)) {
                text.push_str(&cache_line(key, findings));
            }
            let tmp = path.with_extension("txt.tmp");
            fs::write(&tmp, text)?;
            fs::rename(&tmp, path)?;
        } else {
            let mut text = String::new();
            for (key, findings) in &self.added {
                text.push_str(&cache_line(key, findings));
            }
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?
                .write_all(text.as_bytes())?;
        }
        self.added.clear();
        Ok(())
    }
}

fn cache_line(key: &str, findings: &[Finding]) -> String {
    let list: Vec<String> = findings
        .iter()
        .map(|f| format!("{},{},{}", f.kind, f.line, u8::from(f.credential)))
        .collect();
    format!("{key}\t{}\t{}\n", findings.len(), list.join(";"))
}

fn parse_cache(text: &str) -> HashMap<String, Vec<Finding>> {
    let kind_of = |k: &str| {
        rules()
            .iter()
            .map(|r| r.kind)
            .chain(["script"])
            .find(|x| *x == k)
    };
    let mut out = HashMap::new();
    'lines: for line in text.lines() {
        let mut parts = line.split('\t');
        let (Some(key), Some(Ok(count)), Some(list), None) = (
            parts.next(),
            parts.next().map(str::parse::<usize>),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let mut findings = Vec::new();
        for item in list.split(';').filter(|x| !x.is_empty()) {
            let mut fields = item.split(',');
            let (Some(kind), Some(Ok(line)), Some(cred @ ("0" | "1")), None) = (
                fields.next().and_then(kind_of),
                fields.next().map(str::parse::<usize>),
                fields.next(),
                fields.next(),
            ) else {
                continue 'lines;
            };
            findings.push(Finding {
                kind,
                line,
                credential: cred == "1",
            });
        }
        if findings.len() == count {
            out.insert(key.to_owned(), findings);
        }
    }
    out
}

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
    scrub_tree_cached(root, source, allowlist, redact, report, None).map(|_| ())
}

/// One file scanned (or found in the cache).
struct Scanned {
    file: String,
    findings: Vec<Finding>,
    hash: FileHash,
    key: Option<String>,
    /// Remember these findings for this content.
    keep: bool,
    hit: bool,
}

/// [`scrub_tree`], files read and scanned on several threads, skipping content the cache has already scanned.
/// Returns each file's hash as it is now (after any redaction), in the tree's order, for its fingerprint.
pub fn scrub_tree_cached(
    root: &Path,
    source: &'static str,
    allowlist: &[String],
    redact: bool,
    report: &mut ScrubReport,
    mut cache: Option<&mut ScrubCache>,
) -> Result<Vec<FileHash>, ScrubError> {
    let paths = walk(root).map_err(|e| match e {
        WalkError::Io(path, source) => io_error(&path, source),
        WalkError::Symlink(path) => ScrubError::Symlink(path),
    })?;
    let lookup = cache.as_deref();
    let scanned = crate::par::map(&paths, |path| {
        scan_file(root, path, source, allowlist, redact, lookup)
    });
    let mut hashes = Vec::with_capacity(scanned.len());
    for result in scanned {
        let s = result?;
        if let Some(c) = cache.as_deref_mut() {
            if s.hit {
                c.hits += 1;
            } else if s.key.is_some() {
                c.scanned += 1;
            }
            if let Some(key) = s.key.clone().filter(|_| s.keep) {
                c.remember(key, s.findings.clone());
            }
        }
        report
            .findings
            .extend(s.findings.into_iter().map(|finding| FileFinding {
                source,
                file: s.file.clone(),
                finding,
            }));
        hashes.push(s.hash);
    }
    Ok(hashes)
}

fn scan_file(
    root: &Path,
    path: &Path,
    source: &'static str,
    allowlist: &[String],
    redact: bool,
    cache: Option<&ScrubCache>,
) -> Result<Scanned, ScrubError> {
    let bytes = fs::read(path).map_err(|e| io_error(path, e))?;
    let relative = path.strip_prefix(root).expect("walk stays under root");
    let relative = if relative.as_os_str().is_empty() {
        Path::new(path.file_name().unwrap_or_default())
    } else {
        relative
    };
    let file = relative.to_string_lossy().replace('\\', "/");
    let mut hash = FileHash {
        name: file.clone(),
        len: bytes.len() as u64,
        sha256: sha256(&bytes),
    };
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    let text_capture = ["html", "htm", "svg", "json", "css", "js", "mjs"]
        .iter()
        .any(|candidate| ext.eq_ignore_ascii_case(candidate));
    let mut out = Scanned {
        file,
        findings: Vec::new(),
        hash: hash.clone(),
        key: None,
        keep: false,
        hit: false,
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return if text_capture {
            Err(ScrubError::InvalidText(path.to_path_buf()))
        } else {
            Ok(out)
        };
    };
    if text.contains('\0') {
        return if text_capture {
            Err(ScrubError::InvalidText(path.to_path_buf()))
        } else {
            Ok(out)
        };
    }
    if let Some(c) = cache {
        let key = c.key(source, ext, &hash.sha256);
        if let Some(found) = c.known.get(&key).filter(|f| f.is_empty() || !redact) {
            out.findings = found.clone();
            out.hit = true;
            out.keep = true;
            out.key = Some(key);
            return Ok(out);
        }
        out.key = Some(key);
    }
    let mut decoded_findings = Vec::new();
    let mut decoded = None;
    if ext.eq_ignore_ascii_case("json")
        && let Ok(mut json) = serde_json::from_str::<serde_json::Value>(text)
    {
        scrub_json_strings(&mut json, None, allowlist, &mut decoded_findings);
        decoded = Some(serde_json::to_string(&json).expect("JSON value serializes"));
    }
    let (mut scrubbed, mut findings) = scrub_text(decoded.as_deref().unwrap_or(text), allowlist);
    findings.extend(decoded_findings);
    if findings.is_empty() {
        scrubbed = text.to_owned();
    }
    if source == "built" && contains_script(ext, text) {
        findings.push(Finding {
            kind: "script",
            line: 0,
            credential: true,
        });
    }
    // Raw is only reported on, so its findings are kept; a built file only when clean (else it's redacted again).
    out.keep = findings.is_empty() || !redact;
    if redact && scrubbed != text {
        fs::write(path, &scrubbed).map_err(|e| io_error(path, e))?;
        hash.len = scrubbed.len() as u64;
        hash.sha256 = sha256(scrubbed.as_bytes());
        out.hash = hash;
    }
    out.findings = findings;
    Ok(out)
}

/// Captures scanned as they arrive (while recording), so the build after Stop finds them in the cache. Keeps what it
/// has seen by size and time; a file still being written (changed in the last second) waits for the next look. A file
/// it can't read yet is tried again next time. Never redacts: raw is only reported on.
pub struct Prescan {
    root: PathBuf,
    seen: HashMap<PathBuf, (u64, std::time::SystemTime)>,
}

/// What one look found.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PrescanReport {
    pub scanned: usize,
    pub from_cache: usize,
    pub credentials: usize,
}

impl Prescan {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            seen: HashMap::new(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Scans what's new under the root on `threads` threads, into the cache `open` gives (saved). Nothing new:
    /// nothing is opened.
    pub fn look(
        &mut self,
        open: impl FnOnce() -> Option<(Vec<String>, ScrubCache)>,
        threads: usize,
    ) -> PrescanReport {
        let Ok(paths) = walk(&self.root) else {
            return PrescanReport::default();
        };
        let settled = std::time::SystemTime::now() - std::time::Duration::from_secs(1);
        let new: Vec<(PathBuf, (u64, std::time::SystemTime))> = paths
            .into_iter()
            .filter_map(|p| {
                let m = fs::metadata(&p).ok()?;
                let stamp = (m.len(), m.modified().ok()?);
                (self.seen.get(&p) != Some(&stamp) && stamp.1 <= settled).then_some((p, stamp))
            })
            .collect();
        if new.is_empty() {
            return PrescanReport::default();
        }
        let Some((allowlist, mut cache)) = open() else {
            return PrescanReport::default();
        };
        let lookup = &cache;
        let root = self.root.clone();
        let results = crate::par::map_on(threads, &new, |(path, _)| {
            scan_file(&root, path, "raw", &allowlist, false, Some(lookup))
        });
        let mut report = PrescanReport::default();
        for ((path, stamp), result) in new.into_iter().zip(results) {
            let Ok(s) = result else { continue };
            if s.hit {
                report.from_cache += 1;
            } else if s.key.is_some() {
                report.scanned += 1;
            }
            report.credentials += s.findings.iter().filter(|f| f.credential).count();
            if let Some(key) = s.key {
                cache.remember(key, s.findings);
            }
            self.seen.insert(path, stamp);
        }
        let _ = cache.save();
        report
    }
}

fn scrub_json_strings(
    value: &mut serde_json::Value,
    key: Option<&str>,
    allowlist: &[String],
    findings: &mut Vec<Finding>,
) {
    match value {
        serde_json::Value::String(text) => {
            let prefix = key
                .filter(|key| credential_key(key))
                .map(|key| format!("{key}="))
                .unwrap_or_default();
            let input = format!("{prefix}{text}");
            let (output, mut found) = scrub_text(&input, allowlist);
            for finding in &mut found {
                finding.line = 0;
            }
            findings.extend(found);
            if output != input {
                *text = output.strip_prefix(&prefix).unwrap_or(&output).to_owned();
            }
        }
        serde_json::Value::Array(values) => {
            for item in values {
                scrub_json_strings(item, None, allowlist, findings);
            }
        }
        serde_json::Value::Object(values) => {
            for (key, item) in values {
                scrub_json_strings(item, Some(key), allowlist, findings);
            }
        }
        serde_json::Value::Number(_) | serde_json::Value::Bool(_) => {
            if let Some(key) = key.filter(|key| credential_key(key)) {
                let (_, mut found) = scrub_text(&format!("{key}={value}"), allowlist);
                if found.iter().any(|finding| finding.credential) {
                    for finding in &mut found {
                        finding.line = 0;
                    }
                    findings.extend(found);
                    *value = serde_json::Value::String("[REDACTED]".to_owned());
                }
            }
        }
        _ => {}
    }
}

fn credential_key(key: &str) -> bool {
    let input = format!("{key}=x");
    let pattern = &rules()
        .iter()
        .find(|rule| rule.kind == "credential")
        .expect("credential rule exists")
        .pattern;
    pattern
        .find(&input)
        .is_some_and(|matched| matched.start() == 0 && matched.end() == input.len())
}

pub(crate) fn contains_script(ext: &str, text: &str) -> bool {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    let pattern = SCRIPT.get_or_init(|| {
        Regex::new(
            r#"(?i)<script(?:\s|/|>)|<[a-z][^>]*\s+on[a-z0-9_-]+\s*=|<[a-z][^>]*\s+(?:href|src|action|formaction|xlink:href)\s*=\s*['"]?\s*javascript\s*:"#,
        )
        .unwrap()
    });
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
            ("bearer-token", r"(?i)\bbearer\s+[a-z0-9._~+/\-]+", true),
            ("credential", r#"(?i)\b(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|accountkey|sharedaccesskey|sharedaccesssignature|authorization|set-cookie|cookie)\b["'\\]*\s*[:=]\s*["'\\]*(?P<value>[a-z0-9%._~+/\-=]+)"#, true),
            ("sas-signature", r"(?i)[?&;](?:sig|signature)=(?P<value>[a-z0-9%._~+/\-=]+)", true),
            ("private-key", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----", true),
            ("github-token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b", true),
            ("aws-access-key", r"\bAKIA[0-9A-Z]{16}\b", true),
            ("email", r"(?i)\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b", false),
            ("tenant-id", r#"(?i)\b(?:tenant[_-]?id|tenantid|tid)\b[\s"'\\:=]+(?P<value>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b"#, false),
            ("tenant-id", r"(?i)\b(?:login\.microsoftonline\.com|login\.windows\.net)/(?P<value>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b", false),
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
        // Line numbers counted as the matches go (from the top for each match was quadratic on a big capture).
        let (mut line, mut counted) = (1, 0);
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
            line += current[counted..m.start()]
                .bytes()
                .filter(|b| *b == b'\n')
                .count();
            counted = m.start();
            findings.push(Finding {
                kind: rule.kind,
                line,
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
    fn the_cache_catches_the_same_planted_tokens_and_always_redacts_built_files() {
        // A planted token in a raw capture is reported whether it's scanned or remembered; a built file with one is
        // scanned and redacted every time; a clean file isn't scanned twice; a new file is always scanned.
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("t");
        fs::create_dir(&tree).unwrap();
        let token = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        fs::write(tree.join("clean.html"), "<p>hello</p>").unwrap();
        fs::write(tree.join("leak.html"), format!("<p>a\n{token}</p>")).unwrap();
        fs::write(
            tree.join("leak.json"),
            r#"{"client_secret":"abcdefghijklmnop12345"}"#,
        )
        .unwrap();
        let file = dir.path().join("cache.txt");
        let found = |report: &ScrubReport| {
            let mut v: Vec<_> = report
                .findings
                .iter()
                .map(|f| {
                    (
                        f.file.clone(),
                        f.finding.kind,
                        f.finding.line,
                        f.finding.credential,
                    )
                })
                .collect();
            v.sort();
            v
        };
        let mut uncached = ScrubReport::default();
        scrub_tree(&tree, "raw", &[], false, &mut uncached).unwrap();
        let mut c = ScrubCache::at(Some(file.clone()), &[]);
        let mut first = ScrubReport::default();
        scrub_tree_cached(&tree, "raw", &[], false, &mut first, Some(&mut c)).unwrap();
        c.save().unwrap();
        assert_eq!((c.hits, c.scanned), (0, 3));
        let mut c = ScrubCache::at(Some(file.clone()), &[]);
        let mut second = ScrubReport::default();
        scrub_tree_cached(&tree, "raw", &[], false, &mut second, Some(&mut c)).unwrap();
        assert_eq!(
            (c.hits, c.scanned),
            (3, 0),
            "raw: findings are remembered too"
        );
        assert_eq!(found(&uncached), found(&first));
        assert_eq!(found(&first), found(&second));
        assert_eq!(
            second
                .findings
                .iter()
                .filter(|f| f.finding.credential)
                .count(),
            2
        );
        // Another allowlist: scanned again.
        let mut c = ScrubCache::at(Some(file.clone()), &["x@example.test".into()]);
        scrub_tree_cached(
            &tree,
            "raw",
            &[],
            false,
            &mut ScrubReport::default(),
            Some(&mut c),
        )
        .unwrap();
        assert_eq!(c.hits, 0);
        // A new capture with a token, next to remembered ones: scanned.
        fs::write(tree.join("new.html"), format!("<i>{token}</i>")).unwrap();
        let mut c = ScrubCache::at(Some(file.clone()), &[]);
        let mut third = ScrubReport::default();
        scrub_tree_cached(&tree, "raw", &[], false, &mut third, Some(&mut c)).unwrap();
        assert_eq!((c.hits, c.scanned), (3, 1));
        assert!(
            third
                .findings
                .iter()
                .any(|f| f.file == "new.html" && f.finding.credential)
        );
        // Built: the clean file from the cache once known, the leaks redacted every time.
        let mut c = ScrubCache::at(Some(file.clone()), &[]);
        let mut built = ScrubReport::default();
        let hashes =
            scrub_tree_cached(&tree, "built", &[], true, &mut built, Some(&mut c)).unwrap();
        c.save().unwrap();
        assert!(
            !fs::read_to_string(tree.join("leak.html"))
                .unwrap()
                .contains(&token)
        );
        assert!(built.has_credentials());
        let leak = hashes.iter().find(|h| h.name == "leak.html").unwrap();
        assert_eq!(
            leak.sha256,
            sha256(&fs::read(tree.join("leak.html")).unwrap()),
            "hash after redaction"
        );
        fs::write(tree.join("leak.html"), format!("<p>{token}</p>")).unwrap();
        let mut c = ScrubCache::at(Some(file.clone()), &[]);
        let mut again = ScrubReport::default();
        scrub_tree_cached(&tree, "built", &[], true, &mut again, Some(&mut c)).unwrap();
        assert!(
            !fs::read_to_string(tree.join("leak.html"))
                .unwrap()
                .contains(&token)
        );
        assert!(
            again
                .findings
                .iter()
                .any(|f| f.file == "leak.html" && f.finding.credential)
        );
        assert!(c.hits >= 1, "the clean file came from the cache");
    }

    #[test]
    fn captures_scanned_as_they_arrive_are_not_scanned_again_at_build() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw");
        fs::create_dir_all(raw.join("snaps")).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(5);
        let put = |name: &str, text: &str, settled: bool| {
            let path = raw.join(name);
            fs::write(&path, text).unwrap();
            if settled {
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(old)
                    .unwrap();
            }
        };
        let token = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        put("snaps/a.json", r#"{"html":"<p>a</p>"}"#, true);
        put("snaps/b.json", &format!(r#"{{"html":"{token}"}}"#), true);
        put("snaps/c.json", r#"{"html":"<p>still being writ"#, false);
        let cache_file = dir.path().join(".out/scrub-cache.txt");
        let open = || Some((vec![], ScrubCache::at(Some(cache_file.clone()), &[])));
        let mut scan = Prescan::new(&raw);
        let first = scan.look(open, 2);
        assert_eq!(
            (first.scanned, first.credentials),
            (2, 1),
            "c.json isn't settled yet"
        );
        assert_eq!(scan.look(open, 2), PrescanReport::default(), "nothing new");
        put("snaps/c.json", r#"{"html":"<p>c</p>"}"#, true);
        assert_eq!(scan.look(open, 2).scanned, 1);
        // The build: every capture from the cache, the planted token still reported.
        let mut cache = ScrubCache::at(Some(cache_file.clone()), &[]);
        let mut report = ScrubReport::default();
        scrub_tree_cached(&raw, "raw", &[], false, &mut report, Some(&mut cache)).unwrap();
        assert_eq!((cache.hits, cache.scanned), (3, 0));
        assert!(report.has_credentials());
        let mut uncached = ScrubReport::default();
        scrub_tree(&raw, "raw", &[], false, &mut uncached).unwrap();
        assert_eq!(report.findings.len(), uncached.findings.len());
    }

    #[test]
    fn a_cache_line_cut_short_is_ignored() {
        let key = "a".repeat(64);
        let whole = cache_line(
            &key,
            &[
                Finding {
                    kind: "email",
                    line: 3,
                    credential: false,
                },
                Finding {
                    kind: "jwt",
                    line: 0,
                    credential: true,
                },
            ],
        );
        assert_eq!(parse_cache(&whole)[&key].len(), 2);
        let cut = &whole[..whole.find(';').unwrap()];
        assert!(parse_cache(cut).is_empty(), "{cut}");
        assert!(parse_cache(&whole[..40]).is_empty());
    }

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
            "token=abc".to_owned(),
            "SharedAccessKey=x".to_owned(),
            "Bearer abc".to_owned(),
            format!("https://example.test/?{}={}", "sig", "abcdefghijklmnop"),
            "AccountKey=abcdefghijklmnop12345".to_owned(),
        ] {
            let (_, findings) = scrub_text(&value, &[]);
            assert!(findings.iter().any(|f| f.credential), "{value}");
        }
    }

    #[test]
    fn redacts_tenant_id_in_identity_urls_and_honors_allowlist() {
        let id = "12345678-1234-1234-1234-123456789abc";
        let input = format!("https://login.microsoftonline.com/{id}/oauth2");
        let (output, findings) = scrub_text(&input, &[]);
        assert!(!output.contains(id));
        assert!(
            findings
                .iter()
                .any(|f| f.kind == "tenant-id" && !f.credential)
        );
        assert_eq!(scrub_text(&input, &[id.into()]).0, input);
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

    #[test]
    fn detects_inline_event_handlers_and_script_urls_in_captures() {
        for html in [
            r#"<img src="local.png" onerror="run()">"#,
            r#"<a href="javascript:run()">link</a>"#,
            r#"<svg><a xlink:href='JaVaScRiPt:run()'></a></svg>"#,
        ] {
            assert!(contains_script("html", html), "{html}");
            let json = serde_json::json!({ "html": html }).to_string();
            assert!(contains_script("json", &json), "{json}");
        }
        assert!(!contains_script("html", "<p>Use the onclick event.</p>"));
    }

    #[test]
    fn detects_and_redacts_escaped_json_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("capture.json");
        fs::write(
            &path,
            r#"{"client_secr\u0065t":"synthetic","person":"pers\u006fn@example.test"}"#,
        )
        .unwrap();
        let mut report = ScrubReport::default();
        scrub_tree(dir.path(), "raw", &[], false, &mut report).unwrap();
        assert!(report.has_credentials());
        assert!(credential_key("client_secret"));
        assert!(!credential_key("Bearer token"));
        assert!(report.findings.iter().any(|f| f.finding.kind == "email"));
        let mut report = ScrubReport::default();
        scrub_tree(dir.path(), "built", &[], true, &mut report).unwrap();
        let result: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(result["client_secret"], "[REDACTED]");
        assert_eq!(result["person"], "[REDACTED]");
        assert!(report.has_credentials());

        fs::write(
            dir.path().join("allowlisted.json"),
            r#"{"person":"pers\u006fn@example.test","tok\u0065n":12345}"#,
        )
        .unwrap();
        let mut report = ScrubReport::default();
        scrub_tree(
            dir.path(),
            "built",
            &["person@example.test".to_owned()],
            true,
            &mut report,
        )
        .unwrap();
        let result: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("allowlisted.json")).unwrap())
                .unwrap();
        assert_eq!(result["person"], "person@example.test");
        assert_eq!(result["token"], "[REDACTED]");
        assert!(report.has_credentials());
    }
}
