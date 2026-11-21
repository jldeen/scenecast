// The capture window: on top of the browser while recording. It follows the recording through the app's events (the
// same `job` events the main window gets) and has the controls a presenter needs without going back to the app: Pause,
// Go on, Stop, and Copilot's "May I?" questions. Stop goes through the main window, which saves the recording and
// takes the presenter on to Review.
const { invoke } = window.__TAURI__.core;
const { listen, emitTo } = window.__TAURI__.event;
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const STOP = svg('<rect x="6" y="6" width="12" height="12" rx="1"/>');
const SPARK = svg('<path d="M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8z"/>');
const ASKS = new Set(['confirm', 'question', 'you-do']);

const C = { demo: null, copilot: false, title: '', status: null, events: [], tooSoon: 0, blocked: null, off: null, busy: false, stopping: false };
// An app's name as the main window shows it ("teams" is "Teams", "iq" is "IQ").
const appName = id => { const s = String(id || '').replace(/[-_]+/g, ' ').trim(); return s.length <= 3 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1); };
const clock = s => s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const question = () => {
  const answered = new Set(C.events.filter(e => e.event === 'answered').map(e => e.data.id));
  return [...C.events].reverse().find(e => ASKS.has(e.event) && !answered.has(e.data.id));
};

function render() {
  const st = C.status || {}, n = st.count ?? 0, q = C.copilot ? question() : null;
  const held = st.held, step = C.events.filter(e => e.event === 'step').at(-1)?.data;
  let state, title = C.copilot ? 'Copilot is recording' : 'Recording', body = '', foot = '';
  const what = C.title ? `<div class="cap-what" data-test="capture-demo">${esc(C.title)}</div>` : '';
  if (q) {
    state = 'ask';
    const x = q.data;
    const ask = q.event === 'confirm'
      ? `<div class="cap-big">${SPARK}May I?</div><div class="cap-sub">Next: <strong>${esc(x.step)}</strong> in ${esc(appName(x.app))}. ${esc(x.why || '')}</div>
         <div class="cap-asks"><button class="btn primary small" data-answer="do" data-qid="${esc(x.id)}" data-test="capture-do">Do it</button><button class="btn small" data-answer="self" data-qid="${esc(x.id)}">I'll click it</button><button class="btn small subtle" data-answer="skip" data-qid="${esc(x.id)}">Skip</button></div>`
      : `<div class="cap-big">${SPARK}${q.event === 'you-do' ? 'Your turn' : 'I need a hand'}</div><div class="cap-sub">${esc(x.text)}</div>
         <div class="cap-asks"><button class="btn primary small" data-answer="done" data-qid="${esc(x.id)}" data-test="capture-did">I did it</button><button class="btn small subtle" data-answer="skip" data-qid="${esc(x.id)}">Skip</button></div>`;
    body = what + ask;
  } else if (C.copilot) {
    state = 'copilot';
    body = `${what}<div class="cap-big" data-test="capture-state" data-state="copilot">${step ? esc(step.text) : 'Getting ready'}</div>
      <div class="cap-sub">${step ? `Step ${step.n} of ${step.of}. ` : ''}Keep your hands off the browser until it asks.</div>`;
  } else if (C.off) {
    state = 'off';
    title = 'Paused';
    body = `${what}<div class="cap-big" data-test="capture-state" data-state="off">Bring ${esc(C.off.map(appName).join(' and '))} back</div>
      <div class="cap-sub">To the screen ${C.off.length > 1 ? 'they were' : 'it was'} on when you paused, then pick up again. Or <button class="link" data-do="go-on-anyway" data-test="capture-anyway">go on from here</button>.</div>`;
  } else if (held) {
    state = 'held';
    title = 'Paused';
    body = `${what}<div class="cap-big" data-test="capture-state" data-state="held" data-why="${esc(held.why)}"><span class="s"></span>Paused</div>
      <div class="cap-sub">${held.why === 'bar' ? 'The browser\u2019s debugging bar was closed, so nothing is being recorded.' : 'Nothing you do is recorded.'} Your ${plural(n, 'screen')} ${n === 1 ? 'is' : 'are'} kept.</div>`;
  } else if (!C.status) {
    state = 'starting';
    body = `${what}<div class="cap-big" data-test="capture-state" data-state="starting"><span class="s hold"></span>Getting ready</div>
      <div class="cap-sub">Capturing each start screen. Wait for Ready before you click.</div>`;
  } else if (st.busy) {
    state = 'busy';
    body = `${what}<div class="cap-big" data-test="capture-state" data-state="busy"><span class="s hold"></span>Hold on: capturing</div>
      <div class="progress" role="progressbar" aria-label="Capturing this screen"><div></div></div>
      <div class="cap-sub ${C.tooSoon > Date.now() ? 'warn' : ''}">${C.tooSoon > Date.now() ? 'That click came too early. Do it again when this says Ready.' : 'Menus and hovers on this screen. Clicks wait.'}</div>`;
  } else {
    state = 'ready';
    body = `${what}<div class="cap-big" data-test="capture-state" data-state="ready"><span class="s go"></span>Ready: click next</div>
      <div class="cap-sub ${C.tooSoon > Date.now() ? 'warn' : ''}">${C.tooSoon > Date.now() ? 'That click came too early. Do it again now.' : 'Each new screen is captured before you go on.'}</div>`;
  }
  const count = `<span class="grow" data-test="capture-count" data-count="${n}">${plural(n, 'screen')}</span>`;
  if (C.copilot) foot = `${count}<button class="btn small ${q ? '' : 'primary'}" data-do="stop" data-test="capture-stop" ${C.stopping ? 'disabled' : ''}>${STOP}Stop</button>`;
  else if (held || C.off) foot = `${count}<button class="alink" data-do="stop" data-test="capture-stop" ${C.stopping ? 'disabled' : ''}>Stop</button>
    <button class="btn primary small" data-do="go-on" data-test="capture-go-on" ${C.busy ? 'disabled' : ''}>${held?.why === 'bar' && !C.off ? 'Pick up where I left off' : 'Go on'}</button>`;
  else foot = `${count}<button class="btn small" data-do="pause" data-test="capture-pause" ${!C.status || C.busy ? 'disabled' : ''}>Pause</button>
    <button class="btn primary small" data-do="stop" data-test="capture-stop" ${!C.status || C.stopping ? 'disabled' : ''}>${STOP}Stop</button>`;
  document.body.dataset.state = state;
  $('#cap-title').textContent = title;
  $('#cap-time').textContent = clock(st.chromeSecs);
  put($('#cap-body'), body);
  put($('#cap-foot'), foot);
}
// Only what changed: Pause and Stop stay the same buttons while the count ticks over (a click on a button that was
// just replaced is lost).
function put(el, html) {
  if (el.innerHTML === html) return;
  const next = document.createElement(el.tagName);
  next.innerHTML = html;
  morph(el, next);
}
function morph(from, to) {
  const a = [...from.childNodes], b = [...to.childNodes];
  if (a.length !== b.length) return from.replaceChildren(...b);
  a.forEach((x, i) => {
    const y = b[i];
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return from.replaceChild(y, x);
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
    if (x.isEqualNode(y)) return;
    for (const { name } of [...x.attributes]) if (!y.hasAttribute(name)) x.removeAttribute(name);
    for (const { name, value } of [...y.attributes]) if (x.getAttribute(name) !== value) x.setAttribute(name, value);
    morph(x, y);
  });
}

