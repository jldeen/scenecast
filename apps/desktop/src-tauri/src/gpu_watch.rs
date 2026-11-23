//! A window WebKit can't draw in, found from WebKit's own log and fixed (macOS).
//!
//! Nov 22 2026, Jessica's Mac: WebKit found the window's GPU process unresponsive and tried to end it; macOS refused
//! ("Could not signal service com.apple.WebKit.GPU: 1: Operation not permitted"). The page kept its connection to that
//! process and the window stayed blank for two hours, the page itself fine. The process wasn't stopped, just asleep, so
//! nothing about it shows the problem. WebKit's log does, and it's this app's own: it says the process exited, yet it's
//! still running. Ending it and then the window's web process fixed it: Tauri loads
//! the page again, drawn by a new GPU process.
//!
//! One `log stream` (macOS's own tool) runs for the app's life, filtered by the log service to this app's process and
//! WebKit's lines about its GPU process, so it costs nothing until they come. (Reading the log store instead took 3 to
//! 6 s a read on a loaded Mac.) A GPU process WebKit says exited that's still running 5 s later is ended (only if it's
//! this app's: see `mac::ours`), then the web process. Frames, the window's place on screen and the process's state
//! play no part: a covered window draws again once it's uncovered. If the stream can't be read (its marker, written at
//! the start, doesn't come back), recovery is off and the app's log says why, once. macOS lets only administrators
//! stream the log ("Must be admin to run 'stream' command", checked with a standard account): on other accounts a
//! blank window is fixed by quitting and opening Scenecast again.

#[cfg(target_os = "macos")]
use std::time::Duration;

/// The GPU processes WebKit says have exited, from its log lines ("WebProcessPool::gpuProcessDidExit: PID=<n>", and
/// "GPUProcess with PID <n> became unresponsive, terminating it"). One still running a few seconds later is one WebKit
/// couldn't end ("Could not signal service com.apple.WebKit.GPU", which names no process, says so too).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn exited(lines: &[String]) -> Vec<i32> {
    let num = |s: &str| {
        s.split(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|n| n.parse::<i32>().ok())
    };
    let mut out = Vec::new();
    for l in lines {
        let pid = if let Some(rest) = l.split("gpuProcessDidExit: PID=").nth(1) {
            num(rest)
        } else if l.contains("became unresponsive") {
            l.split("GPUProcess with PID ").nth(1).and_then(num)
        } else {
            None
        };
        if let Some(p) = pid
            && p > 0
            && !out.contains(&p)
        {
            out.push(p);
        }
    }
    out
}

#[cfg(target_os = "macos")]
mod mac {
    fn started(pid: i32) -> Option<u64> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (n == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    }

    fn responsible(pid: i32) -> i32 {
        unsafe extern "C" {
            fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
        }
        unsafe { responsibility_get_pid_responsible_for_pid(pid) }
    }

    fn name(pid: i32) -> String {
        let mut name = [0u8; 64];
        let len = unsafe { libc::proc_name(pid, name.as_mut_ptr().cast(), name.len() as u32) };
        String::from_utf8_lossy(&name[..len.max(0) as usize]).into_owned()
    }

    /// Who a process is, for the log: pid, name, and the process it's responsible to.
    pub fn who(pid: i32) -> String {
        format!("{pid} {} (responsible: {})", name(pid), responsible(pid))
    }

    /// This app's GPU process, safe to end: named by this app's own WebKit log (the only way a pid reaches here),
    /// WebKit's GPU service by name, and started after this app. Being responsible to whatever started the app is never
    /// enough: started by a terminal or a test, that program's own GPU processes are responsible to it too (the GitHub
    /// Copilot app's, on Jessica's Mac).
    pub fn ours(pid: i32) -> bool {
        if name(pid) != "com.apple.WebKit.GPU" {
            return false;
        }
        let me = std::process::id() as i32;
        if !matches!((started(pid), started(me)), (Some(p), Some(a)) if p >= a) {
            return false;
        }
        // Opened normally (or as its own launchd job), the app's GPU processes are responsible to it: then that's
        // required too, so a pid since reused by another app's GPU process (started after this app, same name) isn't.
        responsible(me) != me || responsible(pid) == me
    }

