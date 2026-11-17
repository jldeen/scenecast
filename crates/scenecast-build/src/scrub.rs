//! Detection and redaction of sensitive text in captured material.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Finding {
    pub kind: &'static str,
    pub line: usize,
    pub credential: bool,
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
            ("credential", r#"(?i)\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|accountkey|sharedaccesssignature|authorization|set-cookie|cookie)\b[\s"'\\:=]+[a-z0-9%._~+/\-=]{8,}"#, true),
            ("sas-signature", r"(?i)[?&;](?:sig|signature|se|sp|sv)=[a-z0-9%._~+/\-=]{12,}", true),
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
}
