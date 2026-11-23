//! A window WebKit can't draw in, found from WebKit's own log and fixed (macOS 12 and later).
//!
//! Nov 22 2026, Jessica's Mac: WebKit found the window's GPU process unresponsive and tried to end it; macOS refused
//! ("Could not signal service com.apple.WebKit.GPU: 1: Operation not permitted"). The page kept its connection to that
//! process and the window stayed blank for two hours, the page itself fine. The process wasn't stopped, just asleep, so
//! nothing about it shows the problem. WebKit's log does, and it's this app's own (OSLogStore, current process): it
//! says the process exited, yet it's still running. Ending it and then the window's web process fixed it: Tauri loads
//! the page again, drawn by a new GPU process.
//!
//! Every few seconds this reads what this app logged since the last look. A GPU process WebKit says exited that's still
//! running a few seconds later is ended (only if it's this app's: see `mac::ours`), then the web process. Frames, the
//! window's place on screen and the process's state play no part: a covered window draws again once it's uncovered.
//! macOS 11 has no OSLogStore for a process's own log: there this does nothing (quit and open Scenecast again).

#[cfg(target_os = "macos")]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The GPU processes WebKit says have exited, from its log lines ("WebProcessPool::gpuProcessDidExit: PID=<n>", and
/// "GPUProcess with PID <n> became unresponsive, terminating it"). One still running a few seconds later is one WebKit
/// couldn't end ("Could not signal service com.apple.WebKit.GPU", which names no process, says so too).
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
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use std::ptr::null_mut;

    #[link(name = "OSLog", kind = "framework")]
    unsafe extern "C" {}

    /// What this process logged since `since` (seconds since 1970): each entry's message.
    pub fn logged_since(since: f64) -> Vec<String> {
        autoreleasepool(|_| unsafe {
            let mut out = Vec::new();
            let (Some(store_cls), Some(date_cls)) =
                (AnyClass::get(c"OSLogStore"), AnyClass::get(c"NSDate"))
            else {
                return out;
            };
            let mut err: *mut AnyObject = null_mut();
            // OSLogStoreCurrentProcessIdentifier = 1
            let store: *mut AnyObject =
                msg_send![store_cls, storeWithScope: 1isize, error: &mut err];
            if store.is_null() {
                return out;
            }
            let date: *mut AnyObject = msg_send![date_cls, dateWithTimeIntervalSince1970: since];
            let pos: *mut AnyObject = msg_send![&*store, positionWithDate: date];
            let en: *mut AnyObject = msg_send![
                &*store,
                entriesEnumeratorWithOptions: 0usize,
                position: pos,
                predicate: null_mut::<AnyObject>(),
                error: &mut err
            ];
            if en.is_null() {
                return out;
            }
            loop {
                let e: *mut AnyObject = msg_send![&*en, nextObject];
                if e.is_null() {
                    break;
                }
                let e = &*e;
                if !e.class().responds_to(sel!(composedMessage)) {
                    continue;
                }
                let m: *mut AnyObject = msg_send![e, composedMessage];
                if m.is_null() {
                    continue;
                }
                let s: *const std::os::raw::c_char = msg_send![&*m, UTF8String];
                if !s.is_null() {
                    out.push(std::ffi::CStr::from_ptr(s).to_string_lossy().into_owned());
                }
            }
            out
        })
    }

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
        matches!((started(pid), started(me)), (Some(p), Some(a)) if p >= a)
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
    let web = web_process(window);
    if web > 0 {
        unsafe { libc::kill(web, libc::SIGKILL) };
    } else {
        let _ = window.reload();
    }
    format!(
        "GPU processes ended: {ended:?}; not this app's, left alone: {left_alone:?}; web process {web} ended (the page loads again)"
    )
}

/// Watches this app's log (every 5 s) for a GPU process WebKit says exited that's still running, and recovers.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    use tauri::Manager;
    let _ = std::thread::Builder::new()
        .name("gpu-watch".into())
        .spawn(move || {
            let now = || {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0)
            };
            let mut since = now();
            let mut seen: Vec<i32> = Vec::new();
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let t = now();
                // A little overlap, so nothing logged right at the edge is missed.
                let lines: Vec<String> = mac::logged_since(since - 2.0)
                    .into_iter()
                    .filter(|l| {
                        l.contains("gpuProcessDidExit")
                            || l.contains("GPUProcess with PID")
                            || l.contains("com.apple.WebKit.GPU")
                    })
                    .collect();
                since = t;
                let refused = lines
                    .iter()
                    .any(|l| l.contains("Could not signal service com.apple.WebKit.GPU"));
                let new: Vec<i32> = exited(&lines)
                    .into_iter()
                    .filter(|p| !seen.contains(p))
                    .collect();
                if new.is_empty() {
                    continue;
                }
                seen.extend(&new);
                // WebKit may still end it: give it a moment, then only what's still running.
                std::thread::sleep(Duration::from_secs(5));
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
                let msg = format!(
                    "GPU process {left:?} exited per WebKit but still running{why}: {what}"
                );
                eprintln!("gpu-watch: {msg}");
                scenecast_app::ai::app_log("window not drawing", &msg);
            }
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

    // The app's own log, as gpu_watch reads it: libxpc's default-level lines (the level and source of "Could not signal
    // service com.apple.WebKit.GPU") come back; reading the log makes one ("activating connection … OSLogService").
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_this_process_log() {
        let t0 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        // The app logs from its first moment (WebKit does); this test process logs a line first, as the app has.
        {
            use objc2::msg_send;
            use objc2::runtime::{AnyClass, AnyObject};
            unsafe extern "C" {
                fn NSLog(format: *const AnyObject, ...);
            }
            unsafe {
                let s: *mut AnyObject = msg_send![AnyClass::get(c"NSString").unwrap(), stringWithUTF8String: c"gpu-watch test".as_ptr()];
                NSLog(s);
            }
        }
        let mut got = Vec::new();
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            got = super::mac::logged_since(t0 - 5.0);
            if got.iter().any(|l| l.contains("OSLogService")) {
                break;
            }
        }
        assert!(
            got.iter().any(|l| l.contains("OSLogService")),
            "libxpc's lines weren't read back from this process's log: {} read",
            got.len()
        );
    }
}