    pub fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    pub fn end(pid: i32) {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

/// The window's web process (WebKit's own name for it, asked only if it answers).
#[cfg(target_os = "macos")]
fn web_process(window: &tauri::WebviewWindow) -> i32 {
    let (tx, rx) = std::sync::mpsc::channel();
    let ok = window.with_webview(move |wv| {
        use objc2::{msg_send, runtime::AnyObject, sel};
        let wk = wv.inner() as *mut AnyObject;
        let pid = if wk.is_null() {
            0
        } else {
            let wk = unsafe { &*wk };
            if wk.class().responds_to(sel!(_webProcessIdentifier)) {
                unsafe { msg_send![wk, _webProcessIdentifier] }
            } else {
                0
            }
        };
        let _ = tx.send(pid);
    });
    if ok.is_err() {
        return 0;
    }
    rx.recv_timeout(Duration::from_secs(5)).unwrap_or(0)
}

/// Ends the window's web process (Tauri loads the page again), or reloads it if WebKit doesn't say which it is.
#[cfg(target_os = "macos")]
pub fn restart_page(window: &tauri::WebviewWindow) -> i32 {
    let web = web_process(window);
    if web > 0 {
        unsafe { libc::kill(web, libc::SIGKILL) };
    } else {
        let _ = window.reload();
    }
    web
}

/// Ends the GPU processes WebKit couldn't end (only this app's, still running), then the window's web process: Tauri
/// loads the page again. Returns what it did, for the log.
#[cfg(target_os = "macos")]
pub fn recover(window: &tauri::WebviewWindow, stuck: &[i32]) -> String {
    let mut ended = Vec::new();
    let mut left_alone = Vec::new();
    for &p in stuck {
        if !mac::alive(p) {
            continue;
        }
        let w = mac::who(p);
        if mac::ours(p) {
            mac::end(p);
            ended.push(w);
        } else {
            left_alone.push(w);
        }
    }
    // None ended: the app's real GPU process already exited and nothing is wedged; loading the page again would only
    // lose what's on it.
    if ended.is_empty() {
        return format!(
            "nothing ended (not this app's, left alone: {left_alone:?}); the page is left as it is"
        );
    }
    let web = restart_page(window);
    format!(
        "GPU processes ended: {ended:?}; not this app's, left alone: {left_alone:?}; web process {web} ended (the page loads again)"
    )
}

/// The message of one `log stream --style ndjson` line, if it's an entry.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn message(line: &str) -> Option<String> {
    if !line.starts_with('{') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(line)
        .ok()?
        .get("eventMessage")?
        .as_str()
        .map(str::to_owned)
}

#[cfg(target_os = "macos")]
const MARKER: &std::ffi::CStr = c"scenecast gpu-watch marker";

/// Watches this app's log for a GPU process WebKit says exited that's still running, and recovers the window.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    use std::io::BufRead;
    use tauri::Manager;
    let me = std::process::id();
    let predicate = format!(
        "processID == {me} AND (eventMessage CONTAINS \"gpuProcessDidExit\" OR eventMessage CONTAINS \"became unresponsive\" \
         OR eventMessage CONTAINS \"Could not signal service com.apple.WebKit.GPU\" OR eventMessage CONTAINS \"{}\")",
        MARKER.to_string_lossy()
    );
    // The stream ends with the app, even if the app crashes: the shell around it watches the app's pid.
    let script = format!(
        "/usr/bin/log stream --style ndjson --predicate \"$1\" & s=$!; while kill -0 {me} 2>/dev/null; do sleep 5; done; kill $s"
    );
    let off = |why: &str| {
        let msg = format!("can't read this app's log ({why}); blank-window recovery is off");
        eprintln!("gpu-watch: {msg}");
        scenecast_app::ai::app_log("gpu-watch", &msg);
    };
    let child = std::process::Command::new("/bin/sh")
        .args(["-c", &script, "gpu-watch", &predicate])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return off(&e.to_string()),
    };
    let Some(out) = child.stdout.take() else {
        return off("no output");
    };
    // Its first complaint, if any ("log: Must be admin to run 'stream' command" for a standard account): the reason given
    // when recovery is off.
    let said = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(err) = child.stderr.take() {
        let said = said.clone();
        let _ = std::thread::Builder::new()
            .name("gpu-watch-err".into())
            .spawn(move || {
                for l in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                    let mut s = said.lock().expect("said");
                    if s.is_empty() && !l.trim().is_empty() {
                        *s = l.trim().trim_start_matches("log: ").to_owned();
                    }
                }
            });
    }
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let _ = std::thread::Builder::new()
        .name("gpu-watch-read".into())
        .spawn(move || {
            for l in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(m) = message(&l)
                    && tx.send(m).is_err()
                {
                    break;
                }
            }
        });
    let _ = std::thread::Builder::new()
        .name("gpu-watch".into())
        .spawn(move || {
            // The stream is live when the marker written to this app's log comes back through it.
            let mut live = false;
            for _ in 0..5 {
                std::thread::sleep(Duration::from_millis(500));
                unsafe { libc::syslog(libc::LOG_NOTICE, c"%s".as_ptr(), MARKER.as_ptr()) };
                if let Ok(m) = rx.recv_timeout(Duration::from_secs(2))
                    && m.contains(MARKER.to_str().unwrap_or("-"))
                {
                    live = true;
                    break;
                }
            }
            if !live {
                let _ = child.kill();
                let why = said.lock().map(|s| s.clone()).unwrap_or_default();
                return off(if why.is_empty() {
                    "its marker didn't come back"
                } else {
                    &why
                });
            }
            eprintln!("gpu-watch: reading this app's log");
            let mut seen: Vec<i32> = Vec::new();
            let mut refused = false;
            while let Ok(m) = rx.recv() {
                if m.contains("Could not signal service com.apple.WebKit.GPU") {
                    refused = true;
                }
                let new: Vec<i32> = exited(&[m])
                    .into_iter()
                    .filter(|p| !seen.contains(p))
                    .collect();
                if new.is_empty() {
                    continue;
                }
                seen.extend(&new);
                // WebKit may still end it: give it a moment, then only what's still running.
                std::thread::sleep(Duration::from_secs(5));
                while let Ok(m) = rx.try_recv() {
                    refused |= m.contains("Could not signal service com.apple.WebKit.GPU");
                }
                let left: Vec<i32> = new.into_iter().filter(|&p| mac::alive(p)).collect();
                if left.is_empty() {
                    continue;
                }
                let Some(window) = app.get_webview_window("main") else {
                    continue;
                };
                let what = recover(&window, &left);
                let why = if refused {
                    " (macOS refused WebKit's signal)"
                } else {
                    ""
                };
                refused = false;
                let msg = format!(
                    "GPU process {left:?} exited per WebKit but still running{why}: {what}"
                );
                eprintln!("gpu-watch: {msg}");
                scenecast_app::ai::app_log("window not drawing", &msg);
            }
            let _ = child.kill();
        });
}

