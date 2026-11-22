//! Filter non-visual changes from captured hover and click operations.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

fn visible_style(value: Option<&Value>) -> Result<String, &'static str> {
    let style = match value {
        None | Some(Value::Null) => "",
        Some(Value::String(value)) => value,
        _ => return Err("invalid interaction style"),
    };
    static BOOKKEEPING: OnceLock<Regex> = OnceLock::new();
    let bookkeeping = BOOKKEEPING
        .get_or_init(|| Regex::new(r"^(anchor-name|--[A-Za-z0-9_-]+)[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*:").unwrap());
    let mut declarations: Vec<_> = style
        .split(';')
        .map(|value| value.trim_matches(crate::compose::js_whitespace))
        .filter(|value| !value.is_empty() && !bookkeeping.is_match(value))
        .collect();
    declarations.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(declarations.join(";"))
}

/// Keep operations that can produce a visible change.
pub fn filter_ops(ops: &[Value], hover: bool) -> Result<Vec<Value>, &'static str> {
    let mut kept = Vec::new();
    for op in ops {
        let kind = op.get("kind").and_then(Value::as_str);
        if kind == Some("remove")
            && op.get("restTag").and_then(Value::as_str) != Some("#text")
            && !op.get("restText").is_some_and(|text| match text {
                Value::Null | Value::Bool(false) => false,
                Value::String(value) => !value.is_empty(),
                Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
                _ => true,
            })
        {
            continue;
        }
        if kind == Some("attr") {
            let set = op
                .get("set")
                .and_then(Value::as_object)
                .ok_or("missing interaction attributes")?;
            if set.keys().all(|key| key == "style") {
                let before = op.get("was").and_then(|v| v.get("style"));
                if visible_style(set.get("style"))? == visible_style(before)? {
                    continue;
                }
                let tag = op.get("tag").and_then(Value::as_str).unwrap_or("");
                let svg = ["g", "svg", "path", "circle", "rect"];
                let extra = [
                    "ellipse",
                    "line",
                    "polygon",
                    "polyline",
                    "stop",
                    "lineargradient",
                    "radialgradient",
                ];
                if svg.iter().any(|name| tag.eq_ignore_ascii_case(name))
                    || hover && extra.iter().any(|name| tag.eq_ignore_ascii_case(name))
                {
                    continue;
                }
            }
        }
        kept.push(op.clone());
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_visible_changes_and_drops_bookkeeping() {
        let ops = json!([
            {"kind":"remove", "restTag":"span", "restText":""},
            {"kind":"remove", "restTag":"#text", "restText":""},
            {"kind":"attr", "set":{"style":"color:red;--anchor:a"}, "was":{"style":"color:red;--anchor:b"}},
            {"kind":"attr", "set":{"style":"display:block"}, "was":{"style":"display:none"}},
            {"kind":"attr", "tag":"ellipse", "set":{"style":"opacity:1"}, "was":{"style":"opacity:0"}}
        ]);
        let hover = filter_ops(ops.as_array().unwrap(), true).unwrap();
        let click = filter_ops(ops.as_array().unwrap(), false).unwrap();
        assert_eq!(hover, vec![ops[1].clone(), ops[3].clone()]);
        assert_eq!(click, vec![ops[1].clone(), ops[3].clone(), ops[4].clone()]);
    }
}
