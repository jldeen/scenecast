#!/bin/bash
# Spike (stage C): why the installed Chrome on a CI Mac never opens its debugging port. Diagnose only (never fails):
#   Diagnose: command "bash spikes/capture-browser/mac-diag.sh", os macos-latest
# Tries the same Chrome four ways (spawned directly or through open, with and without the mock keychain, plus
# headless as a control). Each one gets 25 s. It saves Chrome's own log and a picture of the runner's screen
# (a dialog would show there). Every Chrome it starts is stopped.
D=${DIAG_DIR:-$PWD/diag}; mkdir -p "$D/mac"
APP="/Applications/Google Chrome.app"; BIN="$APP/Contents/MacOS/Google Chrome"
echo "== chrome"; "$BIN" --version 2>&1 | head -2; ls -la "$APP/Contents/MacOS/" | head -5
echo "== policies"; ls "/Library/Managed Preferences" 2>&1 | head; defaults read com.google.Chrome 2>&1 | head -20; defaults read /Library/Preferences/com.google.Chrome 2>&1 | head -20
echo "== session"; who; launchctl managername 2>&1; echo "console user: $(stat -f %Su /dev/console)"
stopall() { for p in $(pgrep -f "user-data-dir=$1"); do kill $p 2>/dev/null; done; sleep 1; for p in $(pgrep -f "user-data-dir=$1"); do kill -9 $p 2>/dev/null; done; }
try() {
  local name=$1 how=$2; shift 2
  local dir; dir=$(mktemp -d "${TMPDIR:-/tmp}/stuntdouble-capture-diag-XXXX"); local port=$((9300 + RANDOM % 500))
  local flags=(--user-data-dir="$dir" --remote-debugging-port=$port --no-first-run --no-default-browser-check --disable-sync
    --enable-logging=stderr --v=0 "$@" about:blank)
  echo "== $name ($how) port $port"
  local t0=$(date +%s)
  if [ "$how" = open ]; then open -n -g -j --stdout "$D/mac/$name.log" --stderr "$D/mac/$name.log" -a "$APP" --args "${flags[@]}"
  else "$BIN" "${flags[@]}" > "$D/mac/$name.log" 2>&1 & fi
  local ok=no
  for i in $(seq 1 50); do
    if curl -s -m 1 "http://127.0.0.1:$port/json/version" > "$D/mac/$name.version.json" 2>/dev/null && [ -s "$D/mac/$name.version.json" ]; then ok=yes; break; fi
    sleep 0.5
  done
  echo "answered: $ok after $(( $(date +%s) - t0 )) s; DevToolsActivePort: $(head -1 "$dir/DevToolsActivePort" 2>/dev/null || echo none)"
  screencapture -x "$D/mac/$name-screen.png" 2>&1 | head -2
  echo "processes: $(pgrep -f "user-data-dir=$dir" | wc -l | tr -d ' ')"
  echo "-- its log (last 25 lines)"; tail -25 "$D/mac/$name.log" | cut -c1-240
  ls "$dir" | head -20 | tr '\n' ' '; echo
  stopall "$dir"; rm -rf "$dir"
}
try direct-headless direct --headless=new
try direct direct
try direct-mock direct --use-mock-keychain
try open-mock open --use-mock-keychain
try direct-mock-pw direct --use-mock-keychain --password-store=basic --disable-features=MediaRouter --no-startup-window
echo "== leftover"; pgrep -fl stuntdouble-capture-diag | head
exit 0
