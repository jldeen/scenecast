//! Resolve captured resources into content-addressed local assets.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{
    Engine as _, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::STANDARD},
};
use regex::{Captures, Regex};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum AssetError {
    #[error("asset I/O at {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid captured resource: {0}")]
    Invalid(&'static str),
    #[error("invalid captured URL")]
    Url(#[from] url::ParseError),
    #[error("invalid captured base64 data")]
    Base64(#[from] base64::DecodeError),
    #[error("invalid resource JSON")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Compose(String),
}

fn io(path: &Path, source: std::io::Error) -> AssetError {
    AssetError::Io {
        path: path.to_owned(),
        source,
    }
}

macro_rules! re {
    ($pattern:literal) => {{
        static REGEX: OnceLock<Regex> = OnceLock::new();
        REGEX.get_or_init(|| Regex::new($pattern).expect("valid asset regex"))
    }};
}

fn replace(
    text: &str,
    pattern: &Regex,
    mut replacement: impl FnMut(&Captures<'_>) -> Result<String, AssetError>,
) -> Result<String, AssetError> {
    let mut out = String::new();
    let mut end = 0;
    for caps in pattern.captures_iter(text) {
        let matched = caps.get(0).expect("whole match");
        out.push_str(&text[end..matched.start()]);
        out.push_str(&replacement(&caps)?);
        end = matched.end();
    }
    out.push_str(&text[end..]);
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct Resolution {
    pub value: Option<String>,
    pub used: Vec<String>,
    pub missing: Vec<(String, String)>,
}

/// A stylesheet or resource already resolved in this build, and what it reported missing on the way (replayed, so
/// the result is the same as resolving it again). Pages share most of their stylesheets: each is rewritten once.
#[derive(Clone)]
struct Memo {
    value: Option<String>,
    missing: Vec<(String, String, bool)>,
}

pub struct AssetResolver {
    raw: PathBuf,
    assets: PathBuf,
    index: Value,
    used: Vec<String>,
    used_set: HashSet<String>,
    missing: Vec<(String, String)>,
    stream: Option<crate::streams::StreamWriter>,
    css_memo: HashMap<(String, usize), Memo>,
    local_memo: HashMap<String, Memo>,
    /// A part's rules in a source page, by the two's SHA-256 (the same part goes into many pages).
    picks: HashMap<[u8; 32], Result<crate::compose::CssPick, &'static str>>,
    /// What's reported missing while a memoized value is worked out (one list per value in progress).
    logs: Vec<Vec<(String, String, bool)>>,
}

impl AssetResolver {
    pub fn new(raw: &Path, assets: &Path) -> Result<Self, AssetError> {
        let index = raw.join("urls.json");
        let json = fs::read(&index).map_err(|e| io(&index, e))?;
        fs::create_dir_all(assets).map_err(|e| io(assets, e))?;
        Ok(Self {
            raw: raw.to_owned(),
            assets: assets.to_owned(),
            index: serde_json::from_slice(&json)?,
            used: Vec::new(),
            used_set: HashSet::new(),
            missing: Vec::new(),
            stream: None,
            css_memo: HashMap::new(),
            local_memo: HashMap::new(),
            picks: HashMap::new(),
            logs: Vec::new(),
        })
    }

    fn replay(&mut self, memo: Memo) -> Option<String> {
        for (url, reason, limit) in &memo.missing {
            self.missing(url, reason, *limit);
        }
        memo.value
    }

    fn use_asset(&mut self, name: &str) {
        if self.used_set.insert(name.to_owned()) {
            self.used.push(name.to_owned());
        }
    }

    fn missing(&mut self, url: &str, reason: &str, limit: bool) {
        for log in &mut self.logs {
            log.push((url.to_owned(), reason.to_owned(), limit));
        }
        let key = url.split('?').next().unwrap_or(url);
        let key = if limit {
            key.chars().take(140).collect()
        } else {
            key.to_owned()
        };
        if let Some((_, value)) = self.missing.iter_mut().find(|(k, _)| k == &key) {
            *value = reason.to_owned();
        } else {
            self.missing.push((key, reason.to_owned()));
        }
    }

    fn asset(&mut self, bytes: &[u8], extension: &str) -> Result<String, AssetError> {
        let name = format!("{:x}", Sha256::digest(bytes));
        let name = format!("{}.{extension}", &name[..24]);
        let path = self.assets.join(&name);
        if !path.exists() {
            fs::write(&path, bytes).map_err(|e| io(&path, e))?;
        }
        self.use_asset(&name);
        Ok(format!("/assets/{name}"))
    }

    fn empty(&mut self) -> Result<String, AssetError> {
        let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")?;
        self.asset(&bytes, "png")
    }

    fn data(&mut self, input: &str) -> Result<Option<String>, AssetError> {
        let pattern = re!(r"(?s)^data:([^;,]*)(;base64)?,(.*)$");
        let Some(caps) = pattern.captures(input) else {
            return Ok(None);
        };
        let content = caps.get(3).expect("data payload").as_str();
        let bytes = if caps.get(2).is_some() {
            let mut input: String = content
                .chars()
                .take_while(|c| *c != '=')
                .filter_map(|c| match c {
                    'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
                    '-' => Some('+'),
                    '_' => Some('/'),
                    _ => None,
                })
                .collect();
            if input.len() % 4 == 1 {
                input.pop();
            }
            let engine = GeneralPurpose::new(
                &alphabet::STANDARD,
                GeneralPurposeConfig::new()
                    .with_decode_padding_mode(DecodePaddingMode::Indifferent)
                    .with_decode_allow_trailing_bits(true),
            );
            engine.decode(input)?
        } else {
            percent_decode(content)?
        };
        let extension = match &caps[1] {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/svg+xml" => "svg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "bin",
        };
        self.asset(&bytes, extension).map(Some)
    }

    fn blob(&self, url: &str) -> Result<Option<PathBuf>, AssetError> {
        let Some(name) = self
            .index
            .get(url)
            .and_then(|v| v.get("file"))
            .and_then(Value::as_str)
        else {
            return Ok(None);
        };
        if !re!(r"^[0-9a-f]{24}\.[a-z0-9]+$").is_match(name) {
            return Err(AssetError::Invalid("invalid captured blob filename"));
        }
        Ok(Some(self.raw.join("blobs").join(name)))
    }

    fn local(&mut self, url: &str, inline: Option<&str>) -> Result<String, AssetError> {
        if let Some(inline) = inline.filter(|v| !v.is_empty()) {
            return match self.data(inline)? {
                Some(asset) => Ok(asset),
                None => self.empty(),
            };
        }
        if let Some(memo) = self.local_memo.get(url).cloned() {
            return Ok(self.replay(memo).expect("a resolved resource"));
        }
        self.logs.push(Vec::new());
        let value = self.local_uncached(url);
        let missing = self.logs.pop().expect("log pushed");
        if let Ok(v) = &value {
            self.local_memo.insert(
                url.to_owned(),
                Memo {
                    value: Some(v.clone()),
                    missing,
                },
            );
        }
        value
    }

    fn local_uncached(&mut self, url: &str) -> Result<String, AssetError> {
        let Some(src) = self.blob(url)? else {
            let reason = self
                .index
                .get(url)
                .and_then(|v| v.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("not fetched")
                .to_owned();
            self.missing(url, &reason, true);
            return if re!(r"(?i)\.(woff2?|ttf|otf)(\?|$)").is_match(url) {
                Ok("/assets/missing.woff2".into())
            } else {
                self.empty()
            };
        };
        let name = src
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or(AssetError::Invalid("blob filename"))?
            .to_owned();
        if name.ends_with(".css") {
            let bytes = fs::read(&src).map_err(|e| io(&src, e))?;
            self.use_asset(&name);
            let text = String::from_utf8_lossy(&bytes);
            let css = self.rewrite_css(&text, url, 0)?;
            let css = drop_missing_fonts(&css);
            return self.asset(css.as_bytes(), "css");
        }
        // Only its start is read to tell a web page from an image or font; the file is copied as it is.
        let mut head = Vec::with_capacity(600);
        fs::File::open(&src)
            .and_then(|f| f.take(600).read_to_end(&mut head))
            .map_err(|e| io(&src, e))?;
        let prefix: String = head.iter().map(|&b| char::from(b)).collect();
        if re!(r"(?i)<(!doctype html|html[\s>])").is_match(&prefix) {
            self.missing(url, "answered with an HTML page", true);
            return if re!(r"(?i)\.(woff2?|ttf|otf|eot)(\?|$)").is_match(url) {
                Ok("/assets/missing.woff2".into())
            } else {
                self.empty()
            };
        }
        self.use_asset(&name);
        let dst = self.assets.join(&name);
        if !dst.exists() {
            fs::copy(&src, &dst).map_err(|e| io(&dst, e))?;
        }
        Ok(format!("/assets/{name}"))
    }

    fn css_file(&mut self, url: &str, depth: usize) -> Result<Option<String>, AssetError> {
        let key = (url.to_owned(), depth);
        if let Some(memo) = self.css_memo.get(&key).cloned() {
            return Ok(self.replay(memo));
        }
        self.logs.push(Vec::new());
        let value = self.css_file_uncached(url, depth);
        let missing = self.logs.pop().expect("log pushed");
        if let Ok(v) = &value {
            self.css_memo.insert(
                key,
                Memo {
                    value: v.clone(),
                    missing,
                },
            );
        }
        value
    }

    fn css_file_uncached(&mut self, url: &str, depth: usize) -> Result<Option<String>, AssetError> {
        let Some(src) = self.blob(url)? else {
            return Ok(None);
        };
        let bytes = fs::read(&src).map_err(|e| io(&src, e))?;
        self.rewrite_css(&String::from_utf8_lossy(&bytes), url, depth)
            .map(Some)
    }

    fn rewrite_css(&mut self, text: &str, base: &str, depth: usize) -> Result<String, AssetError> {
        let imports = re!(r#"@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*([^;]*);"#);
        let result = replace(text, imports, |c| {
            let url = Url::parse(base)?.join(&c[1])?;
            let nested = if depth < 4 {
                self.css_file(url.as_str(), depth + 1)?
            } else {
                None
            };
            Ok(match nested {
                Some(text) if !c[2].trim().is_empty() => {
                    format!("@media {}{{{text}}}", c[2].trim())
                }
                Some(text) => text,
                None => String::new(),
            })
        })?;
        let urls = re!(r#"url\(\s*("([^"]*)"|'([^']*)'|[^)]*)\s*\)"#);
        replace(&result, urls, |c| {
            let value = c
                .get(2)
                .or_else(|| c.get(3))
                .or_else(|| c.get(1))
                .expect("URL")
                .as_str()
                .trim();
            if value.is_empty() || re!(r"(?i)^(data:|#|/assets/)").is_match(value) {
                return Ok(c[0].to_owned());
            }
            let Ok(url) = Url::parse(base).and_then(|base| base.join(value)) else {
                return Ok(c[0].to_owned());
            };
            Ok(format!("url(\"{}\")", self.local(url.as_str(), None)?))
        })
    }

    fn rewrite_document(&mut self, snap: &str, input: &str) -> Result<String, AssetError> {
        let input: Value = serde_json::from_str(input)?;
        let doc = input
            .get("doc")
            .and_then(Value::as_object)
            .ok_or(AssetError::Invalid("missing captured document"))?;
        let html = doc
            .get("html")
            .and_then(Value::as_str)
            .ok_or(AssetError::Invalid("missing captured document HTML"))?;
        let urls = doc
            .get("urls")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let inline = doc.get("inline").and_then(Value::as_object);
        let keys = input
            .get("keys")
            .and_then(Value::as_array)
            .ok_or(AssetError::Invalid("missing captured frame keys"))?;
        let url = |index: &str| -> Result<&str, AssetError> {
            index
                .parse::<usize>()
                .ok()
                .and_then(|i| urls.get(i))
                .and_then(Value::as_str)
                .ok_or(AssetError::Invalid("invalid captured resource reference"))
        };
        let styles = re!(r#"<style([^>]*) data-d1-fetch="d1res://(\d+)"([^>]*)></style>"#);
        let html = replace(html, styles, |c| {
            let url = url(&c[2])?;
            let css = self.css_file(url, 0)?;
            if css.is_none() {
                self.missing(url, "stylesheet", false);
            }
            let css = re!(r"(?i)</style").replace_all(css.as_deref().unwrap_or(""), r"<\/style");
            Ok(format!("<style{}{}>{css}</style>", &c[1], &c[3]))
        })?;
        let imports = re!(r"/\* d1-import d1res://(\d+) \*/");
        let html = replace(&html, imports, |c| {
            Ok(self.css_file(url(&c[1])?, 0)?.unwrap_or_default())
        })?;
        let html = self.rewrite_resources(&html, urls, inline, true)?;
        let iframe = re!(r#"(<iframe\b[^>]*?)\s(?:sandbox|csp)="[^"]*""#);
        let html = iframe.replace_all(&html, "$1");
        let html = iframe.replace_all(&html, "$1");
        let frames = re!(r"d1frame://(f\d+)");
        let html = frames.replace_all(&html, |c: &Captures<'_>| {
            if keys.iter().any(|key| key.as_str() == Some(&c[1])) {
                format!("/snaps/{snap}.{}.html", &c[1])
            } else {
                "about:blank".to_owned()
            }
        });
        Ok(scrub(quiet(&drop_missing_fonts(&hide_head_frames(&html)))))
    }

    fn rewrite_resources(
        &mut self,
        html: &str,
        urls: &[Value],
        inline: Option<&Map<String, Value>>,
        canvases: bool,
    ) -> Result<String, AssetError> {
        let resources = re!(r"d1res://(\d+)");
        let html = replace(html, resources, |c| {
            let url = c[1]
                .parse::<usize>()
                .ok()
                .and_then(|i| urls.get(i))
                .and_then(Value::as_str)
                .ok_or(AssetError::Invalid("invalid captured resource reference"))?;
            let data = inline
                .and_then(|values| values.get(url))
                .and_then(Value::as_str);
            self.local(url, data)
        })?;
        if !canvases {
            return Ok(html);
        }
        let pattern = re!(r#"data-d1-canvas="(canvas\d+)""#);
        replace(&html, pattern, |c| {
            let data = inline
                .and_then(|values| values.get(&c[1]))
                .and_then(Value::as_str);
            let asset = match data.filter(|value| !value.is_empty()) {
                Some(data) => self.data(data)?.unwrap_or_else(|| "null".into()),
                None => String::new(),
            };
            Ok(format!("data-d1-canvas=\"{asset}\""))
        })
    }

    fn rewrite_fragment(&mut self, input: &str, canvases: bool) -> Result<String, AssetError> {
        let frame: Value = serde_json::from_str(input)?;
        let html = frame
            .get("html")
            .and_then(Value::as_str)
            .ok_or(AssetError::Invalid("missing stream frame HTML"))?;
        let urls = frame
            .get("urls")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let inline = frame.get("inline").and_then(Value::as_object);
        Ok(scrub(quiet(
            &self.rewrite_resources(html, urls, inline, canvases)?,
        )))
    }

    pub fn resolve(
        &mut self,
        op: &str,
        value: &str,
        inline: Option<&str>,
    ) -> Result<Resolution, AssetError> {
        self.missing.clear();
        let used_before = self.used.len();
        let value = match op {
            "local" => Some(self.local(value, inline)?),
            "data" => self.data(value)?,
            "css" => self.css_file(value, 0)?,
            "document" => Some(self.rewrite_document(
                value,
                inline.ok_or(AssetError::Invalid("missing captured document input"))?,
            )?),
            "frame" => Some(self.rewrite_fragment(value, true)?),
            "fragment" => Some(self.rewrite_fragment(value, false)?),
            "css-for" => {
                let [part, source, target]: [String; 3] = serde_json::from_str(value)?;
                let mut key = Sha256::new();
                key.update((part.len() as u64).to_le_bytes());
                key.update(&part);
                key.update(&source);
                let pick = self
                    .picks
                    .entry(key.finalize().into())
                    .or_insert_with(|| crate::compose::css_pick(&part, &source))
                    .clone()
                    .map_err(AssetError::Invalid)?;
                Some(pick.for_target(&target))
            }
            "compose" => {
                let [html, anchor, tag, part, css]: [String; 5] = serde_json::from_str(value)?;
                crate::compose::compose(&html, &anchor, &tag, &part, &css)
                    .map_err(AssetError::Compose)?
            }
            "isolate-classes" | "isolate-class-value" => {
                let (input, prefix, hover): (String, String, bool) = serde_json::from_str(value)?;
                Some(if op == "isolate-classes" {
                    crate::compose::isolate_classes(&input, &prefix, hover)
                } else {
                    crate::compose::isolate_class_value(&input, &prefix, hover)
                })
            }
            "filter-interaction-ops" => {
                let (ops, hover): (Vec<Value>, bool) = serde_json::from_str(value)?;
                Some(serde_json::to_string(
                    &crate::interactions::filter_ops(&ops, hover).map_err(AssetError::Invalid)?,
                )?)
            }
            "stream-begin" => {
                if self.stream.is_some() {
                    return Err(AssetError::Invalid("stream already open"));
                }
                let root = self
                    .assets
                    .parent()
                    .expect("staging asset parent")
                    .join("streams");
                self.stream = Some(
                    crate::streams::StreamWriter::new(&root, value.to_owned())
                        .map_err(AssetError::Compose)?,
                );
                None
            }
            "stream-frame" => {
                let frame: Value = serde_json::from_str(value)?;
                let root = self
                    .assets
                    .parent()
                    .expect("staging asset parent")
                    .join("streams");
                self.stream
                    .as_mut()
                    .ok_or(AssetError::Invalid("no stream open"))?
                    .push(&root, &frame)
                    .map_err(AssetError::Compose)?;
                None
            }
            "stream-end" => {
                let root = self
                    .assets
                    .parent()
                    .expect("staging asset parent")
                    .join("streams");
                let stream = self
                    .stream
                    .take()
                    .ok_or(AssetError::Invalid("no stream open"))?;
                Some(
                    stream
                        .finish(&root)
                        .map_err(AssetError::Compose)?
                        .to_string(),
                )
            }
            _ => return Err(AssetError::Invalid("unknown asset operation")),
        };
        Ok(Resolution {
            value,
            used: self.used[used_before..].to_vec(),
            missing: self.missing.clone(),
        })
    }
}

fn percent_decode(text: &str) -> Result<Vec<u8>, AssetError> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(AssetError::Invalid("malformed data URL"));
            }
            let digit = |b: u8| {
                (b as char)
                    .to_digit(16)
                    .ok_or(AssetError::Invalid("malformed data URL"))
            };
            out.push((digit(bytes[i + 1])? * 16 + digit(bytes[i + 2])?) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    std::str::from_utf8(&out).map_err(|_| AssetError::Invalid("invalid data URL UTF-8"))?;
    Ok(out)
}

// A frame a page keeps in its <head> (the admin center's chat client) never draws there, but loading the capture moves
// it into <body>, where it takes 154 px at the top of the page. Hidden, it stays out of the way, as on the real page.
fn hide_head_frames(html: &str) -> String {
    let Some(end) = html.find("</head>") else {
        return html.to_owned();
    };
    let head = re!(r"(?i)<iframe\b").replace_all(&html[..end], r#"<iframe style="display:none""#);
    format!("{head}{}", &html[end..])
}

fn quiet(text: &str) -> String {
    let text = re!(r"(-webkit-)?appearance:\s*slider-vertical\s*;?").replace_all(text, "");
    re!(r#"\sfocusgroup="[^"]*""#)
        .replace_all(&text, "")
        .into_owned()
}

fn scrub(text: String) -> String {
    let text = re!(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,})?")
        .replace_all(&text, "");
    let text = re!(r#"(?i)([?&;](?:access_token|id_token|token|sig|signature|code|skypetoken|authorization|auth|session_state|client_info|sv|se|sp|spr|srt|ss|st|skoid|sktid|skt|ske|sks|skv)=)[^&"'\s<>]*"#)
        .replace_all(&text, "$1");
    let text = re!(r"Bearer\s+[A-Za-z0-9._-]{20,}").replace_all(&text, "Bearer");
    // A do-nothing link the product writes as href="javascript:void(0)" (the admin center's account menu) is script
    // to the built-replica scan, which stops the build: it does nothing in the replica either, as "#".
    re!(r#"(?i)(\s(?:href|src|action|formaction|xlink:href)\s*=\s*)(["'])\s*javascript:[^"']*(["'])"#)
        .replace_all(&text, "${1}${2}#${3}")
        .into_owned()
}

fn drop_missing_fonts(text: &str) -> String {
    let pattern = re!(r"@font-face\s*\{[^}]*\}");
    pattern
        .replace_all(text, |c: &Captures<'_>| {
            let rule = &c[0];
            if !rule.contains("/assets/missing.woff2") {
                return rule.to_owned();
            }

            let fixed = re!(r#"url\("/assets/missing\.woff2"\)(\s*format\([^)]*\))?\s*,?\s*"#)
                .replace_all(rule, "");
            let fixed = re!(r",\s*;").replace_all(&fixed, ";");
            let fixed = re!(r"src:\s*,").replace_all(&fixed, "src: ");
            if re!(r"src:\s*(;|\})").is_match(&fixed) || !fixed.contains("url(") {
                String::new()
            } else {
                fixed.into_owned()
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_links_become_plain_links() {
        let html = r#"<a id="x" href="javascript:void(0)" class="m">Download</a><form action='javascript:go()'>"#;
        let out = scrub(html.to_owned());
        assert_eq!(
            out,
            r##"<a id="x" href="#" class="m">Download</a><form action='#'>"##
        );
        assert!(!crate::scrub::contains_script("html", &out));
    }

    #[test]
    fn removes_signed_parameters_and_bearer_values_from_capture_text() {
        let token = format!("?{}=value&x=1", "sig");
        let bearer = format!("Bearer {}", "a".repeat(20));
        assert_eq!(scrub(format!("{token} {bearer}")), "?sig=&x=1 Bearer");
    }

    #[test]
    fn a_frame_kept_in_the_head_is_hidden() {
        let temp = tempfile::tempdir().unwrap();
        let raw = temp.path().join("raw");
        fs::create_dir_all(&raw).unwrap();
        fs::write(raw.join("urls.json"), "{}").unwrap();
        let mut resolver = AssetResolver::new(&raw, &temp.path().join("assets")).unwrap();
        let input = serde_json::json!({
            "doc": {
                "html": "<html><head><style>a{}</style><iframe id=\"chat\" data-d1-frame=\"f3\" src=\"d1frame://f3\"></iframe></head><body><iframe data-d1-frame=\"f1\" src=\"d1frame://f1\"></iframe></body></html>",
                "urls": []
            },
            "keys": ["f1", "f3"]
        });
        let result = resolver
            .resolve("document", "s", Some(&input.to_string()))
            .unwrap();
        assert_eq!(
            result.value.as_deref(),
            Some(
                "<html><head><style>a{}</style><iframe style=\"display:none\" id=\"chat\" data-d1-frame=\"f3\" src=\"/snaps/s.f3.html\"></iframe></head><body><iframe data-d1-frame=\"f1\" src=\"/snaps/s.f1.html\"></iframe></body></html>"
            )
        );
    }

    #[test]
    fn fragments_leave_canvas_markers_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let raw = temp.path().join("raw");
        fs::create_dir_all(&raw).unwrap();
        fs::write(raw.join("urls.json"), "{}").unwrap();
        let mut resolver = AssetResolver::new(&raw, &temp.path().join("assets")).unwrap();
        let input = serde_json::json!({
            "html": "<canvas focusgroup=\"x\" data-d1-canvas=\"canvas1\"></canvas>",
            "urls": [],
            "inline": {"canvas1": "data:image/svg+xml,%3Csvg%3E"}
        });
        let result = resolver
            .resolve("fragment", &input.to_string(), None)
            .unwrap();
        assert_eq!(
            result.value.as_deref(),
            Some("<canvas data-d1-canvas=\"canvas1\"></canvas>")
        );
    }

    #[test]
    fn resolves_css_imports_and_local_resources() {
        let temp = tempfile::tempdir().unwrap();
        let raw = temp.path().join("raw");
        let assets = temp.path().join("assets");
        fs::create_dir_all(raw.join("blobs")).unwrap();
        let css = "aaaaaaaaaaaaaaaaaaaaaaaa.css";
        let nested = "bbbbbbbbbbbbbbbbbbbbbbbb.css";
        let image = "cccccccccccccccccccccccc.png";
        fs::write(
            raw.join("blobs").join(css),
            "@import \"nested.css\" screen; .a{background:url(img.png)}",
        )
        .unwrap();
        fs::write(
            raw.join("blobs").join(nested),
            ".b{background:url(img.png)}",
        )
        .unwrap();
        fs::write(raw.join("blobs").join(image), b"image").unwrap();
        fs::write(
            raw.join("urls.json"),
            serde_json::to_vec(&serde_json::json!({
                "https://example.test/a.css":{"file":css},
                "https://example.test/nested.css":{"file":nested},
                "https://example.test/img.png":{"file":image}
            }))
            .unwrap(),
        )
        .unwrap();
        let mut resolver = AssetResolver::new(&raw, &assets).unwrap();
        let result = resolver
            .resolve("css", "https://example.test/a.css", None)
            .unwrap();
        assert_eq!(
            result.value.unwrap(),
            format!(
                "@media screen{{.b{{background:url(\"/assets/{image}\")}}}} .a{{background:url(\"/assets/{image}\")}}"
            )
        );
        assert_eq!(fs::read(assets.join(image)).unwrap(), b"image");
        assert_eq!(result.used, vec![image]);
        assert!(result.missing.is_empty());
    }

    #[test]
    fn handles_inline_data_missing_fonts_and_html_responses() {
        let temp = tempfile::tempdir().unwrap();
        let raw = temp.path().join("raw");
        let assets = temp.path().join("assets");
        fs::create_dir_all(raw.join("blobs")).unwrap();
        let html = "aaaaaaaaaaaaaaaaaaaaaaaa.png";
        fs::write(raw.join("blobs").join(html), "<html>sign in</html>").unwrap();
        fs::write(
            raw.join("urls.json"),
            serde_json::to_vec(&serde_json::json!({
                "https://example.test/image.png":{"file":html}
            }))
            .unwrap(),
        )
        .unwrap();
        let mut resolver = AssetResolver::new(&raw, &assets).unwrap();
        let missing = resolver
            .resolve("local", "https://example.test/font.woff2?x=1", None)
            .unwrap();
        assert_eq!(missing.value.as_deref(), Some("/assets/missing.woff2"));
        let rejected = resolver
            .resolve("local", "https://example.test/image.png", None)
            .unwrap();
        assert_eq!(rejected.missing[0].1, "answered with an HTML page");
        let inline = resolver
            .resolve("data", "data:image/svg+xml,%3Csvg%3E", None)
            .unwrap();
        let name = inline
            .value
            .unwrap()
            .strip_prefix("/assets/")
            .unwrap()
            .to_owned();
        assert_eq!(fs::read(assets.join(name)).unwrap(), b"<svg>");
        let inline = resolver
            .resolve("data", "data:image/png;base64, YWJj-_", None)
            .unwrap();
        let name = inline
            .value
            .unwrap()
            .strip_prefix("/assets/")
            .unwrap()
            .to_owned();
        assert_eq!(fs::read(assets.join(name)).unwrap(), b"abc\xfb");
        assert_eq!(
            drop_missing_fonts("@font-face{src:url(\"/assets/missing.woff2\");}"),
            ""
        );
    }
}
