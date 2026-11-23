// Scenecast's window: the demo library and each step of a demo. Everything goes through the app's commands
// (window.__TAURI__.core.invoke) and their progress events; nothing here touches files or runs anything itself.
import { explain } from './errors.js';
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const S = {
  info: {},
  demos: [],
  view: 'library',
  id: null,
  tab: 'record',
  reviewTab: 'review',
  details: false,
  jobs: {},
  servers: { edit: {}, present: {} },
};
// Where a demo is: Record · Review · Present · Share. S.tab is the panel on screen; Review holds the replica's own
// steps (build, real vs replica, talk track, edit) as its tabs.
const GATES = [['record', 'Record'], ['review', 'Review'], ['present', 'Present'], ['share', 'Share']];
// Review: the show with its screens first; the talk track, the wording and dates, and the build and comparison in
// full are a tab away.
const REVIEW = [['review', 'Review'], ['script', 'Talk track'], ['edit', 'Wording and dates'], ['build', 'Build'], ['fidelity', 'Real vs replica']];
const gateOf = tab => ({ record: 'record', present: 'present', export: 'share' })[tab] || 'review';
const gateTab = g => ({ record: 'record', present: 'present', share: 'export' })[g] || S.reviewTab || 'review';
// Regions drawn before REGIONS is defined (the first run, the AI parts), joined to it once it's there.
const REGIONS_LATE = {};