#[cfg(test)]
mod tests {
    use super::exited;

    #[test]
    fn finds_the_gpu_process_webkit_says_exited() {
        let l = |s: &str| s.to_owned();
        // Nov 23, 0.5.4-rc.1 on Jessica's Mac, in order.
        let lines = vec![
            l("RemoteRenderingBackendProxy::didBecomeUnresponsive"),
            l(
                "0x11c1241f0 - GPUProcessProxy::didBecomeUnresponsive: GPUProcess with PID 69440 became unresponsive, terminating it",
            ),
            l("Could not signal service com.apple.WebKit.GPU: 1: Operation not permitted"),
            l("0x11c1241f0 - GPUProcessProxy::gpuProcessExited: reason=Unresponsive"),
            l("0x105cdaf58 - WebProcessPool::gpuProcessDidExit: PID=69440, reason=Unresponsive"),
        ];
        assert_eq!(exited(&lines), vec![69440]);
        assert_eq!(exited(&lines[4..]), vec![69440]);
        // The refusal alone names no process.
        assert!(exited(&lines[2..4]).is_empty());
    }

    #[test]
    fn reads_log_stream_lines() {
        use super::message;
        assert_eq!(message(r#"{"eventMessage":"WebProcessPool::gpuProcessDidExit: PID=69440, reason=Unresponsive","processID":1}"#).as_deref(), Some("WebProcessPool::gpuProcessDidExit: PID=69440, reason=Unresponsive"));
        assert!(message(r#"Filtering the log data using "processIdentifier == 1""#).is_none());
    }
}
