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
  receiver: null,
  profiles: {},
  update: null,
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
async function step(job, cmd, args, after) {
  const id = S.id;
  J(id).running[job] = true;
  J(id)[job] = { ...(J(id)[job] || {}), stages: [], lines: [], items: [], events: [], error: null, outcome: null, startedAt: Date.now() };
  rerender();
  try {
    const out = await call(cmd, { id, ...args });
    J(id)[job].outcome = out;
    if (after) await after(out);
    return out;
  } catch (e) {
    J(id)[job].error = e.message;
  } finally {
    delete J(id).running[job];
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
// The receiver the app keeps running for the open demo, and whether the recorder extension is connected to it.
listen('receiver', ({ payload }) => {
  const was = S.receiver?.connected;
  S.receiver = payload;
  if (payload.connected && !was && payload.demo === S.id) announce('The recorder is connected');
  if (S.view === 'demo') renderRegions();
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
function renderNew() {
  S.view = 'new';
  S.id = null;
  renderSidebar();
  const browser = isMac() ? 'chrome' : 'edge';
  $('#main').innerHTML = `<div class="page-head"><div class="grow"><h1>New demo</h1>
    <p class="muted">Name it, and list the web apps it shows (each is a tab in the browser while you record).</p></div></div>
    <form id="new-form" class="card stack" novalidate>
      <div><label for="new-title">Name</label><input id="new-title" type="text" required placeholder="Contoso supplier delay" data-test="new-title"></div>
      <fieldset><legend>Apps <span class="hint">Its start page's web address; the name is how you'll switch to it (⌥ or Ctrl+Alt and its first letter).</span></legend>
        <div id="apps">${appRow(0)}</div>
        <button type="button" class="btn small" id="add-app" data-test="add-app">＋ Add another app</button></fieldset>
      <fieldset><legend>Record in</legend>
        <label class="choice"><input type="radio" name="browser" value="edge" ${browser === 'edge' ? 'checked' : ''}> Microsoft Edge</label>
        <label class="choice"><input type="radio" name="browser" value="chrome" ${browser === 'chrome' ? 'checked' : ''}> Google Chrome</label></fieldset>
      <p id="new-error" class="notice bad" hidden role="alert"></p>
      <div class="row"><button class="btn primary" type="submit" data-test="create-demo">Create demo</button>
        <button class="btn" type="button" data-action="library">Cancel</button></div>
    </form>`;
  $('#new-title').focus();
}
async function createDemo(form) {
  const apps = [...form.querySelectorAll('[data-app-row]')].map(r => ({ id: $('[data-app-id]', r).value.trim(), url: $('[data-app-url]', r).value.trim() }));
  const spec = { title: $('#new-title').value, apps, browser: form.browser.value };
  const err = $('#new-error');
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

// ---- A demo ------------------------------------------------------------------------------------------------------

function tabDone(t, s) {
  return { record: s.recorded, build: s.built, fidelity: !!s.fidelity, script: s.focusPoints > 0 }[t];
}
function tabJobs(t) {
  return { record: ['preflight', 'record', 'record-stop', 'extension'], build: ['build', 'checks'], fidelity: ['fidelity'], script: ['script'], export: ['export'] }[t] || [];
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
  await renderPanel();
  // The receiver runs while a demo is open: started now if it isn't (the extension then connects by itself).
  if (S.receiver?.demo !== id || !S.receiver?.up) invoke('receiver_ensure', { id }).then(r => { S.receiver = r; renderRegions(); }).catch(e => { S.receiver = { demo: id, error: String(e?.message || e) }; renderRegions(); });
}
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
    if (html !== undefined && el._html !== html) { el._html = html; el.innerHTML = html; }
  }
}

const progressBar = on => on ? '<div class="progress" role="progressbar" aria-label="Working"><div></div></div>' : '';
const logBox = (lines = [], open = false) => lines.length ? `<details ${open ? 'open' : ''}><summary>Details (${lines.length} lines)</summary>
  <div class="log" tabindex="0">${lines.slice(-200).map(l => `<div class="${l.error ? 'err' : ''}">${esc(l.text)}</div>`).join('')}</div></details>` : '';
const errorBox = e => e ? `<div class="notice bad" role="alert"><div>${esc(e)}</div></div>` : '';
const icon = (status, label) => `<span class="icon ${esc(status)}" role="img" aria-label="${esc(label || status)}">${{ ok: '✓', fixed: '✓', pass: '✓', fail: '!', warn: '!', manual: '?', skip: '–', run: '' }[status] ?? ''}</span>`;

// ---- Record ------------------------------------------------------------------------------------------------------

const PREFLIGHT_LABEL = { receiver: 'Receiver', browser: 'Browser', recorder: 'Recorder extension' };
const browserName = b => b === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
const avatar = p => p.picture ? `<img class="avatar" src="${esc(p.picture)}" alt="">`
  : `<span class="avatar" style="background:${esc(p.color || '#8c959f')}" aria-hidden="true">${esc((p.name || '?').trim()[0] || '?')}</span>`;
const REGIONS = {
  // The receiver: running for this demo, and the recorder connected to it (green) or not yet.
  receiver(d) {
    const r = S.receiver;
    if (!r || r.demo !== d.id) return `<div class="conn" data-test="receiver" data-up="false" data-connected="false"><span class="dot"></span>Starting the receiver…</div>`;
    if (r.error && !r.up) return `<div class="conn bad" data-test="receiver" data-up="false" data-connected="false" role="alert"><span class="dot"></span>The receiver isn't running: ${esc(r.error)}
      <button class="btn small" data-action="receiver-restart">Try again</button></div>`;
    if (!r.up) return `<div class="conn" data-test="receiver" data-up="false" data-connected="false"><span class="dot"></span>Starting the receiver on port ${esc(r.port)}…</div>`;
    if (r.connected) return `<div class="conn ok" data-test="receiver" data-up="true" data-connected="true" data-port="${esc(r.port)}"><span class="dot"></span><strong>Recorder connected.</strong> Ready when you are (receiver on port ${esc(r.port)}).</div>`;
    return `<div class="conn wait" data-test="receiver" data-up="true" data-connected="false" data-port="${esc(r.port)}"><span class="dot"></span>Receiver running on port ${esc(r.port)}. Waiting for the recorder extension in ${esc(browserName(d.browser))}…</div>`;
  },
  // The browser profile to record in: by name and picture, the one with the recorder picked unless the demo says.
  profiles(d) {
    const p = S.profiles[d.id];
    if (!p) return '<p class="muted small">Looking at your browser profiles…</p>';
    if (p.error) return `<p class="muted small">Couldn't read your ${esc(browserName(d.browser))} profiles: ${esc(p.error)}</p>`;
    if (!p.profiles.length) return `<p class="muted small">No ${esc(browserName(d.browser))} profiles found. Open ${esc(browserName(d.browser))} once, then <button class="link" data-action="profiles-refresh">look again</button>.</p>`;
    const cur = p.pick.dir;
    return `<fieldset class="profiles" data-test="profiles"><legend class="small muted">Profile to record in ${p.chosen ? '' : `<span class="pill info">picked for you: ${esc(p.pick.why)}</span>`}</legend>
      ${p.profiles.map(x => `<label class="profile ${x.dir === cur ? 'on' : ''}" data-test="profile-${esc(x.dir.replace(/\s+/g, '-'))}">
        <input type="radio" name="profile" value="${esc(x.dir)}" ${x.dir === cur ? 'checked' : ''}>${avatar(x)}
        <span><span class="pname">${esc(x.name)}</span><span class="small muted">${[x.open ? 'open' : 'not open', x.recorder ? (x.recorderOff ? 'recorder turned off' : 'has the recorder') : ''].filter(Boolean).join(' · ')}</span></span></label>`).join('')}
      <button class="btn small subtle" data-action="profiles-refresh">Refresh</button>
      ${p.chosen ? '<button class="btn small subtle" data-action="profile-auto">Pick for me</button>' : ''}</fieldset>`;
  },
  extension(d) {
    const j = J(d.id).extension || {};
    const ext = j.outcome;
    const on = running('extension', d.id);
    if (on) return `${progressBar(true)}<p class="muted small">Putting the recorder in its folder and opening ${esc(browserName(d.browser))}'s extensions page…</p>`;
    if (!ext) return errorBox(j.error);
    const connected = S.receiver?.demo === d.id && S.receiver?.connected;
    const page = ext.extensionsPage;
    const edge = ext.browser === 'edge';
    return `<div class="install" data-test="install-steps">
      ${connected ? `<div class="notice ok" data-test="install-done"><div><strong>Done.</strong> The recorder is connected. You won't need to do this again.</div></div>` : ''}
      <p class="small">${ext.opened ? `Opened <strong>${esc(page)}</strong> in ${esc(ext.browserName)}${ext.profile ? ` (profile ${esc(ext.profile)})` : ''}, and the folder in ${folderWord()}.` : `Open <strong>${esc(page)}</strong> in ${esc(ext.browserName)}; the folder is open in ${folderWord()}.`}</p>
      <ol class="step-cards">
        <li class="step-card"><img src="install/developer-mode.png" alt="The extensions page, with the Developer mode switch at the top right turned on">
          <div><strong>1. Turn on Developer mode</strong><p class="small muted">${edge ? 'In Edge it\'s in the left-hand menu of edge://extensions.' : 'The switch at the top right of chrome://extensions.'}</p></div></li>
        <li class="step-card"><img src="install/load-unpacked.png" alt="The Load unpacked button, and the Scenecast Recorder card once it's loaded">
          <div><strong>2. Drag the folder in</strong><p class="small muted">Drag <strong>Recorder Extension</strong> from ${folderWord()} onto the extensions page. Or choose <strong>Load unpacked</strong> and pick it.</p></div></li>
        <li class="step-card"><div class="big-dot ${connected ? 'on' : ''}" aria-hidden="true"></div>
          <div><strong>3. Come back here</strong><p class="small muted">${connected ? 'Connected.' : 'This turns green when the recorder connects (a few seconds).'}</p></div></li>
      </ol>
      <div class="path"><code data-test="extension-dir">${esc(ext.dir)}</code>
        <button class="btn small" data-copy="${esc(ext.dir)}">Copy</button>
        <button class="btn small" data-reveal="${esc(ext.dir)}">Show in ${folderWord()}</button>
        <button class="btn small" data-action="open-extensions">Open ${esc(page)} again</button></div>
      <p class="muted small" style="margin-top:8px">Once per browser profile. When Scenecast updates, the recorder updates itself from this folder. Scenecast never restarts a browser you already have open.</p></div>`;
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
        ? `<button class="btn small" data-action="install-recorder" data-test="fix-${esc(i.id)}">Install recorder</button>`
        : `<button class="btn small" data-action="preflight-fix" data-test="fix-${esc(i.id.replace(' ', '-'))}" ${on ? 'disabled' : ''}>Fix</button>`) : '';
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

const PANELS = {};
PANELS.record = (panel, d) => {
  const pf = running('preflight', d.id);
  panel.innerHTML = `<div class="card"><h2><span class="step-num">1</span>The recorder</h2>
      <p class="muted">A small extension in your own browser does the recording. Install it once; it stays, and updates with Scenecast.</p>
      <div data-region="receiver"></div>
      <div class="row"><span class="muted small">Record in</span>
        <select id="browser" aria-label="Browser to record in" style="width:auto" data-test="browser">
          <option value="edge">Microsoft Edge</option><option value="chrome">Google Chrome</option></select></div>
      <div data-region="profiles"></div>
      <div class="row"><button class="btn primary" data-action="install-recorder" data-test="install-recorder">Install recorder</button>
        <button class="btn subtle" data-action="extension" data-test="prepare-extension">Just make the folder</button></div>
      <div data-region="extension"></div></div>
    <div class="card"><h2><span class="step-num">2</span>Ready to record?</h2>
      <p class="muted">Checks the receiver, your browser and profile, the recorder, and each app's tab (open, light theme, on its start screen). It fixes what it can, and never restarts your browser.</p>
      <div class="row"><button class="btn primary" data-action="preflight" data-test="preflight" ${pf ? 'disabled' : ''}>Check</button>
        <button class="btn" data-action="preflight-fix" data-test="preflight-fix" ${pf ? 'disabled' : ''}>Check and fix</button></div>
      <div data-region="preflight" style="margin-top:12px"></div></div>
    <div class="card"><h2><span class="step-num">3</span>Record</h2>
      <p class="muted">Run the demo once, the way you'll present it. Wait for each screen to be captured before the next step.</p>
      <div data-region="record"></div></div>`;
  const sel = $('#browser', panel);
  sel.value = d.browser;
  sel.onchange = () => call('set_browser', { id: d.id, browser: sel.value }).then(async () => {
    toast(`Recording in ${sel.selectedOptions[0].text}`);
    await refreshDemo(d.id);
    await loadProfiles(d.id);
  });
  if (!S.profiles[d.id]) loadProfiles(d.id);
};
async function loadProfiles(id) {
  try { S.profiles[id] = await invoke('browser_profiles', { id }); } catch (e) { S.profiles[id] = { error: String(e?.message || e) }; }
  if (S.id === id) renderRegions();
}
document.addEventListener('change', async e => {
  if (e.target.name !== 'profile' || !S.id) return;
  const id = S.id, p = S.profiles[id];
  await call('set_profile', { id, profile: e.target.value }).catch(() => {});
  const x = p?.profiles?.find(q => q.dir === e.target.value);
  toast(`Recording in profile ${x ? x.name : e.target.value}`);
  await loadProfiles(id);
});

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
const ACTIONS = {
  new: renderNew,
  library: renderLibrary,
  extension: () => step('extension', 'prepare_extension', {}),
  'install-recorder': () => step('extension', 'install_recorder', {}, () => loadProfiles(S.id)),
  'open-extensions': () => call('install_recorder', { id: S.id }).catch(() => {}),
  'profiles-refresh': () => loadProfiles(S.id),
  'profile-auto': async () => { await call('set_profile', { id: S.id, profile: null }); await loadProfiles(S.id); },
  'receiver-restart': async () => { S.receiver = null; renderRegions(); S.receiver = await invoke('receiver_ensure', { id: S.id }).catch(e => ({ demo: S.id, error: String(e?.message || e) })); renderRegions(); },
  // One preflight at a time: a second click while one runs does nothing.
  preflight: () => running('preflight') ? undefined : step('preflight', 'preflight', { fix: false }),
  'preflight-fix': () => running('preflight') ? undefined : step('preflight', 'preflight', { fix: true }),
  'record-start': async () => {
    J(S.id)['record-stop'] = {};
    J(S.id).record = { status: { recording: true, count: 0 } };
    await step('record', 'record_start', { resume: false });
  },
  'record-stop': () => step('record-stop', 'record_stop', {}, () => { J(S.id).record = {}; }),
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
  if (ds.action && ACTIONS[ds.action]) { e.preventDefault(); return ACTIONS[ds.action](); }
  if (ds.duplicate) return duplicateDemo(ds.duplicate);
  if (ds.delete) return deleteDemo(ds.delete);
  if (ds.tab) { S.tab = ds.tab; renderTabsBar(); await renderPanel(); return $(`#tab-${ds.tab}`)?.focus(); }
  if (ds.goto) { S.tab = ds.goto; return openDemo(S.id); }
  if (ds.sheet) { J(S.id).sheetTab = ds.sheet; return renderPanel(); }
  if (ds.reveal) return call('reveal', { path: ds.reveal }).catch(() => {});
  if (ds.copy) { await navigator.clipboard?.writeText(ds.copy).catch(() => {}); return toast('Copied'); }
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
$('#nav-library').onclick = async () => { const m = $('#main'); m.setAttribute('aria-busy', 'true'); try { await loadDemos(); renderLibrary(); } finally { m.removeAttribute('aria-busy'); } };
$('#check-updates').onclick = async () => {
  const u = await call('check_updates');
  dialog({ title: 'Updates', body: `<p>${esc(u.message)}</p>`, cancel: null });
};

// ---- Start -------------------------------------------------------------------------------------------------------

S.info = await call('app_info');
$('#version').textContent = `v${S.info.version}`;
document.documentElement.dataset.os = S.info.os;
await loadDemos();
await refreshServers();
renderLibrary();
if (S.info.engineError) toast(S.info.engineError, true);
window.__scenecast = S;
