//! The JavaScript engine (the `@stuntdouble/*` packages: core, capture, player, checks), run under Node.
//!
//! The engine is the folder that holds `core/bin/engine.mjs`: `packages/` in this repository, `node_modules/@stuntdouble`
//! in an npm install or the desktop app. It's found from `STUNTDOUBLE_JS` (or `SCENECAST_JS`), else by walking up from
//! the running binary to a `packages/` or `node_modules/@stuntdouble` holding it, else the checkout this binary was
//! built from. Node is `STUNTDOUBLE_NODE` (or `SCENECAST_NODE`), else `node` on PATH. Both work the same on macOS and
//! Windows.

use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use thiserror::Error;

/// The engine's entry point, relative to the `packages` folder.
pub const ENTRY: &str = "core/bin/engine.mjs";
const MIN_NODE_MAJOR: u32 = 20;
type Control<'a> = dyn FnMut(&str) -> Option<String> + 'a;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error(
        "can't find StuntDouble's JavaScript packages (core/bin/engine.mjs); set STUNTDOUBLE_JS to the folder that holds core/"
    )]
    NotFound,
    #[error("Node.js {MIN_NODE_MAJOR} or later is needed (https://nodejs.org); `{node}` {problem}")]
    Node { node: String, problem: String },
    #[error("failed to run `{program}`")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("stopped: a newer run took its place")]
    Cancelled,
    #[error("failed to communicate with the engine")]
    Communication(#[source] std::io::Error),
}

/// One line of the engine's output, as it comes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    Stdout(String),
    Stderr(String),
}

#[derive(Debug, Clone)]
pub struct Engine {
    /// The `packages` folder.
    pub packages: PathBuf,
    /// The Node executable.
    pub node: PathBuf,
    /// Extra environment for every command (the desktop app's receiver port).
    pub env: Vec<(OsString, OsString)>,
    /// When set, a running command is stopped (killed) as soon as this turns true.
    pub cancel: Option<Arc<AtomicBool>>,
}

impl Engine {
    pub fn locate() -> Result<Self, EngineError> {
        let packages = std::env::var_os("STUNTDOUBLE_JS")
            .or_else(|| std::env::var_os("SCENECAST_JS"))
            .map(PathBuf::from)
            .filter(|p| p.join(ENTRY).is_file())
            .or_else(|| {
                std::env::current_exe().ok().and_then(|exe| {
                    exe.ancestors()
                        .flat_map(|dir| {
                            [dir.join("packages"), dir.join("node_modules/@stuntdouble")]
                        })
                        .find(|p| p.join(ENTRY).is_file())
                })
            })
            .or_else(|| {
                let built = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages");
                built.join(ENTRY).is_file().then_some(built)
            })
            .ok_or(EngineError::NotFound)?;
        let node = std::env::var_os("STUNTDOUBLE_NODE")
            .or_else(|| std::env::var_os("SCENECAST_NODE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        Ok(Self {
            packages: dunce(packages),
            node,
            env: Vec::new(),
            cancel: None,
        })
    }

    pub fn entry(&self) -> PathBuf {
        self.packages.join(ENTRY)
    }

    /// Checks Node is there and new enough; returns its version.
    pub fn check_node(&self) -> Result<String, EngineError> {
        let err = |problem: String| EngineError::Node {
            node: self.node.display().to_string(),
            problem,
        };
        let out = Command::new(&self.node)
            .arg("--version")
            .output()
            .map_err(|e| err(format!("can't be run ({e})")))?;
        let version = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let major = version
            .trim_start_matches('v')
            .split('.')
            .next()
            .and_then(|m| m.parse::<u32>().ok())
            .ok_or_else(|| err(format!("printed `{version}`")))?;
        if major < MIN_NODE_MAJOR {
            return Err(err(format!("is {version}")));
        }
        Ok(version)
    }

