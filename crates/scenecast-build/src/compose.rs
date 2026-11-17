//! CSS selection for captured parts inserted into another page.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn blocks(css: &str) -> Vec<&str> {
    let bytes = css.as_bytes();
    let mut result = Vec::new();
    let (mut depth, mut start, mut i) = (0_i64, 0, 0);
    let mut quote = None;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 1;
            } else if c == q {
                quote = None;
            }
        } else if c == b'"' || c == b'\'' {
            quote = Some(c);
        } else if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth == 0 {
                result.push(css[start..i + 1].trim_matches(js_whitespace));
                start = i + 1;
            }
        }
        i += 1;
    }
    result
}

fn style_blocks(html: &str) -> impl Iterator<Item = &str> {
    static STYLE: OnceLock<Regex> = OnceLock::new();
    STYLE
        .get_or_init(|| Regex::new(r"(?s)<style[^>]*>(.*?)</style>").unwrap())
        .captures_iter(html)
        .flat_map(|captures| blocks(captures.get(1).expect("style content").as_str()))
}

fn selector_uses(selector: &str, classes: &HashSet<&str>) -> bool {
    static CLASS: OnceLock<Regex> = OnceLock::new();
    CLASS
        .get_or_init(|| Regex::new(r"\.([A-Za-z0-9_-]+)").unwrap())
        .captures_iter(selector)
        .any(|capture| classes.contains(capture.get(1).expect("class").as_str()))
}

fn head(block: &str) -> &str {
    block.split_once('{').map_or(block, |(head, _)| head)
}

fn picked(block: &str, classes: &HashSet<&str>) -> Option<String> {
    let selector = head(block);
    if ["@media", "@supports", "@layer", "@container"]
        .iter()
        .any(|prefix| selector.starts_with(prefix))
    {
        let start = block.find('{')? + 1;
        let end = block.len().checked_sub(1)?;
        let inner: Vec<_> = blocks(&block[start..end])
            .into_iter()
            .filter(|rule| selector_uses(head(rule), classes))
            .collect();
        return (!inner.is_empty()).then(|| format!("{selector}{{{}}}", inner.join("\n")));
    }
    if selector.starts_with('@') || !selector_uses(selector, classes) {
        None
    } else {
        Some(block.to_owned())
    }
}

/// Return rules required by `part` that are present in `source` but absent in `target`.
pub fn css_for(part: &str, source: &str, target: &str) -> Result<String, &'static str> {
    static ATTRIBUTE: OnceLock<Regex> = OnceLock::new();
    let classes: HashSet<_> = ATTRIBUTE
        .get_or_init(|| Regex::new(r#"class="([^"]*)""#).unwrap())
        .captures_iter(part)
        .flat_map(|capture| {
            capture
                .get(1)
                .expect("class attribute")
                .as_str()
                .split(js_whitespace)
                .filter(|class| !class.is_empty())
        })
        .collect();
    let have: HashSet<_> = style_blocks(target).collect();
    let mut keep = Vec::new();
    let mut seen = HashSet::new();
    let mut frames = Vec::new();
    let mut seen_frames = HashSet::new();
    for block in style_blocks(source) {
        if block.starts_with("@keyframes") {
            if seen_frames.insert(block) {
                frames.push(block);
            }
            continue;
        }
        if let Some(rule) = picked(block, &classes)
            && !have.contains(rule.as_str())
            && seen.insert(rule.clone())
        {
            keep.push(rule);
        }
    }
    let text = keep.join("\n");
    static NAME: OnceLock<Regex> = OnceLock::new();
    let names = NAME.get_or_init(|| Regex::new(r"^@keyframes[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+([^\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}{]+)").unwrap());
    for frame in frames {
        let name = names
            .captures(frame)
            .and_then(|capture| capture.get(1))
            .ok_or("invalid keyframes rule")?;
        if text.contains(name.as_str()) && !have.contains(frame) && seen.insert(frame.to_owned()) {
            keep.push(frame.to_owned());
        }
    }
    Ok(keep.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_matching_rules_wrappers_and_used_keyframes() {
        let part = r#"<div class="button icon"></div>"#;
        let source = r#"<style>.button { animation: spin 1s; content: "}"; }.other{color:red}
@media screen{.icon{color:blue}.other{color:green}}
@keyframes spin{from{opacity:0}to{opacity:1}} @keyframes unused{from{opacity:0}}</style>"#;
        let target = "<style>.button { animation: spin 1s; content: \"}\"; }</style>";
        assert_eq!(
            css_for(part, source, target).unwrap(),
            "@media screen{.icon{color:blue}}"
        );
        assert!(
            css_for(part, source, "")
                .unwrap()
                .contains("@keyframes spin")
        );
        assert!(
            !css_for(part, source, "")
                .unwrap()
                .contains("@keyframes unused")
        );
        assert!(css_for(part, "<style>@keyframes{}</style>", "").is_err());
    }
}
