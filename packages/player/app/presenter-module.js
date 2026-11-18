// The presenter guide (/presenter.html, packages/player/presenter/): ⌥G opens it (Ctrl+Alt+G on Windows). It shows the
// script beat the stage is on; its Back, Next and circles only browse, and its "Go to this beat on stage" moves the
// stage. They talk over a BroadcastChannel on the replica's own origin (notes.channel, `scenecast-presenter:<demo>`):
//   window → stage  { t: 'hello' } (every second), { t: 'goto', beat }
//   stage → window  { t: 'state', beat, app, state } (on every change, and in reply to each hello)
// beat is the script's: 0 is Start (⌥0), 1…N the beats, N+1 the End.
//
// Which beat the stage is on: ⌥0–⌥9 set it. After that, each screen belongs to one or more beats (notes.stage.screens,
// from the recorded run-through; demo.json presenter.screens overrides), and a move keeps the beat if the new screen
// belongs to it, or takes the screen's next beat after it (or, going back, its last one).
//
// A beat with no screen of its own (a title slide, a closing line) shares the screen before it. While the window is
// open, → (or a clicker's Page Down) on that screen steps the window there, and ← (Page Up) steps back; the screen
// stays. With no window open, → does what it always did.
import { presenterKey } from './presenter-key.js';

export default async function presenterModule(api) {
  // Served only: an exported folder (file://) has no presenter guide.
  if (location.protocol === 'file:') return;
  let notes = null;
  try { const r = await fetch('/presenter/notes.json', { cache: 'no-store' }); if (r.ok) notes = await r.json(); } catch (e) {}
  const name = (notes && notes.channel) || `scenecast-presenter:${api.flow.name || api.flow.title || 'replica'}`;
  const ch = new BroadcastChannel(name);
  const SB = notes ? notes.stage.beats : [];
  const LAST = Math.max(0, SB.length - 1);
  const screens = notes ? notes.stage.screens : {};
  const rules = notes ? (notes.stage.rules || []).map(([app, re, list]) => [app, new RegExp(re), list]) : [];
  const S = { beat: 0, key: '', pending: false, heard: 0, sent: '', moves: 0 };
  const beatsOf = (app, state) => { for (const [a, re, list] of rules) if (a === app && re.test(state || '')) return list; return screens[`${app}:${state}`] || null; };
  const pick = (prev, allowed) => {
    if (!allowed || !allowed.length || allowed.includes(prev)) return prev;
    const up = allowed.filter(b => b > prev);
    return up.length ? Math.min(...up) : Math.max(...allowed);
  };
  const here = () => { const c = api.current(); return c ? `${c.id}:${c.state}` : ''; };
  const lands = n => { const l = SB[n] && SB[n].lands; return l ? `${l.app}:${l.state}` : null; };
  const open = () => Date.now() - S.heard < 2500;
  const send = force => {
    const cur = api.current(); if (!cur) return;
    const msg = { t: 'state', beat: S.beat, app: cur.id, state: cur.state };
    const k = JSON.stringify(msg);
    if (!force && k === S.sent) return;
    S.sent = k; ch.postMessage(msg);
  };
  const poll = () => {
    if (S.pending) return;
    const cur = api.current(); if (!cur) return;
    // A beat key set the beat: the screen it lands on is that beat's, whatever else it belongs to.
    if (S.key === null) { if (window.d1 && window.d1.state.busy) return; S.key = cur.id + ':' + cur.state; return send(false); }
    const key = cur.id + ':' + cur.state;
    if (key !== S.key) { S.key = key; S.beat = pick(S.beat, beatsOf(cur.id, cur.state)); }
    send(false);
  };
  // "Go to this beat on stage": where the beat starts, the way its beat key does (then its go steps). A beat with no
  // screen of its own, or one reached by go steps, whose screen the stage is already on, stays put. The window hears
  // the new beat at once: a stage window the presenter window covers gets no animation frames, so its screen may only
  // catch up once it's in view, and a move that never finishes is let go after 8 s so the next one can run.
  async function goto(beat) {
    const d1 = window.d1, b = SB[beat]; if (!d1 || !b) return;
    if ((!b.own || (b.go || []).length) && here() === lands(beat)) { S.beat = beat; send(true); return; }
    const my = ++S.moves;
    S.pending = true; S.beat = beat; send(true);
    const done = () => {
      if (S.moves !== my || !S.pending) return;
      S.pending = false; S.key = here(); send(true);
    };
    const guard = setTimeout(done, 8000);
    try {
      if (b.jump != null) await d1.jump(b.jump);
      for (const g of b.go || []) { if (g.morph) { d1.activate(g.app); await d1.morph(g.app, g.state); } else await d1.go(g.app, g.state); }
      await d1.idle();
    } catch (e) { /* the screen stays where it got to */ }
    finally { clearTimeout(guard); done(); }
  }
  ch.onmessage = e => {
    const m = e.data || {};
    if (m.t === 'hello') { S.heard = Date.now(); send(true); }
    else if (m.t === 'goto' && Number.isInteger(m.beat) && m.beat >= 0 && m.beat <= LAST) { S.heard = Date.now(); goto(m.beat); }
  };
  api.on('jump', n => { if (!S.pending) { S.beat = Math.min(n, LAST); S.key = null; send(true); } });
  api.on('activate', () => setTimeout(poll, 0));
  setInterval(poll, 200);
  api.on('key', e => {
    if (presenterKey(e) && !e.shiftKey && e.code === 'KeyG') {
      const w = window.open('/presenter.html', name, 'popup,width=1600,height=1000');
      if (w) w.focus();
      return true;
    }
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || !open() || S.pending || !notes) return false;
    const fwd = e.code === 'ArrowRight' || e.code === 'PageDown', back = e.code === 'ArrowLeft' || e.code === 'PageUp';
    if (!fwd && !back) return false;
    const k = here();
    // The next beat starts on this very screen (a beat with no screen of its own, or a title slide that is both ⌥0
    // and ⌥1): the window steps there, the screen stays.
    if (fwd && S.beat < LAST && lands(S.beat + 1) === k) { S.beat++; send(true); return true; }
    if (back && S.beat > 0 && lands(S.beat) === k && lands(S.beat - 1) === k) { S.beat--; send(true); return true; }
    return false;
  });
  api.expose('presenter', { get beat() { return S.beat; }, get open() { return open(); }, get pending() { return S.pending; }, notes });
}
