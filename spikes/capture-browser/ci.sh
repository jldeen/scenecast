#!/bin/bash
# Spike (stage C) on a CI runner, through the Diagnose workflow (never fails): window modes drawn the same
# (parity.mjs), twins (twins.mjs), and the fixture recorded by the extension and by the CDP recorder in the capture
# browser, compared (compare-raw.mjs). Results under $DIAG_DIR.
#   Diagnose: command "bash spikes/capture-browser/ci.sh"
D=${DIAG_DIR:-$PWD/diag}; mkdir -p "$D"
echo "== $(uname -a)"; node -v
echo "== smoke"; for m in visible minimized offscreen; do node spikes/capture-browser/smoke.mjs $m 2>&1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("{"); if(i<0) return console.log(s.slice(0,800)); const j=JSON.parse(s.slice(i)); console.log(JSON.stringify({ms:j.ms,start:j.info&&j.info.startMs,wins:(j.info&&j.info.wins||[]).map(w=>w.state+"@"+w.left+","+w.top+" "+w.width+"x"+w.height),chat:{raf:j.chat.raf,t:j.chat.timer250,vis:j.chat.vis,dark:j.chat.dark,size:j.chat.size,dpr:j.chat.dpr}}))})'; done
echo "== parity"; node spikes/capture-browser/parity.mjs --out "$D/parity" 2>&1 | tail -80
echo "== twins"; node spikes/capture-browser/twins.mjs --n 1,2,4 --mode minimized --out "$D/twins" 2>&1 | tail -6
rec() { local name=$1; shift; env "$@" node packages/selftest/selftest.mjs --record-only --keep > "$D/rec-$name.log" 2>&1; echo "$name: exit $? $(grep -c '^FAIL' "$D/rec-$name.log") FAIL"; grep -E '^FAIL|^TIME take|capture browser' "$D/rec-$name.log" | cut -c1-300; grep -o 'demo folder: .*' "$D/rec-$name.log" | cut -d' ' -f3; }
echo "== record"
A=$(rec ext SCENECAST_RECORDER=extension | tee /dev/stderr | tail -1)
B=$(rec cdp SCENECAST_RECORDER=agent SCENECAST_CAPTURE_BROWSER=minimized | tee /dev/stderr | tail -1)
if [ -d "$A/raw" ] && [ -d "$B/raw" ]; then
  node spikes/capture-browser/compare-raw.mjs "$A/raw" "$B/raw" --loose --out "$D/compare-ext-cdp.json" 2>&1 | head -40
  mkdir -p "$D/shots-ext" "$D/shots-cdp"; cp "$A"/raw/shots/*.png "$D/shots-ext/" 2>/dev/null; cp "$B"/raw/shots/*.png "$D/shots-cdp/" 2>/dev/null
fi
echo "== leftover browsers"; (ps -A -o pid,command 2>/dev/null || tasklist) | grep -i "stuntdouble-capture" | grep -v grep | head
exit 0