// ---- Helpers -----------------------------------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const demo = () => S.demos.find(d => d.id === S.id);
const J = id => (S.jobs[id] ??= { running: {} });
const busy = (id = S.id) => Object.keys(J(id).running).length > 0;
const running = (job, id = S.id) => !!J(id).running[job];
const secs = s => s == null ? '—' : s < 60 ? `${(+s).toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
const ago = ms => {
  if (!ms) return 'never';
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};
const isMac = () => S.info.os === 'macos';
const browserName = () => ({ chrome: 'Chrome', edge: 'Edge' })[demo()?.browser || (isMac() ? 'chrome' : 'edge')];
const why = (msg, job) => explain(msg, { browser: browserName(), job, retry: job === 'ai-sign-in' ? 'ai-sign-in' : null,
  appName: id => { const a = demo()?.apps.find(x => x.id === id); return a ? appLabel(a) : id; } });
// An error's one button: an app action, a step to go to, or something to copy.
const actionButton = (a, primary = true, test = 'error-action') => a.action ? `<button type="button" class="btn small ${primary ? 'primary' : ''}" data-action="${esc(a.action)}" data-test="${test}">${esc(a.label)}</button>`
  : a.goto ? `<button type="button" class="btn small ${primary ? 'primary' : ''}" data-goto="${esc(a.goto)}" data-test="${test}">${esc(a.label)}</button>`
    : a.copy ? `<button type="button" class="btn small ${primary ? 'primary' : ''}" data-copy="${esc(a.copy)}" data-test="${test}">${esc(a.label)}</button>` : '';
const folderWord = () => isMac() ? 'Finder' : 'File Explorer';

// ---- The look's small parts ----------------------------------------------------------------------------------------

const svg = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  arrow: svg('<path d="M4 12h15M13 6l6 6-6 6"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', ''),
  x: svg('<path d="M7 7l10 10M17 7 7 17"/>', ''),
  term: svg('<path d="M4 7l5 5-5 5M12 18h8"/>'),
  play: svg('<path d="M7 5l12 7-12 7z"/>'),
  spark: svg('<path d="M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8z"/>'),
};
// A row's marker: done, failed, to do, working, or "you are here".
const mk = (state, label) => `<span class="mk" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${{
  ok: `<span class="ok">${I.check}</span>`, no: `<span class="no">${I.x}</span>`, spin: '<span class="spin"></span>',
  hold: `<span class="hold">${svg('<path d="M12 6.5v7M12 17v.5"/>', '')}</span>`,
  here: `<span class="here">${svg('<path d="M4 12h14M12 6l6 6-6 6"/>', '')}</span>`,
}[state] || '<span class="todo"></span>'}</span>`;
const listWords = xs => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
const clock = n => n == null ? '' : `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`;
// An app by the name the presenter gave it, and a tile in its product's colour (others in turn).
const appLabel = a => {
  const s = String(a.id || '').replace(/[-_]+/g, ' ').trim();
  return s.length <= 3 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1);
};
const TILE = [[/teams\.(cloud\.)?microsoft|teams\.live\.com/, '#5B5FC7'], [/m365\.cloud\.microsoft|copilot\.(cloud\.)?microsoft/, '#0F6CBD'], [/admin\.(cloud\.)?microsoft/, '#C4420F']];
const PALETTE = ['#0E7C86', '#5B5FC7', '#0F6CBD', '#C4420F', '#33414E'];
const tile = (a, i = 0) => {
  const c = TILE.find(([r]) => r.test(a.url || ''))?.[1] || PALETTE[i % PALETTE.length];
  const l = appLabel(a);
  return `<span class="tile" style="background:${c}" aria-hidden="true">${esc(l.length <= 3 ? l : l.charAt(0))}</span>`;
};
// Where a demo stands, in the rail and the library: the step it's at, and when it last moved.
function where(d) {
  const s = d.status;
  const st = J(d.id).record?.status;
  if (st?.recording) return { gate: 'record', word: st.held ? 'Paused' : 'Recording', note: `${plural(st.count || 0, 'screen')} so far` };
  const c = J(d.id).aiChain;
  if (c && !['done', 'error'].includes(c.stage)) return { gate: 'review', word: 'Making', note: c.stage === 'fix' ? 'fixing what differs' : 'the replica' };
  if (c?.checking) return { gate: 'review', word: 'Ready', note: c.checking === 'compare' ? 'comparing with the real product' : 'checking' };
  if (!s.recorded && !s.built) return { gate: 'record', word: 'Record', note: 'not recorded yet' };
  const when = (what, at) => at ? `${what} ${ago(at)}` : what;
  if (!s.built || !s.fidelity?.pass) return { gate: 'review', word: 'Review', note: when('recorded', s.recordedAt) };
  if (s.rehearsedAt) return { gate: 'present', word: 'Ready', note: when('rehearsed', s.rehearsedAt) };
  return { gate: 'present', word: 'Present', note: when('checked', s.lastChecked) };
}
const sepOf = p => String(p).includes('\\') ? '\\' : '/';
const within = (dir, file) => `${dir}${sepOf(dir)}${file}`;
const q = p => /[\s"]/.test(p) ? `"${p}"` : p;

// Each screen's head: what it is, one line under it, and Details (the technical view: folders, files, the matching
// command, diagnostics) behind a button.
// Where the time went (timeline.rs): Recorded in X · finished in Y · built in Z, with what's known.
function timesLine(s) {
  const t = s?.timing; if (!t || t.recordSecs == null) return '';
  const parts = [`Recorded in ${secs(t.recordSecs)}`];
  if (t.finishSecs != null) parts.push(`finished in ${secs(t.finishSecs)}`);
  if (t.buildSecs != null) parts.push(`built in ${secs(t.buildSecs)}`);
  return `<span class="small muted" data-test="times" data-record="${t.recordSecs}" data-finish="${t.finishSecs ?? ''}" data-build="${t.buildSecs ?? ''}">${parts.join(' \u00b7 ')}</span>`;
}
function pageHead({ title, sub = '', test = '', side = '', details = true }) {
  document.title = S.view === 'demo' && demo() ? `${demo().title} · Scenecast` : 'Scenecast';
  return `<div class="page-head"><div class="grow"><h1 ${test ? `data-test="${test}"` : ''}>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${side}
    ${details ? `<button class="detailsbtn" data-action="details" aria-expanded="${S.details}" aria-controls="details" data-test="details">${I.term} Details</button>` : ''}</div>
    ${details ? `<div id="details" class="drawer-wrap" data-test="details-drawer" ${S.details ? '' : 'hidden'}>${detailsBody()}</div>` : ''}`;
}
const dRow = (label, value, act = '') => `<div><dt>${esc(label)}</dt><dd>${value}</dd><dd class="act">${act}</dd></div>`;
const codeV = v => `<code>${esc(v)}</code>`;
const copyBtn = (v, label = 'Copy') => `<button class="btn small" data-copy="${esc(v)}">${esc(label)}</button>`;
const revealBtn = p => `<button class="btn small" data-reveal="${esc(p)}">Show in ${folderWord()}</button>`;
function cliFor(d) {
  const at = `--demo ${q(d.dir)}`;
  return {
    record: `scenecast record start ${at}`, build: `scenecast build ${at}`, fidelity: `scenecast fidelity ${at}`,
    script: `scenecast script ${q(within(d.dir, 'script.md'))} ${at}`, edit: `scenecast edit ${at}`,
    present: `scenecast present ${at}`, export: `scenecast check ${at}`,
  }[S.tab] || `scenecast status ${at}`;
}
function detailsBody() {
  const lib = S.info.library || '';
  const foot = extra => `<div class="full"><button class="btn small" data-action="diagnostics" data-test="copy-diagnostics">Copy diagnostics</button>
    <button class="btn small" data-action="show-logs" data-test="show-logs">Show the logs</button>${extra || ''}</div>`;
  if (S.view === 'demo' && demo()) {
    const d = demo();
    const cli = cliFor(d);
    const slots = [0, 180, 300, 480, 600, 900, 1200, 1800];
    if (d.slot && !slots.includes(d.slot)) slots.push(d.slot);
    return `<dl class="drawer">
      ${dRow('Folder', codeV(d.dir), revealBtn(d.dir) + copyBtn(d.dir))}
      ${dRow('Settings', codeV(within(d.dir, 'demo.json')), `<button class="btn small" data-open-file="${esc(within(d.dir, 'demo.json'))}">Open</button>`)}
      ${dRow('Browser', `<label class="visually-hidden" for="browser">Record in</label><select id="browser" class="inline" data-test="browser">${['chrome', 'edge'].map(b => `<option value="${b}" ${d.browser === b ? 'selected' : ''}>${BNAME[b]}</option>`).join('')}</select>
        <span class="muted"> · ${esc(d.profile ? profileName(J(d.id).profiles, d.profile) || d.profile : 'the profile the recorder is in')}</span>
        <div id="profile-pick" data-test="profile-pick" ${J(d.id).pickProfile ? '' : 'hidden'} style="margin-top:8px">${J(d.id).pickProfile ? profileOptions(J(d.id).profiles, d.profile || '') : ''}</div>`,
        `<button class="btn small" data-action="use-profile" aria-expanded="${!!J(d.id).pickProfile}">Use a different profile</button>`)}
      ${S.tab === 'record' ? dRow('Readiness', 'The check Start runs, on its own.', `<button class="btn small" data-action="preflight" data-test="preflight">Run the check</button><button class="btn small" data-action="preflight-fix" data-test="preflight-fix">Check and fix</button>`) : ''}
      ${dRow('Recorder', '<span data-region="recorder-details"></span>')}
      ${dRow('Slot', `<label class="visually-hidden" for="slot-pick">Slot length</label><select id="slot-pick" class="inline" data-test="slot-pick">${slots.sort((a, b) => a - b).map(s => `<option value="${s}" ${(d.slot || 0) === s ? 'selected' : ''}>${s ? `${s / 60} min` : 'No set length'}</option>`).join('')}</select>`)}
      ${dRow('Command line', codeV(cli), copyBtn(cli))}
      </dl>${foot(`<span class="spacer"></span><button class="btn small" data-duplicate="${esc(d.id)}">Duplicate this demo</button>
        <button class="btn small danger" data-delete="${esc(d.id)}">Delete this demo</button>`)}`;
  }
  if (S.view === 'new') return `<dl class="drawer">${dRow('Saved in', codeV(lib), revealBtn(lib))}
    ${dRow('Command line', codeV('scenecast new <folder> --title "<name>" --app <name>=<address>'), copyBtn('scenecast new <folder> --title "<name>" --app <name>=<address>'))}</dl>${foot()}`;
  if (S.view === 'copilot') return `<dl class="drawer">${dRow('Command line', codeV('scenecast ai status'), copyBtn('scenecast ai status'))}
    ${dRow('Model', esc(AI.settings?.model || 'auto'))}</dl>${foot()}`;
  const b = FR.browser || defaultBrowser();
  return `<dl class="drawer">${dRow('Your demos', codeV(lib), revealBtn(lib) + copyBtn(lib))}
    ${dRow('Engine', codeV(S.info.engine || S.info.engineError || ''))}
    ${dRow('Command line', codeV(`scenecast profiles --browser ${b}`), copyBtn(`scenecast profiles --browser ${b}`))}</dl>${foot()}`;
}
// One block of text a technical presenter (or whoever helps) can paste: versions, the demo, the recorder, each step's
// last answer and error, and the end of each step's log.
function diagnostics() {
  const out = [`Scenecast ${S.info.version} on ${S.info.os}`, `Library: ${S.info.library}`, `Engine: ${S.info.engine || S.info.engineError || '?'}`,
    `Copilot: ${AI.status?.signedIn ? 'signed in' : 'not signed in'}`];
  const d = demo();
  if (d) {
    out.push('', `Demo: ${d.title} (${d.id}), made ${d.mode}`, `Folder: ${d.dir}`, `Browser: ${d.browser}, profile ${d.profile || '(the one that\u2019s open)'}`,
      `Apps: ${d.apps.map(a => `${a.id}=${a.url}`).join(' ')}`, `Status: ${JSON.stringify(d.status)}`, `Recorder: ${JSON.stringify(S.rx || {})}`);
    for (const [job, j] of Object.entries(J(d.id))) {
      if (job === 'running' || !j || typeof j !== 'object') continue;
      if (j.error) out.push(`${job}: error: ${j.error}`);
      if (j.items?.length) out.push(`${job}: ${j.items.map(i => `${i.id} ${i.status}${i.status !== 'ok' && i.detail ? ` (${i.detail})` : ''}`).join('; ')}`);
      const tail = (j.lines || []).slice(-20).map(l => `  ${l.text}`);
      if (tail.length) out.push(`${job} log:`, ...tail);
    }
  }
  return out.join('\n');
}

function announce(text) {
  const a = $('#announcer');
  a.textContent = '';
  setTimeout(() => { a.textContent = text; }, 30);
}
function toast(text, bad = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = text;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 9000 : 4500);
}
async function call(cmd, args = {}) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    const msg = typeof e === 'string' ? e : e?.message || String(e);
    const x = why(msg);
    if (x) toast(`${x.title}. ${x.body}`, true);
    throw new Error(msg);
  }
}
// Runs a step's command with the demo marked busy, re-rendering what depends on it.
// A newer run of the same job (Check pressed again, then Check and fix) takes its place: the older one's answer is
// dropped, and only the newest clears the job's busy mark.
// args.id: a demo other than the one open (the chain after Stop goes on if the presenter opens another).
async function step(job, cmd, args, after) {
  const id = args?.id || S.id;
  const token = {};
  J(id).running[job] = true;
  (J(id).owned ??= {})[job] = token;
  J(id)[job] = { ...(J(id)[job] || {}), stages: [], lines: [], items: [], events: [], error: null, outcome: null, startedAt: Date.now(), token };
  const mine = () => J(id)[job]?.token === token;
  rerender();
  try {
    const out = await invoke(cmd, { id, ...args });
    if (!mine()) return;
    J(id)[job].outcome = out;
    if (after) await after(out);
    return out;
  } catch (e) {
    if (!mine()) return;
    const msg = typeof e === 'string' ? e : e?.message || String(e);
    // Shown once: in the step's own place when it's on screen, otherwise as a toast.
    const x = why(msg, job);
    if (x && !(S.view === 'demo' && S.id === id && tabJobs(S.tab).includes(job))) toast(`${x.title}. ${x.body}`, true);
    J(id)[job].error = msg;
  } finally {
    if (mine()) { delete J(id).running[job]; delete J(id).owned[job]; }
    await refreshDemo(id);
    rerender();
  }
}

function dialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
  const d = $('#dialog');
  d.innerHTML = `<form method="dialog"><div class="body"><h2 id="dialog-title">${esc(title)}</h2>${body}</div>
    <div class="foot">${cancel ? `<button class="btn" value="cancel">${esc(cancel)}</button>` : ''}
    <button class="btn primary${danger ? ' destructive' : ''}" value="ok" data-test="dialog-ok">${esc(ok)}</button></div></form>`;
  return new Promise(res => {
    d.onclose = () => res(d.returnValue === 'ok' ? Object.fromEntries(new FormData($('form', d))) : null);
    d.showModal();
    ($('input', d) || $('[value=ok]', d)).focus();
  });
}

// ---- Data --------------------------------------------------------------------------------------------------------

async function loadDemos() {
  S.demos = await call('list_demos');
  renderSidebar();
}
async function refreshDemo(id) {
  try {
    const d = await invoke('get_demo', { id });
    const i = S.demos.findIndex(x => x.id === id);
    if (i >= 0) S.demos[i] = d; else S.demos.push(d);
    renderSidebar();
  } catch { /* deleted meanwhile */ }
}

// ---- Events from the app -----------------------------------------------------------------------------------------

listen('job', ({ payload: { demo: id, job, update: u } }) => {
  const j = (J(id)[job] ??= { stages: [], lines: [], items: [], events: [] });
  j.stages ??= []; j.lines ??= []; j.items ??= []; j.events ??= [];
  switch (u.type) {
    case 'stage':
      j.stages.push(u);
      if (id === S.id) announce(u.label);
      break;
    case 'line':
      j.lines.push(u);
      if (j.lines.length > 400) j.lines.splice(0, j.lines.length - 400);
      break;
    case 'preflight':
      j.items = j.items.filter(i => i.id !== u.item.id).concat(u.item);
      break;
    case 'record':
      if (!u.status?.held) J(id).goOnOff = null;
      if ((j.status?.count ?? -1) !== u.status?.count || !!j.status?.recording !== !!u.status?.recording || !!j.status?.held !== !!u.status?.held) {
        // The page title says Recording or Paused too.
        const flipped = !!j.status?.held !== !!u.status?.held || !!j.status?.recording !== !!u.status?.recording;
        j.status = u.status; renderSidebar();
        if (flipped && id === S.id && S.view === 'demo') renderHead();
      }
      j.status = u.status;
      break;
    case 'check':
      j.items.push(u);
      break;
    case 'event':
      j.events.push(u);
      if (job === 'fidelity' && u.event === 'compared') reloadReviewSoon(id);
      break;
    case 'saved':
      (j.saved ??= []).push(u.data);
      if (id === S.id) announce(`Saved: ${u.data.what || 'a change'}`);
      break;
  }
  if (id === S.id) scheduleRegions();
});
// Stop, pressed in the capture window: saved here, on this demo's Record screen (then on to Review).
listen('capture', async ({ payload: { demo: id, action } }) => {
  if (action !== 'record-stop' || !S.demos.some(d => d.id === id)) return;
  if (S.view !== 'demo' || S.id !== id) await openDemo(id, 'record');
  await ACTIONS['record-stop']();
});
// A job's busy mark. The app says it's done when its command ends, a moment before the page has the command's answer:
// for a job this page started (step), the mark stays until step has the answer (or error) in place, so nothing reads
// "finished, no result" (Nov 23: the quick checks after a script read that, though they passed). Jobs the app runs on
// its own (the background compare) follow the app.
listen('job-state', ({ payload: { demo: id, job, running: on } }) => {
  if (on) J(id).running[job] = true; else if (!J(id).owned?.[job]) delete J(id).running[job];
  if (id === S.id) renderTabsBar();
});

// The next frame, or a timer: macOS pauses animation frames while the window is covered (the browser is in front
// during Record for me), and the progress and "May I?" questions must still be there when the presenter looks.
let regionsQueued = false;
function scheduleRegions() {
  if (regionsQueued) return;
  regionsQueued = true;
  const go = () => { if (!regionsQueued) return; regionsQueued = false; renderRegions(); };
  requestAnimationFrame(go);
  setTimeout(go, 250);
}

// ---- The rail ----------------------------------------------------------------------------------------------------

function renderSidebar() {
  $('#nav-library').setAttribute('aria-current', S.view === 'library' ? 'page' : 'false');
  $('#new-demo').setAttribute('aria-current', S.view === 'new' ? 'page' : 'false');
  $('#nav-copilot').setAttribute('aria-current', S.view === 'copilot' ? 'page' : 'false');
  const next = document.createElement('ul');
  next.innerHTML = S.demos.map(d => {
    const w = where(d);
    return `<li><button data-open="${esc(d.id)}" data-test="demo-${esc(d.id)}" ${S.view === 'demo' && S.id === d.id ? 'aria-current="page"' : ''}>
    <span class="title">${esc(d.title)}</span><span class="sub"><em>${esc(w.word)}</em> · ${esc(w.note)}</span></button></li>`;
  }).join('') || '<li class="none">None yet. Your demos show up here.</li>';
  morph($('#demo-list'), next);
}
// "Recorded 10 min ago" stays true while the window sits open.
setInterval(renderSidebar, 60 * 1000);

// ---- Your demos, and the first run ---------------------------------------------------------------------------------

function matchWords(s) {
  const f = s.fidelity;
  if (!s.built) return s.recorded ? 'not built yet' : '';
  if (!f) return 'not compared yet';
  const views = f.viewsDiffer ? ` \u00b7 ${viewsWords(f.viewsDiffer)}` : '';
  return f.within === f.total ? (f.viewsDiffer ? `every screen matches${views}` : 'every screen matches') : `${plural(f.total - f.within, 'screen')} to look at${views}`;
}
function renderLibrary() {
  S.view = 'library';
  S.id = null;
  renderSidebar();
  if (!S.demos.length) return renderFirstRun();
  const main = $('#main');
  main.innerHTML = `${pageHead({ title: 'Your demos', sub: 'Pick up where you left off, or make a new one.' })}
    <table class="data" aria-label="Demos">
    <thead><tr><th scope="col">Demo</th><th scope="col">Where it is</th><th scope="col">Last checked</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>${S.demos.map(d => {
      const s = d.status, w = where(d);
      return `<tr data-test="row-${esc(d.id)}">
        <td class="title-cell"><button class="link" data-open="${esc(d.id)}">${esc(d.title)}</button>
          <div class="app-cell small muted" style="margin-top:6px">${d.apps.map(tile).join('')}<span>${esc(listWords(d.apps.map(appLabel)))}</span></div></td>
        <td><span class="state ${w.gate === 'present' ? 'ok' : 'idle'}">${esc(w.word)}</span>
          <div class="small muted">${s.recorded ? `${plural(s.screens, 'screen')}${matchWords(s) ? ` · ${esc(matchWords(s))}` : ''}` : 'Not recorded yet'}</div></td>
        <td>${s.lastChecked ? esc(ago(s.lastChecked)) : '<span class="muted">Not yet</span>'}</td>
        <td><div class="row" style="justify-content:flex-end">
          <button class="btn small" data-open="${esc(d.id)}" aria-label="Open ${esc(d.title)}">Open</button>
          <button class="btn small subtle" data-duplicate="${esc(d.id)}" aria-label="Duplicate ${esc(d.title)}">Duplicate</button>
          <button class="btn small subtle danger" data-delete="${esc(d.id)}" aria-label="Delete ${esc(d.title)}">Delete</button>
        </div></td></tr>`;
    }).join('')}</tbody></table>`;
}

// The first run: Scenecast finds the browser and the profile itself, says what's left, and offers one next step.
const FR = { info: null, browser: null, picking: false };
const defaultBrowser = () => localStorage.getItem('scenecast.browser') || (isMac() ? 'chrome' : 'edge');
const savedProfile = () => localStorage.getItem('scenecast.profile') || '';
const profileName = (info, dir) => {
  const p = info?.profiles?.find(x => x.dir === (dir || info.picked));
  return p ? p.name : '';
};
async function loadBrowser(b = defaultBrowser()) {
  FR.browser = b;
  FR.info = null;
  renderRegions();
  const info = await invoke('browser_profiles', { browser: b }).catch(e => ({ error: String(e), browser: b }));
  if (FR.browser === b) { FR.info = info; renderRegions(); }
}
function renderFirstRun() {
  $('#main').innerHTML = `${pageHead({ title: 'Let\u2019s get you ready to record', sub: 'Scenecast sets this up for you. It takes about a minute, once.' })}
    <section class="card rundown compact" aria-labelledby="fr-title" data-test="first-run">
      <div class="rd-head"><div class="grow"><h2 id="fr-title">Before your first recording</h2><small data-region="first-left"></small></div>
        <div class="next"><button class="btn primary big" data-action="new" data-test="empty-new">Make your first demo ${I.arrow}</button></div></div>
      <div data-region="first-run"></div>
    </section>
    <p class="muted" style="margin-top:14px">Scenecast never restarts your browser or changes your tabs without asking.</p>`;
  renderRegions();
  if (!FR.info) loadBrowser();
}
Object.assign(REGIONS_LATE, {
  'first-left'() {
    const i = FR.info;
    const ready = i && !i.error && i.profiles?.length;
    const rec = i?.profiles?.some(p => p.extension?.id);
    const left = (ready ? 0 : 1) + (rec ? 0 : 1);
    return left ? `${plural(left, 'step')} left, and Scenecast does ${left === 1 ? 'it' : 'them'} with your first demo` : 'All set';
  },
  'first-run'() {
    const i = FR.info, b = FR.browser || defaultBrowser(), name = BNAME[b] || b;
    const other = b === 'chrome' ? 'edge' : 'chrome';
    let browser;
    if (!i) browser = `<div class="rd-row">${mk('spin')}<div class="t"><b>Your browser</b><small>Looking for ${esc(name)} and the profile you use for work…</small></div><span class="state idle">Looking</span></div>`;
    else if (i.error || !i.profiles?.length) browser = `<div class="rd-row" data-test="fr-browser" data-status="fail">${mk('no', 'Not found')}<div class="t"><b>${esc(name)} isn\u2019t set up on this computer</b>
      <small>Open it once and sign in to your work account, or record in ${esc(BNAME[other])}.</small></div>
      <button class="alink" data-action="first-browser" data-browser="${other}">Use ${esc(BNAME[other])}</button></div>`;
    else {
      const who = profileName(i, savedProfile());
      browser = `<div class="rd-row" data-test="fr-browser" data-status="ok">${mk('ok', 'Found')}<div class="t"><b>Your browser: ${esc(name)}${who ? `, signed in as ${esc(who)}` : ''}</b>
        <small>The profile you use for work. <button class="alink" data-action="first-pick" aria-expanded="${FR.picking}">Use a different one</button></small></div><span class="state ok">Found</span></div>
        ${FR.picking ? `<div class="rd-row"><span></span><div class="more-row"><fieldset><legend class="small">Record in</legend>
          ${['chrome', 'edge'].map(x => `<label class="choice"><input type="radio" name="fr-browser" value="${x}" ${x === b ? 'checked' : ''}> ${BNAME[x]}</label>`).join('')}</fieldset>
          <div id="fr-profiles" style="margin-top:8px">${profileOptions(i, savedProfile())}</div></div></div>` : ''}`;
    }
    const rec = i?.profiles?.find(p => p.extension?.id);
    const recorder = rec ? `<div class="rd-row" data-test="fr-recorder" data-status="ok">${mk('ok', 'Added')}<div class="t"><b>The Scenecast recorder</b><small>It\u2019s in ${esc(name)} already${rec.name ? `, in ${esc(rec.name)}` : ''}.</small></div><span class="state ok">Added</span></div>`
      : `<div class="rd-row" data-test="fr-recorder" data-status="todo">${mk('todo')}<div class="t"><b>The Scenecast recorder</b><small>Scenecast adds it to ${esc(name)} with your first demo: one step, once.</small></div><span class="state idle">With your first demo</span></div>`;
    const st = AI.status;
    const copilot = st?.signedIn ? `<div class="rd-row" data-test="fr-copilot" data-status="ok">${mk('ok', 'Signed in')}<div class="t"><b>GitHub Copilot</b><small>Signed in as ${esc(st.login || 'you')}: Copilot can click through a demo for you.</small></div><span class="state ok">Signed in</span></div>`
      : `<div class="rd-row" data-test="fr-copilot" data-status="todo">${mk(AI.signing ? 'spin' : 'todo')}<div class="t"><b>GitHub Copilot <span class="muted">(optional)</span></b><small>Lets Copilot click through a demo for you. You can sign in when you first use it.</small></div>
        ${AI.signing ? '<span class="state idle">Signing in</span>' : '<button class="alink" data-action="ai-sign-in" data-test="fr-sign-in">Sign in now</button>'}</div>
        <div class="rd-row" style="border-top:0;min-height:0;padding-top:0"><span></span><div class="more-row" data-region="copilot-signin"></div></div>`;
    return browser + recorder + copilot;
  },
});

async function duplicateDemo(id) {
  const d = S.demos.find(x => x.id === id);
  const r = await dialog({ title: 'Duplicate demo', ok: 'Duplicate',
    body: `<label for="dup-title">Name of the copy</label><input id="dup-title" name="title" type="text" value="${esc(d.title)} copy" data-test="dup-title">
      <p class="muted small" style="margin-top:8px">The copy has the recording too, and its own folder.</p>` });
  if (!r) return;
  const copy = await call('duplicate_demo', { id, title: r.title });
  await loadDemos();
  toast(`Made "${copy.title}"`);
  S.view === 'library' ? renderLibrary() : openDemo(copy.id);
}
async function deleteDemo(id) {
  const d = S.demos.find(x => x.id === id);
  const r = await dialog({ title: `Delete "${d.title}"?`, ok: 'Delete', danger: true,
    body: `<p>The demo and its recording go to the ${isMac() ? 'Trash' : 'Recycle Bin'}.</p>` });
  if (!r) return;
  const how = await call('delete_demo', { id });
  delete S.jobs[id];
  await loadDemos();
  toast(`"${d.title}" ${how}`);
  renderLibrary();
}

// ---- New demo ----------------------------------------------------------------------------------------------------

function appRow(i, app = {}) {
  return `<div class="app-row" data-app-row>
    <div><label class="visually-hidden" for="app-id-${i}">App ${i + 1} name</label>
      <input id="app-id-${i}" type="text" placeholder="Name, like Teams" value="${esc(app.id)}" data-app-id data-test="app-id-${i}"></div>
    <div><label class="visually-hidden" for="app-url-${i}">App ${i + 1} start page</label>
      <input id="app-url-${i}" type="url" placeholder="Its start page: https://…" value="${esc(app.url)}" data-app-url data-test="app-url-${i}"></div>
    <button type="button" class="btn subtle" data-remove-app aria-label="Remove app ${i + 1}">Remove</button></div>`;
}
const aiMode = m => m === 'record' || m === 'script' || m === 'coach';
const SLOTS = [[0, 'No set length'], [180, '3 min'], [300, '5 min'], [480, '8 min'], [600, '10 min'], [900, '15 min'], [1200, '20 min'], [1800, '30 min']];
function renderNew() {
  S.view = 'new';
  S.id = null;
  Object.assign(NEW, { tabs: null, ticked: new Set(), all: false, tries: 0 });
  renderSidebar();
  const mode = 'manual';
  $('#main').innerHTML = `${pageHead({ title: 'New demo', sub: 'Name it and add its apps. You can change both later.' })}
    <div class="split">
    <form id="new-form" class="card" novalidate data-mode="${mode}">
      <div class="field"><label for="new-title">Name</label><input id="new-title" type="text" required placeholder="Innovation Act 1 · Demo 1" data-test="new-title"></div>
      <fieldset class="field"><legend>Which apps does it show? <span class="hint" id="apps-hint">Each one\u2019s start page. On stage you switch to an app with ${isMac() ? '⌥' : 'Ctrl+Alt+'} and its first letter.</span></legend>
        <div id="tab-list" class="tab-list" data-test="tab-list" hidden></div>
        <button type="button" class="alink" id="show-manual" data-test="show-manual" hidden>Add one that isn\u2019t open</button>
        <div id="manual-apps"><div id="apps">${appRow(0)}</div>
        <button type="button" class="alink" id="add-app" data-test="add-app">Add another app</button></div></fieldset>
      <div class="field"><label for="new-script">Your talk track <span class="hint">Optional. Paste it now or add it later.</span></label>
        <textarea id="new-script" rows="4" data-test="new-script" placeholder="## The late shipment lands in Teams (0:00–1:15)&#10;&gt; Kestrel just told us PO-450101 will ship six days late."></textarea>
        <p class="hint" style="margin-top:4px">Each <code>##</code> heading starts a beat; a time like <code>(0:00–1:15)</code> gives it its place in your slot.</p></div>
      <div class="field"><p class="small muted" id="new-where" data-test="new-where">Looking at your browser…</p>
        <div id="new-where-box" hidden>
          <fieldset><legend class="small">Record in</legend>
            ${['chrome', 'edge'].map(x => `<label class="choice"><input type="radio" name="browser" value="${x}" ${x === defaultBrowser() ? 'checked' : ''}> ${BNAME[x]}</label>`).join('')}</fieldset></div></div>
      <p id="new-error" class="notice bad" hidden role="alert"></p>
      <div class="form-foot"><label for="new-slot">Slot</label>
        <select id="new-slot" class="inline" data-test="new-slot">${SLOTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <span class="spacer"></span><button class="btn primary big" type="submit" data-test="create-demo">Create demo ${I.arrow}</button></div>
    </form>
    <aside class="card"><h2>What happens next</h2>
      <p>Scenecast opens anything that isn\u2019t open yet, checks each app is on its start screen, and shows you the run of show.</p>
      <p>Then you click through it once, or let Copilot click for you. Scenecast turns it into a replica that runs the same way every time, with no network.</p></aside>
    </div>`;
  $('#new-title').focus();
  renderRegions();
  const form = $('#new-form');
  loadOpenTabs();
  // The browser and profile are the ones the recorder is in (slice 7): nothing to choose, unless it's in neither.
  const where = async (b, info) => {
    const p = info?.profiles?.find(x => x.extension?.id && x.extension.enabled !== false) || info?.profiles?.find(x => x.dir === info.picked);
    $('#new-where').innerHTML = `Records in <strong>${esc(BNAME[b])}</strong>${p ? ` as <strong>${esc(p.name)}</strong>` : ''}. <button type="button" class="alink" data-action="new-where" aria-expanded="${!$('#new-where-box').hidden}" aria-controls="new-where-box">Change</button>`;
  };
  const load = async (b = form.browser.value) => where(b, await invoke('browser_profiles', { browser: b }).catch(() => null));
  form.addEventListener('change', e => { if (e.target.name === 'browser') load(); });
  (async () => {
    // First time: whichever browser has the recorder (else the one the first run found, else this system's usual).
    const [c, e] = await Promise.all(['chrome', 'edge'].map(b => invoke('browser_profiles', { browser: b }).catch(() => null)));
    if (!form.isConnected) return;
    const has = i => i?.profiles?.some(x => x.extension?.id);
    const b = localStorage.getItem('scenecast.browser') || (has(c) && !has(e) ? 'chrome' : has(e) && !has(c) ? 'edge' : defaultBrowser());
    form.querySelector(`[name=browser][value=${b}]`).checked = true;
    where(b, b === 'chrome' ? c : e);
  })();
}
// New demo from the browser's open tabs (slice 11): the recorder lists them; the product ones are ticked, one per
// address, in the browser's own order. Read again when the window comes back to the front (a tab opened meanwhile).
const GENERIC_HOST = new Set(['www', 'app', 'apps', 'portal', 'web', 'my', 'daily', 'go', 'beta', 'preview', 'insiders']);
// An app's name from its address, as the app names it (library.rs app_id_from_url): preview.iq.example.com is iq.
const nameFor = url => {
  try {
    const u = new URL(url), h = u.hostname;
    if (h === 'localhost' || /^[\d.]+$/.test(h)) return (u.pathname.split('/')[1] || 'app').toLowerCase();
    const parts = h.split('.');
    return parts.slice(0, Math.max(1, parts.length - 1)).find(p => !GENERIC_HOST.has(p)) || parts[0];
  } catch { return 'app'; }
};
// Ticked to start with: Microsoft product pages. Not mail (an inbox would be recorded), sign-in or docs; anything else
// is a tick away.
const PRODUCT_HOST = /(^|\.)(cloud\.microsoft|microsoft\.com|office\.com|microsoft365\.com|sharepoint\.com|azure\.com|powerbi\.com|dynamics\.com|powerapps\.com)$/i;
const NOT_A_PRODUCT = /^(learn|support|docs|techcommunity|answers|login|account|myaccount|go|outlook|mail)\./i;
const NEW = { tabs: null, ticked: new Set(), all: false };
async function loadOpenTabs() {
  const tabs = await invoke('open_tabs').catch(() => []);
  if (S.view !== 'new' || !$('#tab-list')) return;
  // None yet (the recorder busy, reconnecting, or connecting for the first time): ask again in a moment, for a minute.
  if (!tabs?.length && !NEW.tabs?.length && (NEW.tries = (NEW.tries || 0) + 1) <= 20) setTimeout(() => { if (S.view === 'new') loadOpenTabs(); }, 3000);
  const first = NEW.tabs === null;
  // One row per address (the same page open twice is one app).
  const seen = new Set();
  NEW.tabs = (tabs || []).filter(t => !seen.has(t.url) && seen.add(t.url));
  if (first) {
    const hosts = new Set();
    for (const t of NEW.tabs) {
      const h = new URL(t.url).hostname;
      if (PRODUCT_HOST.test(h) && !NOT_A_PRODUCT.test(h) && !hosts.has(h) && hosts.size < 6) { hosts.add(h); NEW.ticked.add(t.url); }
    }
  }
  renderOpenTabs();
}
function renderOpenTabs() {
  const box = $('#tab-list');
  if (!box) return;
  const tabs = NEW.tabs || [];
  const has = tabs.length > 0, manual = $('#manual-apps');
  box.hidden = !has;
  // No open tabs (or no recorder yet): addresses typed in, as before. Tabs: typing one in is a click away.
  if (!has) { manual.hidden = false; $('#show-manual').hidden = true; return; }
  // Addresses typed in before the tabs came stay where they are.
  if ([...document.querySelectorAll('[data-app-url]')].some(i => i.value.trim())) manual.dataset.shown = '1';
  manual.hidden = !manual.dataset.shown;
  $('#show-manual').hidden = !!manual.dataset.shown;
  $('#apps-hint').textContent = `Your open tabs: tick the ones in the demo, on the page it starts from. On stage you switch to an app with ${isMac() ? '⌥' : 'Ctrl+Alt+'} and its first letter.`;
  // The ticked ones first, then the rest, each in the browser's order.
  const order = [...tabs.filter(t => NEW.ticked.has(t.url)), ...tabs.filter(t => !NEW.ticked.has(t.url))];
  const shown = NEW.all ? order : order.slice(0, Math.max(8, NEW.ticked.size));
  box.innerHTML = shown.map((t, i) => {
    const u = new URL(t.url);
    return `<label class="tab-row" data-test="tab-row" data-url="${esc(t.url)}"><input type="checkbox" data-tab-url="${esc(t.url)}" ${NEW.ticked.has(t.url) ? 'checked' : ''}>
      ${tile({ id: nameFor(t.url), url: t.url }, i)}<span class="t"><b>${esc(t.title || u.hostname)}</b><small>${esc(u.hostname + (u.pathname.length > 1 ? u.pathname : ''))}</small></span></label>`;
  }).join('') + (order.length > shown.length ? `<button type="button" class="alink tab-more" data-test="tab-more">Show all ${order.length} tabs</button>` : '');
  createLabel();
}
document.addEventListener('change', e => {
  const url = e.target.dataset?.tabUrl;
  if (!url) return;
  if (e.target.checked) NEW.ticked.add(url); else NEW.ticked.delete(url);
  createLabel();
});
// The button says what it makes: "Create with 4 apps".
function createLabel() {
  const btn = $('[data-test="create-demo"]');
  if (!btn) return;
  const n = NEW.ticked.size + [...document.querySelectorAll('[data-app-url]')].filter(i => i.value.trim()).length;
  btn.innerHTML = `${NEW.tabs?.length && n ? `Create with ${plural(n, 'app')}` : 'Create demo'} ${I.arrow}`;
}
document.addEventListener('click', e => {
  if (e.target.closest('.tab-more')) { NEW.all = true; renderOpenTabs(); }
  if (e.target.closest('#show-manual')) { $('#manual-apps').hidden = false; $('#manual-apps').dataset.shown = '1'; $('#show-manual').hidden = true; $('#app-url-0')?.focus(); }
});
window.addEventListener('focus', () => { if (S.view === 'new' && NEW.tabs) loadOpenTabs(); });
async function createDemo(form) {
  const typed = [...form.querySelectorAll('[data-app-row]')].map(r => ({ id: $('[data-app-id]', r).value.trim(), url: $('[data-app-url]', r).value.trim() }));
  // The ticked tabs (named from their addresses), then any typed in; an empty typed row is left out when tabs were ticked.
  const tabbed = (NEW.tabs || []).filter(t => NEW.ticked.has(t.url)).map(t => ({ id: '', url: t.url }));
  const apps = tabbed.length ? [...tabbed, ...typed.filter(a => a.url)] : typed;
  const slot = +$('#new-slot').value || null;
  // No profile: the demo records in the one the recorder is in (or the one the first run was told to use).
  const spec = { title: $('#new-title').value, apps, browser: form.browser.value, profile: savedProfile() || null, mode: 'manual', slot };
  const err = $('#new-error');
  try {
    const d = await invoke('create_demo', { spec });
    const text = $('#new-script').value;
    if (text.trim()) await invoke('script_save', { id: d.id, text, kind: 'md' }).catch(() => toast('The talk track wasn\u2019t saved: add it again under Review, Talk track', true));
    await loadDemos();
    announce(`Created ${d.title}`);
    openDemo(d.id, 'record');
  } catch (e) {
    const msg = typeof e === 'string' ? e : e.message;
    err.hidden = false;
    err.textContent = /^`.*` isn't a web address/.test(msg) ? 'Each app needs its start page\u2019s address, starting with https://.'
      : msg.charAt(0).toUpperCase() + msg.slice(1) + (/[.!?]$/.test(msg) ? '' : '.');
  }
}

// ---- Copilot -----------------------------------------------------------------------------------------------------

// The presenter's GitHub Copilot: signed in or not, the code to enter while signing in, the settings.
const AI = { status: null, checking: false, signing: false, code: null, runtime: null, error: null, signInError: null, models: null, settings: null };
async function refreshAi() {
  AI.checking = true; renderCopilotState();
  try { AI.status = await invoke('ai_status'); AI.settings = AI.status.settings; AI.error = null; if (AI.status.signedIn) AI.signInError = null; } catch (e) { AI.error = String(e); }
  AI.checking = false; renderCopilotState();
  if (S.view === 'copilot') renderCopilot();
  renderRegions();
}
function renderCopilotState() {
  const el = $('#copilot-state');
  if (!el) return;
  const st = AI.status;
  el.textContent = AI.signing ? 'Copilot: signing in…' : st?.signedIn ? `Copilot: ${st.login || 'signed in'}` : AI.checking && !st ? 'Copilot' : 'Copilot: not signed in';
  el.dataset.signedIn = String(!!st?.signedIn);
  $('#nav-copilot').dataset.signedIn = String(!!st?.signedIn);
}
// Signed in, or Sign in right here: the form stays as it is, and the code to enter shows below.
const signedInLine = () => {
  const st = AI.status;
  if (AI.checking && !st) return '<p class="muted small">Checking your GitHub sign-in…</p>';
  if (st?.signedIn) return `<p class="state ok" data-test="ai-signed-in">${mk('ok')} GitHub Copilot: ${esc(st.login || 'signed in')}</p>`;
  return `<div class="notice info"><div class="grow">This uses <strong>GitHub Copilot</strong> through your own GitHub account.
    ${AI.signing ? '' : '<div class="row" style="margin-top:8px"><button type="button" class="btn small" data-action="ai-sign-in" data-test="go-sign-in">Sign in with GitHub</button></div>'}
    <div data-region="copilot-signin"></div></div></div>`;
};
Object.assign(REGIONS_LATE, {
  'copilot-mini': () => signedInLine(),
  'copilot-signin'() {
    if (!AI.signing && (AI.signInError || AI.error)) return `<div data-test="ai-sign-in-error">${errorBox(AI.signInError || AI.error, 'ai-sign-in', { label: 'Try again', action: 'ai-sign-in' })}</div>`;
    if (!AI.signing) return '';
    const rt = AI.runtime;
    if (!AI.code) return `${progressBar(true)}<p class="small">${rt && !rt.ready ? `Getting Copilot ready (once): ${Math.round((rt.got || 0) / 1048576)} of ${Math.round((rt.total || 0) / 1048576) || '…'} MB` : 'Starting…'}</p>`;
    return `<div class="notice info" data-test="device-code" data-code="${esc(AI.code.userCode)}"><div>
      <p>Enter this code at <strong>${esc(AI.code.verificationUri)}</strong>, signed in to the GitHub account that has Copilot:</p>
      <p class="device-code">${esc(AI.code.userCode)}</p>
      <div class="row"><button type="button" class="btn primary" data-copy-open="${esc(AI.code.userCode)}" data-url="${esc(AI.code.verificationUri)}">Copy the code and open GitHub</button>
      <span class="muted small">This turns green on its own when you're done.</span></div></div></div>`;
  },
});
function renderCopilot() {
  S.view = 'copilot';
  S.id = null;
  renderSidebar();
  const st = AI.status, set = AI.settings || { model: 'auto', pageText: true };
  const models = AI.models || [];
  $('#main').innerHTML = `${pageHead({ title: 'GitHub Copilot', sub: 'Copilot can click through a demo for you while it records, write your talk track from a recording, or coach you as you click. It uses your own GitHub account and its Copilot plan: no keys to set up.' })}
    <div class="card"><h2>Your account</h2>
      <div class="row" style="margin-top:8px">${st?.signedIn ? `<span class="pill ok" data-test="ai-signed-in">Signed in as ${esc(st.login || 'you')}</span>
        <button class="btn" data-action="ai-sign-out" data-test="ai-sign-out">Sign out</button>`
        : `<span class="pill warn">Not signed in</span><button class="btn primary" data-action="ai-sign-in" data-test="ai-sign-in" ${AI.signing ? 'disabled' : ''}>Sign in with GitHub</button>`}
        ${AI.checking ? '<span class="muted small">Checking…</span>' : ''}</div>
      <div data-region="copilot-signin" style="margin-top:10px"></div>
      ${st && !st.signedIn && st.runtime && !st.runtime.ready ? `<p class="muted small">The first sign-in gets Copilot ready on this computer (about ${st.runtime.mb || 80} MB, once).</p>` : ''}</div>
    <div class="card"><h2>What Copilot sees</h2>
      <p>Only what each step needs: what the demo should show, the plan, and for the screen at hand its buttons, links and boxes by name and, if you allow it, its words. Never screenshots. Email addresses, IDs, tokens and web address queries are taken out first. Everything sent is kept with the demo, under <strong>What was sent to Copilot</strong> on its Record step.</p>
      <label class="choice" style="margin-top:10px"><input type="checkbox" id="ai-page-text" data-test="ai-page-text" ${set.pageText !== false ? 'checked' : ''}> Send the page\u2019s words, not just its controls (better plans and talk tracks)</label>
      <div style="margin-top:12px"><label for="ai-model">Model</label>
        <select id="ai-model" style="width:auto" data-test="ai-model"><option value="auto">Automatic (Copilot picks)</option>${models.map(m => `<option value="${esc(m.id)}" ${set.model === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        ${st?.signedIn && !AI.models ? '<button class="btn small subtle" data-action="ai-models">Show the models I can use</button>' : ''}</div></div>`;
  $('#ai-model').value = set.model || 'auto';
  $('#ai-page-text').onchange = e => saveAiSettings({ pageText: e.target.checked });
  $('#ai-model').onchange = e => saveAiSettings({ model: e.target.value });
  renderRegions();
}
async function saveAiSettings(patch) {
  AI.settings = await call('ai_settings', { set: patch });
  toast('Saved');
}
listen('job', ({ payload: { demo: id, job, update: u } }) => {
  if (job !== 'ai-sign-in') return;
  if (u.type === 'event' && u.event === 'device-code') AI.code = u.data;
  if (u.type === 'event' && u.event === 'runtime') AI.runtime = u.data;
  renderRegions();
});

// ---- A demo ------------------------------------------------------------------------------------------------------

function tabDone(t, s) {
  return { record: s.recorded, review: s.built && !!s.fidelity?.pass, build: s.built, fidelity: !!s.fidelity?.pass, script: s.focusPoints > 0 }[t];
}
function tabJobs(t) {
  return { record: ['preflight', 'record', 'record-stop', 'extension', 'install', 'ai-plan', 'ai-record', 'ai-script', 'coach'], review: ['build', 'checks', 'fidelity', 'script', 'ai-script'], build: ['build', 'checks'], fidelity: ['fidelity'], script: ['script'], export: ['export'] }[t] || [];
}
const gateDone = (g, s) => ({ record: s.recorded || s.built, review: s.built && !!s.fidelity?.pass, present: !!s.rehearsedAt, share: !!s.exportedAt })[g];
const gateJobs = g => g === 'review' ? [...new Set(REVIEW.flatMap(([t]) => tabJobs(t)))] : tabJobs(gateTab(g));
// The gates (Record · Review · Present · Share) and, on Review, its tabs.
function renderTabsBar() {
  const d = demo();
  const bar = $('#gates');
  if (!d || !bar) return;
  const cur = gateOf(S.tab);
  bar.innerHTML = GATES.map(([g, label], i) => {
    const done = gateDone(g, d.status), here = g === cur, b = gateJobs(g).some(j => running(j));
    return `<button class="gate${done && !here ? ' done' : ''}${b ? ' busy' : ''}" data-gate="${g}" data-test="tab-${g}" ${here ? 'aria-current="step"' : ''}>
      <i aria-hidden="true">${done && !here ? I.check : i + 1}</i>${label}${b ? '<span class="visually-hidden"> (working)</span>' : done ? '<span class="visually-hidden"> (done)</span>' : ''}</button>`;
  }).join('<span class="gate-line" aria-hidden="true"></span>');
  const tabs = $('#tabs');
  if (tabs) tabs.innerHTML = REVIEW.map(([t, label]) => {
    const b = tabJobs(t).some(j => running(j)), done = tabDone(t, d.status);
    return `<button role="tab" id="tab-${t}" aria-controls="subpanel" aria-selected="${t === S.tab}" tabindex="${t === S.tab ? 0 : -1}" data-tab="${t}" data-test="${t === 'review' ? 'subtab-review' : `tab-${t}`}">
      <span class="tab-dot ${b ? 'busy' : done ? 'done' : ''}" aria-hidden="true"></span>${label}${b ? '<span class="visually-hidden"> (working)</span>' : done ? '<span class="visually-hidden"> (done)</span>' : ''}</button>`;
  }).join('');
}
// What each gate says at the top: the demo on Record, where it stands on the others.
function headFor(d) {
  const s = d.status, f = s.fidelity, g = gateOf(S.tab);
  const slot = d.slot ? `<div class="slot" data-test="slot"><b>${clock(d.slot)}</b>your slot</div>` : '';
  if (g === 'record' && recState(d).recording && recState(d).st?.held) return { title: 'Paused', sub: 'Your screens so far are kept. Pick up when you\u2019re ready.', side: slot };
  if (g === 'record' && recState(d).recording) return { title: 'Recording', sub: `Click through in ${esc(BNAME[d.browser] || 'your browser')}. Wait for \u201cReady\u201d before each click.`, side: slot };
  if (g === 'record') return { title: d.title, test: 'demo-title', sub: esc(listWords(d.apps.map(appLabel))), side: slot };
  if (g === 'review') {
    const h = reviewHead(d, s, f, slot), tl = timesLine(s);
    return tl && h.sub !== undefined ? { ...h, sub: `${h.sub}<br>${tl}` } : h;
  }
  if (g === 'present') return presentHead(d);
  return { title: 'Send it to another presenter', sub: 'They get the replica and your guide. Not your recording, not your sign-ins.' };
}
function reviewHead(d, s, f, slot) {
  {
    const c = J(d.id).aiChain;
    if (c && !['done', 'error'].includes(c.stage)) return { title: c.stage === 'fix' ? 'Fixing what differs' : 'Making your replica', sub: 'Scenecast is building it and checking it against the real product.', side: slot };
    if (!s.recorded) return { title: 'Nothing to review yet', sub: 'Record the demo first: each screen shows up here.' };
    const r = J(d.id).review;
    if (r?.comparing || c?.checking === 'compare') return { title: 'Ready to present', sub: 'Each screen is being compared with the real product. You can rehearse meanwhile.', side: slot };
    if (r?.compared && S.tab === 'review') {
      const nb = r.beats.filter(b => b.n > 0).length;
      const beats = nb > 1 ? ` in ${plural(nb, 'beat')}` : '';
      const talk = s.focusPoints ? ' \u00b7 talk track on its screens' : '';
      const views = r.viewsDiffer ? ` \u00b7 ${viewsWords(r.viewsDiffer)}` : '';
      if (!r.differ && !r.viewsDiffer) return { title: 'Your replica matches the real product', sub: `${plural(r.screens, 'screen')}${beats} \u00b7 every one matches${talk}`, side: slot };
      if (!r.differ) return { title: 'Every screen matches', sub: `${r.matching} of ${r.screens} match the real product${views}${talk}`, side: slot };
      return { title: `${plural(r.differ, 'screen')} ${r.differ === 1 ? 'needs' : 'need'} a look`, sub: `${r.matching} of ${r.screens} match the real product${beats}${views}${talk}`, side: slot };
    }
    if (!s.built) return { title: 'Build the replica', sub: `${plural(s.screens, 'screen')} recorded ${esc(ago(s.recordedAt))}.`, side: slot };
    if (!f) return { title: 'Compare it with the real product', sub: `${plural(s.liveScenes, 'screen')} built. Compare checks each one against what you recorded.`, side: slot };
    if (f.pass) return { title: 'Every screen matches', sub: `${f.total} of ${f.total} match the real product${s.focusPoints ? ` · ${plural(s.focusPoints, 'focus point')}` : ''}.`, side: slot };
    const n = f.total - f.within, views = f.viewsDiffer ? ` \u00b7 ${viewsWords(f.viewsDiffer)}` : '';
    if (!n) return { title: 'Every screen matches', sub: `${f.total} of ${f.total} match the real product${views}.`, side: slot };
    return { title: `${plural(n, 'screen')} ${n === 1 ? 'needs' : 'need'} a look`, sub: `${f.within} of ${f.total} match the real product${views}.`, side: slot };
  }
}
function renderHead() {
  const d = demo(), el = $('#demo-head');
  if (!d || !el) return;
  el.innerHTML = pageHead(headFor(d));
  renderRegions();
}
async function openDemo(id, tab) {
  S.view = 'demo';
  S.id = id;
  if (tab) S.tab = tab;
  if (gateOf(S.tab) === 'review') S.reviewTab = S.tab;
  await refreshDemo(id);
  const d = demo();
  if (!d) return renderLibrary();
  renderSidebar();
  $('#main').innerHTML = `<nav class="gates" id="gates" aria-label="Steps"></nav><div id="demo-head"></div>
    <section id="panel" aria-label="${esc(GATES.find(([g]) => g === gateOf(S.tab))[1])}"></section>`;
  renderTabsBar();
  renderHead();
  invoke('receiver_ensure', { id }).then(r => { if (S.id === id) { S.rx = r; renderRegions(); } }).catch(() => {});
  await renderPanel();
}
// The recorder, every 1.5 s on Record: turns green the moment the extension connects.
setInterval(async () => {
  // Not skipped while the window is covered (the browser in front, as while recording): it came back saying "Recorder
  // not connected" when it was.
  if (S.view !== 'demo' || S.tab !== 'record') return;
  const was = !!S.rx?.receiver?.connected;
  S.rx = await invoke('receiver_status').catch(() => S.rx);
  const now = !!S.rx?.receiver?.connected;
  if (now !== was) {
    if (now) { toast('The recorder is connected'); announce('The recorder is connected'); }
    const pf = J(S.id).preflight;
    // It connected after a check that said it wasn't: check again (nothing is fixed without asking).
    if (now && pf?.items?.some(i => i.id === 'recorder' && i.status === 'fail') && !running('preflight')) step('preflight', 'preflight', { fix: false });
  }
  scheduleRegions();
}, 1500);
function rerender() {
  if (S.view !== 'demo') return;
  renderTabsBar();
  renderHead();
  renderPanel();
}
async function renderPanel() {
  const panel = $('#panel');
  if (!panel) return;
  const d = demo();
  const g = gateOf(S.tab);
  panel.setAttribute('aria-label', GATES.find(([x]) => x === g)[1]);
  let el = panel;
  if (g === 'review') {
    if (!$('#tabs', panel)) panel.innerHTML = '<div class="tabs" role="tablist" aria-label="Review" id="tabs"></div><div id="subpanel" role="tabpanel" tabindex="0"></div>';
    renderTabsBar();
    el = $('#subpanel', panel);
    el.setAttribute('aria-labelledby', `tab-${S.tab}`);
  } else if ($('#tabs', panel)) panel.innerHTML = '';
  await PANELS[S.tab](el, d);
  renderRegions();
}
function renderRegions() {
  for (const el of document.querySelectorAll('[data-region]')) {
    const html = REGIONS[el.dataset.region]?.(demo());
    if (html === undefined || el.innerHTML === html) continue;
    const next = document.createElement(el.tagName);
    next.innerHTML = html;
    const typed = keepTyped(el);
    morph(el, next);
    typed();
  }
}
// What's been typed into a field in a region (by id), put back after it's drawn again: a row appearing beside it
// (the recorder connecting) redraws the whole list, and the field came back with its old value. Nov 2026, the UI
// test: a changed start page saved as the old one.
function keepTyped(root) {
  const active = document.activeElement;
  const kept = [...root.querySelectorAll('input[id],textarea[id]')].filter(f => f.value !== f.defaultValue || f === active)
    .map(f => ({ id: f.id, value: f.value, focused: f === active, start: f.selectionStart, end: f.selectionEnd }));
  return () => {
    for (const k of kept) {
      const f = document.getElementById(k.id);
      if (!f || !root.contains(f)) continue;
      if (f.value !== k.value) f.value = k.value;
      if (k.focused && document.activeElement !== f) { f.focus(); try { f.setSelectionRange(k.start, k.end); } catch (e) {} }
    }
  };
}
// Only what changed is changed: a status line ticking over doesn't replace the buttons beside it (a click on a button
// that was just replaced is lost), and pictures already shown aren't loaded again.
function morph(from, to) {
  const a = [...from.childNodes], b = [...to.childNodes];
  if (a.length !== b.length) return from.replaceChildren(...b);
  a.forEach((x, i) => {
    const y = b[i];
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return from.replaceChild(y, x);
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
    if (x.isEqualNode(y)) return;
    // A Details the presenter opened stays open.
    for (const { name } of [...x.attributes]) if (!y.hasAttribute(name) && !(name === 'open' && x.nodeName === 'DETAILS')) x.removeAttribute(name);
    for (const { name, value } of [...y.attributes]) if (x.getAttribute(name) !== value) x.setAttribute(name, value);
    morph(x, y);
  });
}

const progressBar = on => on ? '<div class="progress" role="progressbar" aria-label="Working"><div></div></div>' : '';
const logBox = (lines = [], open = false) => lines.length ? `<details ${open ? 'open' : ''}><summary>Details (${lines.length} lines)</summary>
  <div class="log" tabindex="0">${lines.slice(-200).map(l => `<div class="${l.error ? 'err' : ''}">${esc(l.text)}</div>`).join('')}</div></details>` : '';
// An error in plain words (errors.js): what happened, one sentence, at most one button; the engine's words under Details.
function errorBox(e, job, fallback) {
  const x = !e ? null : typeof e === 'object' ? e : why(e, job);
  if (!x) return '';
  const a = x.action || fallback;
  return `<div class="notice bad" role="alert" data-test="error" data-error="${esc(x.id)}"><div class="grow"><strong>${esc(x.title)}</strong> ${esc(x.body)}
    ${a ? `<div class="row" style="margin-top:10px">${actionButton(a, false)}</div>` : ''}
    ${x.detail ? `<details class="err-detail"><summary>Details</summary><div class="log">${esc(x.detail)}</div></details>` : ''}</div></div>`;
}
const ICON_SAYS = { ok: 'done', fixed: 'fixed', pass: 'passed', fail: 'needs fixing', warn: 'worth a look', manual: 'yours to do', skip: 'skipped', run: 'working' };
const icon = (status, label) => mk({ ok: 'ok', fixed: 'ok', pass: 'ok', fail: 'no', warn: 'hold', manual: 'hold', run: 'spin' }[status] || 'todo', label || ICON_SAYS[status] || status);

// ---- Record ------------------------------------------------------------------------------------------------------

const BNAME = { chrome: 'Google Chrome', edge: 'Microsoft Edge' };
const avatar = p => p.picture ? `<img class="avatar" src="${esc(p.picture)}" alt="">`
  : `<span class="avatar" style="background:${esc(p.color || '#8a8a94')}" aria-hidden="true">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>`;
// The profile picker: the browser's own profiles by name and picture; "" is the one that's open when recording.
function profileOptions(info, chosen) {
  if (info && info.error) return `<p class="small" role="alert" data-test="profiles-error">Couldn\u2019t read the browser\u2019s profiles: ${esc(info.error)}. Recording uses the one that\u2019s open.</p>`;
  if (!info) return '<p class="muted small">Looking at the browser\u2019s profiles…</p>';
  if (!info.profiles?.length) return `<p class="muted small">No ${esc(BNAME[info.browser] || info.browser)} profiles on this computer yet: it uses the one you open.</p>`;
  const picked = chosen || '';
  const auto = info.profiles.find(p => p.dir === info.picked);
  return `<div class="profiles" role="radiogroup" aria-label="Browser profile">
    <label class="profile"><input type="radio" name="profile" value="" ${picked === '' ? 'checked' : ''} data-test="profile-auto">
      <span class="avatar auto" aria-hidden="true">${svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', '')}</span><span><span class="pname">The one the recorder is in</span>
      <span class="small muted">${auto ? `now: ${esc(auto.name)}` : 'when you record'}</span></span></label>
    ${info.profiles.map(p => `<label class="profile"><input type="radio" name="profile" value="${esc(p.dir)}" ${picked === p.dir ? 'checked' : ''} data-test="profile-${esc(p.dir.replace(/\s+/g, '-'))}">
      ${avatar(p)}<span><span class="pname">${esc(p.name)}</span>
      <span class="small muted">${esc([p.email, p.open ? 'open' : '', p.extension?.id ? 'has the recorder' : ''].filter(Boolean).join(' · ') || p.dir)}</span></span></label>`).join('')}
  </div>`;
}
const rxState = () => S.rx?.receiver || {};
const REGIONS = {
  // Details: the receiver the recorder talks to, its port, and the recorder's version and folder.
  'recorder-details'() {
    const r = rxState(), x = S.rx?.extension || {};
    return `<span data-test="receiver-state" data-port="${esc(r.port ?? '')}">${r.running ? `Receiver on port ${esc(r.port)}` : r.error ? `Receiver stopped: ${esc(r.error)}` : 'Receiver starting'}</span>
      · ${r.connected ? 'recorder connected' : 'recorder not connected'}${x.version ? ` · recorder ${esc(x.version)}` : ''}${x.dir ? ` · <code>${esc(x.dir)}</code>` : ''}`;
  },
  install(d) {
    const j = J(d.id).install || {};
    const o = j.outcome;
    const on = running('install', d.id);
    if (!o && !on && !j.error) return '';
    if (on) return progressBar(true) + '<p class="muted small">Getting the recorder ready…</p>';
    if (j.error) return errorBox(j.error, 'install');
    const b = o.browser, connected = rxState().connected;
    const shot = n => `img/setup/${b}-${n}.png`;
    if (connected) return `<div class="notice ok" data-test="install-status" data-connected="true"><div><strong>Done: the recorder is connected.</strong> You won\u2019t need to do this again.</div></div>`;
    const notes = [];
    if (o.openError) notes.push(`Couldn\u2019t open ${esc(o.browserName)}. Open it yourself, type <code>${esc(o.extensionsPage)}</code> in the address bar and press Enter.`);
    else if (!o.running) notes.push(`${esc(o.browserName)} wasn\u2019t open: it\u2019s starting with your profile ${esc(o.profileName || '')}.`);
    if (o.oldLoaded) notes.push('You still have the old copy of the recorder loaded: click <strong>Remove</strong> on it first.');
    if (o.loaded && o.devMode === false) notes.push('Developer mode is off, so the recorder is switched off: turn Developer mode on (step 1).');
    return `<div class="notice info" data-test="install-status" data-connected="false"><div>
        <strong>${o.opened ? `A Scenecast page opened in ${esc(o.browserName)}${o.profileName ? ` (${esc(o.profileName)})` : ''}` : 'Almost there'}</strong>, and the recorder\u2019s folder is shown in ${folderWord()}. <strong>${esc(o.extensionsPage)}</strong> is copied: click the browser\u2019s address bar, paste and press Enter. Then the steps below; this turns green on its own.
      </div></div>
      ${notes.map(n => `<div class="notice warn"><div>${n}</div></div>`).join('')}
      <div class="row" style="margin:10px 0"><button class="btn small" data-reveal="${esc(o.dir)}">Show the folder in ${folderWord()}</button>
        <button class="btn small" data-copy="${esc(o.dir)}" data-test="copy-path">Copy where it is</button>
        <button class="btn small subtle" data-copy="${esc(o.extensionsPage)}">Copy ${esc(o.extensionsPage)}</button><span hidden data-test="extension-dir" data-dir="${esc(o.dir)}"></span></div>
      <ol class="step-cards">
        <li><figure><img src="${shot('1-developer-mode')}" alt="The extensions page with the Developer mode switch circled"></figure>
          <div><strong>Open ${esc(o.extensionsPage)}, turn on Developer mode</strong><p class="small muted">Paste ${esc(o.extensionsPage)} (copied) in the address bar and press Enter. Developer mode is ${b === 'edge' ? 'at the bottom of the left side of the page' : 'top right of the page'}.</p></div></li>
        <li><figure><img src="${shot('2-load-unpacked')}" alt="Developer mode on, with Load unpacked circled"></figure>
          <div><strong>Drag the Recorder Extension folder onto the page</strong><p class="small muted">From the ${folderWord()} window that just opened. Or click <strong>Load unpacked</strong> and pick the folder (Copy where it is, then paste it in the dialog${isMac() ? ' with ⌘⇧G' : ''}).</p></div></li>
        <li><figure><img src="${shot('3-loaded')}" alt="Scenecast Recorder loaded, its Reload button circled"></figure>
          <div><strong>That\u2019s it</strong><p class="small muted">Scenecast Recorder shows up and this turns green within a few seconds.</p></div></li>
      </ol>`;
  },
  'rec-head': d => recHead(d),
  preshow: d => preshowRows(d),
  show: d => recShowRows(d),
  'record-error'(d) {
    const j = J(d.id).record || {}, stop = J(d.id)['record-stop'] || {};
    if (running('record', d.id) || running('record-stop', d.id)) return '';
    if (j.error) return `<div data-test="record-failed">${errorBox(j.error, 'record')}</div>`;
    if (stop.error) return `<div data-test="record-failed">${errorBox(stop.error, 'record-stop', { label: 'Record again', action: 'record-start' })}</div>`;
    if (stop.outcome && !stop.outcome.states) return `<div data-test="record-failed">${errorBox('record stop: 0 states', 'record-stop')}</div>`;
    return '';
  },
};
Object.assign(REGIONS, REGIONS_LATE);

// ---- Record: the run of show ---------------------------------------------------------------------------------------

// How it's recorded: by hand (I'll click through, optionally coached) or by Copilot. Every demo can switch.
const copilotMode = d => d.mode === 'record';
const coachMode = d => d.mode === 'coach';
const recState = d => {
  const j = J(d.id).record || {}, stop = J(d.id)['record-stop'] || {}, st = j.status;
  const recording = !j.error && (st ? st.recording : !!j.outcome && !stop.outcome);
  return { j, stop, st, recording, starting: running('record', d.id) && !recording, aiOn: running('ai-record', d.id) };
};
const HAND = svg('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-6.5v-1a1.5 1.5 0 0 1 3 0V12m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-5-2.7L4.5 15a1.5 1.5 0 0 1 2.5-1.7L8 14.5"/>');
const STOP = svg('<rect x="6" y="6" width="12" height="12" rx="1"/>');
function recHead(d) {
  const { st, stop, recording, starting, aiOn } = recState(d);
  const rx = rxState();
  const head = (title, small, next) => `<span hidden data-test="recorder-state" data-connected="${!!rx.connected}"></span><div class="rd-head"><div class="grow"><h2>${title}</h2><small>${small}</small></div><div class="next">${next}</div></div>`;
  // Copilot has stopped clicking once it's writing the talk track: the browser is the presenter's again.
  const writing = aiOn && (J(d.id)['ai-record']?.stages || []).some(s => s.name === 'script');
  if (writing) return head('Writing your talk track', 'Copilot has finished clicking. It\u2019s writing what to say from what it did.', `<button class="btn primary big" disabled>Writing\u2026</button>`);
  if (aiOn) return head('Copilot is recording', 'Keep your hands off the browser until it asks.', `<button class="btn primary big" data-action="ai-stop" data-test="ai-stop">${STOP} Stop</button>`);
  if (starting) return head('Getting ready', `<span data-test="record-starting">Checking your browser and the app tabs, then capturing each start screen. Wait for <strong>Recording</strong> before you click.</span>`,
    `<button class="btn primary big" disabled>Starting…</button>`);
  if (recording && st?.held) {
    // Paused (Pause, or the browser's debugging bar was closed): every screen so far is kept.
    const n = st.count ?? 0, bar = st.held.why === 'bar', off = J(d.id).goOnOff;
    const why = off ? `Bring ${off.map(a => esc(appLabel({ id: a }))).join(' and ')} back to the screen you paused on, then pick up again, or <button class="link" data-action="record-go-on" data-anyway="1" data-test="record-go-on-anyway">go on from here</button>.`
      : `Your ${plural(n, 'screen')} ${n === 1 ? 'is' : 'are'} kept.${bar ? ' Picking up shows the bar again: leave it open.' : ''}`;
    const title = bar ? 'The browser\u2019s debugging bar was closed' : 'Nothing you do is recorded';
    return head(title, `<span data-test="recording" data-held="${esc(st.held.why)}" data-busy="false" data-count="${n}">${why}</span>`,
      `<button class="alink" data-action="record-stop" data-test="record-stop" ${running('record-stop', d.id) ? 'disabled' : ''}>Stop recording</button>
       <button class="btn primary big" data-action="record-go-on" data-test="record-go-on" ${running('record-go-on', d.id) ? 'disabled' : ''}>${bar && !off ? 'Pick up where I left off' : 'Go on'} ${I.arrow}</button>`);
  }
  if (recording) {
    const busyNow = !!st?.busy;
    return head('Recording', `<span data-test="recording" data-busy="${busyNow}" data-count="${st?.count ?? 0}" class="state ${busyNow ? 'warn' : 'ok'}">${busyNow ? 'Hold on: capturing this screen' : 'Ready: click next'}</span> · ${plural(st?.count ?? 0, 'screen')} so far`,
      `<button class="alink" data-action="record-pause" data-test="record-pause">Pause</button>
       <button class="btn primary big" data-action="record-stop" data-test="record-stop" ${running('record-stop', d.id) ? 'disabled' : ''}>${STOP} Stop recording</button>`);
  }
  if (running('record-stop', d.id)) return head('Saving the recording', 'A few seconds.', '<button class="btn primary big" disabled>Saving…</button>');
  if (stop.outcome?.states) {
    const s = stop.outcome, tt = s.timing || {};
    return head('Recorded', `<span data-test="record-done">Recorded ${plural(s.states, 'screen')}${s.beats ? ` in ${plural(s.beats, 'beat')}` : ''}, in ${secs(s.secs)}.<details><summary>Details</summary>${plural(s.steps, 'step')}, ${plural(s.streams, 'streamed answer')}. The recorder took ${secs(tt.recorderSecs)}, the product ${secs(tt.productSecs)}.${s.notes?.length ? `<br>${s.notes.map(esc).join('<br>')}` : ''}</details></span>`,
      `<button class="alink" data-action="record-start" data-test="record-again">Record again</button><button class="btn primary big" data-goto="review" data-test="go-review">Next: review it ${I.arrow}</button>`);
  }
  const again = d.status.recorded ? ` Recorded ${esc(ago(d.status.recordedAt))}; recording again replaces it.` : '';
  if (copilotMode(d)) {
    const plan = planBeats(planText(d));
    const asks = plan.flatMap(b => b.steps).filter(s => s.ask).length;
    const other = `<button class="alink" data-action="set-mode" data-mode-to="manual" data-test="mode-manual">${HAND} or click through yourself</button>`;
    if (!plan.length) return head('Run of show', `Say what to show above. Copilot drafts the steps; you read them before it starts.${again}`,
      `${other}<button class="btn primary big" data-action="ai-plan" data-test="ai-plan" ${running('ai-plan', d.id) ? 'disabled' : ''}>Draft the plan ${I.arrow}</button>`);
    return head('Run of show', `Copilot clicks; ${asks ? `${plural(asks, 'step')} ${asks === 1 ? 'asks' : 'ask'} you first` : 'nothing needs your go-ahead'}.${again}`,
      `${other}<button class="btn primary big" data-action="ai-record" data-test="ai-record" ${running('ai-plan', d.id) ? 'disabled' : ''}>Approve and start ${I.arrow}</button>`);
  }
  return head('Run of show', `${BNAME[d.browser] || 'Your browser'} shows a \u201cdebugging\u201d bar while you record. Leave it open.${again}`,
    `<button class="alink" data-action="set-mode" data-mode-to="record" data-test="mode-record">${I.spark} or let Copilot click for you</button>
     <button class="btn primary big" data-action="record-start" data-test="record-start" ${running('record', d.id) || running('preflight', d.id) ? 'disabled' : ''}>Start recording ${I.arrow}</button>`);
}

// The pre-show: what Record needs, as the last check found it. Start checks again, with its fixes.
function preItem(d, i) {
  const ok = i.status === 'ok' || i.status === 'fixed';
  const app = i.id.startsWith('app ') ? d.apps.find(a => a.id === i.id.slice(4)) : null;
  const x = i.status === 'fail' ? why(i.detail, 'preflight') : null;
  const fixBtn = (test = `fix-${i.id.replace(' ', '-')}`) => x?.action ? actionButton(x.action, false, test) : '';
  if (i.id === 'receiver') return ok ? null : { state: 'no', title: x?.title || 'Scenecast can\u2019t reach your browser', small: x?.body || '', right: `<button class="btn small" data-action="receiver-fix" data-test="fix-receiver">Try again</button>` };
  if (i.id === 'browser') {
    const who = profileName(J(d.id).profiles, i.profile || d.profile);
    return ok ? { state: 'ok', title: `${BNAME[d.browser] || 'Your browser'}${who ? ` as ${esc(who)}` : ''}`, small: i.status === 'fixed' ? 'Scenecast opened a window for you.' : 'The profile you use for work.', right: '<span class="state ok">Ready</span>' }
      : { state: 'no', title: esc(x.title), small: esc(x.body), right: fixBtn() };
  }
  if (i.id === 'recorder') {
    if (ok || rxState().connected) return { state: 'ok', title: 'The Scenecast recorder', small: i.status === 'fixed' ? 'Updated for you.' : 'Connected.', right: '<span class="state ok">Ready</span>' };
    const add = x?.id === 'recorder-old' ? fixBtn() : `<button class="btn small" data-action="install" data-test="install-recorder">${x?.id === 'recorder-missing' || !x ? 'Add the recorder' : esc(x.action?.label || 'Show me how')}</button>`;
    return { state: 'no', title: x ? esc(x.title) : 'The Scenecast recorder', small: x ? esc(x.body) : '', right: add };
  }
  if (!app) return null;
  const name = esc(appLabel(app));
  const change = `<button class="alink small" data-action="edit-app" data-app="${esc(app.id)}" data-test="edit-app-${esc(app.id)}">Change</button>`;
  if (ok) return { app, state: 'ok', title: name, small: i.status === 'fixed' ? 'Scenecast opened it for you.' : 'Open, on its start screen.', right: `<span class="state ok">Ready</span>${change}` };
  if (i.status === 'skip') return { app, state: 'todo', title: name, small: 'Checked once the recorder is connected.', right: change };
  if (i.signIn) return { app, state: 'no', title: `Sign in to ${name}`, small: 'Its tab is asking you to sign in. Sign in there, then check again.', right: `<button class="btn small" data-action="preflight" data-test="fix-${esc(i.id.replace(' ', '-'))}">Check again</button>` };
  if (i.missing && i.tabs?.length) return { app, state: 'no', title: `Which tab is ${name}?`, small: 'Scenecast couldn\u2019t find it. Pick it from your open tabs, and Scenecast remembers it.', pick: i.tabs, right: change };
  if (i.missing && app.url) return { app, state: 'hold', title: name, small: 'Not open yet. Scenecast opens it when you start.', right: `<span class="state idle">Opens at start</span>${change}` };
  if (/isn.t on its start screen/.test(i.detail)) return { app, state: 'hold', title: name, small: 'Not on its start screen. Scenecast puts it back when you start.', right: `<span class="state idle">At start</span>${change}` };
  return { app, state: 'no', title: x ? esc(x.title) : name, small: x ? esc(x.body) : esc(i.detail), right: fixBtn() + change };
}
function preshowRows(d) {
  const j = J(d.id).preflight || {};
  const checking = running('preflight', d.id) || recState(d).starting || running('ai-plan', d.id) && !(j.items || []).length;
  const items = j.items || [];
  if (!items.length) return `<div class="rd-row" data-test="preshow-checking">${mk(checking ? 'spin' : 'todo')}<div class="t"><b>${checking ? 'Checking your browser, the recorder and the app tabs\u2026' : 'Your browser, the recorder and the app tabs'}</b>
    <small>${checking ? 'A few seconds.' : 'Checked when you start.'}</small></div><span></span><span></span><span></span></div>${errorBox(j.error, 'preflight')}`;
  const rows = items.map(i => ({ i, r: preItem(d, i) })).filter(x => x.r);
  const ready = j.outcome?.ready ?? items.every(i => i.status === 'ok' || i.status === 'fixed');
  const profileAsk = askProfile(d);
  const allSet = ready && !checking && !J(d.id).preshowOpen && !profileAsk;
  // Every item's status stays on the page (the UI test reads them), shown as a row or not.
  const marks = items.filter(i => allSet || !rows.some(x => x.i === i)).map(i => `<span hidden data-test="pf-${esc(i.id.replace(' ', '-'))}" data-status="${esc(i.status)}"></span>`).join('');
  const result = (j.outcome ? `<span hidden data-test="preflight-result" data-ready="${!!j.outcome.ready}"></span>` : '') + marks;
  // All set: one line, with every app's tile; the rows are a click away.
  if (allSet) {
    const who = profileName(J(d.id).profiles, items.find(i => i.id === 'browser')?.profile || d.profile);
    const opened = items.some(i => i.status === 'fixed');
    return `${result}<div class="rd-row" data-test="preshow-all-set">${mk('ok', 'Ready')}<div class="t"><b>All set: ${esc(BNAME[d.browser] || 'your browser')}${who ? ` as ${esc(who)}` : ''}, the recorder, and your ${plural(d.apps.length, 'app tab')}</b>
      <small>Scenecast ${opened ? 'opened and checked them' : 'checked them'} for you.</small></div>
      <span class="app-cell">${d.apps.map(tile).join('')}</span><span></span><button class="alink" data-action="preshow-toggle" data-test="preshow-show-all">Show all ${rows.length}</button></div>`;
  }
  const editing = J(d.id).editApp;
  return `${result}${profileAsk}${rows.map(({ i, r }) => `<div class="rd-row" data-test="pf-${esc(i.id.replace(' ', '-'))}" data-status="${esc(i.status)}">${mk(checking && i.status === 'fail' ? 'spin' : r.state)}
      <div class="t"><b>${r.title}</b>${r.small ? `<small>${r.small}</small>` : ''}</div>
      <span class="app-cell">${r.app ? tile(r.app, d.apps.indexOf(r.app)) : ''}</span><span></span><span class="row">${r.right}</span>
      ${r.pick ? `<div class="more-row"><label class="visually-hidden" for="pick-${esc(r.app.id)}">Which tab is ${esc(appLabel(r.app))}?</label>
        <div class="row"><select id="pick-${esc(r.app.id)}" class="inline" data-test="pick-tab-${esc(r.app.id)}">${r.pick.map(t => `<option value="${esc(t.url)}">${esc(t.title || t.host)} \u2014 ${esc(t.host)}</option>`).join('')}</select>
        <button class="btn small" data-action="pick-tab" data-app="${esc(r.app.id)}" data-test="pick-tab-ok-${esc(r.app.id)}">This one</button></div></div>` : ''}
      ${r.app && editing === r.app.id ? `<div class="more-row"><form class="row" data-app-form="${esc(r.app.id)}"><label class="visually-hidden" for="addr-${esc(r.app.id)}">${esc(appLabel(r.app))}\u2019s start page</label>
        <input id="addr-${esc(r.app.id)}" type="url" value="${esc(r.app.url)}" style="flex:1;width:auto" data-test="app-addr-${esc(r.app.id)}">
        <button class="btn small" type="submit" data-test="app-save-${esc(r.app.id)}">Save</button><button class="alink small" type="button" data-action="edit-app" data-app="">Cancel</button></form></div>` : ''}</div>`).join('')}
    ${ready && J(d.id).preshowOpen ? `<div class="rd-row" style="min-height:0"><span></span><div class="t"></div><span></span><span></span><button class="alink small" data-action="preshow-toggle">Show less</button></div>` : ''}
    ${errorBox(j.error, 'preflight')}`;
}
// Slice 7: the profile is the one the recorder is in. Asked once, only when it's in more than one.
function askProfile(d) {
  const info = J(d.id).profiles;
  if (d.profile || !info?.profiles) return '';
  const withIt = info.profiles.filter(p => p.extension?.id && p.extension.enabled !== false);
  if (withIt.length < 2) return '';
  return `<div class="rd-row" data-test="ask-profile">${mk('hold')}<div class="t"><b>The recorder is in ${withIt.length} ${esc(BNAME[d.browser] || '')} profiles</b><small>Which one do you record in? Scenecast remembers.</small>
      <div class="row" style="margin-top:8px">${withIt.map(p => `<button class="btn small" data-action="pick-profile" data-profile="${esc(p.dir)}" data-test="pick-profile-${esc(p.dir.replace(/\s+/g, '-'))}">${avatar(p)} ${esc(p.name)}</button>`).join('')}</div></div>
      <span></span><span></span><span></span></div>`;
}

// The show: the beats, from Copilot's plan (with its steps, and which ask first) or from the talk track (with times).
const planText = d => document.querySelector('#ai-plan')?.dataset.dirty ? $('#ai-plan').value : AIS[d.id]?.plan || '';
function planBeats(text) {
  const beats = [];
  let b = null;
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    let m;
    if ((m = /^##\s+(.*)$/.exec(l))) { b = { title: m[1].replace(/^beat\s*\d+\s*[·:.)\-–—]?\s*/i, ''), steps: [], say: [] }; beats.push(b); continue; }
    if (!b) continue;
    if ((m = /^[-*]\s+(.*)$/.exec(l))) { const ask = /\s[—–-]\s*ask (me )?first\.?$/i.test(m[1]); b.steps.push({ text: m[1].replace(/\s*[—–-]\s*ask (me )?first\.?$/i, ''), ask }); }
    else if ((m = /^>\s?(.*)$/.exec(l))) b.say.push(m[1]);
    // Details under a step (docs/engine/plan-format.md): what it changes, and where the product differs from her script.
    else if ((m = /^(Writes|Differs):\s*(.+)$/i.exec(l)) && b.steps.length) b.steps[b.steps.length - 1][m[1].toLowerCase()] = m[2].replace(/ · [\w-]+:[\w-]+$/, '');
  }
  return beats;
}
function recShowRows(d) {
  const rd = J(d.id).rundown;
  const { recording } = recState(d);
  const timed = n => { const b = rd?.beats?.find(x => x.n === n); return b && b.start != null && b.end != null ? `${clock(b.start)}\u2013${clock(b.end)}` : ''; };
  const stateOf = () => recording ? '<span></span>' : d.status.recorded ? '<span class="state ok">Recorded</span>' : '<span class="state idle">To record</span>';
  if (copilotMode(d)) {
    const plan = planBeats(planText(d));
    if (!plan.length) return `<div class="sec">Show <span>Copilot\u2019s plan shows here.</span></div>
      <div class="rd-row" data-test="show-empty">${mk('todo')}<div class="t"><b>No plan yet</b><small>Say what the demo should show, then draft the plan.</small></div><span></span><span></span><span></span></div>`;
    const rev = AIS[d.id]?.review, differs = plan.flatMap(b => b.steps).filter(s => s.differs);
    const from = rev?.from ? `Made from ${esc(rev.from)}, each step on the screens your demo shows.` : 'Copilot\u2019s plan.';
    return `<div class="sec">Show <span>${from} Read it, change anything, then approve.</span></div>
      ${differs.length ? `<div class="rd-row" data-test="plan-differs" data-count="${differs.length}">${mk('hold')}<div class="t"><b>${plural(differs.length, 'step')} ${differs.length === 1 ? 'isn\u2019t' : 'aren\u2019t'} quite what your script says</b><small>Copilot uses what the product shows. They\u2019re marked below.</small></div><span></span><span></span><span></span></div>` : ''}
      ${plan.map((b, k) => `<div class="rd-row" data-test="plan-beat-${k + 1}">${mk('todo')}<div class="t"><b>Beat ${k + 1} \u00b7 ${esc(b.title)}</b>${b.say[0] ? `<small><em>\u201c${esc(b.say[0])}\u201d</em></small>` : ''}
        <ul class="steps">${b.steps.map(s => `<li${s.differs ? ' data-test="plan-step-differs"' : ''}>${esc(s.text)}${s.writes ? ` <span class="tag" data-test="plan-step-writes" title="${esc(s.writes)}">changes something</span>` : s.ask ? ' <span class="tag">asks you first</span>' : ''}${s.writes ? `<small>${esc(s.writes[0].toUpperCase() + s.writes.slice(1))}</small>` : ''}${s.differs ? `<small class="differs">Not as your script says: ${esc(s.differs)}</small>` : ''}</li>`).join('')}</ul></div>
        <span></span><span class="time">${timed(k + 1)}</span>${stateOf()}</div>`).join('')}`;
  }
  const beats = rd?.beats || [];
  if (!beats.length) return `<div class="sec">Show</div>
    <div class="rd-row" data-test="show-empty">${mk('todo')}<div class="t"><b>No talk track yet</b><small>Your beats come from what you click. Add your talk track to see its beats and times here.</small></div>
      <span></span><span></span><button class="alink" data-goto="script">Add it</button></div>`;
  return `<div class="sec">Show <span>From your talk track.${rd.planned ? ` ${clock(rd.planned)} planned.` : ''}</span></div>
    ${beats.map(b => { const app = d.apps.find(a => a.id === b.app); return `<div class="rd-row" data-test="beat-${b.n}">${mk(d.status.recorded ? 'ok' : 'todo')}<div class="t"><b>Beat ${b.n} \u00b7 ${esc(b.title)}</b></div>
      <span class="app-cell">${app ? `${tile(app, d.apps.indexOf(app))}<span>${esc(appLabel(app))}</span>` : ''}</span><span class="time">${timed(b.n)}</span>${stateOf()}</div>`; }).join('')}`;
}

const PANELS = {};
PANELS.record = (panel, d) => {
  const sent = copilotMode(d) || coachMode(d) || d.mode === 'script';
  const live = recState(d).recording || recState(d).aiOn;
  panel.innerHTML = `<div data-region="record-error"></div>
    ${copilotMode(d) || coachMode(d) ? '<div data-region="copilot-mini"></div>' : ''}
    ${copilotMode(d) ? `<section class="card goal" aria-label="What should the demo show?">
      <div class="goal-row"><div class="grow"><label for="ai-goal">What should the demo show? <span class="hint">One line is enough. Your talk track helps.</span></label>
        <textarea id="ai-goal" rows="2" data-test="ai-goal" data-save="goal" placeholder="A buyer finds out PO-450101 is late, asks Copilot what it holds up, and IT rolls the agent out."></textarea></div>
        ${planBeats(AIS[d.id]?.plan).length ? `<button class="btn" data-action="ai-plan" data-test="ai-plan-again" ${running('ai-plan', d.id) ? 'disabled' : ''}>${I.spark} Draft it again</button>` : ''}</div>
      <div class="row" style="margin-top:8px"><button class="btn" data-action="ai-plan-script" data-test="ai-plan-script" ${running('ai-plan', d.id) ? 'disabled' : ''}>Make it from my script\u2026</button>
        <span class="hint small">Your talk track, in Word, Markdown, RunLines or text. Copilot puts each Do line on the real screens.</span></div>
      <details style="margin-top:6px"><summary>Add notes, a doc or an email to work from</summary>
        <label for="ai-source" class="visually-hidden">Material to work from</label><textarea id="ai-source" rows="3" data-test="ai-source" data-save="source" style="margin-top:8px"></textarea>
        <div class="row" style="margin-top:6px"><button class="btn small" data-action="pick-source-demo">Open a file…</button></div></details>
      <div data-region="ai-plan-progress"></div></section>` : ''}
    ${coachMode(d) ? `<section class="card" aria-label="Your coach"><div class="row"><h2 class="grow">Your coach</h2>
        <button class="btn small" data-action="coach-window" data-test="coach-window">Open it in a small window</button>
        <button class="alink small" data-action="set-mode" data-mode-to="manual">Stop coaching</button></div>
      <p class="muted small" style="margin-top:4px">Copilot shows the next step and what to say while you record. It starts when you start recording.</p>
      <div data-region="coach" style="margin-top:10px"></div></section>` : ''}
    <section class="card rundown" aria-label="Run of show" data-test="run-of-show">
      <div data-region="rec-head"></div>
      <div data-region="ai-run" class="ai-run"></div>
      <div class="rd-cols" aria-hidden="true"><span></span><span>Item</span><span>App</span><span>Time</span><span>State</span></div>
      ${live ? '<div data-region="preshow" hidden></div>' : `<div class="sec">Pre-show</div>
      <div data-region="preshow"></div>
      <div data-region="install" class="install-steps"></div>`}
      <div data-region="show"></div>
      ${copilotMode(d) ? `<details class="plan-edit" data-test="plan-edit"><summary>Edit the plan</summary>
        <p class="small muted" style="margin:8px 0">One step per line: <code>- Click "Plugins"</code>, <code>- Type "\u2026" in "Message"</code>, <code>- Press Enter</code>, <code>- Go to admin</code>, <code>- Wait for the answer</code>, <code>- You: \u2026</code> for something only you can do. <code>&gt;</code> lines are what to say. Steps that could send, save or change something ask you first.</p>
        <label for="ai-plan" class="visually-hidden">Plan</label><textarea id="ai-plan" class="plan" data-test="ai-plan-text" data-save="plan"></textarea></details>` : ''}
      ${!copilotMode(d) && !coachMode(d) && !live ? `<div class="rd-foot small muted">${I.spark} Copilot can also coach you as you click: the next step and what to say. <button class="alink small" data-action="set-mode" data-mode-to="coach" data-test="mode-coach">Coach me</button></div>` : ''}
    </section>
    <div data-region="ai-after"></div>
    ${sent ? `<details class="card sent"><summary>What was sent to Copilot</summary><div data-region="ai-sent"></div></details>` : ''}`;
  if (aiMode(d.mode)) loadAi(d.id);
  // The rundown (talk track beats), the profiles (who, and whether to ask which), and a quiet check (no fixes):
  // Start checks again, with its fixes.
  invoke('rundown', { id: d.id }).then(r => { J(d.id).rundown = r; renderRegions(); }).catch(() => {});
  if (!J(d.id).profiles) invoke('browser_profiles', { id: d.id }).then(p => { J(d.id).profiles = p; renderRegions(); }).catch(() => {});
  const pf = J(d.id).preflight;
  const stale = !pf?.startedAt || Date.now() - pf.startedAt > 120000;
  if (stale && !busy(d.id) && !recState(d).recording) setTimeout(() => { if (S.id === d.id && S.tab === 'record' && !busy(d.id)) step('preflight', 'preflight', { fix: false }); }, 0);
};

// ---- The AI modes on the Record step -----------------------------------------------------------------------------

const AIS = {};   // per demo: what ai_get says (goal, material, plan, what was sent, the last run)
async function loadAi(id) {
  AIS[id] = await invoke('ai_get', { id }).catch(() => AIS[id] || {});
  if (S.id === id && S.tab === 'record') {
    for (const [sel, v] of [['#ai-goal', AIS[id].goal], ['#ai-source', AIS[id].source], ['#ai-plan', AIS[id].plan]]) {
      const el = $(sel);
      if (el && document.activeElement !== el && !el.dataset.dirty) el.value = v || '';
    }
    renderRegions();
  }
}
const questionKinds = new Set(['confirm', 'question', 'you-do']);
function pendingQuestion(events) {
  const answered = new Set(events.filter(e => e.event === 'answered').map(e => e.data.id));
  return [...events].reverse().find(e => questionKinds.has(e.event) && !answered.has(e.data.id));
}
Object.assign(REGIONS, {
  'ai-plan-progress'(d) {
    const j = J(d.id)['ai-plan'] || {};
    if (running('ai-plan', d.id)) return `${progressBar(true)}<p class="small" data-test="ai-planning">${J(d.id).planFrom ? `Copilot is reading ${esc(J(d.id).planFrom)} and putting each step on the screens your demo shows\u2026` : 'Copilot is reading your words and the start screens, and drafting the plan\u2026'}</p>`;
    const plan = (j.events || []).find(e => e.event === 'plan');
    // As the plan is now: the presenter may have edited it since Copilot drafted it.
    const now = planBeats(planText(d)), counts = now.length ? { beats: now.length, steps: now.reduce((n, b) => n + b.steps.length, 0) } : plan?.data;
    if (plan && j.outcome) return `<div class="notice ok" data-test="ai-plan-done" data-steps="${counts.steps}"><div><strong>Plan drafted:</strong> ${plural(counts.beats, 'beat')}, ${plural(counts.steps, 'step')}${plan.data.askFirst ? `, ${plan.data.askFirst} asking you first` : ''}. Check it below.</div></div>`;
    return errorBox(j.error, 'ai-plan');
  },
  'ai-run'(d) {
    const j = J(d.id)['ai-record'] || {};
    const on = running('ai-record', d.id);
    const ev = (j.events || []);
    if (!on && !j.outcome && !j.error) {
      const run = AIS[d.id]?.run;
      return run ? `<p class="muted small">Last run ${esc(ago(Date.parse(run.at)))}: ${plural(run.steps.length, 'step')}${run.stopped ? ', stopped' : ''}.</p>` : '';
    }
    const steps = ev.filter(e => e.event === 'step');
    const cur = steps.at(-1)?.data;
    const q = on ? pendingQuestion(ev) : null;
    const st = j.status;
    const notes = ev.filter(e => ['adapted', 'skipped', 'note', 'waiting'].includes(e.event)).slice(-4);
    let html = '';
    if (on) html += `${progressBar(true)}<div class="row"><strong data-test="ai-step" data-n="${cur?.n || 0}">${cur ? `Step ${cur.n} of ${cur.of}: ${esc(cur.text)}` : esc(j.stages?.at(-1)?.label || 'Starting…')}</strong><span class="spacer"></span>
      <button class="btn small" data-action="ai-stop" data-test="ai-stop">Stop</button></div>
      ${st ? `<p class="muted small">${plural(st.count || 0, 'screen')} captured, ${plural(st.streams || 0, 'streamed answer')}${st.busy ? ' · capturing this screen…' : ''}</p>` : ''}`;
    if (q) {
      const x = q.data;
      if (q.event === 'confirm') html += `<div class="notice warn ask" role="alert" data-test="ai-confirm" data-qid="${esc(x.id)}"><div><strong>May I?</strong> Next: <strong>${esc(x.step)}</strong> in ${esc(x.app)}. ${esc(x.why)}.
        <div class="row" style="margin-top:10px"><button class="btn primary" data-answer="do" data-qid="${esc(x.id)}" data-test="ai-confirm-do">Do it</button>
        <button class="btn" data-answer="self" data-qid="${esc(x.id)}" data-test="ai-confirm-self">I'll click it myself</button>
        <button class="btn" data-answer="skip" data-qid="${esc(x.id)}" data-test="ai-confirm-skip">Skip it</button>
        <button class="btn subtle" data-answer="stop" data-qid="${esc(x.id)}">Stop recording</button></div></div></div>`;
      else html += `<div class="notice info ask" role="alert" data-test="ai-question" data-qid="${esc(x.id)}"><div><strong>${q.event === 'you-do' ? 'Your turn' : 'I need a hand'}:</strong> ${esc(x.text)}${x.step ? ` <span class="muted small">(step: ${esc(x.step)})</span>` : ''}
        <div class="row" style="margin-top:10px"><button class="btn primary" data-answer="done" data-qid="${esc(x.id)}" data-test="ai-question-done">I did it</button>
        <button class="btn" data-answer="skip" data-qid="${esc(x.id)}">Skip it</button>
        <button class="btn subtle" data-answer="stop" data-qid="${esc(x.id)}">Stop recording</button></div>
        ${q.event === 'question' ? `<div class="row" style="margin-top:8px"><input type="text" id="ai-instead" placeholder='Or tell it what to do: Click "Plugins"' style="flex:1"><button class="btn" data-answer="do" data-qid="${esc(x.id)}" data-with-text="1">Do this instead</button></div>` : ''}</div></div>`;
    }
    if (notes.length && on) html += `<ul class="small muted">${notes.map(e => `<li>${esc(e.event === 'adapted' ? `Did "${e.data.to}" instead of "${e.data.from}"` : e.event === 'skipped' ? `Skipped "${e.data.step}": ${e.data.why}` : e.data.text)}</li>`).join('')}</ul>`;
    if (j.outcome) {
      const o = j.outcome;
      html += `<div class="notice ok" data-test="ai-record-done" data-steps="${o.steps}" data-confirmed="${o.confirmed}"><div><strong>Recorded for you:</strong> ${plural(o.summary?.states || 0, 'screen')}, ${plural(o.steps, 'step')}${o.confirmed ? `, ${o.confirmed} after you said yes` : ''}${o.stopped ? ' (stopped early)' : ''}. ${o.script ? `The talk track: ${plural(o.script.beats, 'beat')}, ${plural(o.script.lines, 'line')}.` : ''}</div></div>`;
    }
    return html + errorBox(j.error, 'ai-record');
  },
  'ai-after'(d) {
    const c = J(d.id).aiChain;
    if (!c) return '';
    if (c.stage === 'error') return errorBox(c.error);
    if (c.stage !== 'done') return `${progressBar(true)}<p class="small" data-test="ai-after" data-stage="${c.stage}">Making your replica: <button class="link" data-goto="review">see it in Review</button>.</p>`;
    if (c.checking) return `<div class="notice ok" data-test="ai-after-ready" data-checking="${esc(c.checking)}"><div><strong>Your replica is ready to present.</strong> Each screen is being compared with the real product: <button class="link" data-goto="review">see it in Review</button>.</div></div>`;
    return `<div class="notice ok" data-test="ai-after-done" data-checks="${J(d.id).checks?.outcome?.pass ?? ''}" data-compared="${!!J(d.id).review?.compared}"><div><strong>Your replica is made.</strong> <button class="link" data-goto="review">Review it</button>: every screen next to the real product, with your talk track on its screens.</div></div>`;
  },
  coach(d) {
    const j = J(d.id).coach || {};
    const on = running('coach', d.id);
    const c = (j.events || []).filter(e => e.event === 'coach').at(-1)?.data;
    if (!on && !c) return j.lines?.some(l => l.error) ? errorBox(j.lines.filter(l => l.error).at(-1).text) : '<p class="muted small">Not coaching yet.</p>';
    if (!c) return `${progressBar(true)}<p class="small">${esc(j.stages?.at(-1)?.label || 'Getting ready…')}</p>`;
    return `<div class="coach-box" data-test="coach-next" data-done="${c.done}" data-of="${c.of}" data-finished="${c.finished}">
      <div class="muted small">${c.finished ? 'That was the whole plan: stop recording when you\u2019re done.' : `Beat ${c.beat + 1}: ${esc(c.beatTitle)}${c.offPlan ? ' · off the plan, so a suggestion' : ''}`}</div>
      ${c.next ? `<div class="coach-next"><span class="muted small">Next</span> ${esc(c.next)}</div>` : ''}
      ${c.say ? `<div class="coach-say"><span class="muted small">Say</span> ${esc(c.say)}</div>` : ''}
      <div class="progress"><div style="width:${c.of ? Math.round(100 * c.done / c.of) : 0}%;animation:none"></div></div>
      <p class="muted small">${!c.recording ? 'Start recording below when you\u2019re ready.' : c.busy ? 'Capturing this screen…' : 'Ready for your next step.'}${on ? '' : ' (The coach has stopped.)'}</p></div>`;
  },
  'ai-sent'(d) {
    const sent = AIS[d.id]?.sent || [];
    if (!sent.length) return '<p class="muted small">Nothing yet.</p>';
    const task = { plan: 'Draft the plan', adapt: 'A step that didn\u2019t fit the screen', next: 'A coaching suggestion', script: 'Write the talk track' };
    return `<p class="muted small">Each request, exactly as sent${sent.some(x => x.pageText === false) ? '' : ' (page words included: turn that off on the Copilot page)'}.</p>
      <table class="data" data-test="ai-sent-list" aria-label="What was sent to Copilot"><thead><tr><th scope="col">For</th><th scope="col">Model</th><th scope="col">Size</th><th scope="col">When</th><th scope="col"><span class="visually-hidden">Open</span></th></tr></thead>
      <tbody>${sent.slice(-12).reverse().map(x => `<tr><td>${esc(task[x.task] || x.task)}</td><td class="muted">${esc(x.model)}</td><td class="muted">${(x.chars / 1024).toFixed(1)} KB</td><td class="muted">${esc(ago(Date.parse(x.at)))}</td>
        <td><button class="btn small subtle" data-open-file="${esc(x.file)}">Show</button></td></tr>`).join('')}</tbody></table>`;
  },
});
// After the talk track exists: the replica, its focus points and guide, the checks for what changed.
// After every recording (slice 12): the replica made on its own, then Review. Copilot writes the talk track first when
// it's Copilot's to write; the talk track goes on its screens when there is one; then it's ready to present. Every screen
// compared with the real product, and the quick checks, follow in the background (checkInBackground). A step that fails
// stops the chain and says so in Review.
async function makeReplica(id, { write = false } = {}) {
  const set = stage => { J(id).aiChain = { ...(J(id).aiChain || {}), stage, write }; renderSidebar(); renderRegions(); if (id === S.id) renderHead(); };
  J(id).aiChain = { stage: 'start', write, recorded: J(id)['record-stop']?.outcome || J(id)['ai-record']?.outcome?.summary || null };
  J(id).review = null;
  try {
    if (write) { set('script'); const w = await step('ai-script', 'ai_script', { id }); if (!w) throw new Error(J(id)['ai-script']?.error || 'the talk track wasn\u2019t written'); }
    set('build');
    const b = await step('build', 'build', { force: false, id });
    if (!b?.ok) throw new Error(b?.stopped || J(id).build?.error || 'the build stopped: see Build');
    J(id).scrub = b.scrub;
    if (write || S.demos.find(x => x.id === id)?.status.hasScript) {
      set('focus');
      const sc = await step('script', 'script_run', { id });
      if (!sc) throw new Error(J(id).script?.error || 'the talk track wasn\u2019t put on its screens: see Talk track');
    }
    set('done');
    toast('Your replica is ready to present');
  } catch (e) { J(id).aiChain = { ...(J(id).aiChain || {}), stage: 'error', error: e.message }; }
  await loadReview(id);
  if (aiMode(S.demos.find(x => x.id === id)?.mode)) loadAi(id);
  renderSidebar();
  if (id === S.id) rerender(); else renderRegions();
  if (J(id).aiChain?.stage === 'done') await checkInBackground(id);
}
// Once it's ready: every screen compared with the real product, then the quick checks, in the background. Review fills
// in as each screen is compared; Present doesn't wait for either.
async function checkInBackground(id) {
  const c = J(id).aiChain;
  const done = () => { renderSidebar(); if (id === S.id) rerender(); else renderRegions(); };
  c.checking = 'compare'; done();
  const f = await step('fidelity', 'fidelity_run', { fix: false, id });
  if (!f) c.compareError = J(id).fidelity?.error || 'the comparison stopped: see Real vs replica';
  await loadReview(id);
  c.checking = 'checks'; done();
  await quickChecks(id);
  c.checking = null;
  await loadReview(id);
  done();
}
// Review again as screens are compared (at most every 1.5 s).
const reviewSoon = new Map();
function reloadReviewSoon(id) {
  if (reviewSoon.has(id)) return;
  reviewSoon.set(id, setTimeout(async () => { reviewSoon.delete(id); await loadReview(id); if (id === S.id) { renderHead(); renderRegions(); } }, 1500));
}

// ---- Review: the show, each beat with its screens, and how each compares with the real product ----------------------

async function loadReview(id) {
  J(id).review = await invoke('review_get', { id }).catch(() => null);
  const r = J(id).review;
  // The screen picked: kept while it's still there, else the first that differs, else the first.
  const all = r ? [...r.beats.flatMap(b => b.screens), ...r.others] : [];
  if (!all.some(x => x.id === J(id).pick)) J(id).pick = (all.find(x => x.pass === false) || all[0])?.id || null;
  return r;
}
const MAKING = [
  ['script', 'Copilot is writing your talk track'],
  ['build', 'Building the replica, and taking out email addresses, names and IDs'],
  ['focus', 'Putting your talk track on its screens'],
];
function makingCard(d, c) {
  if (c.stage === 'fix') return `<section class="card making" data-test="making" data-stage="fix" aria-live="polite">
    <p class="sub">Scenecast finds why each screen differs, changes this demo (never with a screenshot), builds it and compares again. A few minutes.</p>
    <div class="line">${mk('spin')}<span>${esc(J(d.id).fidelity?.stages?.at(-1)?.label || 'Starting')}</span></div></section>`;
  const steps = MAKING.filter(([k]) => k !== 'script' || c.write).filter(([k]) => k !== 'focus' || c.write || d.status.hasScript);
  const at = steps.findIndex(([k]) => k === c.stage);
  const rec = c.recorded;
  return `<section class="card making" data-test="making" data-stage="${esc(c.stage)}" aria-live="polite">
    <p class="sub">About a minute. Then it\u2019s ready to present, and each screen is compared with the real product while you look.</p>
    ${rec?.states ? `<div class="line">${mk('ok', 'done')}<span data-test="record-done">Recorded ${plural(rec.states, 'screen')}${rec.beats > 1 ? ` in ${plural(rec.beats, 'beat')}` : ''}${rec.secs ? `, in ${secs(rec.secs)}` : ''}</span></div>` : ''}
    ${steps.map(([k, label], i) => `<div class="line">${mk(i < at ? 'ok' : i === at ? 'spin' : 'todo', i < at ? 'done' : i === at ? 'working' : 'to do')}<span${i > at ? ' class="muted"' : ''}>${label}${i === at ? '\u2026' : ''}</span></div>`).join('')}</section>`;
}
const pctWords = p => p == null ? '' : p < 0.01 ? 'identical' : `${(+p).toFixed(p < 1 ? 2 : 1)}% different`;
// A zoom level or a menu that differs, apart from its screen: "1 zoom level or menu differs".
const viewsWords = n => `${plural(n, 'zoom level or menu', 'zoom levels or menus')} ${n === 1 ? 'differs' : 'differ'}`;
function screenState(sc) {
  return sc.pass === true ? ['ok', 'Matches'] : sc.pass === false ? ['hold', 'Needs a look'] : ['todo', 'Not compared'];
}
const thumbBtn = (d, sc, label) => {
  const [st, says] = screenState(sc);
  return `<button class="thumb ${st === 'hold' ? 'differs' : ''}" data-pick="${esc(sc.id)}" aria-pressed="${J(d.id).pick === sc.id}" aria-label="${esc(label)}: ${says.toLowerCase()}" data-test="screen">
    ${sc.shot ? `<img src="${esc(sc.thumb || sc.shot)}" alt="" loading="lazy" decoding="async">` : '<span class="noshot"></span>'}${st === 'hold' ? `<span class="badge">${svg('<path d="M12 6.5v7M12 17v.5"/>', '')}</span>` : ''}</button>`;
};
Object.assign(REGIONS, {
  review(d) {
    const c = J(d.id).aiChain, r = J(d.id).review;
    if (c && !['done', 'error'].includes(c.stage)) return makingCard(d, c);
    const err = c?.stage === 'error' ? `<div class="notice bad" role="alert" data-test="making-failed"><div class="grow"><strong>The replica wasn\u2019t finished.</strong> ${esc(c.error)}
      <div class="row" style="margin-top:10px"><button class="btn" data-action="make-replica">Try again</button></div></div></div>` : '';
    if (!d.status.recorded) return `<section class="card"><p>Each screen you record shows up here, with how the replica compares.</p><div class="row" style="margin-top:12px"><button class="btn primary" data-goto="record">Record it ${I.arrow}</button></div></section>`;
    if (!d.status.built) return `${err}<section class="card"><h2>Make the replica</h2><p class="muted">Scenecast builds it, checks it and compares every screen with the real product. A few minutes.</p>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-action="make-replica" data-test="make-replica">Make the replica ${I.arrow}</button></div></section>`;
    if (!r) return `${err}<p class="muted">Reading the replica\u2026</p>`;
    const fixing = running('fidelity', d.id);
    // Compared in the background after it's made: ready to present meanwhile.
    const comparing = r.comparing || c?.checking === 'compare';
    const ev = J(d.id).fidelity?.events || [];
    const of = ev.find(e => e.event === 'compare-start')?.data?.items, sofar = ev.filter(e => e.event === 'compared').length;
    const primary = comparing ? `<button class="btn primary" data-goto="present" data-test="review-next">Next: rehearse ${I.arrow}</button>`
      : r.differ || r.viewsDiffer ? `<button class="btn primary" data-action="review-fix" data-test="review-fix" ${fixing ? 'disabled' : ''}>Fix it for me ${I.arrow}</button>`
      : !r.compared ? `<button class="btn primary" data-action="review-compare" data-test="review-compare" ${fixing ? 'disabled' : ''}>Compare with the real product ${I.arrow}</button>`
      : `<button class="btn primary" data-goto="present" data-test="review-next">Next: rehearse ${I.arrow}</button>`;
    let k = 0;
    const row = (b, label, screens) => {
      const bad = screens.filter(x => x.pass === false).length, todo = screens.some(x => x.pass == null);
      const state = bad ? ['hold', `${bad} to look at`, 'warn'] : todo ? ['todo', 'Not compared', 'idle'] : ['ok', 'Matches', 'ok'];
      const meta = [b?.app ? appLabel({ id: b.app }) : '', b?.start != null && b?.end != null ? `${clock(b.start)}\u2013${clock(b.end)}` : '', plural(screens.length, 'screen')].filter(Boolean).join(' \u00b7 ');
      return `<div class="rd-row" data-test="review-beat" data-differ="${bad}">${mk(state[0], state[1])}<span class="t"><b>${label}</b><small>${esc(meta)}</small></span><span class="state ${state[2]}">${state[1]}</span>
        <div class="film">${screens.map((sc, i) => thumbBtn(d, sc, `${label}, screen ${i + 1}`)).join('')}</div></div>`;
    };
    const rows = r.beats.map(b => row(b, b.n === 0 || (r.beats.length === 1 && b.title === 'The show') ? esc(b.title) : `Beat ${b.n} \u00b7 ${esc(b.title)}`, b.screens)).join('')
      + (r.others.length ? row(null, 'Menus and hovers', r.others) : '');
    // Compared before 0.5.3 (drawn headless): text can read about 1% different though it matches. One button checks it
    // again, drawn in Chrome or Edge as it was recorded.
    const all = [...r.beats.flatMap(b => b.screens), ...r.others];
    const oldCheck = r.compared && !comparing && all.some(x => x.pass != null) && !all.some(x => x.realChecker)
      ? `<p class="small muted" data-test="review-old-check">Checked by an older Scenecast, which draws text a little differently. <button class="link" data-action="review-recheck" data-test="review-recheck" ${fixing ? 'disabled' : ''}>Check again in Chrome</button></p>` : '';
    const sub = comparing ? `Comparing each screen with the real product${of ? `: ${sofar} of ${of}` : ''}\u2026 It\u2019s ready to present meanwhile.`
      : !r.compared ? `${plural(r.screens, 'screen')}. Not compared with the real product yet.`
      : r.differ ? `${plural(r.differ, 'screen')} ${r.differ === 1 ? 'differs' : 'differ'} from the real product${r.viewsDiffer ? `, and ${viewsWords(r.viewsDiffer).replace(/ differs?$/, '')}` : ''}. Fix it for me finds why and fixes it.`
      : r.viewsDiffer ? `Every screen matches the real product; ${viewsWords(r.viewsDiffer)}. Fix it for me finds why and fixes it.`
      : 'Every screen matches the real product.';
    // The quick checks (keys, focus points, menus, the guide): not a screen's, so said once, above the show.
    const ck = J(d.id).checks?.outcome;
    const nf = (ck?.items || []).filter(i => i.status === 'fail').length || 1;
    const checks = ck && !ck.pass ? `<div class="notice warn" data-test="review-checks"><div class="grow"><strong>${plural(nf, 'check')} ${nf === 1 ? 'fails' : 'fail'}.</strong> Something beyond the screens (a key, a focus point, a menu) doesn\u2019t work in the replica yet.
      <div class="row" style="margin-top:8px"><button class="btn" data-goto="build">See what fails</button></div></div></div>` : '';
    return `${err}${checks}<div class="review-grid">
      <section class="card rundown compact" aria-label="Show" data-test="review" data-compared="${r.compared}" data-comparing="${!!comparing}" data-screens="${r.screens}" data-views-differ="${r.viewsDiffer || 0}" data-matching="${r.matching}" data-differ="${r.differ}">
        <div class="rd-head"><div class="grow"><h2>Show</h2><small>${sub}</small>${oldCheck}</div><div class="next">${primary}</div></div>
        <div class="rd-cols" aria-hidden="true"><span></span><span>Beat</span><span>State</span></div>
        <div>${rows}</div></section>
      ${pickPanel(d, r)}</div>`;
  },
});
// What the comparison found, in the presenter's words (its report's two stock phrases are the engine's).
const plainWhy = w => /^not diagnosed/i.test(w) ? 'It differs from the real product. Fix it for me finds out why.'
  : /^within the threshold/i.test(w) ? 'Only small differences: anti-aliasing, a shadow, a caret.' : w;
function pickPanel(d, r) {
  const beat = r.beats.find(b => b.screens.some(x => x.id === J(d.id).pick));
  const list = beat ? beat.screens : r.others;
  const i = list.findIndex(x => x.id === J(d.id).pick);
  const sc = list[i];
  if (!sc) return '<section class="card pick"><p class="muted">Pick a screen to see it next to the real product.</p></section>';
  const [st] = screenState(sc);
  const where = beat ? (beat.n === 0 ? `${appLabel({ id: sc.app })}\u2019s start screen` : `Beat ${beat.n}, screen ${i + 1}`) : `Menus and hovers, ${i + 1}`;
  // Compared in the browser it was recorded in: only a real difference fails, and it's shown where it is.
  if (sc.pass === false && sc.spot) return pickPanelSpot(d, sc, where, st);
  const said = sc.pass === true ? `<p><b>Matches.</b> Same as the real product${sc.pct ? ` (${pctWords(sc.pct)}: anti-aliasing, a caret)` : ', to the pixel'}.</p>`
    : sc.pass === false ? `<p><b>${esc(plainWhy(sc.why[0] || 'It differs from the real product.'))}</b> <span class="muted">${pctWords(sc.pct)}.</span></p>${sc.why.length > 1 ? `<ul class="also">${sc.why.slice(1).map(w => `<li>${esc(plainWhy(w))}</li>`).join('')}</ul>` : ''}${(sc.detail || []).length ? `<details class="err-detail"><summary>Details</summary><div class="log">${sc.detail.map(esc).join('\n')}</div></details>` : ''}`
    : '<p class="muted">Not compared yet.</p>';
  // Its zoom levels and menus that differ, each with its own score (not folded into the screen's).
  const views = (sc.views || []).length ? `<ul class="also" data-test="review-views">${sc.views.map(v => `<li>${esc(v.label[0].toUpperCase() + v.label.slice(1))}: ${pctWords(v.pct)}</li>`).join('')}</ul>${sc.pass === true && sc.why.length ? `<p class="small muted">${esc(plainWhy(sc.why[0]))}</p>` : ''}` : '';
  return `<section class="card pick" aria-live="polite" data-test="review-pick" data-screen="${esc(sc.id)}" data-state="${st}">
    <h2>${where}</h2><p class="sub">${esc(appLabel({ id: sc.app }))}</p>
    ${sc.sideBySide ? `<figure class="compare"><div class="labels"><span>Real product</span><span>Your replica</span></div><div class="shotwrap"><img src="${esc(sc.sideBySide)}" alt="The real product and your replica, side by side">${spotBoxes(sc)}</div></figure>`
      : sc.shot ? `<figure class="compare one"><div class="labels"><span>What you recorded</span></div><img src="${esc(sc.shot)}" alt="What you recorded"></figure>` : ''}
    ${said}${views}
    <div class="others"><button class="alink" data-goto="edit" data-test="review-wording">Change wording or a date</button><button class="alink" data-goto="script" data-test="review-say">Edit what you say here</button></div></section>`;
}
// The spot that differs, outlined on both pictures of the side by side (real | 12 px | replica, a 34 px caption on top).
function spotBoxes(sc) {
  if (!sc.spot) return '';
  const [x, y, w, h, W, H] = sc.spot, TW = 2 * W + 12, TH = H + 34, pad = 6;
  const box = left => `<span class="spot" style="left:${(100 * (left - pad) / TW).toFixed(2)}%;top:${(100 * (y + 34 - pad) / TH).toFixed(2)}%;width:${(100 * (w + 2 * pad) / TW).toFixed(2)}%;height:${(100 * (h + 2 * pad) / TH).toFixed(2)}%"></span>`;
  return box(x) + box(x + W + 12);
}
function pickPanelSpot(d, sc, where, st) {
  return `<section class="card pick" aria-live="polite" data-test="review-pick" data-screen="${esc(sc.id)}" data-state="${st}" data-spot="1">
    <h2>${where}</h2><p class="sub">${esc(appLabel({ id: sc.app }))}</p>
    <figure class="compare"><div class="labels"><span>Real product</span><span>Your replica</span></div><div class="shotwrap"><img src="${esc(sc.sideBySide)}" alt="The real product and your replica, side by side">${spotBoxes(sc)}</div></figure>
    <p><b>This spot differs.</b> <span class="muted">It’s outlined on both. Fix it for me finds out why.</span></p>
    <div class="others"><button class="alink" data-goto="edit" data-test="review-wording">Change wording or a date</button><button class="alink" data-goto="script" data-test="review-say">Edit what you say here</button></div></section>`;
}
PANELS.review = async (panel, d) => {
  panel.innerHTML = '<div data-region="review"></div>';
  if (!J(d.id).review && d.status.built) { await loadReview(d.id); }
};

// ---- Build and check ---------------------------------------------------------------------------------------------

const STAGES = ['scrub-raw', 'fingerprint', 'compile-flow', 'process', 'scrub-built', 'sync'];
Object.assign(REGIONS, {
  build(d) {
    const j = J(d.id).build || {};
    const on = running('build', d.id);
    if (!on && !j.outcome && !j.error) return d.status.built ? `<p class="muted">Built ${esc(ago(d.status.builtAt))}: ${plural(d.status.liveScenes, 'page')}.</p>` : '';
    const seen = new Map((j.stages || []).map(s => [s.name, s.label]));
    const last = j.stages?.at(-1)?.name;
    const o = j.outcome;
    return `${progressBar(on)}<ul class="status-list" aria-label="Build stages">${STAGES.filter(s => seen.has(s)).map(s => {
      const st = on && s === last ? 'run' : (o && !o.ok && s === last ? 'fail' : 'ok');
      return `<li>${icon(st, st === 'run' ? 'working' : st === 'fail' ? 'stopped' : 'done')}<span class="id" style="grid-column:span 2">${esc(seen.get(s))}</span><span></span></li>`;
    }).join('')}</ul>
    ${o ? (o.ok ? `<div class="notice ok" data-test="build-done"><div><strong>Built:</strong> ${plural(o.liveScenes, 'live page')}, ${plural(o.streams, 'streamed answer')}, ${plural(o.beats, 'beat')}.${o.fallback.length ? ` ${plural(o.fallback.length, 'fallback scene')} (flagged): ${esc(o.fallback.join(', '))}` : ''}</div></div>`
      : `<div class="notice bad" role="alert" data-test="build-failed"><div>${esc(o.stopped || 'The build has errors.')}${o.errors.length ? `<ul>${o.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div></div>`) : ''}
    ${o?.warnings?.length ? `<details><summary>${plural(o.warnings.length, 'warning')}</summary><ul>${o.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    ${errorBox(j.error, 'build')}${logBox(j.lines)}`;
  },
  scrub(d) {
    const s = J(d.id).build?.outcome?.scrub || J(d.id).scrub;
    if (!s) return '<p class="muted">Build the demo to see what the scrub removed.</p>';
    if (!s.findings.length) return '<div class="notice ok" data-test="scrub-clean">Nothing to remove: no credentials, email addresses or tenant IDs in the recording or the replica.</div>';
    return `<p data-test="scrub-summary">${s.credentials ? `<strong class="pill bad">${plural(s.credentials, 'credential')} found: the build stopped</strong> ` : ''}
      Removed ${plural(s.redacted, 'item')}: ${s.byKind.map(([k, n]) => `${n} ${esc(k)}`).join(', ')}.</p>
      <table class="data" style="margin-top:10px" aria-label="Scrub findings"><thead><tr><th scope="col">What</th><th scope="col">Where</th><th scope="col">Line</th><th scope="col">From</th></tr></thead>
      <tbody>${s.findings.slice(0, 200).map(f => `<tr><td>${f.credential ? '<span class="pill bad">credential</span> ' : ''}${esc(f.kind)}</td><td class="mono">${esc(f.file)}</td><td>${f.line}</td><td>${f.source === 'raw' ? 'Recording' : 'Replica'}</td></tr>`).join('')}</tbody></table>
      <p class="muted small" style="margin-top:8px">Values themselves are never shown or kept in the report. To keep one on purpose (a demo tenant's address), ask whoever set up the demo to allow it.</p>`;
  },
  checks(d) {
    const j = J(d.id).checks || {};
    const on = running('checks', d.id);
    const items = j.outcome?.items?.length ? j.outcome.items : j.items || [];
    if (!items.length && !on) {
      const c = d.status.checks;
      return c ? `<p class="muted">Last run ${esc(ago(c.at))}: ${c.passed} passed, ${c.failed} failed${c.quick ? ' (quick)' : ''}.</p>` + errorBox(j.error, 'checks') : errorBox(j.error, 'checks') || '<p class="muted">Not run yet.</p>';
    }
    const fails = items.filter(i => i.status === 'fail').length;
    return `${progressBar(on)}<ul class="status-list" aria-label="Checks">${items.map(i => `<li data-status="${esc(i.status)}">${icon(i.status)}<span class="id mono">${esc(i.id)}</span><span class="small">${esc(String(i.detail).split('\n')[0].slice(0, 220))}</span><span></span></li>`).join('')}</ul>
      ${j.outcome ? `<div class="notice ${j.outcome.pass ? 'ok' : 'bad'}" data-test="checks-done" data-pass="${j.outcome.pass}" data-quick="${j.outcome.quick}">${j.outcome.pass ? (j.outcome.quick ? 'What changed passes its checks.' : 'Every automatic check passes.') : `${plural(fails, 'check')} failing.`}</div>` : ''}
      ${errorBox(j.error, 'checks')}${logBox(j.lines)}`;
  },
});
PANELS.build = async (panel, d) => {
  panel.innerHTML = `<div class="card"><h2>Build the replica</h2>
      <p class="muted">Turns the recording into the replica: every screen a real captured page. Secrets and personal data are scrubbed on the way; a password, key or token stops the build.</p>
      <div class="row"><button class="btn primary" data-action="build" data-test="build" ${d.status.recorded ? '' : 'disabled'}>${d.status.built ? 'Build again' : 'Build'}</button>
        ${d.status.recorded ? '' : '<span class="muted small">Record the demo first.</span>'}</div>
      <div data-region="build" style="margin-top:12px"></div></div>
    <div class="card"><h2>Scrub report</h2><p class="muted">What was taken out of the replica before anyone sees it.</p><div data-region="scrub"></div></div>
    <div class="card"><h2>Checks</h2><p class="muted">The replica in a headless browser: each step landing where the recording did, presenter keys, focus points, menus and lists, the presenter guide, no errors and nothing fetched from outside. After a build, an edit or a new script, the checks for what changed run on their own (a few minutes at most). Every check, two identical runs and every zoom included, runs once: when you export.</p>
      <div class="row"><button class="btn" data-action="checks-quick" data-test="checks-quick" ${d.status.built ? '' : 'disabled'}>Check what changed</button></div>
      <div data-region="checks" style="margin-top:12px"></div></div>`;
  if (!J(d.id).scrub) J(d.id).scrub = await invoke('last_scrub', { id: d.id }).catch(() => null);
};

// ---- Fidelity ----------------------------------------------------------------------------------------------------

const pct = v => v == null ? '—' : `${(+v).toFixed(v < 0.1 && v > 0 ? 3 : 2)}%`;
Object.assign(REGIONS, {
  'fidelity-progress'(d) {
    const j = J(d.id).fidelity || {};
    const on = running('fidelity', d.id);
    if (!on) return errorBox(j.error, 'fidelity');
    const compared = (j.events || []).filter(e => e.event === 'compared').length;
    const last = j.stages?.at(-1)?.label || 'Starting';
    return `${progressBar(true)}<p class="small" data-test="fidelity-running">${esc(last)}${compared ? ` · ${plural(compared, 'state')} compared` : ''}</p>${logBox(j.lines)}`;
  },
});
async function fidelityView(d) {
  const j = J(d.id).fidelity;
  return j?.outcome || await invoke('fidelity_last', { id: d.id }).catch(() => null);
}
PANELS.fidelity = async (panel, d) => {
  const v = await fidelityView(d);
  const r = v?.report;
  const base = v ? await invoke('file_url', { path: v.dir }) : null;
  const only = J(d.id).onlyDiffs ?? true;
  const items = (r?.items || []).filter(i => !only || !i.pass || i.pct > 0);
  const sum = r?.summary || {};
  panel.innerHTML = `<div class="card"><div class="row"><div class="grow" style="flex:1"><h2>Real vs replica</h2>
      <p class="muted">Every captured state of the real product next to the replica, compared pixel by pixel (each zoom, each menu and pane), and every font checked to be the real file.</p></div></div>
      <div class="row" style="margin-top:12px">
        <button class="btn" data-action="fidelity-check" data-test="fidelity-check" ${d.status.built && !running('fidelity') ? '' : 'disabled'}>Compare</button>
        <button class="btn primary" data-action="fidelity-fix" data-test="fidelity-fix" ${d.status.built && !running('fidelity') ? '' : 'disabled'}>Fix differences</button>
        <span class="muted small">Fix diagnoses each difference, patches this demo (never with a screenshot), builds and compares again.</span></div>
      <div data-region="fidelity-progress"></div>
      ${r ? `<div class="stats" data-test="fidelity-summary" data-within="${sum.within}" data-compared="${sum.compared}">
        <div class="stat"><div class="n">${d.status.fidelity?.score ?? '—'}%</div><div class="l">States that match</div></div>
        <div class="stat"><div class="n">${sum.within ?? 0} / ${sum.compared ?? 0}</div><div class="l">Within ${r.threshold}% of pixels</div></div>
        <div class="stat"><div class="n">${sum.worst ? pct(sum.worst.pct) : '—'}</div><div class="l">Most different${sum.worst ? `: <span class="mono">${esc(sum.worst.id)}</span>` : ''}</div></div>
        <div class="stat"><div class="n">${r.fixes?.length ?? 0}</div><div class="l">Fixes applied</div></div></div>
        <div class="notice ${r.pass ? 'ok' : 'warn'}">${r.pass ? 'Every state matches the real product, and every font is the real file.' : 'Some states still differ: they are listed first, with what was found.'}
          <span class="spacer"></span><button class="btn small" data-open-file="${esc(v.html)}">Open the full report</button></div>` : d.status.built ? '<p class="muted" style="margin-top:12px">Not compared yet.</p>' : '<p class="muted" style="margin-top:12px">Build the demo first.</p>'}
    </div>
    ${r ? `<div class="card"><div class="row"><h2 style="flex:1">States</h2>
      <label class="choice" style="margin:0"><input type="checkbox" id="only-diffs" ${only ? 'checked' : ''}> Only the ones that differ</label></div>
      ${r.fonts?.length ? `<p class="small" style="margin-top:8px">Fonts: ${r.fonts.map(f => `${esc(f.name || f.family)} <span class="pill ${f.status === 'match' ? 'ok' : 'bad'}">${esc(f.status)}</span>`).join(' ')}</p>` : ''}
      ${r.fixes?.length ? `<details><summary>${plural(r.fixes.length, 'fix', 'fixes')} applied</summary><ul>${r.fixes.map(f => `<li><strong>${esc(f.kind)}</strong>: ${esc(f.finding || f.cause || '')}</li>`).join('')}</ul></details>` : ''}
      <div class="shots" style="margin-top:12px">${items.length ? items.sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 60).map(i => {
        const why = (r.residual || []).find(x => x.id === i.id)?.why || [];
        return `<article class="shot" data-test="shot" aria-label="${esc(i.id)}"><header><h3>${esc(i.id)}</h3>
          <span class="muted small">${esc(i.kind)}${i.z !== 100 ? ` at ${i.z}%` : ''}</span>
          <span class="pill ${i.pass ? 'ok' : 'bad'}">${i.pass ? 'Matches' : 'Differs'} · ${pct(i.pct)}</span></header>
          <div class="labels"><span>Real</span><span>Replica</span></div>
          ${i.sideBySide && base ? `<img loading="lazy" src="${esc(base + i.sideBySide)}" alt="The real ${esc(i.id)} and the replica, side by side">` : `<p class="why muted">${esc(i.note || i.error || 'No picture')}</p>`}
          ${why.length && !i.pass ? `<div class="why"><strong>Why:</strong> ${why.map(esc).join('; ')}</div>` : ''}</article>`;
      }).join('') : '<p class="muted">Every state matches, pixel for pixel. Untick the box to see them all.</p>'}</div></div>` : ''}`;
  const cb = $('#only-diffs', panel);
  if (cb) cb.onchange = () => { J(d.id).onlyDiffs = cb.checked; renderPanel(); };
};

// ---- Script ------------------------------------------------------------------------------------------------------

Object.assign(REGIONS, {
  'script-progress'(d) {
    const j = J(d.id).script || {};
    if (!running('script', d.id)) return errorBox(j.error, 'script');
    const ev = j.events || [];
    const matched = ev.filter(e => e.event === 'matched').length;
    return `${progressBar(true)}<p class="small" data-test="script-running">${ev.some(e => e.event === 'indexed') ? `Matching lines${matched ? `: ${matched}` : ''}…` : 'Reading each screen…'}</p>${logBox(j.lines)}`;
  },
});
const LINE_STATUS = { backed: ['ok', 'On screen'], partial: ['warn', 'Partly'], unbacked: ['bad', 'Not on screen'] };
PANELS.script = async (panel, d) => {
  const saved = await invoke('script_get', { id: d.id }).catch(() => ({}));
  const v = J(d.id).script?.outcome || saved.view;
  const [sheet, cues] = v ? await Promise.all([invoke('file_url', { path: v.sheet }), invoke('file_url', { path: v.cues })]) : [];
  const kind = (saved.name || 'script.md').split('.').pop();
  const sheetTab = J(d.id).sheetTab || 'sheet';
  const s = v?.report?.summary;
  panel.innerHTML = `<div class="grid2"><div class="card"><h2>Your script</h2>
      <p class="muted">Paste it, or open a file: plain text (a line per line), Markdown (<code>&gt;</code> quotes are the spoken lines, <code>##</code> headings start beats) or a RunLines <code>.sk</code>.</p>
      <label for="script-text" class="visually-hidden">Script</label>
      <textarea id="script-text" data-test="script-text" placeholder="&gt; Here's the supplier delay on PO-450101…">${esc(saved.text || '')}</textarea>
      <div class="row" style="margin-top:10px">
        <label for="script-kind" class="visually-hidden">Format</label>
        <select id="script-kind" style="width:auto" data-test="script-kind"><option value="md">Markdown</option><option value="txt">Plain text</option><option value="sk">RunLines (.sk)</option></select>
        <button class="btn" data-action="script-open" data-test="script-open">Open a file…</button><span class="spacer"></span>
        <button class="btn primary" data-action="script-run" data-test="script-run" ${d.status.built && !running('script') ? '' : 'disabled'}>Find the focus points</button></div>
      ${d.status.built ? '' : '<p class="muted small" style="margin-top:8px">Build the demo first: each line is matched to the replica\'s screens.</p>'}
      <div data-region="script-progress"></div></div>
    <div class="card"><h2>Lines and their screens</h2>
      ${v ? `<div class="stats" data-test="script-summary" data-points="${s.points}" data-lines="${s.lines}">
        <div class="stat"><div class="n">${s.lines}</div><div class="l">Lines</div></div>
        <div class="stat"><div class="n">${s.backed}</div><div class="l">On their screen</div></div>
        <div class="stat"><div class="n">${s.unbacked}</div><div class="l">Not backed</div></div>
        <div class="stat"><div class="n">${s.points}</div><div class="l">Focus points</div></div></div>
        ${v.guide ? `<div class="notice ok" data-test="script-guide" data-beats="${v.guide.beats}"><div><strong>Presenter guide ready:</strong> ${plural(v.guide.beats, 'beat')}, ${plural(v.guide.pictures, 'picture')}. Open it from Present.</div></div>` : ''}
        ${v.guideError ? `<div class="notice warn"><div>The presenter guide wasn't made: ${esc(v.guideError)}</div></div>` : ''}
        <ul class="lines" aria-label="Script lines">${v.report.lines.map(l => `<li><span class="lid">${esc(l.id)}</span><div>${esc(l.text)}<div class="on">on <span class="mono">${esc(l.state)}</span>${l.points.length ? ` · ${plural(l.points.length, 'focus point')}` : ''}${l.missing.length ? ` · not on screen: ${esc(l.missing.join(', '))}` : ''}</div></div>
          <span class="pill ${LINE_STATUS[l.status]?.[0] || ''}">${LINE_STATUS[l.status]?.[1] || esc(l.status)}</span></li>`).join('')}</ul>`
        : '<p class="muted">Run it to see each line on the screen it plays over, and the focus points it gets.</p>'}</div></div>
    ${v ? `<div class="card"><div class="tabs" role="tablist" aria-label="Sheets" style="margin-bottom:12px">
        <button role="tab" aria-selected="${sheetTab === 'sheet'}" data-sheet="sheet" data-test="sheet-tab">Line-to-screen sheet</button>
        <button role="tab" aria-selected="${sheetTab === 'cues'}" data-sheet="cues" data-test="cues-tab">Cue sheet</button>
        <span class="spacer"></span>${v.sheetPdf ? `<button class="btn small subtle" data-reveal="${esc(v.sheetPdf)}">Show the PDF</button>` : ''}</div>
      <iframe class="sheet" title="${sheetTab === 'sheet' ? 'Line-to-screen sheet' : 'Cue sheet'}" src="${esc(sheetTab === 'sheet' ? sheet : cues)}" data-test="sheet-frame"></iframe></div>` : ''}`;
  $('#script-kind', panel).value = ['md', 'txt', 'sk'].includes(kind) ? kind : 'md';
};

// ---- Edit --------------------------------------------------------------------------------------------------------

Object.assign(REGIONS, {
  edit(d) {
    const url = S.servers.edit[d.id];
    const saved = J(d.id).edit?.saved || [];
    if (!url) return J(d.id).edit?.error ? errorBox(J(d.id).edit.error) : '';
    return `<div class="notice info" data-test="editing" data-url="${esc(url)}"><div><strong>Editing.</strong> ${S.info.noOpen ? 'Open it in your browser:' : 'It opened in its own window. Lost it?'}
      <div class="path"><code>${esc(url)}</code><button class="btn small" data-open-url="${esc(url)}">Open</button><button class="btn small" data-copy="${esc(url)}">Copy</button></div></div></div>
      <h3 style="margin-top:12px">Saved changes <span class="pill" data-test="saved-count">${saved.length}</span></h3>
      ${saved.length ? `<ul class="status-list" aria-label="Saved changes">${saved.slice().reverse().map(s => `<li>${icon(s.error ? 'fail' : 'ok')}<span class="id" style="grid-column:span 2">${esc(s.what || 'a change')}${s.error ? ` <span class="small">(not saved: ${esc(s.error)})</span>` : ''}</span><span class="muted small">${esc((s.files || []).join(', '))}</span></li>`).join('')}</ul>`
        : '<p class="muted">Nothing yet. Every change you make shows at once and is saved here.</p>'}
      ${saved.some(s => s.needsBuild) ? '<div class="notice warn">Wording and date changes are in the replica now; build again to bake them in for export.</div>' : ''}`;
  },
});
PANELS.edit = (panel, d) => {
  const on = !!S.servers.edit[d.id];
  const k = isMac() ? '⌥⇧E' : 'Ctrl+Alt+Shift+E';
  panel.innerHTML = `<div class="card"><h2>Edit the replica</h2>
      <p class="muted">Adjust what the script matched, or add your own focus points, right in the replica. It opens in ${d.browser === 'edge' ? 'Edge' : 'Chrome'} in edit mode; ${esc(k)} turns the editor on and off.</p>
      <div class="row">${on ? `<button class="btn" data-action="edit-stop" data-test="edit-stop">Stop editing</button>`
        : `<button class="btn primary" data-action="edit-start" data-test="edit-start" ${d.status.built ? '' : 'disabled'}>Open the editor</button>`}</div>
      <div data-region="edit" style="margin-top:12px"></div></div>
    <div class="card"><h2>In the editor</h2><table class="data" aria-label="Editor actions"><tbody>
      <tr><td><strong>Add a focus point</strong></td><td>Click what the line points at: a dot. It snaps to the element and gets its zoom, a box or an arrow, its beat and its place.</td></tr>
      <tr><td><strong>Move one</strong></td><td>Drag its dot onto something else.</td></tr>
      <tr><td><strong>Delete, reorder, box or arrow</strong></td><td>Click its dot, then Delete; <kbd>[</kbd> <kbd>]</kbd> for its place; <kbd>M</kbd> for box or arrow. ▶ plays it.</td></tr>
      <tr><td><strong>Change wording or a date</strong></td><td>Drag across the text, type the new words, Enter. It changes everywhere it appears.</td></tr>
      <tr><td><strong>Set where a beat starts</strong></td><td>Go to the screen, then Start here next to the beat.</td></tr>
      <tr><td><strong>Undo</strong></td><td><kbd>${isMac() ? '⌘Z' : 'Ctrl+Z'}</kbd>, or Undo.</td></tr></tbody></table></div>`;
};

// ---- Present -----------------------------------------------------------------------------------------------------

// The screens: the guide on this window's screen (the laptop), the stage on the biggest other one (the projector);
// Swap turns that round. One screen: the stage full screen on it, the guide where it always opened.
function placement(disp) {
  const ds = disp?.displays || [];
  if (ds.length < 2) return { one: ds[0] || null };
  const here = ds.find(x => x.here) || ds.find(x => x.primary) || ds[0];
  const other = ds.filter(x => x !== here).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const [stage, guide] = localStorage.getItem('scenecast.swap') === '1' ? [here, other] : [other, here];
  const box = x => ({ x: x.x, y: x.y, width: x.width, height: x.height });
  return { stage, guide, stagePlace: box(stage), guidePlace: box(guide.work || guide) };
}
const secsWords = n => n < 60 ? `${n} s` : `${clock(n)}`;
// Where the demo stands for the stage, and what's left: the screens match, the guide is made, it's rehearsed.
function stageReady(d, p) {
  const f = d.status.fidelity, g = p?.guide, r = p?.rd?.rehearsal;
  return { matches: !!f?.pass, guide: !!g && !g.missingPictures, rehearsed: !!r, all: !!f?.pass && !!g && !g.missingPictures && !!r };
}
function presentHead(d) {
  const p = J(d.id).pres, rd = p?.rd, r = rd?.rehearsal, slot = d.slot || rd?.slot;
  const side = r ? `<div class="slot" data-test="last-rehearsal"><b>${clock(r.total)}</b>last rehearsal</div>`
    : slot ? `<div class="slot" data-test="slot"><b>${clock(slot)}</b>your slot</div>` : '';
  if (!d.status.built) return { title: 'Not ready for the stage yet', sub: 'Record and review the demo first.', side };
  const ok = stageReady(d, p);
  const when = r ? `rehearsed ${ago(r.at)} in ${clock(r.total)}${slot ? ` of your ${clock(slot)} slot` : ''}` : '';
  if (ok.all) return { title: 'Ready for the stage', sub: `Checked, ${esc(when)}.`, side };
  const left = [!ok.matches && 'make every screen match', !ok.guide && 'make your guide', !ok.rehearsed && 'rehearse it once'].filter(Boolean);
  return { title: 'Almost ready for the stage', sub: `${esc(listWords(left).replace(/^./, c => c.toUpperCase()))}, and it\u2019s ready.`, side };
}
function readyRows(d, p) {
  const f = d.status.fidelity, g = p.guide, rd = p.rd, r = rd?.rehearsal, slot = d.slot || rd?.slot;
  const row = (state, title, small, right, test) => `<div class="rd-row" data-test="${test}" data-status="${state}">${mk(state === 'ok' ? 'ok' : state === 'hold' ? 'hold' : 'todo', state === 'ok' ? 'Ready' : 'Not yet')}
    <div class="t"><b>${title}</b>${small ? `<small>${small}</small>` : ''}</div><span></span><span></span>${right}</div>`;
  const ready = '<span class="state ok">Ready</span>';
  const rows = [];
  rows.push(f?.pass ? row('ok', 'Every screen matches the real product', `${f.total} of ${f.total}`, ready, 'ready-matches')
    : f && f.within === f.total ? row('hold', `Every screen matches; ${viewsWords(f.viewsDiffer || 0)}`, `${f.within} of ${f.total} match`, '<button class="alink" data-goto="review">See them on Review</button>', 'ready-views')
    : f ? row('hold', `${plural(f.total - f.within, 'screen')} ${f.total - f.within === 1 ? 'doesn\u2019t' : 'don\u2019t'} match yet`, `${f.within} of ${f.total} match${f.viewsDiffer ? ` \u00b7 ${viewsWords(f.viewsDiffer)}` : ''}`, '<button class="alink" data-goto="review">Fix on Review</button>', 'ready-matches')
      : row('todo', 'Not compared with the real product yet', 'Review compares each screen with what you recorded.', '<button class="alink" data-goto="review">Compare on Review</button>', 'ready-matches'));
  rows.push(g && !g.missingPictures ? row('ok', 'Presenter guide', 'Talk track, clicks and pictures for each beat', ready, 'ready-guide')
    : g ? row('hold', 'Presenter guide', `${plural(g.missingPictures, 'picture')} not made yet`, '<button class="alink" data-goto="script">Make them</button>', 'ready-guide')
      : row('todo', 'No presenter guide yet', 'Add your talk track on Review, and Scenecast makes it.', '<button class="alink" data-goto="script">Add the talk track</button>', 'ready-guide'));
  const pl = placement(p.disp);
  rows.push(pl.stage ? row('ok', 'Projector found', `${esc(pl.stage.name)}: the stage goes there. Your guide opens on ${esc(pl.guide.name)}.`, S.servers.present[d.id] ? ready : '<button class="alink" data-action="swap-displays" data-test="swap-displays">Swap them</button>', 'ready-screens')
    : row('todo', 'One screen', 'Connect the projector and Scenecast puts the stage there. On one screen, the stage opens full screen.', '<span class="state idle">Optional</span>', 'ready-screens'));
  const over = r && slot ? r.total - slot : null;
  rows.push(r ? row('ok', 'Rehearsed', `${esc(ago(r.at))}, in ${clock(r.total)}${slot ? ` of your ${clock(slot)} slot` : ''}`,
    over > 0 ? `<span class="state warn">${secsWords(over)} over</span>` : ready, 'ready-rehearsed')
    : row('todo', 'Not rehearsed yet', 'Rehearse runs it with the clock going, and keeps each beat\u2019s time.', '<span class="state idle">Not yet</span>', 'ready-rehearsed'));
  return rows.join('');
}
function showRows(d, p) {
  const beats = p.rd?.beats || [];
  if (!beats.length) return `<div class="rd-row" data-test="show-empty">${mk('todo')}<div class="t"><b>Your talk track sets the beats</b><small>Add it on Review: each ## heading is a beat, with its time.</small></div><span></span><span></span>
    <button class="alink" data-goto="script">Add the talk track</button></div>`;
  return beats.map(b => {
    const planned = b.start != null && b.end != null ? b.end - b.start : null;
    const diff = b.took != null && planned != null ? b.took - planned : null;
    const state = b.took == null ? '<span class="state idle">Not rehearsed</span>'
      : diff == null ? '<span class="state ok">Rehearsed</span>' : diff <= 2 ? '<span class="state ok">On time</span>' : `<span class="state warn">Ran ${secsWords(diff)} long</span>`;
    const app = d.apps.find(a => a.id === b.app);
    return `<div class="rd-row" data-test="beat-${b.n}">${mk('todo')}
      <div class="t"><b>Beat ${b.n} · ${esc(b.title)}</b>${app ? `<small>${esc(appLabel(app))}</small>` : ''}</div>
      <span>${b.key ? `<kbd>${esc(b.key)}</kbd>` : ''}</span>
      <span class="time">${planned != null ? `${clock(b.start)}–${clock(b.end)}` : ''}${b.took != null ? `<small>took ${clock(b.took)}</small>` : ''}</span>${state}</div>`;
  }).join('');
}
PANELS.present = async (panel, d) => {
  const url = S.servers.present[d.id];
  if (!d.status.built) {
    panel.innerHTML = `<section class="card rundown"><div class="rd-head"><div class="grow"><h2>Run of show</h2><small>Record the demo and review it first: then it\u2019s ready to rehearse.</small></div>
      <div class="next"><button class="btn primary big" data-gate="${d.status.recorded ? 'review' : 'record'}">${d.status.recorded ? 'Review it' : 'Record it'} ${I.arrow}</button></div></div></section>`;
    return;
  }
  const [rd, guide, keys, disp] = await Promise.all([invoke('rundown', { id: d.id }).catch(() => null), invoke('guide_status', { id: d.id }).catch(() => null),
    url ? null : invoke('key_reference', { id: d.id }).catch(() => null), invoke('displays').catch(() => null)]);
  const p = J(d.id).pres = { rd, guide, keys, disp };
  renderHead();
  const guideUrl = J(d.id).guideUrl, rehearsing = !!J(d.id).rehearsing;
  const gk = isMac() ? '⌥G' : 'Ctrl+Alt+G';
  const head = url ? `<div class="rd-head"><div class="grow"><h2>${rehearsing ? 'Rehearsing' : 'Presenting'}</h2>
      <small data-test="presenting" data-url="${esc(url)}">${S.info.noOpen ? `Open it: <code>${esc(url)}</code>` : J(d.id).fullscreen === false ? `The stage is open in ${esc(browserName())}${placement(disp).stage ? ` on ${esc(placement(disp).stage.name)}` : ''}. To make it full screen, click it and press <kbd>${isMac() ? '⌃⌘F' : 'F11'}</kbd>.` : `The stage is full screen${placement(disp).stage ? ` on ${esc(placement(disp).stage.name)}` : ''}. Scenecast is out of the way.`}</small></div>
      <div class="next">${guide ? '<button class="btn" data-action="present-guide" data-test="present-guide">Open the guide again</button>' : ''}
        <button class="btn primary big" data-action="present-stop" data-test="present-stop">${rehearsing ? 'Stop rehearsing' : 'Stop presenting'}</button></div></div>
      ${guide ? `<div class="notice info" style="margin:12px 20px" data-test="guide-open" data-url="${esc(guideUrl || '')}"><div>${guideUrl ? 'Your guide opened on your laptop screen. Its dot reads <strong>In sync</strong> once the stage is up.' : `Open your guide with <kbd>${esc(gk)}</kbd> on the stage.`}
        ${S.info.noOpen && guideUrl ? `<div class="path"><code>${esc(guideUrl)}</code></div>` : ''}</div></div>` : ''}`
    : `<div class="rd-head"><div class="grow"><h2>Run of show</h2><small>The stage opens full screen on the projector; your guide on this screen.</small></div>
      <div class="next"><button class="btn" data-action="rehearse" data-test="rehearse">${I.play} Rehearse</button>
        <button class="btn primary big" data-action="present-start" data-test="present-start">Present ${I.arrow}</button></div></div>`;
  panel.innerHTML = `<section class="card rundown" aria-label="Run of show">${head}
      <div class="rd-cols" aria-hidden="true"><span></span><span>Item</span><span>Key</span><span>Time</span><span>State</span></div>
      <div class="sec">Pre-show</div>${readyRows(d, p)}
      <div class="sec">Show ${p.rd?.planned ? `<span>${clock(p.rd.planned)} planned${d.slot ? `, your slot is ${clock(d.slot)}` : ''}</span>` : ''}</div>${showRows(d, p)}
    </section>
    ${url ? '' : `<div class="grid2" style="margin-top:18px">
      ${keys ? `<section class="card" data-test="key-reference"><h2>Keys on stage</h2><p class="muted" style="margin-bottom:12px">Your presenter keys: hold <kbd>${esc(keys.modifier)}</kbd> with the key.</p>
        <div class="keys">${keys.groups.map(g => `<div><h3>${esc(g.title)}</h3><table>${g.rows.map(r => `<tr><td><kbd>${esc(r.keys)}</kbd></td><td>${esc(r.what)}</td></tr>`).join('')}</table></div>`).join('')}</div>
        <p class="muted small" style="margin-top:12px">${esc(keys.exit)}</p></section>` : ''}
      <section class="card" data-test="guide-card"><h2>Your guide</h2>
      ${guide ? `<p class="muted small" data-test="guide-status" data-beats="${guide.beats}" data-pictures="${guide.pictures}">A window for your laptop screen: your talk track, the clicks and the time, following the stage. ${plural(guide.beats, 'beat')}, from ${esc(guide.script)}.</p>
        <label class="choice" style="margin:10px 0"><input type="checkbox" id="with-guide" data-test="with-guide" checked> Open it when I present</label>
        <table class="data" aria-label="Guide keys"><tbody>
          <tr><td><kbd>Page Down</kbd> <kbd>Page Up</kbd></td><td>A clicker: the stage moves on, or back.</td></tr>
          <tr><td><kbd>→</kbd> <kbd>←</kbd></td><td>Read ahead or back. The stage stays put.</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Back to the beat the stage is on.</td></tr>
          <tr><td><kbd>${esc(gk)}</kbd> on the stage</td><td>Opens the guide if it isn\u2019t open.</td></tr></tbody></table>`
        : '<p class="muted" data-test="guide-none">Your talk track becomes your guide: a window for your laptop screen with what to say, the clicks and the time. Add it on Review.</p>'}</section></div>`}`;
};

// ---- Share -------------------------------------------------------------------------------------------------------

const SHARE_KINDS = {
  share: { title: 'A Scenecast file', text: 'They double-click it, and it opens ready to rehearse, with your guide.', go: 'Make the file' },
  folder: { title: 'A folder for any browser', text: 'For someone without Scenecast: it opens in Edge or Chrome.', go: 'Make the folder' },
};
Object.assign(REGIONS, {
  export(d) {
    const j = J(d.id).export || {};
    const items = j.items || [];
    const list = items.length ? `<ul class="status-list" aria-label="Checks before sharing">${items.map(i => `<li data-status="${esc(i.status)}">${icon(i.status)}<span class="id">${esc(i.id)}</span><span class="small">${esc(String(i.detail).split('\n')[0].slice(0, 220))}</span><span></span></li>`).join('')}</ul>` : '';
    if (running('export', d.id)) {
      const last = j.stages?.at(-1);
      return progressBar(true) + `<p class="small" data-test="export-running">${esc(last?.label || 'Checking every screen first…')}</p>${list}`;
    }
    const r = j.outcome;
    if (!r) return errorBox(j.error, 'export');
    if (!r.exported) {
      const fails = (r.checks?.items || []).filter(i => i.status === 'fail');
      return `<div class="notice bad" role="alert" data-test="export-checks-failed"><div class="grow"><strong>Not shared yet: ${plural(fails.length, 'check')} ${fails.length === 1 ? 'fails' : 'fail'}.</strong>
        Fix ${fails.length === 1 ? 'it' : 'them'} on Review, then share again. Or share it as it is.
        <div class="row" style="margin-top:10px"><button class="btn small" data-action="export-anyway" data-test="export-anyway">Share it anyway</button>
        ${r.checks?.report ? `<button class="btn small subtle" data-open-file="${esc(r.checks.report)}">Open the full report</button>` : ''}</div>
        <details class="err-detail"><summary>Details</summary><ul class="small">${fails.map(i => `<li><code>${esc(i.id)}</code>: ${esc(String(i.detail).split('\n')[0].slice(0, 220))}</li>`).join('')}</ul></details></div></div>`;
    }
    const o = r.exported;
    const mb = (o.bytes / 1048576).toFixed(1);
    const checked = { ran: 'Every check passed first.', current: 'Every check had passed, and nothing has changed since.', skipped: 'Shared without the checks passing.' }[r.checked] || '';
    const what = o.kind === 'share' ? 'The Scenecast file is ready' : o.kind === 'zip' ? 'The zip is ready' : 'The folder is ready';
    const how = o.kind === 'share' ? 'Send it to the other presenter. They double-click it, and it opens in Scenecast on Present.'
      : 'Send it to the other presenter. They open index.html in Edge or Chrome: no install, nothing online.';
    return `<div class="notice ${r.checked === 'skipped' ? 'warn' : 'ok'}" data-test="export-done" data-path="${esc(o.path)}" data-kind="${esc(o.kind)}" data-checked="${esc(r.checked)}"><div class="grow"><strong>${what}</strong> (${mb} MB). ${esc(checked)}
      <p class="small" style="margin-top:4px">${how}</p>
      <div class="row" style="margin-top:10px"><button class="btn small" data-reveal="${esc(o.path)}">Show in ${folderWord()}</button><button class="btn small subtle" data-copy="${esc(o.path)}">Copy where it is</button></div></div></div>`;
  },
});
PANELS.export = async (panel, d) => {
  const dest = J(d.id).dest || await invoke('default_export_dir');
  J(d.id).dest = dest;
  const kind = J(d.id).shareKind || 'share';
  const busyNow = !d.status.built || running('checks') || running('export');
  panel.innerHTML = `<div class="split">
    <div><div class="ways stacked" role="radiogroup" aria-label="What to send">${Object.entries(SHARE_KINDS).map(([k, x]) => `<label class="way big" data-test="share-kind-${k === 'share' ? 'file' : 'folder'}">
        <input type="radio" name="share-kind" value="${k}" ${k === kind ? 'checked' : ''}><span><b>${esc(x.title)}</b><small>${esc(x.text)}</small></span></label>`).join('')}</div>
      <div class="row" style="margin-top:18px"><button class="btn primary big" data-action="export-go" data-test="export-go" ${busyNow ? 'disabled' : ''}>${esc(SHARE_KINDS[kind].go)} ${I.arrow}</button>
        <span class="muted small">${d.status.built ? 'Every check runs first: a few minutes.' : 'Record and review the demo first.'}</span></div>
      <p class="small muted" style="margin-top:10px" data-test="export-dest">Saves to <strong>${esc(dest.split(/[\\/]/).filter(Boolean).pop() || dest)}</strong>. <button class="alink" data-action="export-pick">Change</button></p>
      <div data-region="export" style="margin-top:14px"></div></div>
    <aside class="card"><h2>Got a demo file?</h2>
      <p>Someone sent you a <strong>.scenecast</strong> file? Double-click it, or open it here. It opens on Present, ready to rehearse.</p>
      <div class="row" style="margin-top:12px"><button class="btn" data-action="share-open" data-test="share-open">Open a demo file…</button></div></aside></div>`;
  panel.querySelectorAll('[name=share-kind]').forEach(r => { r.onchange = () => { J(d.id).shareKind = r.value; renderPanel(); }; });
};

// ---- Actions -----------------------------------------------------------------------------------------------------

// The checks for only what changed: after a build, an edit or a new script. Never the whole checklist (that's Export).
async function saveAiField(field, value, id = S.id) {
  AIS[id] = await call('ai_save', { id, [field]: value });
}
async function saveAiFields(id = S.id) {
  const goal = $('#ai-goal'), source = $('#ai-source');
  if (!goal && !source) return;
  AIS[id] = await call('ai_save', { id, goal: goal ? goal.value : null, source: source ? source.value : null });
}
document.addEventListener('input', e => { if (e.target.dataset.save) e.target.dataset.dirty = '1'; if (e.target.id === 'ai-plan') scheduleRegions(); if ('appUrl' in e.target.dataset) createLabel(); });
document.addEventListener('change', e => {
  const f = e.target.dataset.save;
  if (!f || f === 'plan' || S.view !== 'demo') return;
  saveAiField(f, e.target.value).then(() => { delete e.target.dataset.dirty; }).catch(() => {});
});
async function quickChecks(id = S.id) {
  if (!S.demos.find(x => x.id === id)?.status.built) return;
  return step('checks', 'run_checks', { quick: true, id });
}
// Export: the whole checklist first (unless it passed and nothing changed since), then the folder or zip.
async function exportDemo(kind, anyway) {
  J(S.id).exportKind = kind;
  return step('export', 'export_demo', { kind, dest: J(S.id).dest, anyway });
}
// A .scenecast file (double-clicked, or Open a demo file): into the library, opened on Present.
const recentOpens = new Map();
async function openShared(path) {
  // The same file can arrive twice at launch (as it opens, and in the list of files waiting): open it once.
  if (Date.now() - (recentOpens.get(path) || 0) < 15000) return;
  recentOpens.set(path, Date.now());
  try {
    const d = await call('share_import', { path });
    await loadDemos();
    toast(`Opened \u201c${d.title}\u201d: ready to rehearse`);
    await openDemo(d.id, 'present');
  } catch { /* call() said what went wrong */ }
}
// Present or Rehearse: the stage on the projector and the guide on this screen when there are two.
async function presentNow(rehearse) {
  const id = S.id, guide = $('#with-guide')?.checked ?? true;
  const pl = placement(J(id).pres?.disp);
  const r = await call('present_start', { id, guide, rehearse, stage: pl.stagePlace || null, guidePlace: pl.guidePlace || null });
  S.servers.present[id] = r.url;
  J(id).guideUrl = r.guide || null;
  J(id).fullscreen = r.fullscreen;
  J(id).rehearsing = rehearse;
  announce(`${rehearse ? 'Rehearsing' : 'Presenting'}${r.guide ? ', with your guide' : ''}`);
  rerender();
}
async function refreshServers() {
  S.servers = await invoke('servers').catch(() => S.servers);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* the webview may not allow it: the old way */ }
  const t = document.createElement('textarea');
  t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.append(t); t.select();
  try { document.execCommand('copy'); } finally { t.remove(); }
}
const ACTIONS = {
  new: renderNew,
  copilot: () => { renderCopilot(); refreshAi(); },
  'ai-sign-in': async () => {
    // Right where it was pressed: the page and anything typed in it stay; the code shows below the button.
    AI.signing = true; AI.code = null; AI.runtime = null; AI.error = null; AI.signInError = null; renderCopilotState();
    if (S.view === 'copilot') renderCopilot(); else renderRegions();
    try { await invoke('ai_sign_in'); toast('Signed in to GitHub Copilot'); } catch (e) {
      AI.signInError = typeof e === 'string' ? e : e.message;
      const x = why(AI.signInError, 'ai-sign-in');
      if (x && !document.querySelector('[data-region=copilot-signin]')) toast(`${x.title}. ${x.body}`, true);
    }
    AI.signing = false; AI.code = null;
    await refreshAi();
  },
  'show-logs': async () => { const d = await call('logs_dir'); call('reveal', { path: d }).catch(() => {}); },
  details: () => {
    S.details = !S.details;
    $('#details').hidden = !S.details;
    $('[data-action=details]').setAttribute('aria-expanded', String(S.details));
    if (S.details) renderRegions();
  },
  diagnostics: async () => { await copyText(diagnostics()); toast('Diagnostics copied: paste them where you\u2019re asking for help'); },
  help: () => call('open_url', { url: 'https://github.com/jldeen/scenecast/blob/main/docs/guide.md' }).catch(() => {}),
  'new-where': t => { const box = $('#new-where-box'); box.hidden = !box.hidden; t.setAttribute('aria-expanded', String(!box.hidden)); },
  'first-pick': () => { FR.picking = !FR.picking; renderRegions(); },
  'first-browser': t => { localStorage.setItem('scenecast.browser', t.dataset.browser); localStorage.removeItem('scenecast.profile'); loadBrowser(t.dataset.browser); },
  'ai-sign-out': async () => { await call('ai_sign_out'); await refreshAi(); },
  'ai-models': async () => { AI.models = (await call('ai_models')).models; renderCopilot(); },
  'pick-source-demo': async () => { const f = await call('pick_text_file'); if (f) { $('#ai-source').value = f.text; await saveAiField('source', f.text); toast(`Using ${f.name}`); } },
  // Make it from my script: her talk track, mapped onto the demo's screens; the plan shows here to approve once.
  'ai-plan-script': async () => {
    const id = S.id;
    const f = await call('pick_script_file');
    if (!f) return;
    await saveAiFields(id);
    J(id).planFrom = f.name;
    const o = await step('ai-plan', 'ai_plan', { script: f.path });
    J(id).planFrom = null;
    if (o) { const p = $('#ai-plan'); if (p) delete p.dataset.dirty; await loadAi(id); }
  },
  'ai-plan': async () => {
    const id = S.id;
    J(id).planFrom = null;
    await saveAiFields(id);
    const o = await step('ai-plan', 'ai_plan', {});
    if (o) { const p = $('#ai-plan'); if (p) delete p.dataset.dirty; await loadAi(id); }
  },
  'ai-record': async () => {
    const id = S.id;
    const plan = $('#ai-plan')?.value || '';
    if (!plan.trim()) return toast('Draft the plan first', true);
    // Approving is the plan as it is now: its writes included. Any edit after this needs approving again.
    try { await saveAiFields(id); await call('ai_save', { id, plan }); await call('ai_approve', { id }); } catch { return; }
    J(id).aiChain = null;
    const o = await step('ai-record', 'ai_record', {});
    loadAi(id);
    // Copilot's run stays on screen (what it did, what it asked); the replica is made meanwhile, a link away.
    if (o) await makeReplica(id);
  },
  'ai-stop': () => call('ai_stop', { id: S.id }).then(() => toast('Stopping: what was recorded is kept')),
  'coach-start': async () => {
    const id = S.id;
    await saveAiFields(id);
    J(id).coach = { events: [], lines: [], stages: [] };
    await call('ai_coach', { id });
    rerender();
  },
  'coach-window': async () => { const u = await call('ai_coach_window', { id: S.id }); if (S.info.noOpen) toast(u); },
  library: renderLibrary,
  extension: () => step('extension', 'prepare_extension', {}),
  install: () => {
    // Browsers only open their extensions page from their own address bar: its address goes on the clipboard now,
    // while this click still counts as one.
    copyText(`${demo()?.browser === 'edge' ? 'edge' : 'chrome'}://extensions`);
    if (S.tab !== 'record') { S.tab = 'record'; openDemo(S.id); }
    setTimeout(() => $('[data-region=install]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    return step('install', 'install_recorder', {});
  },
  'receiver-fix': async () => {
    const id = S.id;
    S.rx = await call('receiver_ensure', { id }).catch(() => S.rx);
    renderRegions();
    if (J(id).preflight?.items?.length) await step('preflight', 'preflight', { fix: false });
  },
  preflight: () => step('preflight', 'preflight', { fix: false }),
  'preflight-fix': () => step('preflight', 'preflight', { fix: true }),
  'record-start': async () => {
    const id = S.id, d = demo();
    J(id)['record-stop'] = {};
    J(id).record = {};
    // The check runs inside Start (with its fixes): its items land in the pre-show as they come.
    J(id).preflight = { items: [], startedAt: Date.now() };
    J(id).preshowOpen = false;
    if (coachMode(d) && !running('coach', id)) { await saveAiFields(id).catch(() => {}); call('ai_coach', { id }).catch(() => {}); }
    await step('record', 'record_start', { resume: false });
  },
  // How it's recorded: by hand, coached, or by Copilot. Any demo can switch.
  'set-mode': async t => {
    const id = S.id, mode = t.dataset.modeTo;
    if (mode !== 'record') await saveAiFields(id).catch(() => {});
    await call('ai_save', { id, mode });
    await refreshDemo(id);
    if (mode !== 'manual' && !AI.status) refreshAi();
    rerender();
    announce({ manual: 'You click through', record: 'Copilot clicks for you', coach: 'Copilot coaches you as you click' }[mode] || '');
  },
  'use-profile': async () => {
    const id = S.id;
    J(id).pickProfile = !J(id).pickProfile;
    if (J(id).pickProfile && !J(id).profiles) J(id).profiles = await invoke('browser_profiles', { id }).catch(() => null);
    renderHead();
  },
  'preshow-toggle': () => { J(S.id).preshowOpen = !J(S.id).preshowOpen; renderRegions(); },
  'edit-app': t => { J(S.id).editApp = t.dataset.app || null; J(S.id).preshowOpen = true; renderRegions(); $(`#addr-${t.dataset.app}`)?.focus(); },
  // Which tab is it? The one picked is kept as the app's address, then checked again.
  'pick-tab': async t => {
    const id = S.id, app = t.dataset.app, url = $(`#pick-${app}`)?.value;
    if (!url) return;
    await call('set_app', { id, app, url });
    await refreshDemo(id);
    toast(`${appLabel(demo().apps.find(a => a.id === app) || { id: app })} is that tab now`);
    step('preflight', 'preflight', { fix: false });
  },
  'pick-profile': async t => {
    const id = S.id;
    await call('set_profile', { id, profile: t.dataset.profile });
    await refreshDemo(id);
    J(id).profiles = await invoke('browser_profiles', { id }).catch(() => J(id).profiles);
    step('preflight', 'preflight', { fix: false });
  },
  'record-pause': async () => {
    const id = S.id;
    await call('record_pause', { id });
    const j = J(id).record || {};
    if (j.status) j.status = { ...j.status, held: { why: 'you', secs: 0 } };
    renderSidebar(); renderHead();
  },
  'record-go-on': async t => {
    const id = S.id;
    J(id).running['record-go-on'] = true; renderRegions();
    try {
      const r = await call('record_go_on', { id, anyway: !!t.dataset.anyway });
      J(id).goOnOff = r?.off?.length ? r.off : null;
      const j = J(id).record || {};
      if (!J(id).goOnOff && j.status) j.status = { ...j.status, held: undefined };
    } catch { /* said in a toast */ } finally { delete J(id).running['record-go-on']; renderSidebar(); renderHead(); }
  },
  'record-stop': async () => {
    const id = S.id;
    J(id).goOnOff = null;
    const o = await step('record-stop', 'record_stop', {}, () => { J(id).record = {}; });
    if (!o) return;
    // Saved: on to Review, where the replica is made and checked without a button.
    const d = S.demos.find(x => x.id === id);
    const chain = makeReplica(id, { write: d?.mode === 'script' || d?.mode === 'coach' });
    if (S.id === id) openDemo(id, 'review');
    await chain;
  },
  'make-replica': () => makeReplica(S.id),
  'review-compare': async () => { const id = S.id; await step('fidelity', 'fidelity_run', { fix: false }); await loadReview(id); rerender(); },
  'review-recheck': async () => { const id = S.id; await step('fidelity', 'fidelity_run', { fix: false, real: true }); await loadReview(id); renderSidebar(); rerender(); },
  'review-fix': async () => {
    const id = S.id;
    J(id).aiChain = { stage: 'fix' }; renderSidebar(); rerender();
    await step('fidelity', 'fidelity_run', { fix: true });
    J(id).aiChain = { stage: 'done' };
    await loadReview(id); renderSidebar(); rerender();
  },
  build: async () => {
    const o = await step('build', 'build', { force: false }, o => { J(S.id).scrub = o.scrub; });
    if (o?.ok) await quickChecks();
  },
  'checks-quick': () => quickChecks(),
  'fidelity-check': () => step('fidelity', 'fidelity_run', { fix: false }),
  'fidelity-fix': () => step('fidelity', 'fidelity_run', { fix: true }),
  'script-open': async () => {
    const r = await call('script_open', { id: S.id });
    if (r) { $('#script-text').value = r.text; $('#script-kind').value = r.kind; toast(`Opened; kept with the demo as ${r.name}`); }
  },
  'script-run': async () => {
    const text = $('#script-text').value;
    const kind = $('#script-kind').value;
    J(S.id).scriptDraft = text;
    try { await call('script_save', { id: S.id, text, kind }); } catch { return; }
    const o = await step('script', 'script_run', {});
    if (o) await quickChecks();
  },
  'edit-start': async () => {
    J(S.id).edit = { saved: J(S.id).edit?.saved || [] };
    try {
      const url = await call('edit_start', { id: S.id });
      S.servers.edit[S.id] = url;
    } catch (e) { J(S.id).edit.error = e.message; }
    rerender();
  },
  'edit-stop': async () => {
    const id = S.id;
    await call('edit_stop', { id });
    await refreshServers();
    rerender();
    // What the edits touched gets its checks now, and only that.
    if ((J(id).edit?.saved || []).some(x => !x.error)) await quickChecks();
  },
  'present-start': () => presentNow(false),
  rehearse: () => presentNow(true),
  'swap-displays': () => { localStorage.setItem('scenecast.swap', localStorage.getItem('scenecast.swap') === '1' ? '0' : '1'); renderPanel(); },
  'present-guide': async () => {
    J(S.id).guideUrl = await call('present_guide', { id: S.id });
    toast('Opened the presenter guide on this screen');
    rerender();
  },
  'present-stop': async () => {
    const id = S.id, was = J(id).rehearsing;
    await call('present_stop', { id });
    J(id).rehearsing = false;
    await refreshServers();
    await refreshDemo(id);
    rerender();
    if (was) announce('Rehearsal kept: each beat\u2019s time is in the run of show');
  },
  'export-pick': async () => {
    const p = await call('pick_folder');
    if (p) { J(S.id).dest = p; renderPanel(); }
  },
  'export-go': () => exportDemo(J(S.id).shareKind || 'share', false),
  'export-anyway': () => exportDemo(J(S.id).exportKind || 'share', true),
  'share-open': async () => { const p = await call('pick_share_file'); if (p) openShared(p); },
};

document.addEventListener('click', async e => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const ds = t.dataset;
  if (ds.open) { e.preventDefault(); return openDemo(ds.open); }
  if (ds.answer) {
    const text = ds.withText ? $('#ai-instead')?.value.trim() : undefined;
    if (ds.withText && !text) return toast('Say what to do instead', true);
    return call('ai_answer', { id: S.id, question: ds.qid, answer: ds.answer, text: text || null });
  }
  if (ds.copyOpen) { await copyText(ds.copyOpen); toast('Code copied'); return call('open_url', { url: ds.url }).catch(() => {}); }
  if (ds.action && ACTIONS[ds.action]) { e.preventDefault(); return ACTIONS[ds.action](t); }
  if (ds.gate) { S.tab = gateTab(ds.gate); return openDemo(S.id).then(() => $(`[data-gate=${ds.gate}]`)?.focus()); }
  if (ds.duplicate) return duplicateDemo(ds.duplicate);
  if (ds.delete) return deleteDemo(ds.delete);
  if (ds.tab) { S.tab = S.reviewTab = ds.tab; renderTabsBar(); renderHead(); await renderPanel(); return $(`#tab-${ds.tab}`)?.focus(); }
  if (ds.goto) { S.tab = ds.goto; return openDemo(S.id); }
  if (ds.pick) { J(S.id).pick = ds.pick; return renderRegions(); }
  if (ds.sheet) { J(S.id).sheetTab = ds.sheet; return renderPanel(); }
  if (ds.reveal) return call('reveal', { path: ds.reveal }).catch(() => {});
  if (ds.copy) { await copyText(ds.copy); return toast('Copied'); }
  if (ds.openUrl) return call('open_url', { url: ds.openUrl }).catch(() => {});
  if (ds.openFile) return call('open_file', { path: ds.openFile }).catch(() => {});
  if (ds.removeApp !== undefined) { const rows = document.querySelectorAll('[data-app-row]'); if (rows.length > 1) t.closest('[data-app-row]').remove(); return; }
  if (t.id === 'add-app') { const n = document.querySelectorAll('[data-app-row]').length; $('#apps').insertAdjacentHTML('beforeend', appRow(n)); return $(`#app-id-${n}`).focus(); }
});
// The first run's browser and profile, and a demo's slot (Details).
document.addEventListener('change', e => {
  const t = e.target;
  if (t.name === 'fr-browser') { localStorage.setItem('scenecast.browser', t.value); localStorage.removeItem('scenecast.profile'); return loadBrowser(t.value); }
  if (t.name === 'profile' && t.closest('#fr-profiles')) { localStorage.setItem('scenecast.profile', t.value); return renderRegions(); }
  if (t.id === 'browser' && S.view === 'demo') {
    const id = S.id;
    return call('set_browser', { id, browser: t.value }).then(async () => {
      J(id).profiles = null; J(id).preflight = null;
      await refreshDemo(id);
      J(id).profiles = await invoke('browser_profiles', { id }).catch(() => null);
      toast(`Recording in ${BNAME[t.value]}`);
      rerender();
    }).catch(() => {});
  }
  if (t.name === 'profile' && t.closest('#profile-pick')) {
    const id = S.id;
    return call('set_profile', { id, profile: t.value }).then(async () => {
      await refreshDemo(id);
      toast(t.value ? `Recording as ${t.closest('label').querySelector('.pname').textContent}` : 'Recording in the profile the recorder is in');
      J(id).pickProfile = false;
      rerender();
    }).catch(() => {});
  }
  if (t.id === 'slot-pick') {
    const id = S.id;
    call('set_slot', { id, slot: +t.value || null }).then(async () => { await refreshDemo(id); renderHead(); toast(+t.value ? `Your slot: ${+t.value / 60} min` : 'No set length'); }).catch(() => {});
  }
});
document.addEventListener('submit', e => {
  if (e.target.id === 'new-form') { e.preventDefault(); createDemo(e.target); }
  // An app's address, changed on Record's pre-show.
  const app = e.target.dataset?.appForm;
  if (app) {
    e.preventDefault();
    const id = S.id, url = e.target.querySelector('input').value;
    call('set_app', { id, app, url }).then(async () => {
      J(id).editApp = null;
      await refreshDemo(id);
      toast('Saved');
      step('preflight', 'preflight', { fix: false });
    }).catch(() => {});
  }
});
// Tabs: arrow keys move between them (and Home, End).
document.addEventListener('keydown', e => {
  const tab = e.target.closest?.('#tabs [role=tab]');
  if (!tab) return;
  const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
  const i = tabs.indexOf(tab);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  tabs[(next + tabs.length) % tabs.length].click();
});
$('#new-demo').onclick = renderNew;
// Busy while the list loads: the table is drawn again when it's in (screen readers wait; so does the UI test).
$('#nav-copilot').onclick = ACTIONS.copilot;
$('#help').onclick = ACTIONS.help;
$('#nav-library').onclick = async () => { const m = $('#main'); m.setAttribute('aria-busy', 'true'); try { await loadDemos(); renderLibrary(); } finally { m.removeAttribute('aria-busy'); } };
// ---- Updates: checked at start, every 30 minutes, and when the window comes back to the front (at most every 10
// minutes); quietly, a failed check is just tried again later. A newer version shows at once: a dot on "Check for
// updates" and "Update to vX.Y.Z" in the sidebar. Nothing installs until it's clicked, and not while recording or
// presenting.
const U = { available: null, busy: false, progress: null, checkedAt: 0 };
const inTheMiddle = () => Object.values(S.jobs).some(j => j.running.record || j.running['ai-record']) || Object.keys(S.servers.present || {}).length > 0;
function renderUpdate() {
  const el = $('#update');
  const link = $('#check-updates');
  link.classList.toggle('has-update', !!U.available);
  link.dataset.available = U.available || '';
  if (!U.available) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const p = U.progress;
  const pct = p?.total ? Math.round(100 * p.downloaded / p.total) : null;
  const hold = inTheMiddle();
  el.innerHTML = U.busy
    ? `<div class="small"><strong>Updating to v${esc(U.available)}…</strong> ${p?.stage === 'install' ? 'Installing; Scenecast restarts in a moment.' : pct !== null ? `${pct}%` : 'Downloading'}</div>
       <div class="progress" role="progressbar" aria-label="Downloading the update" ${pct !== null ? `aria-valuenow="${pct}"` : ''}><div style="${pct !== null ? `width:${pct}%;animation:none` : ''}"></div></div>`
    : `<div class="small"><span class="update-dot" aria-hidden="true"></span>A new version is ready: <strong>v${esc(U.available)}</strong></div>
       <button class="btn small primary" id="update-now" data-test="update-now" ${hold ? 'disabled title="After you stop recording or presenting"' : ''}>Update to v${esc(U.available)}</button>
       ${hold ? '<div class="small muted">After you stop recording or presenting.</div>' : ''}`;
  const b = $('#update-now');
  if (b) b.onclick = installUpdate;
}
async function checkUpdates(quiet) {
  U.checkedAt = Date.now();
  const u = await invoke('check_updates').catch(e => ({ error: String(e) }));
  if (!u.error || !quiet) U.available = u.available || null;
  renderUpdate();
  if (U.available && quiet) announce(`Scenecast ${U.available} is ready to install`);
  if (quiet) return u;
  // The updater's own words go under Details; the address and the error are in the app's log.
  if (u.error) dialog({ title: 'Updates', body: `<p>${/valid release JSON|ReleaseNotFound|status|connect|dns|timed out/i.test(u.error) ? 'Scenecast couldn\u2019t reach the update server, or it had no update information. Try again later.' : 'Scenecast couldn\u2019t check for updates. Try again later.'}</p><details class="err-detail"><summary>Details</summary><div class="log">${esc(u.error)}</div></details>`, cancel: null });
  else if (!u.available) dialog({ title: 'Updates', body: `<p>You have the newest Scenecast (v${esc(u.current)}).</p>`, cancel: null });
  return u;
}
async function installUpdate() {
  if (inTheMiddle()) return toast('Stop recording or presenting first, then update', true);
  U.busy = true; U.progress = null; renderUpdate();
  try {
    // Restarts on the new version when it's installed: nothing after this runs.
    await invoke('install_update');
  } catch (e) {
    U.busy = false; renderUpdate();
    toast('The update didn\u2019t install. Scenecast will offer it again; your demos are unchanged.', true);
  }
}
listen('update-progress', ({ payload }) => { U.progress = payload; renderUpdate(); });
const quietCheck = () => { if (!U.busy && Date.now() - U.checkedAt > 10 * 60 * 1000) checkUpdates(true); };
window.addEventListener('focus', quietCheck);
document.addEventListener('visibilitychange', () => { if (!document.hidden) quietCheck(); });
$('#check-updates').onclick = () => checkUpdates(false);

// ---- Start -------------------------------------------------------------------------------------------------------

listen('open-file', ({ payload }) => openShared(payload));
S.info = await call('app_info');
$('#version').textContent = `v${S.info.version}${S.info.testFeed ? ' \u00b7 test updates' : ''}`;
document.documentElement.dataset.os = S.info.os;
await loadDemos();
await refreshServers();
renderLibrary();
for (const p of (await invoke('pending_opens').catch(() => null)) || []) await openShared(p);
if (S.info.engineError) { const x = why(S.info.engineError); if (x) toast(`${x.title}. ${x.body}`, true); }
refreshAi();
checkUpdates(true);
setInterval(() => { if (!U.busy) checkUpdates(true); }, 30 * 60 * 1000);
// Recording or presenting started or stopped: the Update button follows.
setInterval(() => { if (U.available && !U.busy) { const b = $('#update-now'); if (b && b.disabled !== inTheMiddle()) renderUpdate(); } }, 2000);
window.__scenecast = S;
// The UI test opens a shared file the way a double-click does.
S.openFile = openShared;
