//! Work spread over the computer's cores, results in the order given (no dependency: scoped threads and a shared
//! cursor).

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// How many threads a build uses: `SCENECAST_THREADS`, else the cores there are (at most 16).
pub fn threads() -> usize {
    std::env::var("SCENECAST_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
                .min(16)
        })
}

/// `f` over every item, on several threads; the results in the items' order.
pub fn map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    map_on(threads(), items, f)
}

/// [`map`] on at most `threads` threads.
pub fn map_on<T: Sync, R: Send>(threads: usize, items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let n = threads.min(items.len());
    if n <= 1 {
        return items.iter().map(f).collect();
    }
    let next = AtomicUsize::new(0);
    let out: Vec<Mutex<Option<R>>> = items.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..n {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let r = f(item);
                    *out[i].lock().expect("result slot") = Some(r);
                }
            });
        }
    });
    out.into_iter()
        .map(|slot| {
            slot.into_inner()
                .expect("result slot")
                .expect("every item mapped")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_the_order() {
        let items: Vec<u32> = (0..1000).collect();
        assert_eq!(
            super::map(&items, |x| x * 2),
            (0..1000).map(|x| x * 2).collect::<Vec<_>>()
        );
        assert!(super::map(&[] as &[u32], |x| *x).is_empty());
    }
}
