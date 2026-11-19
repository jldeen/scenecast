// Scenecast's window: the demo library and each step of a demo. Everything goes through the app's commands
// (window.__TAURI__.core.invoke) and their progress events; nothing here touches files or runs anything itself.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const S = {
  info: {},
  demos: [],
  view: 'library',
  id: null,
  tab: 'record',
  jobs: {},
  servers: { edit: {}, present: {} },
};
const TABS = [
  ['record', 'Record'],
  ['build', 'Build & check'],
  ['fidelity', 'Fidelity'],
  ['script', 'Script'],
  ['edit', 'Edit'],
  ['present', 'Present'],
  ['export', 'Export'],
];

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
const folderWord = () => isMac() ? 'Finder' : 'File Explorer';

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
    toast(msg, true);
    throw new Error(msg);
  }
}
// Runs a step's command with the demo marked busy, re-rendering what depends on it.
// A newer run of the same job (Check pressed again, then Check and fix) takes its place: the older one's answer is
// dropped, and only the newest clears the job's busy mark.
async function step(job, cmd, args, after) {
  const id = S.id;
  const token = {};
  J(id).running[job] = true;
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
    toast(msg, true);
    J(id)[job].error = msg;
  } finally {
    if (mine()) delete J(id).running[job];
    await refreshDemo(id);
    rerender();
  }
}

function dialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
  const d = $('#dialog');
  d.innerHTML = `<form method="dialog"><div class="body"><h2 id="dialog-title">${esc(title)}</h2>${body}</div>
    <div class="foot">${cancel ? `<button class="btn" value="cancel">${esc(cancel)}</button>` : ''}
    <button class="btn ${danger ? 'primary' : 'primary'}" value="ok" data-test="dialog-ok">${esc(ok)}</button></div></form>`;
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
      j.status = u.status;
      break;
    case 'check':
      j.items.push(u);
      break;
    case 'event':
      j.events.push(u);
      break;
    case 'saved':
      (j.saved ??= []).push(u.data);
      if (id === S.id) announce(`Saved: ${u.data.what || 'a change'}`);
      break;
  }
  if (id === S.id) scheduleRegions();
});
listen('job-state', ({ payload: { demo: id, job, running: on } }) => {
  if (on) J(id).running[job] = true; else delete J(id).running[job];
  if (id === S.id) renderTabsBar();
});

let regionsQueued = false;
function scheduleRegions() {
  if (regionsQueued) return;
  regionsQueued = true;
  requestAnimationFrame(() => { regionsQueued = false; renderRegions(); });
}

// ---- Sidebar -----------------------------------------------------------------------------------------------------

const stagePill = s => ({
  new: '<span class="pill">New</span>',
  recorded: '<span class="pill info">Recorded</span>',
  built: '<span class="pill info">Built</span>',
  checked: '<span class="pill ok">Checked</span>',
})[s.stage] || '';

function renderSidebar() {
  $('#nav-library').setAttribute('aria-current', S.view === 'library' ? 'page' : 'false');
  $('#demo-list').innerHTML = S.demos.map(d => `<li><button data-open="${esc(d.id)}" data-test="demo-${esc(d.id)}" ${S.view === 'demo' && S.id === d.id ? 'aria-current="page"' : ''}>
    <span class="title">${esc(d.title)}</span>${stagePill(d.status)}</button></li>`).join('') ||
    '<li class="muted small" style="padding:4px 10px">None yet</li>';
}

// ---- Library -----------------------------------------------------------------------------------------------------

