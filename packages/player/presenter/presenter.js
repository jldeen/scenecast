// The presenter guide (/presenter.html, scenecast, from replica-kit 1.6.0): ⌥G on the stage opens it (Ctrl+Alt+G on Windows). It follows
// the stage's beat over a BroadcastChannel (packages/player/app/presenter-module.js has the protocol). Its Back, Next, beat
// circles and keys only browse: the window shows another beat to read ahead or back ("Previewing beat 7 · stage is on
// beat 3") and the stage stays put. "Back to live" (or Esc) returns to the stage's beat; "Go to this beat on stage"
// moves the stage there, and a clicker's Page Down and Page Up move it on or back (presenter-module.js). Its content is the demo's presenter/notes.json, made from the script by `scenecast notes`
// (the desktop app makes it when it finds the focus points).
import { presenterKey, keyLabel, isWindows } from '/app/presenter-key.js';

const root = document.querySelector('.pn');
// Opened by the desktop app ("Open presenter guide") with #place=x,y,w,h: the laptop screen, where the app's window is.
// The browser was asked to open it there too; this puts it right when the browser was already running.
{
  const m = /place=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(location.hash);
  if (m) { try { window.moveTo(+m[1], +m[2]); window.resizeTo(+m[3], +m[4]); } catch (e) {} }
}
const $ = name => document.querySelector(`[data-pn="${name}"]`);
let notes = null;
try { const r = await fetch('/presenter/notes.json', { cache: 'no-store' }); if (r.ok) notes = await r.json(); } catch (e) {}
if (!notes || !(notes.beats || []).length) {
  root.innerHTML = '<p class="pn-empty">No presenter notes yet. In the Scenecast app, open the demo\'s Script step and press <strong>Find the focus points</strong> (or run <code>scenecast notes</code> in the demo folder), then reload this window.</p>';
  throw new Error('no presenter notes');
}
const WIN = isWindows();
if (WIN) document.documentElement.classList.add('is-windows');
const B = notes.beats, LAST = B.length - 1;
const ch = new BroadcastChannel(notes.channel);

// index: the beat the window shows; live: the stage's (null before it's heard); moving: a beat the stage was sent to.
let index = -1, live = null, app = null, lastSeen = 0, moving = null, movingAt = 0;
// The timer follows the stage, not what the window shows: stopped at 0:00 until the stage leaves Start, then it runs
// from the script's start time for the beat it lands on (0:00 for beat 1), so the beat windows line up; it stops at End.
// Reset puts it back to the stage's beat's start time (0:00 at Start).
const timer = { base: 0, from: null };
const elapsed = () => timer.base + (timer.from === null ? 0 : (Date.now() - timer.from) / 1000);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const md = s => esc(keyLabel(s))
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
const shotUrl = name => name ? `/presenter/shots/${encodeURIComponent(name)}.png` : '';
const stepName = b => (b.n === 0 ? `Start · ${b.title}` : b.n === LAST ? `End · ${b.title}` : `${b.n} · ${b.title}`);
const beatName = n => (n === 0 ? 'Start' : n === LAST ? 'End' : `beat ${n}`);
const connected = () => Date.now() - lastSeen < 2500;
const partStarts = new Set((notes.parts || []).map(p => p.from).filter(n => n != null));

document.title = `Presenter guide · ${notes.title}`;
$('deck').textContent = notes.title;
$('rail').innerHTML = B.map(b => `<button type="button" class="pn-dot${partStarts.has(b.n) ? ' is-part' : ''}" data-goto="${b.n}" title="${esc(stepName(b))}${b.time ? ' · ' + b.time : ''}">${esc(b.label)}</button>`).join('');
$('keys').innerHTML = notes.keys.map(([k, v]) => `<dt>${md(k)}</dt><dd>${md(v)}</dd>`).join('');

