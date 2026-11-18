//! What the app's window may show from disk (the fidelity report's pictures, the script's sheets): files inside the
//! folders it's been allowed (the library), addressed as `/<root>/<path inside it>` so relative links inside a report
//! work as they do on disk, the same on macOS and Windows (no drive letters in a URL). The app serves these paths on
//! its own `scenecast:` protocol.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

#[derive(Default)]
pub struct FileScope {
    roots: RwLock<Vec<PathBuf>>,
}

fn canonical(path: &Path) -> PathBuf {
    let p = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // Without Windows' `\\?\` prefix, so prefixes compare the same as the paths the app hands out.
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("md" | "txt") => "text/plain; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn percent_encode(part: &str) -> String {
    let mut out = String::new();
    for b in part.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl FileScope {
    /// Lets the window show files inside `dir`.
    pub fn allow(&self, dir: &Path) {
        let dir = canonical(dir);
        let mut roots = self.roots.write().expect("roots lock");
        if !roots.contains(&dir) {
            roots.push(dir);
        }
    }

    /// `/<root>/<path>` for a file or folder inside an allowed folder (a folder's ends in `/`, for relative links).
    pub fn url_path(&self, path: &Path) -> Option<String> {
        let real = canonical(path);
        let roots = self.roots.read().ok()?;
        let (i, root) = roots
            .iter()
            .enumerate()
            .filter(|(_, r)| real.starts_with(r))
            .max_by_key(|(_, r)| r.components().count())?;
        let mut out = format!("/{i}");
        for c in real.strip_prefix(root).ok()?.components() {
            out.push('/');
            out.push_str(&percent_encode(&c.as_os_str().to_string_lossy()));
        }
        if real.is_dir() {
            out.push('/');
        }
        Some(out)
    }

    /// The file a `/<root>/<path>` names, if it's a file inside that root.
    pub fn resolve(&self, url_path: &str) -> Option<PathBuf> {
        let path = url_path.split(['?', '#']).next().unwrap_or("");
        let decoded = percent_decode(path)?;
        let mut parts = decoded.trim_start_matches('/').split('/');
        let i: usize = parts.next()?.parse().ok()?;
        let root = self.roots.read().ok()?.get(i)?.clone();
        let mut candidate = root.clone();
        for part in parts.filter(|p| !p.is_empty()) {
            let mut c = Path::new(part).components();
            match (c.next(), c.next()) {
                (Some(Component::Normal(n)), None) => candidate.push(n),
                _ => return None,
            }
        }
        let real = canonical(&candidate);
        (real.starts_with(&root) && real.is_file()).then_some(real)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_out_files_inside_allowed_folders_only() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("my library");
        let out = lib.join("demo/.out/fidelity");
        fs::create_dir_all(out.join("round-1")).unwrap();
        fs::write(out.join("report.html"), "<img src=round-1/a.png>").unwrap();
        fs::write(out.join("round-1/a.png"), [137, 80]).unwrap();
        fs::write(tmp.path().join("secret.txt"), "no").unwrap();
        let scope = FileScope::default();
        assert_eq!(scope.url_path(&lib), None);
        scope.allow(&lib);

        let page = scope.url_path(&out.join("report.html")).unwrap();
        assert_eq!(page, "/0/demo/.out/fidelity/report.html");
        assert_eq!(
            scope.resolve(&page),
            Some(canonical(&out.join("report.html")))
        );
        // A relative link resolves against the page's folder.
        let folder = scope.url_path(&out).unwrap();
        assert_eq!(folder, "/0/demo/.out/fidelity/");
        assert_eq!(
            scope.resolve(&format!("{folder}round-1/a.png?x=1")),
            Some(canonical(&out.join("round-1/a.png")))
        );
        assert_eq!(scope.url_path(&lib.join("demo")).unwrap(), "/0/demo/");

        assert_eq!(scope.url_path(&tmp.path().join("secret.txt")), None);
        for bad in [
            "/0/../secret.txt",
            "/0/demo/..%2F..%2Fsecret.txt",
            "/0/demo/.out/./fidelity/report.html",
            "/1/report.html",
            "/x/report.html",
            "/0/demo",
            "/0/C:%5Csecret.txt",
        ] {
            assert_eq!(scope.resolve(bad), None, "{bad}");
        }
    }

    #[test]
    fn encodes_names_and_picks_the_closest_root() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("a");
        let inner = outer.join("b c");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("x #1.html"), "x").unwrap();
        let scope = FileScope::default();
        scope.allow(&outer);
        scope.allow(&inner);
        let url = scope.url_path(&inner.join("x #1.html")).unwrap();
        assert_eq!(url, "/1/x%20%231.html");
        assert_eq!(
            scope.resolve(&url),
            Some(canonical(&inner.join("x #1.html")))
        );
    }

    #[test]
    fn types_what_it_serves() {
        assert_eq!(
            content_type(Path::new("a.HTML")),
            "text/html; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("a.png")), "image/png");
        assert_eq!(content_type(Path::new("a")), "application/octet-stream");
        assert_eq!(percent_decode("a%20b%2Fc").as_deref(), Some("a b/c"));
        assert_eq!(percent_decode("%zz"), None);
    }
}
