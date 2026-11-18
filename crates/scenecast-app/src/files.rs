//! A local file server for what the app shows from a demo's folder (the fidelity report's pictures, the script's
//! sheets): `http://127.0.0.1:<port>/<token>/<path>`. Only on the loopback address, only with the token, only files
//! inside the folders it's been allowed (the library), so relative links inside a report work as they do on disk.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::thread;

use crate::AppError;

pub struct FileServer {
    /// `http://127.0.0.1:<port>/<token>`.
    pub base: String,
    roots: Arc<RwLock<Vec<PathBuf>>>,
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

fn token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
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

/// The file a request path names, if it's inside one of the roots.
fn resolve(roots: &[PathBuf], url_path: &str) -> Option<PathBuf> {
    let path = url_path.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(path)?;
    let rel = Path::new(decoded.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let candidate = if cfg!(windows) {
        // `/C:/Users/…` on Windows.
        PathBuf::from(decoded.trim_start_matches('/'))
    } else {
        PathBuf::from(&decoded)
    };
    let real = fs::canonicalize(&candidate).ok()?;
    let real = canonical(&real);
    roots
        .iter()
        .any(|root| real.starts_with(root))
        .then_some(real)
        .filter(|p| p.is_file())
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

fn percent_encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl FileServer {
    pub fn start() -> Result<Self, AppError> {
        let server = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| AppError::Invalid(format!("the app's file server: {e}")))?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or_else(|| AppError::Invalid("the app's file server has no port".into()))?;
        let token = token();
        let roots: Arc<RwLock<Vec<PathBuf>>> = Arc::default();
        let shared = roots.clone();
        let prefix = format!("/{token}");
        thread::spawn(move || {
            for request in server.incoming_requests() {
                let url = request.url().to_owned();
                let found = url
                    .strip_prefix(&prefix)
                    .filter(|rest| rest.starts_with('/'))
                    .and_then(|rest| resolve(&shared.read().expect("roots lock"), rest));
                let response = match found.and_then(|p| Some((fs::read(&p).ok()?, p))) {
                    Some((body, path)) => tiny_http::Response::from_data(body)
                        .with_header(
                            tiny_http::Header::from_bytes("Content-Type", content_type(&path))
                                .expect("static header"),
                        )
                        .with_header(
                            tiny_http::Header::from_bytes("Cache-Control", "no-cache")
                                .expect("static header"),
                        ),
                    None => tiny_http::Response::from_string("not found").with_status_code(404),
                };
                let _ = request.respond(response);
            }
        });
        Ok(Self {
            base: format!("http://127.0.0.1:{port}/{token}"),
            roots,
        })
    }

    /// Lets the server hand out files inside `dir`.
    pub fn allow(&self, dir: &Path) {
        let dir = canonical(dir);
        let mut roots = self.roots.write().expect("roots lock");
        if !roots.contains(&dir) {
            roots.push(dir);
        }
    }

    /// The URL of a file or folder inside an allowed folder (a folder's ends in `/`, for relative links).
    pub fn url(&self, path: &Path) -> Option<String> {
        let real = canonical(path);
        if !self.roots.read().ok()?.iter().any(|r| real.starts_with(r)) {
            return None;
        }
        let mut text = real.to_string_lossy().replace('\\', "/");
        if !text.starts_with('/') {
            text.insert(0, '/');
        }
        if real.is_dir() && !text.ends_with('/') {
            text.push('/');
        }
        Some(format!("{}{}", self.base, percent_encode_path(&text)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn get(url: &str) -> (u16, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = std::net::TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.0\r\nHost: {host}\r\n\r\n").unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf);
        let status = text[9..12].parse().unwrap();
        let body_at = text.find("\r\n\r\n").unwrap() + 4;
        (status, buf[body_at..].to_vec())
    }

    #[test]
    fn serves_files_inside_allowed_folders_only() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("my library");
        fs::create_dir_all(lib.join("demo/.out/fidelity/round-1")).unwrap();
        fs::write(
            lib.join("demo/.out/fidelity/report.html"),
            "<img src=round-1/a.png>",
        )
        .unwrap();
        fs::write(lib.join("demo/.out/fidelity/round-1/a.png"), [137, 80]).unwrap();
        fs::write(tmp.path().join("secret.txt"), "no").unwrap();
        let server = FileServer::start().unwrap();
        assert_eq!(server.url(&lib), None);
        server.allow(&lib);

        let page = server
            .url(&lib.join("demo/.out/fidelity/report.html"))
            .unwrap();
        assert!(page.contains("my%20library"));
        assert_eq!(get(&page), (200, b"<img src=round-1/a.png>".to_vec()));
        // A relative link resolves against the page's folder.
        let folder = server.url(&lib.join("demo/.out/fidelity")).unwrap();
        assert!(folder.ends_with('/'));
        assert_eq!(get(&format!("{folder}round-1/a.png")).1, vec![137, 80]);

        assert_eq!(server.url(&tmp.path().join("secret.txt")), None);
        let outside = page.replace("my%20library/demo/.out/fidelity/report.html", "secret.txt");
        assert_eq!(get(&outside).0, 404);
        let climbing = page.replace("demo/.out/fidelity/report.html", "../secret.txt");
        assert_eq!(get(&climbing).0, 404);
        let no_token = page.replace(
            &server.base,
            &server.base[..server.base.rfind('/').unwrap()],
        );
        assert_eq!(get(&no_token).0, 404);
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