function sayHtml(b) {
  if (b.n === 0) return `<p class="pn-quiet">Nothing to say yet. When you start, ${md(b.next[0])}: ${md(B[1] ? B[1].title : '')}.</p>`;
  if (b.n === LAST) return '<p class="pn-quiet">That\'s the talk.</p>';
  if (!b.say.length) return '<p class="pn-quiet">(No lines in the script for this beat.)</p>';
  let prevAlt = false;
  return b.say.map(p => {
    if (!p.alt) { prevAlt = false; return `<p>${md(p.text)}</p>`; }
    const first = !prevAlt; prevAlt = true;
    return `<div class="pn-alt${first ? ' is-first' : ''}"><b>${md(p.alt)}</b><p>${md(p.text)}</p></div>`;
  }).join('');
}
function clicksHtml(b) {
  let h = '';
  if (b.do.length) {
    h += '<ul>';
    for (let i = 0; i < b.do.length; i++) {
      const d = b.do[i];
      if (d.level) continue;
      const subs = [];
      for (let j = i + 1; j < b.do.length && b.do[j].level; j++) subs.push(b.do[j]);
      h += `<li>${md(d.text)}${subs.length ? `<ol>${subs.map(s => `<li>${md(s.text)}</li>`).join('')}</ol>` : ''}</li>`;
    }
    h += '</ul>';
  }
  if ((b.focus || []).length) h += `<p class="pn-focus-h">${md('⌥F')}, in order (Esc zooms out)</p><ol class="pn-focus">${b.focus.map(f => `<li>${md(f)}</li>`).join('')}</ol>`;
  return h;
}
function showShot() {
  const b = B[index];
  const name = (index === live && b.shotApp && b.shotApp[app]) || b.shot;
  const url = shotUrl(name);
  if ($('shot').getAttribute('src') !== url) { if (url) $('shot').setAttribute('src', url); else $('shot').removeAttribute('src'); }
  $('shot-label').textContent = (notes.shotLabels || {})[name] || stepName(b);
}
function show(n) {
  n = Math.max(0, Math.min(LAST, n));
  index = n;
  const b = B[n], next = n === LAST ? B[0] : B[n + 1];
  document.body.dataset.beat = String(n);
  $('count').textContent = (n === 0 ? 'Start' : n === LAST ? 'End' : `Beat ${n} of ${LAST - 1}`) + (b.time ? ` · ${b.time}` : '');
  $('part').textContent = b.part;
  $('title').textContent = b.title;
  $('where').innerHTML = b.screen ? `On screen: ${md(b.screen)}` : '';
  $('say').innerHTML = sayHtml(b);
  $('clicks').innerHTML = clicksHtml(b);
  $('clicks-h').hidden = !b.do.length && !(b.focus || []).length;
  $('watch').innerHTML = b.watch.map(w => `<li>${md(w)}</li>`).join('');
  $('watch-h').hidden = !b.watch.length;
  $('notes-col').scrollTop = 0;
  showShot();
  $('next-act').innerHTML = md(b.next[0]);
  $('next-to').innerHTML = md(b.next[1]);
  $('next-title').textContent = next ? stepName(next) : '';
  if (next && next.shot) $('next-shot').setAttribute('src', shotUrl(next.shot)); else $('next-shot').removeAttribute('src');
  $('prev').disabled = n === 0;
  $('next').disabled = n === LAST;
  tick();
}
// The stage moved from beat a to beat b: the timer starts, stops or goes on.
function liveMoved(a, b) {
  const nb = B[b];
  if (a === 0 && b > 0 && b < LAST && timer.from === null && timer.base === 0) { timer.base = nb.start || 0; timer.from = Date.now(); }
  if (b === LAST && timer.from !== null) { timer.base = elapsed(); timer.from = null; }
  if (a === LAST && b > 0 && b < LAST && timer.from === null && timer.base > 0) timer.from = Date.now();
}
function tick() {
  const s = Math.floor(elapsed());
  $('clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const on = connected();
  const lb = B[on && live !== null ? live : index];
  $('window').textContent = lb ? lb.time : '';
  root.classList.toggle('is-late', !!lb && lb.end != null && timer.from !== null && elapsed() > lb.end);
  if (moving !== null && Date.now() - movingAt > 4000) moving = null;
  const previewing = on && live !== null && index !== live;
  $('preview').hidden = !previewing;
  if (previewing) $('preview-text').textContent = moving === index ? `Moving the stage to ${beatName(index)}…` : `Previewing ${beatName(index)} · stage is on ${beatName(live)}`;
  root.classList.toggle('is-previewing', previewing);
  // The circles: the beat shown (filled) and, while previewing, the stage's beat (ringed).
  for (const d of document.querySelectorAll('[data-goto]')) {
    const k = +d.dataset.goto;
    d.classList.toggle('is-current', k === index);
    d.classList.toggle('is-done', k < index);
    d.classList.toggle('is-live', previewing && k === live);
    if (k === index) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
  }
  $('status').classList.toggle('is-on', on);
  $('status-text').textContent = on ? 'In sync' : 'Not connected';
  $('status').title = on ? 'Following the replica' : `Open the replica in this browser and press ${keyLabel('⌥G')} there`;
}
// Browse: show another beat; the stage stays where it is.
function browse(n) { show(Math.max(0, Math.min(LAST, n))); }
function backToLive() { if (live !== null && connected()) show(live); }
// Only this moves the stage: to the start of the beat the window shows.
function goStage() {
  if (!connected()) return;
  moving = index; movingAt = Date.now();
  ch.postMessage({ t: 'goto', beat: index });
  tick();
}

ch.onmessage = e => {
  const m = e.data || {};
  if (m.t !== 'state' || !Number.isInteger(m.beat)) return;
  const wasOn = connected();
  lastSeen = Date.now();
  const appChanged = m.app !== app, was = live;
  app = m.app; live = m.beat;
  if (was !== null && was !== live) liveMoved(was, live);
  // Following (the window was on the stage's beat, just connected, or sent the stage here): show the stage's beat.
  // Previewing another beat: stay on it; the banner says where the stage is.
  const follow = index === -1 || !wasOn || was === null || index === was || moving === live;
  if (moving === live) moving = null;
  if (follow && index !== live) show(live);
  else if (appChanged && index === live) showShot();
  tick();
};
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.goto) browse(+t.dataset.goto);
  else if (t.dataset.pn === 'prev') browse(index - 1);
  else if (t.dataset.pn === 'next') browse(index + 1);
  else if (t.dataset.pn === 'live') backToLive();
  else if (t.dataset.pn === 'go-stage') goStage();
  else if (t.dataset.pn === 'reset-timer') {
    const n = connected() && live !== null ? live : index, b = B[n];
    timer.base = n === 0 || n === LAST ? 0 : b.start || 0;
    timer.from = n === 0 || n === LAST ? null : Date.now();
    tick();
  }
});
document.addEventListener('keydown', e => {
  if (presenterKey(e) && /^Digit\d$/.test(e.code)) { e.preventDefault(); browse(+e.code.slice(5)); return; }
  if (e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Escape') { e.preventDefault(); backToLive(); }
  // A clicker sends Page Down and Page Up: they move the stage on (or back), and the window follows it. The arrows and
  // Space read ahead, as the buttons do.
  else if ((e.code === 'PageDown' || e.code === 'PageUp') && connected()) { e.preventDefault(); backToLive(); ch.postMessage({ t: e.code === 'PageDown' ? 'next' : 'prev' }); }
  else if (e.code === 'ArrowRight' || e.code === 'PageDown' || e.code === 'Space') { e.preventDefault(); browse(index + 1); }
  else if (e.code === 'ArrowLeft' || e.code === 'PageUp') { e.preventDefault(); browse(index - 1); }
});

// For the notes check only; nothing on screen.
window.presenter = { get index() { return index; }, get live() { return live; }, get connected() { return connected(); }, get elapsed() { return elapsed(); }, get running() { return timer.from !== null; }, notes, windows: WIN };
const hello = () => ch.postMessage({ t: 'hello' });
show(0);
hello();
setInterval(hello, 1000);
setInterval(tick, 250);