function fidelityText(f) {
  if (!f) return '<span class="muted">Not checked</span>';
  return `<span class="pill ${f.pass ? 'ok' : f.score >= 80 ? 'warn' : 'bad'}" title="${f.within} of ${f.total} states match">${f.score}%</span>`;
}
function renderLibrary() {
  S.view = 'library';
  renderSidebar();
  const main = $('#main');
  if (!S.demos.length) {
    main.innerHTML = `<div class="empty card"><img src="icon.svg" alt="" width="64" height="64">
      <h1>Make your first demo</h1>
      <p class="muted">Scenecast records a live web demo once in Edge or Chrome, and turns it into a replica you can present anywhere: real pages, every run identical.</p>
      <button class="btn primary" data-action="new" data-test="empty-new">New demo</button></div>`;
    return;
  }
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Your demos</h1>
    <p class="muted">Kept in <code>${esc(S.info.library)}</code></p></div>
    <button class="btn primary" data-action="new">New demo</button></div>
    <table class="data" aria-label="Demos">
    <thead><tr><th scope="col">Demo</th><th scope="col">Recorded</th><th scope="col">Built</th><th scope="col">Fidelity</th><th scope="col">Focus points</th><th scope="col">Last checked</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>${S.demos.map(d => {
      const s = d.status;
      return `<tr data-test="row-${esc(d.id)}">
        <td class="title-cell"><button class="link" data-open="${esc(d.id)}">${esc(d.title)}</button>
          <div class="muted small">${d.apps.map(a => esc(a.id)).join(' · ')}</div></td>
        <td>${s.recorded ? `<span class="pill ok">${plural(s.screens, 'screen')}</span>` : '<span class="muted">Not yet</span>'}</td>
        <td>${s.built ? `<span class="pill ok">${plural(s.liveScenes, 'page')}</span>` : '<span class="muted">Not yet</span>'}</td>
        <td>${fidelityText(s.fidelity)}</td>
        <td>${s.focusPoints || '<span class="muted">0</span>'}</td>
        <td>${s.lastChecked ? esc(ago(s.lastChecked)) : '<span class="muted">Never</span>'}</td>
        <td><div class="row" style="justify-content:flex-end">
          <button class="btn small" data-open="${esc(d.id)}" aria-label="Open ${esc(d.title)}">Open</button>
          <button class="btn small subtle" data-duplicate="${esc(d.id)}" aria-label="Duplicate ${esc(d.title)}">Duplicate</button>
          <button class="btn small subtle danger" data-delete="${esc(d.id)}" aria-label="Delete ${esc(d.title)}">Delete</button>
        </div></td></tr>`;
    }).join('')}</tbody></table>`;
}

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
    body: `<p>Its folder goes to the ${isMac() ? 'Trash' : 'Recycle Bin'}. The recording itself stays where it was recorded.</p>` });
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
      <input id="app-id-${i}" type="text" placeholder="Name (optional)" value="${esc(app.id)}" data-app-id data-test="app-id-${i}"></div>
    <div><label class="visually-hidden" for="app-url-${i}">App ${i + 1} web address</label>
      <input id="app-url-${i}" type="url" placeholder="https://…" value="${esc(app.url)}" data-app-url data-test="app-url-${i}"></div>
    <button type="button" class="btn subtle" data-remove-app aria-label="Remove app ${i + 1}">Remove</button></div>`;
}
// The four ways to make a demo. The AI ones use GitHub Copilot through the presenter's own GitHub sign-in.
const MODES = {
  record: { title: 'Record for me', icon: '✦', text: 'Say what the demo should show (or give your notes, a doc or a script). Copilot plans the steps, you check the plan, and it clicks through in your browser while it records. It asks you before anything that sends, saves or changes something.' },
  script: { title: 'I\u2019ll click, you script it', icon: '✎', text: 'Click through once with the recorder on, without knowing the beats. Afterwards Copilot writes the beats, what to say, the focus points and your presenter guide.' },
  coach: { title: 'Coach me', icon: '➜', text: 'Click through yourself while Copilot shows the next step and what to say, live, here and in a small window for your laptop screen.' },
  manual: { title: 'I know my demo', icon: '●', text: 'You run the demo the way you\u2019ll present it, and bring your own script later.' },
};
// Regions drawn by the AI parts, joined to REGIONS once it's there.
const REGIONS_LATE = {};
const aiMode = m => m === 'record' || m === 'script' || m === 'coach';
function renderNew() {
  S.view = 'new';
  S.id = null;
  renderSidebar();
  $('#main').innerHTML = `<div class="page-head"><div class="grow"><h1>New demo</h1>
    <p class="muted">How do you want to make it?</p></div></div>
    <div class="modes" role="list">${Object.entries(MODES).map(([m, x]) => `<button class="mode card" role="listitem" data-mode="${m}" data-test="mode-${m}">
      <span class="mode-icon" aria-hidden="true">${x.icon}</span><span class="mode-title">${esc(x.title)}</span>
      <span class="muted small">${esc(x.text)}</span>${aiMode(m) ? '<span class="pill info">GitHub Copilot</span>' : ''}</button>`).join('')}</div>`;
  $('[data-mode]').focus();
}
function renderNewForm(mode) {
  S.view = 'new';
  S.newMode = mode;
  const browser = isMac() ? 'chrome' : 'edge';
  const m = MODES[mode];
  const wants = mode === 'record' || mode === 'coach';
  $('#main').innerHTML = `<div class="page-head"><div class="grow"><h1>New demo: ${esc(m.title)}</h1>
    <p class="muted">${esc(m.text)}</p></div><button class="btn subtle" data-action="new">Choose another way</button></div>
    ${aiMode(mode) ? `<div data-region="copilot-mini"></div>` : ''}
    <form id="new-form" class="card stack" novalidate data-mode="${mode}">
      <div><label for="new-title">Name</label><input id="new-title" type="text" required placeholder="Contoso supplier delay" data-test="new-title"></div>
      <fieldset><legend>Apps <span class="hint">Its start page's web address; the name is how you'll switch to it (⌥ or Ctrl+Alt and its first letter).</span></legend>
        <div id="apps">${appRow(0)}</div>
        <button type="button" class="btn small" id="add-app" data-test="add-app">＋ Add another app</button></fieldset>
      ${wants ? `<div><label for="new-goal">What should the demo show? <span class="hint">In your own words: one line is enough.</span></label>
        <textarea id="new-goal" rows="3" data-test="new-goal" placeholder="Show how the assistant answers a question about the supplier delay on PO-450101, then where IT manages the tools."></textarea></div>
        <div><label for="new-source">Material to work from <span class="hint">Optional: notes, a doc, an email, or a script you already have (a RunLines .sk too).</span></label>
        <textarea id="new-source" rows="4" data-test="new-source" placeholder="Paste it here, or open a file."></textarea>
        <div class="row" style="margin-top:6px"><button type="button" class="btn small" data-action="pick-source" data-test="pick-source">Open a file…</button><span class="muted small" id="source-name"></span></div></div>` : ''}
      <fieldset><legend>Record in</legend>
        <label class="choice"><input type="radio" name="browser" value="edge" ${browser === 'edge' ? 'checked' : ''}> Microsoft Edge</label>
        <label class="choice"><input type="radio" name="browser" value="chrome" ${browser === 'chrome' ? 'checked' : ''}> Google Chrome</label></fieldset>
      <fieldset><legend>Profile <span class="hint">The one you’re signed in to the apps with. Change it any time on the Record step.</span></legend>
        <div id="new-profiles" data-test="new-profiles">${profileOptions(null)}</div></fieldset>
      <p id="new-error" class="notice bad" hidden role="alert"></p>
      <div class="row"><button class="btn primary" type="submit" data-test="create-demo">Create demo</button>
        <button class="btn" type="button" data-action="library">Cancel</button></div>
    </form>`;
  $('#new-title').focus();
  renderRegions();
  if (aiMode(mode) && !AI.status) refreshAi();
  const form = $('#new-form');
  const load = async () => {
    const b = form.browser.value;
    const box = $('#new-profiles');
    box.innerHTML = profileOptions(null);
    const info = await invoke('browser_profiles', { browser: b }).catch(() => null);
    if (box.isConnected && form.browser.value === b) box.innerHTML = profileOptions(info, '');
  };
  form.addEventListener('change', e => { if (e.target.name === 'browser') load(); });
  load();
}
async function createDemo(form) {
  const apps = [...form.querySelectorAll('[data-app-row]')].map(r => ({ id: $('[data-app-id]', r).value.trim(), url: $('[data-app-url]', r).value.trim() }));
  const mode = form.dataset.mode || 'manual';
  const goal = $('#new-goal')?.value.trim() || null, source = $('#new-source')?.value.trim() || null;
  const spec = { title: $('#new-title').value, apps, browser: form.browser.value, profile: form.querySelector('[name=profile]:checked')?.value || null, mode, goal, source };
  const err = $('#new-error');
  if (mode === 'record' && !goal && !source) { err.hidden = false; err.textContent = 'Say what the demo should show, or give it something to work from.'; return; }
  try {
    const d = await invoke('create_demo', { spec });
    await loadDemos();
    announce(`Created ${d.title}`);
    openDemo(d.id, 'record');
  } catch (e) {
    err.hidden = false;
    err.textContent = typeof e === 'string' ? e : e.message;
  }
}

// ---- Copilot -----------------------------------------------------------------------------------------------------