    /// The command for one engine subcommand (`record`, `serve`, `fidelity`, …), not yet started.
    pub fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = Command::new(&self.node);
        cmd.arg(self.entry()).args(args);
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)));
        cmd
    }

    /// Runs a subcommand with the terminal attached (a server you stop with Ctrl+C, a recording). Returns its exit
    /// code.
    pub fn run_attached<I, S>(&self, args: I) -> Result<i32, EngineError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.check_node()?;
        let status = self
            .command(args)
            .status()
            .map_err(|source| self.spawn_err(source))?;
        Ok(status.code().unwrap_or(1))
    }

    /// Hands the terminal over to a subcommand for good (a server, the receiver): on macOS and Linux this process
    /// becomes Node (so a signal to it reaches the engine); on Windows it waits and returns the exit code (Ctrl+C
    /// reaches the whole console group there).
    pub fn exec_attached<I, S>(&self, args: I) -> Result<i32, EngineError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            self.check_node()?;
            let source = self.command(args).exec();
            Err(self.spawn_err(source))
        }
        #[cfg(not(unix))]
        {
            self.run_attached(args)
        }
    }

    /// Runs a subcommand and reports each line of its output as it comes. Returns its exit code.
    pub fn run_with_progress<I, S>(
        &self,
        args: I,
        on: impl FnMut(Progress),
    ) -> Result<i32, EngineError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run_with_progress_env(args, std::iter::empty::<(&OsStr, &OsStr)>(), on)
    }

    /// Runs a subcommand with explicit environment values and reports its output.
    pub fn run_with_progress_env<I, S, E, K, V>(
        &self,
        args: I,
        env: E,
        on: impl FnMut(Progress),
    ) -> Result<i32, EngineError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
        E: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.run_with_progress_control(args, env, on, None)
    }

    /// Runs an engine command with an optional line-based request handler on standard input.
    pub(crate) fn run_with_progress_control<I, S, E, K, V>(
        &self,
        args: I,
        env: E,
        mut on: impl FnMut(Progress),
        mut control: Option<&mut Control<'_>>,
    ) -> Result<i32, EngineError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
        E: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.check_node()?;
        let mut child = self
            .command(args)
            .envs(env)
            .stdin(if control.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| self.spawn_err(source))?;
        let (tx, rx) = mpsc::channel();
        let readers: Vec<_> = [
            child
                .stdout
                .take()
                .map(|s| (Box::new(s) as Box<dyn std::io::Read + Send>, false)),
            child
                .stderr
                .take()
                .map(|s| (Box::new(s) as Box<dyn std::io::Read + Send>, true)),
        ]
        .into_iter()
        .flatten()
        .map(|(pipe, is_err)| {
            let tx = tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let p = if is_err {
                        Progress::Stderr(line)
                    } else {
                        Progress::Stdout(line)
                    };
                    if tx.send(p).is_err() {
                        break;
                    }
                }
            })
        })
        .collect();
        drop(tx);
        let cancelled = || {
            self.cancel
                .as_ref()
                .is_some_and(|c| c.load(Ordering::SeqCst))
        };
        loop {
            let p = match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(p) => p,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if cancelled() {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(EngineError::Cancelled);
                    }
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if let Progress::Stdout(line) = &p
                && let Some(reply) = control.as_mut().and_then(|handler| handler(line))
            {
                let stdin = child.stdin.as_mut().expect("control uses piped stdin");
                if let Err(error) = writeln!(stdin, "{reply}").and_then(|_| stdin.flush()) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(EngineError::Communication(error));
                }
                continue;
            }
            on(p);
        }
        for r in readers {
            let _ = r.join();
        }
        let status = child.wait().map_err(|source| self.spawn_err(source))?;
        Ok(status.code().unwrap_or(1))
    }

    fn spawn_err(&self, source: std::io::Error) -> EngineError {
        EngineError::Spawn {
            program: self.node.display().to_string(),
            source,
        }
    }
}

/// `sub rest… --demo <dir>`: the engine reads positional args from the front, so the folder goes last.
pub fn with_demo(sub: &str, rest: &[OsString], dir: &Path) -> Vec<OsString> {
    let mut args = vec![OsString::from(sub)];
    args.extend(rest.iter().cloned());
    if !rest.iter().any(|a| a == "--demo") {
        args.push("--demo".into());
        args.push(dir.as_os_str().to_owned());
    }
    args
}

// Canonical, without Windows' `\\?\` prefix (Node's path functions don't take it).
pub(crate) fn dunce(path: PathBuf) -> PathBuf {
    match path.canonicalize() {
        Ok(p) => {
            let s = p.to_string_lossy();
            match s.strip_prefix(r"\\?\") {
                Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
                _ => p,
            }
        }
        Err(_) => path,
    }
}