async function act(what) {
  const id = C.demo;
  C.busy = true; render();
  try {
    if (what === 'pause') { await invoke('record_pause', { id }); C.status = { ...C.status, held: { why: 'you', secs: 0 } }; }
    if (what === 'go-on' || what === 'go-on-anyway') {
      const r = await invoke('record_go_on', { id, anyway: what === 'go-on-anyway' });
      C.off = r?.off?.length ? r.off : null;
      if (!C.off) C.status = { ...C.status, held: undefined };
    }
    if (what === 'stop') {
      C.stopping = true;
      // The main window saves the recording (and goes on to Review); Copilot's run is stopped where it is.
      if (C.copilot) await invoke('ai_stop', { id });
      else await emitTo('main', 'capture', { demo: id, action: 'record-stop' });
    }
  } catch (e) {
    const msg = typeof e === 'string' ? e : e?.message || String(e);
    $('#cap-body').innerHTML = `<div class="cap-big"><span class="s hold"></span>That didn\u2019t work</div><div class="cap-sub">${esc(msg)}</div>`;
    C.busy = false; return;
  }
  C.busy = false; render();
}

document.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t || t.disabled) return;
  if (t.dataset.answer) return invoke('ai_answer', { id: C.demo, question: t.dataset.qid, answer: t.dataset.answer, text: null }).then(() => { C.events.push({ event: 'answered', data: { id: t.dataset.qid } }); render(); });
  if (t.dataset.do) act(t.dataset.do);
});

listen('job', ({ payload: { demo, update: u } }) => {
  if (demo !== C.demo) return;
  if (u.type === 'record' && u.status) {
    const before = C.status?.blocked ?? 0;
    if ((u.status.blocked ?? 0) > before) C.tooSoon = Date.now() + 5000;
    C.status = u.status;
    if (!u.status.held) C.off = null;
  }
  if (u.type === 'event') C.events.push(u);
  render();
});

// Opened (or opened again for another recording): which demo, and what it's called.
window.captureOpen = async () => {
  const o = window.SCENECAST_CAPTURE || {};
  Object.assign(C, { demo: o.demo, copilot: !!o.copilot, status: null, events: [], off: null, stopping: false, tooSoon: 0 });
  render();
  const d = await invoke('get_demo', { id: C.demo }).catch(() => null);
  if (d) C.title = d.title;
  if (!C.copilot) C.status = await invoke('record_status', { id: C.demo }).catch(() => C.status);
  render();
};
window.captureOpen();
setInterval(() => { if (C.tooSoon && C.tooSoon < Date.now()) { C.tooSoon = 0; render(); } }, 1000);