// The presenter's GitHub Copilot: signed in or not, the code to enter while signing in, the settings.
const AI = { status: null, checking: false, signing: false, code: null, runtime: null, error: null, models: null, settings: null };
async function refreshAi() {
  AI.checking = true; renderCopilotState();
  try { AI.status = await invoke('ai_status'); AI.settings = AI.status.settings; AI.error = null; } catch (e) { AI.error = String(e); }
  AI.checking = false; renderCopilotState();
  if (S.view === 'copilot') renderCopilot();
  renderRegions();
}
function renderCopilotState() {
  const el = $('#copilot-state');
  if (!el) return;
  const st = AI.status;
  el.className = 'pill small ' + (st?.signedIn ? 'ok' : AI.checking ? '' : 'warn');
  el.textContent = AI.signing ? 'Signing in…' : st?.signedIn ? 'On' : AI.checking ? '…' : 'Sign in';
  el.dataset.signedIn = String(!!st?.signedIn);
}
const signedInLine = () => {
  const st = AI.status;
  if (AI.checking && !st) return '<p class="muted small">Checking your GitHub sign-in…</p>';
  if (st?.signedIn) return `<span class="pill ok" data-test="ai-signed-in">GitHub Copilot: ${esc(st.login || 'signed in')}</span>`;
  return `<div class="notice warn"><div>These use <strong>GitHub Copilot</strong> through your own GitHub account. <button class="btn small primary" data-action="copilot" data-test="go-sign-in">Sign in with GitHub</button></div></div>`;
};
Object.assign(REGIONS_LATE, {
  'copilot-mini': () => signedInLine(),
  'copilot-signin'() {
    if (AI.error && !AI.signing) return errorBox(AI.error);
    if (!AI.signing) return '';
    const rt = AI.runtime;
    if (!AI.code) return `${progressBar(true)}<p class="small">${rt && !rt.ready ? `Getting Copilot ready (once): ${Math.round((rt.got || 0) / 1048576)} of ${Math.round((rt.total || 0) / 1048576) || '…'} MB` : 'Starting…'}</p>`;
    return `<div class="notice info" data-test="device-code" data-code="${esc(AI.code.userCode)}"><div>
      <p>Enter this code at <strong>${esc(AI.code.verificationUri)}</strong>, signed in to the GitHub account that has Copilot:</p>
      <p class="device-code">${esc(AI.code.userCode)}</p>
      <div class="row"><button class="btn primary" data-copy-open="${esc(AI.code.userCode)}" data-url="${esc(AI.code.verificationUri)}">Copy the code and open GitHub</button>
      <span class="muted small">This turns green on its own when you're done.</span></div></div></div>`;
  },
});
function renderCopilot() {
  S.view = 'copilot';
  S.id = null;
  renderSidebar();
  const st = AI.status, set = AI.settings || { model: 'auto', pageText: true };
  const models = AI.models || [];
  $('#main').innerHTML = `<div class="page-head"><div class="grow"><h1>GitHub Copilot</h1>
    <p class="muted">Record for me, I\u2019ll click you script it, and Coach me use GitHub Copilot through your own GitHub account and its Copilot plan. No keys to set up.</p></div></div>
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
  return { record: s.recorded, build: s.built, fidelity: !!s.fidelity, script: s.focusPoints > 0 }[t];
}
function tabJobs(t) {
  return { record: ['preflight', 'record', 'record-stop', 'extension', 'install', 'ai-plan', 'ai-record', 'ai-script', 'coach'], build: ['build', 'checks'], fidelity: ['fidelity'], script: ['script'], export: ['export'] }[t] || [];
}
function renderTabsBar() {
  const d = demo();
  const bar = $('#tabs');
  if (!d || !bar) return;
  bar.innerHTML = TABS.map(([t, label]) => {
    const b = tabJobs(t).some(j => running(j));
    return `<button role="tab" id="tab-${t}" aria-controls="panel" aria-selected="${t === S.tab}" tabindex="${t === S.tab ? 0 : -1}" data-tab="${t}" data-test="tab-${t}">
      <span class="tab-dot ${b ? 'busy' : tabDone(t, d.status) ? 'done' : ''}" aria-hidden="true"></span>${label}${b ? '<span class="visually-hidden"> (working)</span>' : ''}</button>`;
  }).join('');
}
async function openDemo(id, tab) {
  S.view = 'demo';
  S.id = id;
  if (tab) S.tab = tab;
  await refreshDemo(id);
  const d = demo();
  if (!d) return renderLibrary();
  $('#main').innerHTML = `<div class="page-head"><div class="grow"><h1 data-test="demo-title">${esc(d.title)}</h1>
      <p class="muted small">${d.apps.map(a => `${esc(a.id)} <span class="mono">${esc(a.url)}</span>`).join(' · ')}</p></div>
      <button class="btn subtle" data-reveal="${esc(d.dir)}">Show in ${folderWord()}</button>
      <button class="btn subtle" data-duplicate="${esc(d.id)}">Duplicate</button>
      <button class="btn subtle danger" data-delete="${esc(d.id)}">Delete</button></div>
    <div class="tabs" role="tablist" aria-label="Steps" id="tabs"></div>
    <section id="panel" role="tabpanel" aria-labelledby="tab-${S.tab}" tabindex="0"></section>`;
  renderTabsBar();
  invoke('receiver_ensure', { id }).then(r => { if (S.id === id) { S.rx = r; renderRegions(); } }).catch(() => {});
  await renderPanel();
}
// The receiver and the recorder, every 1.5 s on the Record step: turns green the moment the extension connects.
setInterval(async () => {
  if (S.view !== 'demo' || S.tab !== 'record' || document.hidden) return;
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
  renderPanel();
}
async function renderPanel() {
  const panel = $('#panel');
  if (!panel) return;
  panel.setAttribute('aria-labelledby', `tab-${S.tab}`);
  const d = demo();
  await PANELS[S.tab](panel, d);
  renderRegions();
}
function renderRegions() {
  for (const el of document.querySelectorAll('[data-region]')) {
    const html = REGIONS[el.dataset.region]?.(demo());
    if (html !== undefined && el.innerHTML !== html) el.innerHTML = html;
  }
}

const progressBar = on => on ? '<div class="progress" role="progressbar" aria-label="Working"><div></div></div>' : '';
const logBox = (lines = [], open = false) => lines.length ? `<details ${open ? 'open' : ''}><summary>Details (${lines.length} lines)</summary>
  <div class="log" tabindex="0">${lines.slice(-200).map(l => `<div class="${l.error ? 'err' : ''}">${esc(l.text)}</div>`).join('')}</div></details>` : '';
const errorBox = e => e ? `<div class="notice bad" role="alert"><div>${esc(e)}</div></div>` : '';
const icon = (status, label) => `<span class="icon ${esc(status)}" role="img" aria-label="${esc(label || status)}">${{ ok: '✓', fixed: '✓', pass: '✓', fail: '!', warn: '!', manual: '?', skip: '–', run: '' }[status] ?? ''}</span>`;

// ---- Record ------------------------------------------------------------------------------------------------------

const PREFLIGHT_LABEL = { receiver: 'Receiver', browser: 'Browser', recorder: 'Recorder extension' };
const BNAME = { chrome: 'Google Chrome', edge: 'Microsoft Edge' };
const avatar = p => p.picture ? `<img class="avatar" src="${esc(p.picture)}" alt="">`
  : `<span class="avatar" style="background:${esc(p.color || '#8a8a94')}" aria-hidden="true">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>`;
// The profile picker: the browser's own profiles by name and picture; "" is the one that's open when recording.
function profileOptions(info, chosen) {
  if (!info) return '<p class="muted small">Looking at the browser\u2019s profiles…</p>';
  if (!info.profiles?.length) return `<p class="muted small">No ${esc(BNAME[info.browser] || info.browser)} profiles on this computer yet: it uses the one you open.</p>`;
  const picked = chosen || '';
  const auto = info.profiles.find(p => p.dir === info.picked);
  return `<div class="profiles" role="radiogroup" aria-label="Browser profile">
    <label class="profile"><input type="radio" name="profile" value="" ${picked === '' ? 'checked' : ''} data-test="profile-auto">
      <span class="avatar auto" aria-hidden="true">✓</span><span><span class="pname">The one that\u2019s open</span>
      <span class="small muted">${auto ? `now: ${esc(auto.name)}` : 'when you record'}</span></span></label>
    ${info.profiles.map(p => `<label class="profile"><input type="radio" name="profile" value="${esc(p.dir)}" ${picked === p.dir ? 'checked' : ''} data-test="profile-${esc(p.dir.replace(/\s+/g, '-'))}">
      ${avatar(p)}<span><span class="pname">${esc(p.name)}</span>
      <span class="small muted">${esc([p.email, p.open ? 'open' : '', p.extension?.id ? 'has the recorder' : ''].filter(Boolean).join(' · ') || p.dir)}</span></span></label>`).join('')}
  </div>`;
}
const rxState = () => S.rx?.receiver || {};
const REGIONS = {
  recorder(d) {
    const r = rxState(), x = S.rx?.extension || {};
    const rxLine = r.running ? `<span class="pill ok" data-test="receiver-state" data-port="${r.port}">Receiver running · port ${r.port}</span>`
      : r.error ? `<span class="pill bad" data-test="receiver-state">Receiver stopped</span> <span class="small">${esc(r.error)}</span> <button class="btn small" data-action="receiver-fix">Start it</button>`
        : '<span class="pill" data-test="receiver-state">Receiver starting…</span>';
    const recLine = r.connected ? `<span class="pill ok" data-test="recorder-state" data-connected="true">Recorder connected</span>`
      : `<span class="pill warn" data-test="recorder-state" data-connected="false">Recorder not connected</span>`;
    const upd = x.updated ? `<p class="small muted" style="margin-top:6px">The recorder was updated to ${esc(x.version)}. ${x.reloaded ? 'Scenecast reloaded it for you.' : `If it doesn\u2019t connect, click Reload on Scenecast Recorder at ${d.browser}://extensions.`}</p>` : '';
    return `<div class="row">${rxLine}${recLine}</div>${upd}`;
  },
  install(d) {
    const j = J(d.id).install || {};
    const o = j.outcome;
    const on = running('install', d.id);
    if (!o && !on && !j.error) return '';
    if (on) return progressBar(true) + '<p class="muted small">Getting the recorder ready…</p>';
    if (j.error) return errorBox(j.error);
    const b = o.browser, connected = rxState().connected;
    const shot = n => `img/setup/${b}-${n}.png`;
    const notes = [];
    if (o.openError) notes.push(`Couldn\u2019t open ${esc(o.browserName)} (${esc(o.openError)}). Open it yourself, type <code>${esc(o.extensionsPage)}</code> in the address bar and press Enter.`);
    else if (!o.running) notes.push(`${esc(o.browserName)} wasn\u2019t open: it\u2019s starting with your profile ${esc(o.profileName || '')}.`);
    if (o.oldLoaded) notes.push('You still have the old copy (from the hidden .scenecast folder) loaded: click <strong>Remove</strong> on it first.');
    if (o.loaded && o.devMode === false) notes.push('Developer mode is off, so the recorder is switched off: turn Developer mode on (step 1).');
    if (connected) return `<div class="notice ok" data-test="install-status" data-connected="true"><div><strong>Done: the recorder is connected.</strong> You won\u2019t need to do this again.</div></div>
      <div class="path"><code data-test="extension-dir">${esc(o.dir)}</code><button class="btn small" data-reveal="${esc(o.dir)}">Show in ${folderWord()}</button></div>`;
    return `<div class="notice ${connected ? 'ok' : 'info'}" data-test="install-status" data-connected="${!!connected}"><div>
        ${connected ? '<strong>Done: the recorder is connected.</strong> You won\u2019t need to do this again.'
          : `<strong>${o.opened ? `A Scenecast page opened in ${esc(o.browserName)}${o.profileName ? ` (${esc(o.profileName)})` : ''}` : 'Almost there'}</strong>, and the folder is shown in ${folderWord()}. <strong>${esc(o.extensionsPage)}</strong> is copied: click the browser\u2019s address bar, paste and press Enter. Then the steps below; this turns green on its own.`}
      </div></div>
      ${notes.map(n => `<div class="notice warn"><div>${n}</div></div>`).join('')}
      <div class="path"><code data-test="extension-dir">${esc(o.dir)}</code>
        <button class="btn small" data-copy="${esc(o.dir)}" data-test="copy-path">Copy path</button>
        <button class="btn small" data-reveal="${esc(o.dir)}">Show in ${folderWord()}</button>
        <button class="btn small" data-copy="${esc(o.extensionsPage)}">Copy ${esc(o.extensionsPage)}</button></div>
      <ol class="step-cards">
        <li><figure><img src="${shot('1-developer-mode')}" alt="The extensions page with the Developer mode switch circled"></figure>
          <div><strong>Open ${esc(o.extensionsPage)}, turn on Developer mode</strong><p class="small muted">Paste ${esc(o.extensionsPage)} (copied) in the address bar and press Enter. Developer mode is ${b === 'edge' ? 'at the bottom of the left side of the page' : 'top right of the page'}.</p></div></li>
        <li><figure><img src="${shot('2-load-unpacked')}" alt="Developer mode on, with Load unpacked circled"></figure>
          <div><strong>Drag the Recorder Extension folder onto the page</strong><p class="small muted">From the ${folderWord()} window that just opened. Or click <strong>Load unpacked</strong> and pick the folder (Copy path, then paste it in the dialog${isMac() ? ' with ⌘⇧G' : ''}).</p></div></li>
        <li><figure><img src="${shot('3-loaded')}" alt="Scenecast Recorder loaded, its Reload button circled"></figure>
          <div><strong>That\u2019s it</strong><p class="small muted">Scenecast Recorder shows up and this turns green within a few seconds. After a Scenecast update, Reload (circled) gets the new recorder; Scenecast does it for you when it can.</p></div></li>
      </ol>`;
  },
  preflight(d) {
    const j = J(d.id).preflight || {};
    const on = running('preflight', d.id);
    const items = j.items || [];
    const report = j.outcome;
    if (!items.length && !on) return report === undefined && !j.error ? '<p class="muted">Not run yet.</p>' : errorBox(j.error);
    const fails = items.filter(i => i.status === 'fail');
    return `${progressBar(on)}<ul class="status-list" aria-label="Preflight">${items.map(i => {
      const label = PREFLIGHT_LABEL[i.id] || (i.id.startsWith('app ') ? `App: ${i.id.slice(4)}` : i.id);
      const fix = i.status === 'fail' ? (i.id === 'recorder'
        ? `<button class="btn small" data-action="${/Fix reloads|reload/i.test(i.detail) && /is \d/.test(i.detail) ? 'preflight-fix' : 'install'}" data-test="fix-${esc(i.id)}">${/is \d/.test(i.detail) ? 'Fix' : 'Install recorder'}</button>`
        : i.id === 'receiver' ? `<button class="btn small" data-action="receiver-fix" data-test="fix-receiver">Fix</button>`
          : `<button class="btn small" data-action="preflight-fix" data-test="fix-${esc(i.id.replace(' ', '-'))}">Fix</button>`) : '';
      return `<li data-test="pf-${esc(i.id.replace(' ', '-'))}" data-status="${esc(i.status)}">${icon(i.status)}<span class="id">${esc(label)}</span>
        <span class="small">${esc(i.detail)}</span>${fix}</li>`;
    }).join('')}</ul>
    ${report ? `<div class="notice ${report.ready ? 'ok' : 'warn'}" data-test="preflight-result" data-ready="${report.ready}">
      ${report.ready ? `Ready to record (checked in ${secs(report.secs)}).` : `${plural(fails.length, 'thing')} to put right first.`}</div>` : ''}
    ${errorBox(j.error)}`;
  },
  record(d) {
    const j = J(d.id).record || {};
    const stop = J(d.id)['record-stop'] || {};
    const st = j.status;
    const recording = st ? st.recording : !!j.outcome && !stop.outcome;
    const t = st?.timing || {};
    let html = '';
    if (recording || running('record', d.id)) {
      html += `<div class="notice info" data-test="recording" data-busy="${!!st?.busy}" data-count="${st?.count ?? 0}"><div>
        <strong>Recording.</strong> Go through the demo in ${esc(d.apps.length > 1 ? 'the app tabs' : 'the app')} as you'll present it. ${st?.busy ? 'Hold on: capturing this screen' + (st.side ? ` (${esc(st.side)})` : '') + '…' : 'Ready for your next step.'}</div></div>
        <div class="stats">
          <div class="stat"><div class="n" data-test="screens">${st?.count ?? 0}</div><div class="l">Screens captured</div></div>
          <div class="stat"><div class="n">${st?.actions ?? 0}</div><div class="l">Steps</div></div>
          <div class="stat"><div class="n">${st?.streams ?? 0}</div><div class="l">Streamed answers</div></div>
          <div class="stat"><div class="n">${secs(t.recorderSecs)}</div><div class="l">Recorder's time</div></div>
          <div class="stat"><div class="n">${secs(t.productSecs)}</div><div class="l">Product's time</div></div>
        </div>
        <p class="small muted">Side states (hovers, menus, panes, zoom, long lists) are captured on each new screen as you go${st?.side ? `: now <strong>${esc(st.side)}</strong>` : ''}.</p>
        ${st?.log?.length ? `<details><summary>Recorder log</summary><div class="log">${st.log.map(esc).join('\n')}</div></details>` : ''}
        <div class="row" style="margin-top:12px"><button class="btn primary" data-action="record-stop" data-test="record-stop" ${running('record-stop', d.id) ? 'disabled' : ''}>Stop recording</button></div>`;
    } else if (stop.outcome) {
      const s = stop.outcome;
      const tt = s.timing || {};
      html += `<div class="notice ok" data-test="record-done"><div><strong>Recorded:</strong> ${plural(s.states, 'screen')}, ${plural(s.steps, 'step')}, ${plural(s.streams, 'streamed answer')}, ${plural(s.beats, 'beat')} in ${secs(s.secs)}
        (recorder ${secs(tt.recorderSecs)}, product ${secs(tt.productSecs)}).</div></div>
        ${s.notes?.length ? `<h3>Worth a look</h3><ul>${s.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        ${s.autos?.length ? `<details><summary>Side states per screen</summary><div class="log">${s.autos.map(esc).join('\n')}</div></details>` : ''}
        <div class="row" style="margin-top:12px"><button class="btn primary" data-goto="build">Next: build the replica</button>
        <button class="btn" data-action="record-start">Record again</button></div>`;
    } else {
      html += `<div class="row"><button class="btn primary" data-action="record-start" data-test="record-start" ${running('record', d.id) ? 'disabled' : ''}>Start recording</button>
        ${d.status.recorded ? `<span class="muted small">Recorded ${esc(ago(d.status.recordedAt))} (${plural(d.status.screens, 'screen')}). Recording again replaces it.</span>` : ''}</div>`;
    }
    return html + errorBox(j.error || stop.error);
  },
};
Object.assign(REGIONS, REGIONS_LATE);

