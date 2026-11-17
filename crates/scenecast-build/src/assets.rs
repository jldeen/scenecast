//! Resolve captured resources into content-addressed local assets.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{
    Engine as _, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::STANDARD},
};
use regex::{Captures, Regex};
use serde::Serialize;
use serde_json::Value;
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
    #[error("invalid resource index")]
    Json(#[from] serde_json::Error),
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

pub struct AssetResolver {
    raw: PathBuf,
    assets: PathBuf,
    index: Value,
    used: Vec<String>,
    used_set: HashSet<String>,
    missing: Vec<(String, String)>,
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
        })
    }

    fn use_asset(&mut self, name: &str) {
        if self.used_set.insert(name.to_owned()) {
            self.used.push(name.to_owned());
        }
    }

    fn missing(&mut self, url: &str, reason: &str, limit: bool) {
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
        let bytes = fs::read(&src).map_err(|e| io(&src, e))?;
        let prefix: String = bytes.iter().take(600).map(|&b| char::from(b)).collect();
        if !name.ends_with(".css") && re!(r"(?i)<(!doctype html|html[\s>])").is_match(&prefix) {
            self.missing(url, "answered with an HTML page", true);
            return if re!(r"(?i)\.(woff2?|ttf|otf|eot)(\?|$)").is_match(url) {
                Ok("/assets/missing.woff2".into())
            } else {
                self.empty()
            };
        }
        self.use_asset(&name);
        if name.ends_with(".css") {
            let text = String::from_utf8_lossy(&bytes);
            let css = self.rewrite_css(&text, url, 0)?;
            let css = drop_missing_fonts(&css);
            return self.asset(css.as_bytes(), "css");
        }
        let dst = self.assets.join(&name);
        if !dst.exists() {
            fs::write(&dst, bytes).map_err(|e| io(&dst, e))?;
        }
        Ok(format!("/assets/{name}"))
    }

    fn css_file(&mut self, url: &str, depth: usize) -> Result<Option<String>, AssetError> {
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
