//! CSS selection for captured parts inserted into another page.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::{Captures, Regex};

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn isolated_class(value: &str, hover: bool) -> bool {
    static MERGE: OnceLock<Regex> = OnceLock::new();
    static REACT: OnceLock<Regex> = OnceLock::new();
    MERGE
        .get_or_init(|| Regex::new(r"^[A-Za-z][A-Za-z0-9]*-[0-9]+$").unwrap())
        .is_match(value)
        || hover
            && REACT
                .get_or_init(|| Regex::new(r"_r_[0-9a-z]+_").unwrap())
                .is_match(value)
}

/// Prefix capture-specific generated class names in an attribute value.
pub fn isolate_class_value(value: &str, prefix: &str, hover: bool) -> String {
    let mut result = String::new();
    for token in value.split_inclusive(js_whitespace) {
        let trimmed = token.trim_end_matches(js_whitespace);
        if isolated_class(trimmed, hover) {
            result.push_str(prefix);
        }
        result.push_str(token);
    }
    result
}

/// Isolate generated names in markup and matching inline style selectors.
pub fn isolate_classes(html: &str, prefix: &str, hover: bool) -> String {
    static ATTRIBUTE: OnceLock<Regex> = OnceLock::new();
    static STYLE: OnceLock<Regex> = OnceLock::new();
    static SELECTOR: OnceLock<Regex> = OnceLock::new();
    let attributes = ATTRIBUTE
        .get_or_init(|| Regex::new(r#"class="([^"]*)""#).unwrap())
        .replace_all(html, |captures: &Captures<'_>| {
            format!(
                "class=\"{}\"",
                isolate_class_value(&captures[1], prefix, hover)
            )
        });
    STYLE
        .get_or_init(|| Regex::new(r"(?s)(<style[^>]*>)(.*?)(</style>)").unwrap())
        .replace_all(&attributes, |captures: &Captures<'_>| {
            let css = SELECTOR
                .get_or_init(|| Regex::new(r"\.([A-Za-z0-9_-]+)").unwrap())
                .replace_all(&captures[2], |selector: &Captures<'_>| {
                    if isolated_class(&selector[1], hover) {
                        format!(".{prefix}{}", &selector[1])
                    } else {
                        selector[0].to_owned()
                    }
                });
            format!("{}{css}{}", &captures[1], &captures[3])
        })
        .into_owned()
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

/// Replace the element surrounding an anchor with a captured part.
pub fn compose(
    html: &str,
    anchor: &str,
    tag: &str,
    part: &str,
    css: &str,
) -> Result<Option<String>, String> {
    let Some(at) = html.find(anchor) else {
        return Ok(None);
    };
    let prefix = format!("<{tag}");
    let start_tag = Regex::new(r"^<([a-zA-Z0-9-]+)").expect("valid tag regex");
    let mut before = at;
    let mut include_at = true;
    let (start, end) = loop {
        let candidate = if include_at && html[at..].starts_with(&prefix) {
            Some(at)
        } else {
            html[..before].rfind(&prefix)
        };
        include_at = false;
        let Some(start) = candidate else {
            return Err(format!("compose: no <{tag}> around {anchor}"));
        };
        let slice = &html[start..];
        let Some(captures) = start_tag.captures(slice) else {
            if start == 0 {
                return Err(format!("compose: no <{tag}> around {anchor}"));
            }
            before = start;
            continue;
        };
        let actual = captures.get(1).expect("tag").as_str();
        let valid = slice[1 + actual.len()..]
            .chars()
            .next()
            .is_some_and(|c| c == '>' || js_whitespace(c));
        if valid && actual.len() <= tag.len() {
            let pattern = Regex::new(&format!(r"<(/?){}(?-u:\b)", regex::escape(actual)))
                .map_err(|error| error.to_string())?;
            let mut depth = 0_i64;
            let mut end = None;
            for matched in pattern.captures_iter(slice) {
                depth += if &matched[1] == "/" { -1 } else { 1 };
                if depth == 0 {
                    let offset = matched.get(0).expect("tag").start();
                    end = slice[offset..].find('>').map(|n| start + offset + n + 1);
                    break;
                }
            }
            let end = end.ok_or_else(|| format!("unbalanced {actual}"))?;
            if end > at {
                break (start, end);
            }
        }
        if start == 0 {
            return Err(format!("compose: no <{tag}> around {anchor}"));
        }
        before = start;
    };
    let mut out = format!("{}{}{}", &html[..start], part, &html[end..]);
    if !css.is_empty() && out.contains("</head>") {
        static STYLE_END: OnceLock<Regex> = OnceLock::new();
        let escaped = STYLE_END
            .get_or_init(|| Regex::new(r"(?i)</style").expect("valid style regex"))
            .replace_all(css, r"<\/style");
        out = out.replacen(
            "</head>",
            &format!(r#"<style data-d1-compose="">{escaped}</style></head>"#),
            1,
        );
    }
    Ok(Some(out))
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

    #[test]
    fn replaces_containing_element_and_escapes_style_end() {
        let html = "<head></head><body>😎<div><div>anchor</div></div></body>";
        let result = compose(html, "anchor", "div", "<p>new</p>", "x{content:'</STYLE'}")
            .unwrap()
            .unwrap();
        assert_eq!(
            result,
            "<head><style data-d1-compose=\"\">x{content:'<\\/style'}</style></head><body>😎<div><p>new</p></div></body>"
        );
        assert_eq!(compose(html, "missing", "div", "", "").unwrap(), None);
        assert!(compose("<div>anchor", "anchor", "div", "", "").is_err());
    }

    #[test]
    fn isolates_generated_class_names_without_touching_other_names() {
        let html = "<style>.root-123,.x_r_a_foo,.root-123-more{color:red}</style><div class=\"root-123 \u{feff}x_r_a_foo root-123-more\"></div>";
        assert_eq!(
            isolate_classes(html, "x-", true),
            "<style>.x-root-123,.x-x_r_a_foo,.root-123-more{color:red}</style><div class=\"x-root-123 \u{feff}x-x_r_a_foo root-123-more\"></div>"
        );
        assert!(!isolate_classes(html, "x-", false).contains("x-x_r_a_foo"));
    }
}