const PANELS = {};
PANELS.record = (panel, d) => {
  panel.innerHTML = `<div class="card"><h2><span class="step-num">1</span>The recorder</h2>
      <p class="muted">A small extension in your own browser does the recording. Install it once; it stays.</p>
      <div data-region="recorder" style="margin:10px 0"></div>
      <div class="row"><button class="btn primary" data-action="install" data-test="install-recorder">Install recorder</button>
        <span class="muted small">Record in</span>
        <select id="browser" aria-label="Browser to record in" style="width:auto" data-test="browser">
          <option value="edge">Microsoft Edge</option><option value="chrome">Google Chrome</option></select></div>
      <div style="margin-top:12px"><span class="muted small">Profile</span><div id="profile-pick" data-test="profile-pick"></div></div>
      <div data-region="install" style="margin-top:12px"></div></div>
    <div class="card"><h2><span class="step-num">2</span>Ready to record?</h2>
      <p class="muted">Checks the receiver, your browser and profile, the recorder, and each app's tab (open, light theme, on its start screen). It fixes what it can, and never restarts your browser.</p>
      <div class="row"><button class="btn primary" data-action="preflight" data-test="preflight">Check</button>
        <button class="btn" data-action="preflight-fix" data-test="preflight-fix">Check and fix</button></div>
      <div data-region="preflight" style="margin-top:12px"></div></div>
    ${recordCards(d)}`;
  if (aiMode(d.mode)) loadAi(d.id);
  const sel = $('#browser', panel);
  sel.value = d.browser;
  const pick = $('#profile-pick', panel);
  const showProfiles = async () => {
    pick.innerHTML = profileOptions(J(d.id).profiles, demo()?.profile);
    J(d.id).profiles = await invoke('browser_profiles', { id: d.id }).catch(() => null);
    if (pick.isConnected) pick.innerHTML = profileOptions(J(d.id).profiles, demo()?.profile);
  };
  pick.onchange = e => {
    if (e.target.name !== 'profile') return;
    call('set_profile', { id: d.id, profile: e.target.value }).then(async () => {
      await refreshDemo(d.id);
      toast(e.target.value ? `Recording in profile ${e.target.closest('label').querySelector('.pname').textContent}` : 'Recording in the profile that\u2019s open');
    });
  };
  sel.onchange = () => call('set_browser', { id: d.id, browser: sel.value }).then(async () => {
    toast(`Recording in ${sel.selectedOptions[0].text}`);
    await refreshDemo(d.id);
    J(d.id).profiles = null;
    showProfiles();
  });
  showProfiles();
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
const recordCard = (n, note) => `<div class="card"><h2><span class="step-num">${n}</span>Record</h2>
      <p class="muted">${note || 'Run the demo once, the way you\u2019ll present it. Wait for each screen to be captured before the next step.'}</p>
      <div data-region="record"></div></div>`;
const goalFields = () => `<div><label for="ai-goal">What should the demo show?</label>
      <textarea id="ai-goal" rows="3" data-test="ai-goal" data-save="goal" placeholder="In your own words: one line is enough."></textarea></div>
    <div style="margin-top:10px"><label for="ai-source">Material to work from <span class="hint">Optional: notes, a doc, an email, a script.</span></label>
      <textarea id="ai-source" rows="3" data-test="ai-source" data-save="source"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn small" data-action="pick-source-demo">Open a file…</button></div></div>`;
function recordCards(d) {
  const sent = aiMode(d.mode) ? `<div class="card"><h2>What was sent to Copilot</h2><div data-region="ai-sent"></div></div>` : '';
  if (d.mode === 'record') return `<div data-region="copilot-mini"></div>
    <div class="card"><h2><span class="step-num">3</span>What to show</h2>
      <p class="muted">Copilot reads your words and each app's start screen, and drafts the steps: what to click and type, and what to say.</p>
      ${goalFields()}
      <div class="row" style="margin-top:12px"><button class="btn primary" data-action="ai-plan" data-test="ai-plan">Draft the plan</button></div>
      <div data-region="ai-plan-progress"></div></div>
    <div class="card"><h2><span class="step-num">4</span>The plan</h2>
      <p class="muted">Read it and change anything: one step per line (<code>- Click "Plugins"</code>, <code>- Type "…" in "Message"</code>, <code>- Press Enter</code>, <code>- Go to admin</code>, <code>- Wait for the answer</code>, <code>- You: …</code> for something only you can do), <code>&gt;</code> lines are what to say. Steps marked <strong>ask first</strong> could send, save or change something: Copilot stops and asks you before each one.</p>
      <label for="ai-plan" class="visually-hidden">Plan</label>
      <textarea id="ai-plan" class="plan" data-test="ai-plan-text" data-save="plan" placeholder="Draft the plan first."></textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-action="ai-record" data-test="ai-record">Approve and record</button>
        <span class="muted small">Your browser needs to be ready (step 2). Copilot clicks in your app tabs: keep your hands off until it asks.</span></div>
      <div data-region="ai-run" style="margin-top:12px"></div><div data-region="ai-after"></div></div>
    ${sent}`;
  if (d.mode === 'coach') return `<div data-region="copilot-mini"></div>
    <div class="card"><h2><span class="step-num">3</span>Your coach</h2>
      <p class="muted">Start the coach, then start recording and click through. It shows the next step and what to say, and keeps up as you go; if you go your own way, it suggests what's next from your goal.</p>
      ${goalFields()}
      <div class="row" style="margin-top:12px"><button class="btn primary" data-action="coach-start" data-test="coach-start">Start coaching</button>
        <button class="btn" data-action="coach-window" data-test="coach-window">Open the coach window</button>
        <button class="btn subtle" data-action="ai-plan" data-test="ai-plan">Draft the plan again</button></div>
      <div data-region="coach" style="margin-top:12px"></div></div>
    ${recordCard(4, 'Click through the demo. When you stop, Copilot writes the beats, what to say, the focus points and your presenter guide.')}
    <div data-region="ai-after"></div>${sent}`;
  if (d.mode === 'script') return `<div data-region="copilot-mini"></div>
    ${recordCard(3, 'Click through the demo once; you don\u2019t need to know the beats. When you stop, Copilot writes the beats, what to say, the focus points and your presenter guide.')}
    <div data-region="ai-after"></div>${sent}`;
  return recordCard(3);
}
const questionKinds = new Set(['confirm', 'question', 'you-do']);
function pendingQuestion(events) {
  const answered = new Set(events.filter(e => e.event === 'answered').map(e => e.data.id));
  return [...events].reverse().find(e => questionKinds.has(e.event) && !answered.has(e.data.id));
}
Object.assign(REGIONS, {
  'ai-plan-progress'(d) {
    const j = J(d.id)['ai-plan'] || {};
    if (running('ai-plan', d.id)) return `${progressBar(true)}<p class="small" data-test="ai-planning">Copilot is reading your words and the start screens, and drafting the plan…</p>`;
    const plan = (j.events || []).find(e => e.event === 'plan');
    if (plan && j.outcome) return `<div class="notice ok" data-test="ai-plan-done" data-steps="${plan.data.steps}"><div><strong>Plan drafted:</strong> ${plural(plan.data.beats, 'beat')}, ${plural(plan.data.steps, 'step')}${plan.data.askFirst ? `, ${plan.data.askFirst} asking you first` : ''}. Check it below.</div></div>`;
    return errorBox(j.error);
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
    return html + errorBox(j.error);
  },
  'ai-after'(d) {
    const c = J(d.id).aiChain;
    if (!c) return '';
    const labels = { script: 'Copilot is writing the beats and what to say…', build: 'Building the replica…', focus: 'Putting each line on its screen: focus points and the presenter guide…', checks: 'Checking what changed…' };
    if (c.error) return errorBox(c.error);
    if (c.stage !== 'done') return `${progressBar(true)}<p class="small" data-test="ai-after" data-stage="${c.stage}">${labels[c.stage]}</p>`;
    return `<div class="notice ok" data-test="ai-after-done"><div><strong>Your demo is ready.</strong> The script is under <button class="link" data-goto="script">Script</button> (edit it any time), the focus points and presenter guide are made, and the checks for them pass. <button class="link" data-goto="present">Present it</button>.</div></div>`;
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
      <ul class="status-list" data-test="ai-sent-list">${sent.slice(-12).reverse().map(x => `<li><span class="id">${esc(task[x.task] || x.task)}</span><span class="small muted">${esc(x.model)} · ${(x.chars / 1024).toFixed(1)} KB · ${esc(ago(Date.parse(x.at)))}</span>
        <button class="btn small subtle" data-open-file="${esc(x.file)}">Show</button><span></span></li>`).join('')}</ul>`;
  },
});
// After the talk track exists: the replica, its focus points and guide, the checks for what changed.
async function aiFinish(id, write) {
  const set = stage => { J(id).aiChain = { stage }; renderRegions(); };
  try {
    if (write) { set('script'); const w = await step('ai-script', 'ai_script', {}); if (!w) throw new Error(J(id)['ai-script']?.error || 'the talk track wasn\u2019t written'); }
    set('build');
    const b = await step('build', 'build', { force: false });
    if (!b?.ok) throw new Error(b?.stopped || J(id).build?.error || 'the build stopped: see Build & check');
    set('focus');
    const sc = await step('script', 'script_run', {});
    if (!sc) throw new Error(J(id).script?.error || 'the focus points weren\u2019t made: see Script');
    set('checks');
    const q = await quickChecks(id);
    if (q && !q.pass) throw new Error('some checks fail: see Build & check');
    set('done');
    toast('Your demo is ready');
  } catch (e) { J(id).aiChain = { stage: 'error', error: e.message }; renderRegions(); }
  loadAi(id);
}

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
    ${errorBox(j.error)}${logBox(j.lines)}`;
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
      return c ? `<p class="muted">Last run ${esc(ago(c.at))}: ${c.passed} passed, ${c.failed} failed${c.quick ? ' (quick)' : ''}.</p>` + errorBox(j.error) : errorBox(j.error) || '<p class="muted">Not run yet.</p>';
    }
    const fails = items.filter(i => i.status === 'fail').length;
    return `${progressBar(on)}<ul class="status-list" aria-label="Checks">${items.map(i => `<li data-status="${esc(i.status)}">${icon(i.status)}<span class="id mono">${esc(i.id)}</span><span class="small">${esc(String(i.detail).split('\n')[0].slice(0, 220))}</span><span></span></li>`).join('')}</ul>
      ${j.outcome ? `<div class="notice ${j.outcome.pass ? 'ok' : 'bad'}" data-test="checks-done" data-pass="${j.outcome.pass}" data-quick="${j.outcome.quick}">${j.outcome.pass ? (j.outcome.quick ? 'What changed passes its checks.' : 'Every automatic check passes.') : `${plural(fails, 'check')} failing.`}</div>` : ''}
      ${errorBox(j.error)}${logBox(j.lines)}`;
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
    if (!on) return errorBox(j.error);
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
    if (!running('script', d.id)) return errorBox(j.error);
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

PANELS.present = async (panel, d) => {
  const url = S.servers.present[d.id];
  if (!d.status.built) {
    panel.innerHTML = '<div class="card"><h2>Present</h2><p class="muted">Build the demo first.</p></div>';
    return;
  }
  const keys = url ? null : await invoke('key_reference', { id: d.id }).catch(() => null);
  const guide = await invoke('guide_status', { id: d.id }).catch(() => null);
  const gk = isMac() ? '⌥G' : 'Ctrl+Alt+G';
  const f = d.status.fidelity;
  const guideUrl = J(d.id).guideUrl;
  panel.innerHTML = `${url ? `<div class="card"><div class="notice ok" data-test="presenting" data-url="${esc(url)}"><div><strong>Presenting.</strong>
      ${S.info.noOpen ? 'Open it:' : 'The replica is full screen in its own window; this one is out of the way.'}
      <div class="path"><code>${esc(url)}</code><button class="btn small" data-open-url="${esc(url)}">Open again</button></div></div></div>
      ${guide ? `<div class="notice info" data-test="guide-open" data-url="${esc(guideUrl || '')}"><div><strong>Presenter guide.</strong> ${guideUrl ? 'It opened on this screen, next to the stage. Its dot reads <strong>In sync</strong> once the stage is up.' : 'Open it on this screen; it follows the stage.'}
        ${S.info.noOpen && guideUrl ? `<div class="path"><code>${esc(guideUrl)}</code></div>` : ''}</div></div>` : ''}
      <div class="row"><button class="btn primary" data-action="present-stop" data-test="present-stop">Stop presenting</button>
        ${guide ? `<button class="btn" data-action="present-guide" data-test="present-guide">Open presenter guide</button>` : ''}</div></div>`
    : `<div class="card"><div class="row"><div style="flex:1"><h2>Before you start</h2>
      <p class="muted">The keys, on one page. This page isn't on screen while you present: the replica opens full screen, and Scenecast steps aside.</p></div>
      <button class="btn primary" data-action="present-start" data-test="present-start">Start presenting</button></div>
      ${guide ? `<label class="choice" style="margin-top:10px"><input type="checkbox" id="with-guide" data-test="with-guide" checked> Open the presenter guide on this screen too</label>` : ''}
      ${f && !f.pass ? `<div class="notice warn">Fidelity: ${f.within} of ${f.total} states match the real product. Fix them under Fidelity first, if you can.</div>` : ''}
      ${d.status.focusPoints ? '' : '<div class="notice info">No focus points yet: run your script under Script, or add them under Edit.</div>'}</div>`}
    <div class="card" data-test="guide-card"><h2>Presenter guide</h2>
      ${guide ? `<p>A second window for your laptop screen while the stage is on the projector: your talk track word for word, the clicks, the watch-outs, the time, what's on screen and what's next. It follows the stage as you go.</p>
        <p class="muted small" data-test="guide-status" data-beats="${guide.beats}" data-pictures="${guide.pictures}">From <span class="mono">${esc(guide.script)}</span>: ${plural(guide.beats, 'beat')}, ${plural(guide.pictures, 'picture')}${guide.missingPictures ? ` (${guide.missingPictures} not made yet: find the focus points again under Script)` : ''}.</p>
        <table class="data" aria-label="Presenter guide keys"><tbody>
          <tr><td><kbd>${esc(gk)}</kbd> on the stage</td><td>Opens the guide (if it isn't open).</td></tr>
          <tr><td><kbd>→</kbd> <kbd>Page Down</kbd>, <kbd>←</kbd> <kbd>Page Up</kbd> in the guide</td><td>Read the next or previous beat. The stage stays put.</td></tr>
          <tr><td><kbd>Esc</kbd> in the guide</td><td>Back to the beat the stage is on.</td></tr>
          <tr><td><strong>Go to this beat on stage</strong></td><td>Moves the stage to the beat you're reading.</td></tr>
          <tr><td><strong>Reset</strong></td><td>The timer back to this beat's start time in the script.</td></tr></tbody></table>
        <p class="muted small" style="margin-top:10px">If it opens on the projector instead, drag it to your laptop screen.</p>`
        : '<p class="muted" data-test="guide-none">Your script becomes a presenter guide: a window for your laptop screen with the talk track, clicks and time, that follows the stage. Add your script under Script and press <strong>Find the focus points</strong>.</p>'}</div>
    ${keys && !url ? `<div class="card" data-test="key-reference"><h2>${esc(keys.title)}: presenter keys</h2>
      <p class="muted" style="margin-bottom:14px">Hold <kbd>${esc(keys.modifier)}</kbd> with the key.</p>
      <div class="keys">${keys.groups.map(g => `<div><h3>${esc(g.title)}</h3><table>${g.rows.map(r => `<tr><td><kbd>${esc(r.keys)}</kbd></td><td>${esc(r.what)}</td></tr>`).join('')}</table></div>`).join('')}</div>
      <p class="muted small" style="margin-top:14px">${esc(keys.exit)}</p></div>` : ''}`;
};

// ---- Export ------------------------------------------------------------------------------------------------------

Object.assign(REGIONS, {
  export(d) {
    const j = J(d.id).export || {};
    const items = j.items || [];
    const list = items.length ? `<ul class="status-list" aria-label="Checks before the export">${items.map(i => `<li data-status="${esc(i.status)}">${icon(i.status)}<span class="id mono">${esc(i.id)}</span><span class="small">${esc(String(i.detail).split('\n')[0].slice(0, 220))}</span><span></span></li>`).join('')}</ul>` : '';
    if (running('export', d.id)) {
      const last = j.stages?.at(-1);
      return progressBar(true) + `<p class="small" data-test="export-running">${esc(last?.label || 'Exporting…')}</p>${list}`;
    }
    const r = j.outcome;
    if (!r) return errorBox(j.error);
    if (!r.exported) {
      const fails = (r.checks?.items || []).filter(i => i.status === 'fail');
      return `<div class="notice bad" role="alert" data-test="export-checks-failed"><div><strong>Not exported yet:</strong> ${plural(fails.length, 'check')} failing.
        <ul>${fails.map(i => `<li><span class="mono">${esc(i.id)}</span>: ${esc(String(i.detail).split('\n')[0].slice(0, 220))}</li>`).join('')}</ul>
        <p class="small">Fix them (Fidelity, Edit, or ask whoever set up the demo), then export again. Or export it as it is.</p>
        <div class="row" style="margin-top:8px"><button class="btn" data-action="export-anyway" data-test="export-anyway">Export anyway</button>
        ${r.checks?.report ? `<button class="btn subtle" data-open-file="${esc(r.checks.report)}">Open the full report</button>` : ''}</div></div></div>`;
    }
    const o = r.exported;
    const mb = (o.bytes / 1048576).toFixed(1);
    const checked = { ran: 'Every check passed first.', current: 'Every check had already passed, and nothing has changed since.', skipped: 'Exported without the checks passing.' }[r.checked] || '';
    return `<div class="notice ${r.checked === 'skipped' ? 'warn' : 'ok'}" data-test="export-done" data-path="${esc(o.path)}" data-kind="${esc(o.kind)}" data-checked="${esc(r.checked)}"><div><strong>Exported</strong> ${o.kind === 'zip' ? 'a zip' : 'a folder'}: ${plural(o.files, 'file')}, ${mb} MB. ${esc(checked)}
      <div class="path"><code>${esc(o.path)}</code><button class="btn small" data-reveal="${esc(o.path)}">Show in ${folderWord()}</button><button class="btn small" data-copy="${esc(o.path)}">Copy</button></div>
      <p class="small" style="margin-top:8px">Send it to the other presenter. They open <code>index.html</code> in Edge or Chrome: no install, nothing online.</p></div></div>`;
  },
});
PANELS.export = async (panel, d) => {
  const dest = J(d.id).dest || await invoke('default_export_dir');
  J(d.id).dest = dest;
  panel.innerHTML = `<div class="card"><h2>Export for another presenter</h2>
      <p class="muted">The replica on its own: a plain folder, or the same folder zipped. Built pages only (scrubbed); no editor, no recording. Every check runs first (two identical runs, cold starts, every zoom, focus points, the presenter guide), unless it already passed and nothing has changed since.</p>
      <label for="export-dest">Save in</label>
      <div class="row"><input id="export-dest" type="text" value="${esc(dest)}" style="flex:1" data-test="export-dest">
        <button class="btn" data-action="export-pick">Choose…</button></div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-action="export-folder" data-test="export-folder" ${d.status.built && !running('checks') ? '' : 'disabled'}>Export a folder</button>
        <button class="btn" data-action="export-zip" data-test="export-zip" ${d.status.built && !running('checks') ? '' : 'disabled'}>Export a zip</button>
        ${d.status.built ? '' : '<span class="muted small">Build the demo first.</span>'}</div>
      <div data-region="export" style="margin-top:12px"></div></div>`;
  $('#export-dest', panel).onchange = e => { J(d.id).dest = e.target.value; };
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
document.addEventListener('input', e => { if (e.target.dataset.save) e.target.dataset.dirty = '1'; });
document.addEventListener('change', e => {
  const f = e.target.dataset.save;
  if (!f || f === 'plan' || S.view !== 'demo') return;
  saveAiField(f, e.target.value).then(() => { delete e.target.dataset.dirty; }).catch(() => {});
});
async function quickChecks(id = S.id) {
  if (!S.demos.find(x => x.id === id)?.status.built) return;
  if (id !== S.id) return;
  return step('checks', 'run_checks', { quick: true });
}
// Export: the whole checklist first (unless it passed and nothing changed since), then the folder or zip.
async function exportDemo(kind, anyway) {
  J(S.id).exportKind = kind;
  return step('export', 'export_demo', { kind, dest: $('#export-dest').value, anyway });
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
    AI.signing = true; AI.code = null; AI.runtime = null; AI.error = null; renderCopilotState(); renderCopilot();
    try { await invoke('ai_sign_in'); toast('Signed in to GitHub Copilot'); } catch (e) { AI.error = typeof e === 'string' ? e : e.message; }
    AI.signing = false; AI.code = null;
    await refreshAi();
  },
  'ai-sign-out': async () => { await call('ai_sign_out'); await refreshAi(); },
  'ai-models': async () => { AI.models = (await call('ai_models')).models; renderCopilot(); },
  'pick-source': async () => { const f = await call('pick_text_file'); if (f) { $('#new-source').value = f.text; $('#source-name').textContent = f.name; } },
  'pick-source-demo': async () => { const f = await call('pick_text_file'); if (f) { $('#ai-source').value = f.text; await saveAiField('source', f.text); toast(`Using ${f.name}`); } },
  'ai-plan': async () => {
    const id = S.id;
    await saveAiFields(id);
    const o = await step('ai-plan', 'ai_plan', {});
    if (o) { const p = $('#ai-plan'); if (p) delete p.dataset.dirty; await loadAi(id); }
  },
  'ai-record': async () => {
    const id = S.id;
    const plan = $('#ai-plan')?.value || '';
    if (!plan.trim()) return toast('Draft the plan first', true);
    try { await saveAiFields(id); await call('ai_save', { id, plan }); } catch { return; }
    J(id).aiChain = null;
    const o = await step('ai-record', 'ai_record', {});
    loadAi(id);
    if (o) await aiFinish(id, false);
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
    J(S.id)['record-stop'] = {};
    J(S.id).record = { status: { recording: true, count: 0 } };
    await step('record', 'record_start', { resume: false });
  },
  'record-stop': async () => {
    const id = S.id;
    const o = await step('record-stop', 'record_stop', {}, () => { J(id).record = {}; });
    const d = S.demos.find(x => x.id === id);
    if (o && (d?.mode === 'script' || d?.mode === 'coach')) await aiFinish(id, true);
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
  'present-start': async () => {
    const guide = $('#with-guide')?.checked ?? true;
    const r = await call('present_start', { id: S.id, guide });
    S.servers.present[S.id] = r.url;
    J(S.id).guideUrl = r.guide || null;
    announce(r.guide ? 'Presenting, with the presenter guide' : 'Presenting');
    rerender();
  },
  'present-guide': async () => {
    J(S.id).guideUrl = await call('present_guide', { id: S.id });
    toast('Opened the presenter guide on this screen');
    rerender();
  },
  'present-stop': async () => { await call('present_stop', { id: S.id }); await refreshServers(); rerender(); },
  'export-pick': async () => {
    const p = await call('pick_folder');
    if (p) { J(S.id).dest = p; $('#export-dest').value = p; }
  },
  'export-folder': () => exportDemo('folder', false),
  'export-zip': () => exportDemo('zip', false),
  'export-anyway': () => exportDemo(J(S.id).exportKind || 'folder', true),
};

document.addEventListener('click', async e => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const ds = t.dataset;
  if (ds.open) { e.preventDefault(); return openDemo(ds.open); }
  if (ds.mode) return renderNewForm(ds.mode);
  if (ds.answer) {
    const text = ds.withText ? $('#ai-instead')?.value.trim() : undefined;
    if (ds.withText && !text) return toast('Say what to do instead', true);
    return call('ai_answer', { id: S.id, question: ds.qid, answer: ds.answer, text: text || null });
  }
  if (ds.copyOpen) { await copyText(ds.copyOpen); toast('Code copied'); return call('open_url', { url: ds.url }).catch(() => {}); }
  if (ds.action && ACTIONS[ds.action]) { e.preventDefault(); return ACTIONS[ds.action](); }
  if (ds.duplicate) return duplicateDemo(ds.duplicate);
  if (ds.delete) return deleteDemo(ds.delete);
  if (ds.tab) { S.tab = ds.tab; renderTabsBar(); await renderPanel(); return $(`#tab-${ds.tab}`)?.focus(); }
  if (ds.goto) { S.tab = ds.goto; return openDemo(S.id); }
  if (ds.sheet) { J(S.id).sheetTab = ds.sheet; return renderPanel(); }
  if (ds.reveal) return call('reveal', { path: ds.reveal }).catch(() => {});
  if (ds.copy) { await copyText(ds.copy); return toast('Copied'); }
  if (ds.openUrl) return call('open_url', { url: ds.openUrl }).catch(() => {});
  if (ds.openFile) return call('open_file', { path: ds.openFile }).catch(() => {});
  if (ds.removeApp !== undefined) { const rows = document.querySelectorAll('[data-app-row]'); if (rows.length > 1) t.closest('[data-app-row]').remove(); return; }
  if (t.id === 'add-app') { const n = document.querySelectorAll('[data-app-row]').length; $('#apps').insertAdjacentHTML('beforeend', appRow(n)); return $(`#app-id-${n}`).focus(); }
});
document.addEventListener('submit', e => {
  if (e.target.id === 'new-form') { e.preventDefault(); createDemo(e.target); }
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
$('#nav-library').onclick = async () => { const m = $('#main'); m.setAttribute('aria-busy', 'true'); try { await loadDemos(); renderLibrary(); } finally { m.removeAttribute('aria-busy'); } };
// ---- Updates: checked at start and every few hours; one click downloads, installs and restarts on the new version.
const U = { available: null, busy: false, progress: null };
function renderUpdate() {
  const el = $('#update');
  if (!U.available) { el.hidden = true; return; }
  el.hidden = false;
  const p = U.progress;
  const pct = p?.total ? Math.round(100 * p.downloaded / p.total) : null;
  el.innerHTML = U.busy
    ? `<div class="small"><strong>Updating to v${esc(U.available)}…</strong> ${p?.stage === 'install' ? 'Installing; Scenecast restarts in a moment.' : pct !== null ? `${pct}%` : 'Downloading'}</div>
       <div class="progress" role="progressbar" aria-label="Downloading the update" ${pct !== null ? `aria-valuenow="${pct}"` : ''}><div style="${pct !== null ? `width:${pct}%;animation:none` : ''}"></div></div>`
    : `<div class="small">Update available: <strong>v${esc(U.available)}</strong></div>
       <button class="btn small primary" id="update-now" data-test="update-now">Update</button>`;
  const b = $('#update-now');
  if (b) b.onclick = installUpdate;
}
async function checkUpdates(quiet) {
  const u = await invoke('check_updates').catch(e => ({ error: String(e) }));
  U.available = u.available || null;
  renderUpdate();
  if (quiet) return u;
  if (u.error) dialog({ title: 'Updates', body: `<p>Couldn\u2019t check for updates: ${esc(u.error)}</p>`, cancel: null });
  else if (!u.available) dialog({ title: 'Updates', body: `<p>You have the newest Scenecast (v${esc(u.current)}).</p>`, cancel: null });
  return u;
}
async function installUpdate() {
  U.busy = true; U.progress = null; renderUpdate();
  try {
    // Restarts on the new version when it's installed: nothing after this runs.
    await invoke('install_update');
  } catch (e) {
    U.busy = false; renderUpdate();
    toast(`The update didn\u2019t install: ${typeof e === 'string' ? e : e.message}`, true);
  }
}
listen('update-progress', ({ payload }) => { U.progress = payload; renderUpdate(); });
$('#check-updates').onclick = () => checkUpdates(false);

// ---- Start -------------------------------------------------------------------------------------------------------

S.info = await call('app_info');
$('#version').textContent = `v${S.info.version}`;
document.documentElement.dataset.os = S.info.os;
await loadDemos();
await refreshServers();
renderLibrary();
if (S.info.engineError) toast(S.info.engineError, true);
refreshAi();
checkUpdates(true);
setInterval(() => { if (!U.busy) checkUpdates(true); }, 4 * 3600 * 1000);
window.__scenecast = S;
