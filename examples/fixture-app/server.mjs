// A small two-app product for the kit's self-test: everything the real demos have that's hard to replicate, on
// localhost, with no sign-in. Light mode.
//   chat  http://127.0.0.1:47801/  a sidebar, a chat with a composer (send arrow, Enter) whose answer streams in
//         (steps, then words) with a Stop button while it works, a Workspace pane that closes and reopens and resizes
//         by its handle (250–480 px), chips with hover cards placed by script that show two rows and then "+N" (which
//         shows the rest and becomes "Show less"), a Plugins page, a sidebar that collapses by script below 1100 px,
//         a Projects section that collapses (and whose hover puts a "+ New project" button in it, moving what the
//         click changes), and a More options menu whose styles load when it opens and go again when it closes.
//         Each answer's steps stream into a collapsed step group ("3 steps") that opens even mid-answer and drops
//         its list when the answer ends; the second answer also ends with an "Approved 1 action" row that keeps its
//         list in the page and opens by a class swap. It runs a background worker of its own, as Teams and Copilot
//         do: a kind of target with no Fetch, whose requests go through the page
//   admin http://127.0.0.1:47802/  a search box that filters on Enter, a virtualized grid of 300 tools (only the
//         rows in view exist), a details pane that opens on a row and closes with its button or Escape
//   node test/fixture/server.mjs
import { createServer } from 'node:http';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const chat = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Chat</title>
<link rel="icon" href="/icon.png"><link rel="stylesheet" href="/chat.css">
<style id="dyn"></style>
<script>/* the real app's scripts: the replica keeps none of these */</script>
</head><body>
<div class="app" id="app">
  <nav aria-label="Sidebar" class="side">
    <div class="brand"><img src="/icon.png" alt="" width="16" height="16"> <span class="label">Fixture</span></div>
    <a href="#new" aria-label="New" class="nav-item"><span class="ico">+</span><span class="label">New</span></a>
    <a href="#plugins" aria-label="Plugins" class="nav-item"><span class="ico">▦</span><span class="label">Plugins</span></a>
    <div class="sec-wrap"><button class="sec label" aria-expanded="true" aria-label="Projects">Projects</button><ul class="proj label" id="proj"><li>Kestrel</li><li>Contoso</li></ul></div>
    <div class="recent" id="recent"></div>
  </nav>
  <main><header class="bar"><span>Supplier delays</span><button aria-label="More options" aria-haspopup="menu" aria-expanded="false" class="more">⋯</button></header><div id="main"></div></main>
  <aside aria-label="Workspace" id="ws">
    <div role="separator" aria-label="Resize workspace" aria-orientation="vertical" aria-valuenow="400" aria-valuemin="250" aria-valuemax="480" class="ws-resize"></div>
    <div class="ws-head"><span>Workspace</span><button aria-label="Close workspace" class="x">×</button></div>
    <ul role="list" class="chips">
      <li role="listitem" data-chip="" tabindex="0">Work IQ</li><li role="listitem" data-chip="" tabindex="0">Fabric IQ</li>
      <li role="listitem" data-chip="" tabindex="0">Connectors</li><li role="listitem" data-chip="" tabindex="0">Teams</li>
      <li role="listitem" data-chip="" tabindex="0">SharePoint</li><li role="listitem" data-chip="" tabindex="0">Outlook</li>
      <li role="listitem" data-chip="" tabindex="0">Planner</li>
    </ul>
  </aside>
</div>
<script>
const $ = s => document.querySelector(s);
const sheet = $('#dyn').sheet;
const CHEV = '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3 L5 7 L8 3" fill="none" stroke="currentColor"/></svg>';
// CSS written by script (insertRule), the way Griffel and merge-styles do it.
sheet.insertRule('.msg-you{background:#eef3ff;border-radius:10px;padding:10px 14px;margin:10px 0 10px auto;max-width:70%}');
sheet.insertRule('.msg-ai{padding:10px 2px;line-height:1.5}');
sheet.insertRule('.steps li{color:#555;font-size:13px}');
const DESC = { 'Work IQ': 'Your work: mail, meetings, files and chats.', 'Fabric IQ': 'Data agents over Fabric.', Connectors: 'Data from other systems.', Teams: 'Chats and channels in Teams.', SharePoint: 'Sites and documents.', Outlook: 'Mail and calendar.', Planner: 'Plans and tasks.' };
const STEPS = {};
let chats = 0, page = 'chat', streaming = false;
const composer = () => '<div data-testid="composer" class="composer"><span role="textbox" contenteditable="true" aria-label="Message" data-placeholder="Ask anything"></span><button aria-label="Send" class="send" disabled>➤</button></div>';
function renderChat(fresh) {
  page = 'chat';
  $('#main').innerHTML = '<div class="chat" id="chat">' + (fresh ? '<h1 class="hello">Hi Jessica, what are we working on?</h1>' : '') + '</div>' + composer();
  wireComposer();
  $('[role=textbox]').focus();
}
function renderPlugins() {
  page = 'plugins';
  const items = ['Supply chain disruption', 'Northwind IQ', 'Fabric IQ', 'Work IQ', 'Connectors', 'Planner'].map((n, i) => '<li class="card" role="listitem"><b>' + n + '</b><span>Plugin ' + (i + 1) + ' of 6</span></li>').join('');
  $('#main').innerHTML = '<div class="plugins"><h1>Plugins</h1><ul role="list" class="cards">' + items + '</ul></div>';
}
function wireComposer() {
  const box = $('[role=textbox]'), send = $('[aria-label=Send]');
  box.addEventListener('input', () => { send.disabled = !box.innerText.trim(); });
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  send.addEventListener('click', ask);
}
function ask() {
  const box = $('[role=textbox]'); const q = box.innerText.trim();
  if (!q || streaming) return;
  streaming = true;
  const h = $('.hello'); if (h) h.remove();
  box.innerText = ''; $('[aria-label=Send]').disabled = true;
  const c = $('#chat');
  const k = chats + 1, gid = 'grp-' + k;
  // The steps stream into a collapsed step group; its label counts them.
  c.insertAdjacentHTML('beforeend', '<div class="msg-you"><span class="sr">You said:</span> ' + q.replace(/</g, '&lt;') + '</div><div class="msg-ai"><div class="working">Working on it… <button aria-label="Stop" class="stop">■</button></div>' +
    '<button class="grp" aria-expanded="false" aria-controls="' + gid + '" data-state="closed"><span class="gicons" aria-hidden="true">◆◆</span><span class="glabel">0 steps</span>' + CHEV + '</button>' +
    '<div class="grp-region grp-closed" id="' + gid + '" aria-hidden="true" inert=""><div class="grp-inner"></div></div><div class="answer"></div></div>');
  const ai = c.lastElementChild;
  const steps = STEPS[gid] = chats ? ['Pricing the delay', 'Checking stock on hand', 'Reading the cost model'] : ['Reading the supplier alert', 'Looking up purchase orders', 'Checking open customer orders'];
  const words = ('Kestrel moved the ship date on PO-450101 by six days. Two builds and three customer orders are at risk; the earliest is due Friday. ' + (chats ? 'The cost of the delay is about $35,073.' : 'I can turn this into a reusable skill.')).split(' ');
  let i = 0;
  const step = () => {
    if (i < steps.length) { ai.querySelector('.grp-inner').insertAdjacentHTML('beforeend', '<div class="step">' + steps[i++] + '</div>'); ai.querySelector('.glabel').textContent = i + (i === 1 ? ' step' : ' steps'); return setTimeout(step, 350); }
    let w = 0;
    const word = () => {
      if (w < words.length) { ai.querySelector('.answer').textContent = words.slice(0, ++w).join(' '); return setTimeout(word, 70); }
      ai.querySelector('.working').remove();
      ai.insertAdjacentHTML('afterbegin', '<div class="said">Fixture said:</div>');
      // The product drops a closed group's list when the answer ends.
      if (ai.querySelector('.grp').getAttribute('aria-expanded') === 'false') ai.querySelector('.grp-inner').innerHTML = '';
      if (chats) ai.insertAdjacentHTML('beforeend', '<button class="grp-row" aria-expanded="false" aria-controls="row-' + k + '"><span class="glabel">Approved 1 action</span>' + CHEV + '</button><div class="row row-closed" id="row-' + k + '"><div class="row-inner"><div class="step">Copy file · skills / supplier-delay-triage</div></div></div>');
      streaming = false; chats++;
      $('#recent').innerHTML = '<div class="label rec-title">Recent</div>' + Array.from({ length: chats }, (_, k) => '<a href="#c' + k + '" class="nav-item recent-item"><span class="label">Supplier delay ' + (k + 1) + '</span></a>').join('');
    };
    word();
  };
  setTimeout(step, 400);
}
// Workspace pane: closes, and a button in its place opens it again.
document.addEventListener('click', e => {
  const t = e.target.closest('a,button');
  if (!t) return;
  if (t.matches('[aria-label="Close workspace"]')) { $('#ws').hidden = true; $('#app').insertAdjacentHTML('beforeend', '<button aria-label="Show workspace" class="show-ws">Workspace</button>'); }
  else if (t.matches('[aria-label="Show workspace"]')) { $('#ws').hidden = false; t.remove(); }
  else if (t.matches('[aria-label=New]')) { e.preventDefault(); renderChat(true); }
  else if (t.matches('[aria-label=Plugins]')) { e.preventDefault(); renderPlugins(); }
});
// Projects collapses and expands in place. Resting on the section puts a "+ New project" button in it, right after the
// Projects button (so what a click changes sits one place further on while the pointer is there).
$('[aria-label=Projects]').addEventListener('click', e => {
  const b = e.currentTarget, open = b.getAttribute('aria-expanded') === 'true';
  b.setAttribute('aria-expanded', open ? 'false' : 'true');
  if (open) $('#proj').remove(); else $('.sec-wrap').insertAdjacentHTML('beforeend', '<ul class="proj label" id="proj"><li>Kestrel</li><li>Contoso</li></ul>');
});
$('.sec-wrap').addEventListener('mouseenter', () => { if (!$('.new-proj')) $('[aria-label=Projects]').insertAdjacentHTML('afterend', '<button class="new-proj label" aria-label="New project">+ New project</button>'); });
$('.sec-wrap').addEventListener('mouseleave', () => { const n = $('.new-proj'); if (n) n.remove(); });
// Step groups: a list group puts its list in when it opens and slides open to its height; it drops the list again when
// it closes (unless the answer is still coming). An approval row keeps its list and opens by a class swap.
document.addEventListener('click', e => {
  const g = e.target.closest('button.grp'), r = e.target.closest('button.grp-row');
  if (g) {
    const region = document.getElementById(g.getAttribute('aria-controls')), inner = region.firstElementChild, open = g.getAttribute('aria-expanded') === 'true';
    if (!open) {
      if (!inner.childElementCount) inner.innerHTML = (STEPS[region.id] || []).map(s => '<div class="step">' + s + '</div>').join('');
      g.setAttribute('aria-expanded', 'true'); g.setAttribute('data-state', 'open');
      const ic = g.querySelector('.gicons'); if (ic) ic.remove();
      g.querySelector('svg').classList.add('chev-open');
      region.classList.replace('grp-closed', 'grp-open'); region.setAttribute('aria-hidden', 'false'); region.removeAttribute('inert');
      region.style.height = inner.offsetHeight + 'px';
    } else {
      g.setAttribute('aria-expanded', 'false'); g.setAttribute('data-state', 'closed');
      g.insertAdjacentHTML('afterbegin', '<span class="gicons" aria-hidden="true">◆◆</span>');
      g.querySelector('svg').classList.remove('chev-open');
      region.classList.replace('grp-open', 'grp-closed'); region.setAttribute('aria-hidden', 'true'); region.setAttribute('inert', ''); region.removeAttribute('style');
      if (!region.closest('.msg-ai').querySelector('.working')) inner.innerHTML = '';
    }
  } else if (r) {
    const region = document.getElementById(r.getAttribute('aria-controls')), open = r.getAttribute('aria-expanded') === 'true';
    r.setAttribute('aria-expanded', open ? 'false' : 'true');
    r.querySelector('svg').classList.toggle('chev-open', !open);
    region.classList.replace(open ? 'row-open' : 'row-closed', open ? 'row-closed' : 'row-open');
  }
});
// The chips show two rows at most; the rest give way to "+N", which shows them all and becomes "Show less".
let chipsOpen = false;
function fitChips() {
  const ul = $('.chips'); if (!ul || !ul.clientWidth) return;
  const items = [...ul.querySelectorAll(':scope > li[data-chip]')];
  items.forEach(li => li.style.removeProperty('display')); const old = ul.querySelector('[data-chip-more]'); if (old) old.remove();
  // Like Fluent's overflow (Copilot's Workspace chips), a hidden copy of "+N" to measure with, always there: not the chip.
  if (!ul.querySelector('[data-chip-measure]')) ul.insertAdjacentHTML('beforeend', '<li aria-hidden="true" data-chip-measure="" style="position:absolute;top:0;left:0;visibility:hidden;pointer-events:none">+9</li>');
  const W = ul.clientWidth, gap = 6, widths = items.map(li => li.getBoundingClientRect().width);
  const rowsFor = ws => { let rows = 1, x = 0; for (const w of ws) { if (x && x + gap + w > W) { rows++; x = w; } else x = x ? x + gap + w : w; } return rows; };
  if (rowsFor(widths) <= 2) return;
  ul.insertAdjacentHTML('beforeend', '<li role="listitem" data-chip-more=""><button class="more-chip" aria-expanded="false">+0</button></li>');
  const li = ul.lastElementChild, btn = li.firstElementChild;
  if (chipsOpen) { btn.textContent = 'Show less'; btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-label', 'Show less connectors'); return; }
  let k = items.length - 1;
  for (; k > 0; k--) { btn.textContent = '+' + (items.length - k); if (rowsFor([...widths.slice(0, k), li.getBoundingClientRect().width]) <= 2) break; }
  btn.textContent = '+' + (items.length - k); btn.setAttribute('aria-label', '+' + (items.length - k) + ' more connectors');
  items.slice(k).forEach(x => x.style.setProperty('display', 'none'));
}
document.addEventListener('click', e => { if (e.target.closest('.more-chip')) { chipsOpen = !chipsOpen; fitChips(); } });
addEventListener('resize', fitChips);
new ResizeObserver(fitChips).observe($('#ws'));
// More options: a menu whose stylesheet loads when it opens, and is taken away again when it closes (the way some
// apps load a style chunk with the component). Escape, a click elsewhere, or an item closes it.
const MENU_CSS = '.fx-menu{background:rgb(250,240,255);border:1px solid #c8b6e2;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.16);padding:6px;width:180px;z-index:20}.fx-menu-item{padding:7px 10px;border-radius:8px;font-size:13px}.fx-menu-item:hover{background:#efe4fb}';
function closeMenu() { const m = $('.fx-portal'); if (!m) return; m.remove(); const c = $('#menu-css'); if (c) c.remove(); $('[aria-label="More options"]').setAttribute('aria-expanded', 'false'); }
$('[aria-label="More options"]').addEventListener('click', e => {
  const b = e.currentTarget;
  if ($('.fx-portal')) return closeMenu();
  if (!$('#menu-css')) { const st = document.createElement('style'); st.id = 'menu-css'; st.textContent = MENU_CSS; document.head.appendChild(st); }
  const r = b.getBoundingClientRect();
  document.body.insertAdjacentHTML('beforeend', '<div class="fx-portal"><div role="menu" class="fx-menu" style="position:fixed;left:' + Math.round(r.right - 180) + 'px;top:' + Math.round(r.bottom + 4) + 'px"><div role="menuitem" class="fx-menu-item">Settings</div><div role="menuitem" class="fx-menu-item">Help</div></div></div>');
  b.setAttribute('aria-expanded', 'true');
});
document.addEventListener('mousedown', e => { if ($('.fx-portal') && !e.target.closest('.fx-portal,[aria-label="More options"]')) closeMenu(); }, true);
document.addEventListener('click', e => { if (e.target.closest('[role=menuitem]')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
// The Workspace pane resizes by its handle, live, between 250 and 480 px.
$('.ws-resize').addEventListener('mousedown', e => {
  e.preventDefault();
  const ws = $('#ws'), sep = e.currentTarget, x0 = e.clientX, w0 = ws.getBoundingClientRect().width;
  const move = ev => { const w = Math.max(250, Math.min(480, Math.round(w0 - (ev.clientX - x0)))); ws.style.width = w + 'px'; sep.setAttribute('aria-valuenow', String(w)); };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});
// Chip hover cards: a portal at the end of <body>, placed by script against the chip, after 300 ms.
let tip = null, tipTimer = null;
document.addEventListener('mouseover', e => {
  const chip = e.target.closest('[data-chip]');
  if (!chip || (tip && tip.__for === chip)) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (tip) tip.remove();
    const r = chip.getBoundingClientRect();
    tip = document.createElement('div');
    tip.className = 'portal';
    tip.innerHTML = '<div role="tooltip" class="card-tip" style="position:fixed;left:0;top:0;transform:translate(' + Math.round(Math.min(r.left, innerWidth - 250)) + 'px,' + Math.round(r.bottom + 6) + 'px)"><b>' + chip.textContent + '</b><br>' + DESC[chip.textContent] + '<br><i>Built-in</i></div>';
    tip.__for = chip;
    document.body.appendChild(tip);
  }, 300);
});
document.addEventListener('mouseout', e => {
  const chip = e.target.closest('[data-chip]');
  if (!chip || (e.relatedTarget && chip.contains(e.relatedTarget))) return;
  clearTimeout(tipTimer);
  if (tip) { tip.remove(); tip = null; }
});
// Below 1100 px the sidebar collapses to an icon rail, by script (the replica needs a zoom capture for this).
const fit = () => $('#app').classList.toggle('narrow', innerWidth < 1100);
addEventListener('resize', fit); fit();
renderChat(true);
// A background worker of the page's own (Teams and Copilot run them).
new Worker(URL.createObjectURL(new Blob(['setInterval(() => {}, 60000)'], { type: 'text/javascript' })));
</script></body></html>`;

const chatCss = `html,body{margin:0;height:100%;font:15px/1.4 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1b1b1b;background:#fff}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}
.app{display:flex;height:100vh}
.side{width:220px;flex:0 0 220px;background:#f6f7f9;border-right:1px solid #e3e5e8;padding:12px;box-sizing:border-box}
.app.narrow .side{width:56px;flex-basis:56px}.app.narrow .label{display:none}
.brand{display:flex;gap:8px;align-items:center;font-weight:600;margin-bottom:14px}
.nav-item{display:flex;gap:10px;align-items:center;padding:8px;border-radius:8px;color:inherit;text-decoration:none}
.nav-item:hover{background:#e8eaee}.ico{width:20px;text-align:center}
.rec-title{margin:16px 8px 4px;color:#666;font-size:12px}
main{flex:1;display:flex;flex-direction:column;min-width:0}
.grp,.grp-row{display:flex;align-items:center;gap:6px;border:0;background:none;padding:4px 0;color:#555;font-size:13px}
.gicons{color:#8a5cf6;font-size:9px}.chev{width:10px;height:10px;transition:transform .2s}.chev-open{transform:rotate(180deg)}
.grp-closed{height:0;overflow:hidden;visibility:hidden}.grp-open{overflow:hidden;transition:height .2s ease}
.grp-inner{transition:transform .2s ease}.step{color:#555;font-size:13px;padding:2px 0 2px 16px}
.row{display:grid;transition:grid-template-rows .2s}.row-closed{grid-template-rows:0fr;visibility:hidden}.row-open{grid-template-rows:1fr}.row-inner{overflow:hidden;min-height:0}
.new-proj{display:block;border:0;background:none;color:#2f5fd0;font-size:12px;padding:2px 8px}
.more-chip{border:1px dashed #b8bcc2;background:#fff;border-radius:12px;padding:3px 10px;font-size:13px}
#main{flex:1;display:flex;flex-direction:column;min-height:0}
.bar{display:flex;justify-content:space-between;align-items:center;padding:8px 16px 8px 32px;border-bottom:1px solid #eef0f2;font-weight:600}
.more{border:1px solid #d5d8dc;background:#fff;border-radius:8px;width:32px;height:28px}
.sec{display:block;width:100%;text-align:left;border:0;background:none;margin:14px 0 2px;padding:4px 8px;color:#666;font-size:12px}
.proj{list-style:none;margin:0;padding:0 8px;font-size:13px}.proj li{padding:4px 0}
.chat{flex:1;overflow:auto;padding:24px 32px}
.hello{font-size:26px;font-weight:600;margin-top:18vh;text-align:center}
.composer{display:flex;gap:8px;align-items:flex-end;margin:12px 32px 20px;border:1px solid #c9ccd1;border-radius:14px;padding:12px}
.composer [role=textbox]{flex:1;min-height:22px;outline:none}
.composer [role=textbox]:empty::before{content:attr(data-placeholder);color:#8a8d91}
.send{border:0;border-radius:8px;background:#2f5fd0;color:#fff;width:34px;height:30px}.send:disabled{background:#d6d9de}
aside{position:relative;width:25%;min-width:250px;max-width:480px;flex:none;border-left:1px solid #e3e5e8;padding:14px;box-sizing:border-box}
.ws-resize{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize}
aside[hidden]{display:none}
.ws-head{display:flex;justify-content:space-between;font-weight:600}.x{border:0;background:none;font-size:18px}
.chips{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.chips li{border:1px solid #d5d8dc;border-radius:12px;padding:3px 10px;font-size:13px}
.card-tip{background:#fff;border:1px solid #d5d8dc;box-shadow:0 4px 14px rgba(0,0,0,.14);border-radius:8px;padding:10px;width:230px;font-size:13px;z-index:10}
.show-ws{position:fixed;right:16px;top:12px;border:1px solid #c9ccd1;background:#fff;border-radius:8px;padding:4px 10px}
.working{color:#555}.stop{border:0;background:#eee;border-radius:4px}.said{font-weight:600;font-size:13px;color:#444}.sr{font-weight:600}
.plugins{padding:24px 32px}.cards{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.card{border:1px solid #e3e5e8;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:4px}.card span{color:#666;font-size:13px}`;

const ROWS = Array.from({ length: 300 }, (_, i) => ({ name: ['alpha', 'bravo', 'charlie', 'delta', 'echo'][i % 5] + '-' + (i + 1), type: i % 3 ? 'Plugin' : 'Agent', status: i % 7 ? 'On' : 'Off' }));
const admin = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Admin</title><link rel="icon" href="/icon.png">
<style>html,body{margin:0;height:100%;font:14px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1b1b1b;background:#fff}
header{display:flex;align-items:center;gap:16px;padding:10px 20px;border-bottom:1px solid #e3e5e8}header b{font-size:16px}
input[type=search]{width:320px;padding:7px 10px;border:1px solid #c9ccd1;border-radius:6px}
.wrap{display:flex;height:calc(100vh - 54px)}.gridbox{flex:1;overflow:auto;position:relative}
[role=grid]{position:relative}.hdr{position:sticky;top:0;background:#fafbfc;z-index:1;display:flex;border-bottom:1px solid #e3e5e8;font-weight:600}
.rows{position:relative}[role=row]{display:flex;height:36px;align-items:center;border-bottom:1px solid #f0f1f3}
.rows [role=row]{position:absolute;left:0;right:0}.rows [role=row]:hover{background:#f5f7fa}
[role=gridcell],[role=columnheader]{padding:0 16px;width:200px}
[role=dialog]{width:360px;border-left:1px solid #e3e5e8;padding:16px;box-sizing:border-box}</style></head>
<body><header><b>Fixture Admin</b><input type="search" aria-label="Search tools by name" placeholder="Search by name"></header>
<div class="wrap"><div class="gridbox" id="box"><div role="grid" aria-label="Tools" aria-rowcount="301" id="grid">
<div class="hdr" role="row" aria-rowindex="1"><div role="columnheader">Name</div><div role="columnheader">Type</div><div role="columnheader">Status</div></div>
<div class="rows" id="rows"></div></div></div></div>
<script>
const ALL = ${JSON.stringify(ROWS)};
let rows = ALL;
const box = document.getElementById('box'), list = document.getElementById('rows'), grid = document.getElementById('grid');
function draw() {
  list.style.height = rows.length * 36 + 'px';
  grid.setAttribute('aria-rowcount', rows.length + 1);
  const first = Math.max(0, Math.floor(box.scrollTop / 36) - 2), last = Math.min(rows.length, first + Math.ceil(box.clientHeight / 36) + 4);
  list.innerHTML = rows.slice(first, last).map((r, k) => { const i = first + k; return '<div role="row" aria-rowindex="' + (i + 2) + '" style="top:' + i * 36 + 'px"><div role="gridcell">' + r.name + '</div><div role="gridcell">' + r.type + '</div><div role="gridcell">' + r.status + '</div></div>'; }).join('');
}
box.addEventListener('scroll', draw); addEventListener('resize', draw); draw();
const search = document.querySelector('input[type=search]');
search.addEventListener('keydown', e => { if (e.key === 'Enter') { const q = search.value.trim().toLowerCase(); rows = ALL.filter(r => r.name.includes(q)); box.scrollTop = 0; draw(); } });
function closeDetails() { const d = document.querySelector('[role=dialog]'); if (d) d.remove(); }
list.addEventListener('click', e => {
  const row = e.target.closest('[role=row]'); if (!row) return;
  closeDetails();
  const name = row.firstElementChild.textContent;
  document.querySelector('.wrap').insertAdjacentHTML('beforeend', '<div role="dialog" aria-label="Details"><h2>' + name + '</h2><p>Publisher: Fixture</p><button aria-label="Close details">Close</button></div>');
});
document.addEventListener('click', e => { if (e.target.closest('[aria-label="Close details"]')) closeDetails(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetails(); });
</script></body></html>`;

export function startFixture({ chatPort = 47801, adminPort = 47802 } = {}) {
  const serve = (port, routes) => createServer((q, s) => { const r = routes[q.url.split('?')[0].split('#')[0]]; if (!r) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': r[0] }); s.end(r[1]); }).listen(port, '127.0.0.1');
  const a = serve(chatPort, { '/': ['text/html; charset=utf-8', chat], '/chat.css': ['text/css', chatCss], '/icon.png': ['image/png', PNG] });
  const b = serve(adminPort, { '/': ['text/html; charset=utf-8', admin], '/icon.png': ['image/png', PNG] });
  return { chat: `http://127.0.0.1:${chatPort}/`, admin: `http://127.0.0.1:${adminPort}/`, close: () => { a.close(); b.close(); } };
}

// A third app with a server of its own, for the unattended capture pass (selftest/capture-run.mjs): its writes change
// what the server keeps, so a test can see what reached it.
//   tasks http://127.0.0.1:47821/  a task list (each with "Delete <name>"), a "New task" box that adds one on Enter
//         (the page moves to /task/<id>), a Sync switch, Refresh (it posts, asks for a count the server doesn't have:
//         a 404, then says "Up to date: <n> tasks"), and a catalog service it calls as it loads and as you type
//         (GET /api/catalog; catalog(mode) makes it answer 500),
//         Archive all, and Help on another host (localhost). Every load posts /api/telemetry. The page gets a session
//         (GET /api/session) and sends it as Authorization; deleting a task without it is refused (401), so an undo by
//         the API has to use the page's own session. ?signin=<ms>&tid=<tenant id>: the page keeps a sign-in library's
//         account key for that tenant (MSAL's shape) after that many ms (never: none), for the capture start's wait.
//         suggest(true): the page also lists Suggested items from GET /api/suggested ({ items, order }: the items by ref,
//         drawn in order's order; an order ref with no item draws an empty row) with their count, and a Teams tree it
//         draws from its own store (localStorage, as Teams keeps its teams in IndexedDB): Leave out's two ways.
//         chips(true): a Chips button that draws Chips one in the page (/chips/1), then two and three (Next; each its
//         own address, pushed, as an app's in-page routes are): six plain buttons a screen that show
//         nothing on hover, and on the third a "Slow chip" (in a wrapper, as a card's anchor often is) whose card
//         shows 1.5 s after the pointer arrives, a "Quiet chip" that shows nothing, and a sidebar-like section (Projects,
//         whose card "Collapse projects" shows after 0.3 s; Add project here; a Recent list): the recorded hovers' floor.
//         moving(true): Chips one also has three buttons with a card each (Tip one, two, three) and a Details expander,
//         (no aria-controls: a click's, not a step group's), and the page moves while it's swept: a 90 px banner comes on top as the pointer leaves the first tip it
//         hovered, and another just after the recorder picks Details to click (a page that moves mid-sweep).
//         extras('fix' | 'stuck'): a side section outside the chips screens (Projects, expanded, with its list) whose
//         Peek button collapses it on hover; Chips one also has four menus (Menu A–D, each opening a menu that Escape
//         closes) and a Dud menu that opens nothing; Chips two has a Help button whose hover opens a Help pane that
//         Escape doesn't close ('stuck': it's kept in the tab's session, so a reload draws it again). Each chips
//         screen has its own title ("Chips one | Fixture Tasks"), the side section a "Chips one" button that goes
//         back there, and Chips one an "Elsewhere" menu that swaps the screen for another at the same address (as
//         Teams' conversations do), a "Find here" toggle drawn again when pressed whose bar Escape doesn't close (as
//         Teams' Find in channel), a "Fill box" menu that also fills the side section's Ask box (as a suggestion fills
//         Copilot's composer), and a status button ("Your status Away") with a menu.
//         Chips three always has an avatar ("Profile picture of Pat Doe.") whose people card shows after 0.3 s.
//         presence({ self, other }): the page keeps a sign-in library's account key (its account 00…aa) and asks
//         POST /api/presence for its account and a colleague's every 2 s, as Teams' getpresence: the Me button names
//         your status from the answer ("Your profile, status <self>") and "Pat Doe: <other>" shows the colleague's.
//         Each request body is kept (presenceBodies), to check it went out as the page sent it.
//         counts('late' | 'never'): the home screen's Inbox button is named with its count ("Inbox, 2 unread items")
//         8 s after the page loads (after the run's first save of it), or never (just "Inbox"), as admin's bell loads
//         its count; by default, at once.
//         notice('close' | 'stuck'): 0.3 s after Chips is clicked, Teams' "Loading latest updates…" notice comes on top
//         of the page and stays, with its own Close button ('close') or none ('stuck').
//         status(text): the page also shows your own status on a "Me" button ("Your profile, status <text>", as Teams'
//         avatar), and follows GET /api/status as it changes (status(null): none).
//   notes http://127.0.0.1:47824/  a panel in the tasks page's frame, on a host of its own with a session of its own
//         (it refuses a call without it): "Pin note" and "Unpin note" post to it, for a write inside a frame and an
//         API undo that has to go from that frame.
// The chips screens (main's markup), drawn in place by the tasks page, as an app's in-page routes are.
const chipsPart = (n, moving = false, extras = null) => `<h1>Chips ${['', 'one', 'two', 'three'][n]}</h1>${n === 1 && extras ? `<p class="menus"><button type="button" data-testid="find-toggle-button" aria-pressed="false" aria-label="Find here">Find</button>${['A', 'B', 'C', 'D'].map(x => `<button type="button" class="mb" aria-haspopup="menu" aria-expanded="false">Menu ${x}</button>`).join('')}<button type="button" aria-haspopup="menu">Dud menu</button><button type="button" aria-haspopup="menu" id="away">Elsewhere</button><button type="button" class="mb" aria-haspopup="menu" aria-expanded="false" data-fill="Prompt text">Fill box</button><button type="button" class="mb" data-tid="me-btn" aria-label="Your status Away" aria-haspopup="menu" aria-expanded="false">PD</button></p>` : ''}${n === 2 && extras ? '<p><button id="helpb">Help</button></p>' : ''}${n === 1 && moving ? '<p data-moving><button id="tip1">Tip one</button><br><button id="tip2">Tip two</button><br><button id="tip3">Tip three</button></p><p><button id="details" aria-expanded="false">Details</button></p><div id="dpanel" hidden>Details panel open</div>' : ''}<p>
${n === 3 ? '<span class="wrap"><button id="slow">Slow chip</button></span><button>Quiet chip</button><button id="pat" aria-label="Profile picture of Pat Doe.">PD</button>' : ''}${(n === 3 ? ['c1', 'c2', 'c3', 'c4'] : [1, 2, 3, 4, 5, 6].map(i => (n === 1 ? 'a' : 'b') + i)).map(x => `<button>Chip ${x}</button>`).join('')}
</p>${n < 3 ? `<p><button id="next" data-n="${n + 1}">Next</button></p>` : '<div class="sect"><button id="proj">Projects</button><button>Add project here</button><span>Recent</span><span>Item B</span><span>Item A</span></div>'}`;
const tasksPage = (port, notesPort, suggest = false, status = null, chips = false, notice = null, extras = null, counts = null, presence = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Tasks</title>
<link rel="icon" href="/icon.png"><style>
body{font:14px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif;margin:0;background:#fff;color:#1f2328}
main{max-width:720px;margin:32px auto;padding:0 24px} h1{font-size:22px;margin:0 0 12px}
.bar{display:flex;gap:8px;align-items:center;margin:0 0 16px} button{font:inherit;padding:4px 10px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;cursor:pointer}
button[role=switch][aria-checked=true]{background:#1f6feb;color:#fff} ul{list-style:none;padding:0;margin:0 0 16px}
li{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #eaeef2}
textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #d0d7de;border-radius:6px}
.card{position:fixed;background:#fff;border:1px solid #c9ccd1;border-radius:6px;padding:8px 10px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
</style></head><body><main>
<h1>Tasks</h1>
${status ? `<p><button id="me" aria-label="Your profile, status ${status}">Me</button></p>` : ''}${presence ? '<p><button id="me" aria-label="Your profile, status Unknown">Me</button> <span id="pat">Pat Doe: Unknown</span></p>' : ''}
<div class="bar"><button role="switch" aria-checked="false" aria-label="Sync" id="sync">Sync</button><span id="syncText">Sync is off</span>
<button aria-label="Refresh" id="refresh">Refresh</button><button aria-label="Archive all" id="archive">Archive all</button>
<a href="http://localhost:${port}/help" id="help">Help</a>${chips ? '<button id="chipsbtn">Chips</button>' : ''}<button id="inbox" aria-label="${counts ? 'Inbox' : 'Inbox, 2 unread items'}">Inbox</button><span id="fresh" role="status"></span></div>
<ul id="list" aria-label="Task list"></ul>
<p id="none">No tasks yet</p>
<textarea aria-label="New task" id="box" rows="2" placeholder="New task"></textarea>
<p id="saved" role="status"></p>
<iframe title="Notes" src="http://127.0.0.1:${notesPort}/" style="width:100%;height:90px;border:1px solid #d0d7de;border-radius:6px"></iframe>
${suggest ? '<h2>Suggested</h2><p id="sugCount"></p><ul id="sug" aria-label="Suggested"></ul><h2>Teams</h2><div role="tree" aria-label="Teams" id="teams"></div>' : ''}
</main><script>
const $ = id => document.getElementById(id);
let AUTH = '';
const EXTRAS = ${JSON.stringify(extras)};
// Presence, as Teams': the sign-in library's key for this account, then the presence service every 2 s.
const PKEY = '00000000-0000-0000-0000-0000000000aa.99999999-0000-0000-0000-000000000099-login.windows.net-idtoken-fixture-99999999-0000-0000-0000-000000000099---';
if (${JSON.stringify(!!presence)}) {
  try { localStorage.setItem(PKEY, '1'); } catch (e) {}
  const ask = () => fetch('/api/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mris: ['8:orgid:00000000-0000-0000-0000-0000000000aa', '8:orgid:00000000-0000-0000-0000-0000000000bb'] }) }).then(r => r.json()).then(list => {
    for (const e of list) { const a = (e.presence || {}).availability; if (/00000000-0000-0000-0000-0000000000aa/.test(e.mri)) document.getElementById('me').setAttribute('aria-label', 'Your profile, status ' + a); else document.getElementById('pat').textContent = 'Pat Doe: ' + a; }
  }).catch(() => {});
  ask(); setInterval(ask, 2000);
} else try { localStorage.removeItem(PKEY); } catch (e) {}
if (${JSON.stringify(counts)} === 'late') setTimeout(() => { const b = $('inbox'); if (b) b.setAttribute('aria-label', 'Inbox, 2 unread items'); }, 8000);
if (EXTRAS !== 'stuck') try { sessionStorage.removeItem('fx-pane'); } catch (e) {}
if ($('chipsbtn')) {
  // The chips screens, in place: Slow chip's card shows 1.5 s after the pointer arrives.
  const bind = () => {
    const nx = $('next'); if (nx) nx.addEventListener('click', () => show(+nx.dataset.n));
    const cardOn = (el, text, ms) => { if (!el) return; let t = null, card = null; el.addEventListener('mouseenter', () => { t = setTimeout(() => { const r = el.getBoundingClientRect(); card = document.createElement('div'); card.className = 'card'; card.setAttribute('role', 'tooltip'); card.textContent = text; card.style.left = r.x + 'px'; card.style.top = (r.bottom + 6) + 'px'; document.body.appendChild(card); }, ms); }); el.addEventListener('mouseleave', () => { clearTimeout(t); if (card) card.remove(); card = null; }); };
    cardOn($('slow'), 'Takes its time', 1500);
    cardOn($('proj'), 'Collapse projects', 300);
    cardOn($('pat'), 'PD Pat Doe Engineer Profile pat@example.com', 300);
    if (EXTRAS) {
      // The side section, outside the chips screens (it stays as they change), and what each extra does.
      if (!$('xside')) {
        document.body.insertAdjacentHTML('afterbegin', '<aside aria-label="Side" id="xside"><button id="peek">Peek</button> <button id="fold" aria-expanded="true">Projects</button><ul id="xlist"><li>Alpha</li><li>Beta</li></ul><button id="goone">Chips one</button><textarea aria-label="Ask" id="ask"></textarea></aside>');
        document.addEventListener('click', e => { const t = e.target.closest('[data-testid=find-toggle-button]'); if (!t) return; const on = t.getAttribute('aria-pressed') !== 'true', n = t.cloneNode(true); n.setAttribute('aria-pressed', String(on)); t.replaceWith(n); const fb = $('findbar'); if (on && !fb) n.insertAdjacentHTML('afterend', '<span role="search" id="findbar">Find bar <input aria-label="Find text"></span>'); if (!on && fb) fb.remove(); });
        $('goone').addEventListener('click', () => show(1));
        $('peek').addEventListener('mouseenter', () => { $('fold').setAttribute('aria-expanded', 'false'); $('xlist').hidden = true; });
        $('fold').addEventListener('click', () => { const open = $('fold').getAttribute('aria-expanded') !== 'true'; $('fold').setAttribute('aria-expanded', String(open)); $('xlist').hidden = !open; });
      }
      const pane = () => { if ($('xpane')) return; document.body.insertAdjacentHTML('beforeend', '<section aria-label="Help pane" id="xpane">Help pane text</section>'); if (EXTRAS === 'stuck') sessionStorage.setItem('fx-pane', '1'); };
      if (EXTRAS === 'stuck' && sessionStorage.getItem('fx-pane')) pane();
      if ($('helpb')) $('helpb').addEventListener('mouseenter', pane);
      if ($('away')) $('away').addEventListener('click', () => { document.querySelector('main').innerHTML = '<h1>Elsewhere</h1><p>Somewhere else</p>'; document.title = 'Elsewhere | Fixture Tasks'; });
      document.querySelectorAll('.mb').forEach(b => b.addEventListener('click', () => {
        const open = b.getAttribute('aria-expanded') === 'true';
        document.querySelectorAll('.fxm').forEach(m => m.remove()); document.querySelectorAll('.mb').forEach(x => x.setAttribute('aria-expanded', 'false'));
        if (open) return;
        if (b.dataset.fill) $('ask').value = b.dataset.fill;
        const r = b.getBoundingClientRect(), m = document.createElement('div');
        m.className = 'fxm card'; m.setAttribute('role', 'menu'); m.setAttribute('aria-label', b.textContent + ' items');
        m.innerHTML = '<div role="menuitem">' + b.textContent + ' one</div><div role="menuitem">' + b.textContent + ' two</div>';
        m.style.left = r.x + 'px'; m.style.top = (r.bottom + 4) + 'px'; document.body.appendChild(m); b.setAttribute('aria-expanded', 'true');
      }));
    }
    ['one', 'two', 'three'].forEach((w, i) => cardOn($('tip' + (i + 1)), 'Tip ' + w + ' card', 200));
    const d = $('details');
    if (d) d.addEventListener('click', () => { const open = d.getAttribute('aria-expanded') !== 'true'; d.setAttribute('aria-expanded', String(open)); $('dpanel').hidden = !open; });
    if (document.querySelector('[data-moving]')) {
      const banner = id => { if ($(id)) return; const b = document.createElement('div'); b.id = id; b.style.cssText = 'height:90px;background:#ddf4ff'; b.textContent = 'Catching up'; document.body.prepend(b); };
      ['tip1', 'tip2', 'tip3'].forEach(t => $(t).addEventListener('mouseleave', () => banner('banner1')));
      new MutationObserver(() => { if (d.hasAttribute('data-d1-ctl')) setTimeout(() => banner('banner2'), 40); }).observe(d, { attributes: true, attributeFilter: ['data-d1-ctl'] });
    }
  };
  const show = (n, push = true) => fetch('/chips-part/' + n).then(r => r.text()).then(h => { document.querySelector('main').innerHTML = h; if (push && location.pathname !== '/chips/' + n) history.pushState({}, '', '/chips/' + n); if (EXTRAS) document.title = 'Chips ' + ['', 'one', 'two', 'three'][n] + ' | Fixture Tasks'; bind(); });
  $('chipsbtn').addEventListener('click', () => show(1));
  // Teams' notice, a moment after the click, on top of the page; its own Close button takes it away.
  const NOTICE = ${JSON.stringify(notice)};
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('.fxm').forEach(m => m.remove()); document.querySelectorAll('.mb').forEach(x => x.setAttribute('aria-expanded', 'false')); } });
  if (NOTICE) $('chipsbtn').addEventListener('click', () => setTimeout(() => { if ($('notice')) return; const b = document.createElement('div'); b.id = 'notice'; b.setAttribute('role', 'status'); b.style.cssText = 'padding:8px;background:#fff8c5'; b.innerHTML = 'Loading latest updates… in the meantime, you can still send and respond to messages' + (NOTICE === 'close' ? ' <button aria-label="Close" id="nclose">×</button>' : ''); document.body.prepend(b); const c = $('nclose'); if (c) c.addEventListener('click', () => b.remove()); }, 300));
  const at = new RegExp('^/chips/([123])$').exec(location.pathname); if (at) show(+at[1], false);
}
if ($('me')) setInterval(() => fetch('/api/status').then(r => r.json()).then(j => { const l = 'Your profile, status ' + j.status; if (j.status && $('me').getAttribute('aria-label') !== l) $('me').setAttribute('aria-label', l); }).catch(() => {}), 400);
const session = fetch('/api/session').then(r => r.json()).then(j => { AUTH = 'Bearer ' + j.token; }).catch(() => {});
const post = (u, b) => session.then(() => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: AUTH }, body: JSON.stringify(b || {}) })).then(r => r.json());
function render(st) {
  if (!$('list')) return;
  $('list').innerHTML = st.tasks.map(t => '<li><span>' + t.name + '</span><button aria-label="Delete ' + t.name + '" data-id="' + t.id + '">Delete</button></li>').join('');
  $('none').hidden = st.tasks.length > 0;
  $('sync').setAttribute('aria-checked', String(st.sync)); $('syncText').textContent = 'Sync is ' + (st.sync ? 'on' : 'off');
}
const load = () => session.then(() => fetch('/api/tasks', { headers: { authorization: AUTH } })).then(r => r.json()).then(render);
$('box').addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  const name = $('box').value.trim(); if (!name) return;
  const r = await post('/api/tasks', { name });
  history.pushState({}, '', '/task/' + r.id);
  $('saved').textContent = 'Task saved: ' + name; $('box').value = '';
  await load();
});
$('list').addEventListener('click', async e => { const b = e.target.closest('button[data-id]'); if (!b) return; await fetch('/api/tasks/' + b.dataset.id, { method: 'DELETE', headers: { authorization: AUTH } }); $('saved').textContent = ''; await load(); });
$('sync').addEventListener('click', async () => { await post('/api/sync', { on: $('sync').getAttribute('aria-checked') !== 'true' }).catch(() => {}); await load(); });
$('refresh').addEventListener('click', async () => { await post('/api/refresh').catch(() => {}); fetch('/api/fresh-count').catch(() => {}); await load(); const n = $('list').children.length; $('fresh').textContent = 'Up to date: ' + n + (n === 1 ? ' task' : ' tasks'); });
$('archive').addEventListener('click', async () => { await post('/api/archive').catch(() => {}); await load(); });
post('/api/telemetry', { at: location.pathname }).catch(() => {});
// Its catalog service, as it loads and as you type (a lookup, 300 ms after the last key).
fetch('/api/catalog?from=load').catch(() => {});
let lookup = null;
$('box').addEventListener('input', () => { clearTimeout(lookup); lookup = setTimeout(() => fetch('/api/catalog?from=type').catch(() => {}), 300); });
load();
if ($('sug')) {
  fetch('/api/suggested').then(r => r.json()).then(j => {
    const by = new Map(j.items.map(i => [i.ref, i]));
    $('sug').innerHTML = j.order.map(o => by.has(o.ref) ? '<li><span>' + by.get(o.ref).name + '</span></li>' : '<li class="blank"></li>').join('');
    $('sugCount').textContent = j.order.length + ' suggested';
  }).catch(() => {});
  if (!localStorage.getItem('fx-teams')) localStorage.setItem('fx-teams', JSON.stringify(['Contoso Alpha', 'Contoso Beta', 'Northwind Ops']));
  $('teams').innerHTML = JSON.parse(localStorage.getItem('fx-teams')).map(t => '<div role="treeitem" aria-level="2" aria-expanded="true">' + t + '</div><div role="group"><div role="treeitem" aria-level="3">General</div></div>').join('');
}
{ const q = new URLSearchParams(location.search), ms = q.get('signin'), tid = q.get('tid');
  if (ms && ms !== 'never' && tid) setTimeout(() => localStorage.setItem('00000000-0000-0000-0000-0000000000aa.' + tid + '-login.windows.net-idtoken-fixture-' + tid + '---', '1'), +ms); }
</script></body></html>`;

const notesPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title><style>
body{font:14px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif;margin:8px;color:#1f2328} button{font:inherit;padding:4px 10px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;cursor:pointer}
</style></head><body><span id="state" role="status"></span> <button aria-label="Pin note" id="pin">Pin note</button> <button aria-label="Unpin note" id="unpin">Unpin note</button>
<script>
let AUTH = '', pinging = false;
const session = fetch('/api/session').then(r => r.json()).then(j => { AUTH = 'Bearer ' + j.token; }).catch(() => {});
const call = (path, method, body) => session.then(() => fetch(path, { method: method || 'GET', headers: { authorization: AUTH, ...(body ? { 'content-type': 'application/json' } : {}) }, body }));
const show = st => { document.getElementById('state').textContent = st.pinned ? 'Note is pinned' : 'Nothing pinned'; if (st.ping && !pinging) { pinging = true; setInterval(() => call('/api/seen', 'POST', JSON.stringify({ seen: Date.now() })).catch(() => {}), 150); } };
const load = () => call('/api/note').then(r => r.json()).then(show);
for (const [id, path] of [['pin', '/api/pin'], ['unpin', '/api/unpin']]) document.getElementById(id).addEventListener('click', async () => { await call(path, 'POST').catch(() => {}); await load(); });
load();
</script></body></html>`;

export function startTasks({ port = 47821, notesPort = 47824 } = {}) {
  const st = { tasks: [], sync: false, refreshes: 0, archives: 0, next: 100001, pinned: false, ping: false, seen: [], unpins: [], catalog: 'ok', suggest: false, status: null, chips: false, moving: false, notice: null, extras: null, counts: null, presence: null, presenceBodies: [] };
  const token = Math.random().toString(36).slice(2), notesToken = Math.random().toString(36).slice(2);
  const log = [];
  const body = q => new Promise(res => { let b = ''; q.on('data', d => { b += d; }); q.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { res({}); } }); });
  const send = (s, code, type, out) => { s.writeHead(code, { 'content-type': type }); s.end(out); };
  const view = () => ({ tasks: st.tasks.map(t => ({ ...t })), sync: st.sync });
  const server = createServer(async (q, s) => {
    const path = q.url.split('?')[0];
    log.push(`${q.method} ${path.replace(/\/\d{6}\b/, '/{id}')}`);
    if (q.method === 'GET' && (path === '/' || /^\/task\/\d+$/.test(path))) return send(s, 200, 'text/html; charset=utf-8', tasksPage(port, notesPort, st.suggest, st.status, st.chips, st.notice, st.extras, st.counts, !!st.presence));
    if (q.method === 'GET' && path === '/api/session') return send(s, 200, 'application/json', JSON.stringify({ token }));
    if (q.method === 'GET' && /^\/chips\/[123]$/.test(path)) return send(s, 200, 'text/html; charset=utf-8', tasksPage(port, notesPort, st.suggest, st.status, true, null, st.extras, st.counts));
    if (q.method === 'GET' && /^\/chips-part\/[123]$/.test(path)) return send(s, 200, 'text/html; charset=utf-8', chipsPart(+path.slice(-1), st.moving, st.extras));
    if (q.method === 'POST' && path === '/api/presence') { let b = ''; for await (const d of q) b += d; st.presenceBodies.push(b); const p = st.presence || {}; return send(s, 200, 'application/json', JSON.stringify([{ mri: '8:orgid:00000000-0000-0000-0000-0000000000aa', presence: { availability: p.self || 'Away', activity: p.self || 'Away' } }, { mri: '8:orgid:00000000-0000-0000-0000-0000000000bb', presence: { availability: p.other || 'Busy', activity: 'InAMeeting' } }])); }
    if (q.method === 'GET' && path === '/api/status') return send(s, 200, 'application/json', JSON.stringify({ status: st.status }));
    if (q.method === 'GET' && path === '/help') return send(s, 200, 'text/html; charset=utf-8', '<!doctype html><title>Help</title><h1>Help</h1><p>Fixture Tasks help.</p>');
    if (q.method === 'GET' && path === '/icon.png') return send(s, 200, 'image/png', PNG);
    if (q.method === 'GET' && path === '/api/tasks') return send(s, 200, 'application/json', JSON.stringify(view()));
    if (q.method === 'GET' && path === '/api/suggested') return send(s, 200, 'application/json', JSON.stringify({ items: [{ ref: 'r1', name: 'Contoso Notes' }, { ref: 'r2', name: 'Fabrikam Payroll' }, { ref: 'r3', name: 'Northwind Ledger' }], order: [{ ref: 'r2' }, { ref: 'r1' }, { ref: 'r3' }] }));
    if (q.method === 'GET' && path === '/api/catalog') {
      const from = new URLSearchParams(q.url.split('?')[1] || '').get('from');
      // 'drop': the connection closed with no answer at all (a call with no status, as a failed CORS preflight is).
      if (st.catalog === 'drop') { q.socket.destroy(); return; }
      const down = st.catalog === 'fail' || (st.catalog === 'fail-on-type' && from === 'type');
      // 'cards': its list has one row (a plan can click "Kestrel ledger Tracks every shipment. Plugin"); else empty.
      return send(s, down ? 500 : 200, 'application/json', down ? '{"error":"catalog unavailable"}' : st.catalog === 'cards' ? '{"items":[{"id":"k1","name":"Kestrel ledger","about":"Tracks every shipment."}]}' : '{"items":[]}');
    }
    if (q.method === 'POST' && path === '/api/tasks') { const b = await body(q); const t = { id: st.next++, name: String(b.name || '').slice(0, 200) }; st.tasks.push(t); return send(s, 200, 'application/json', JSON.stringify(t)); }
    const del = /^\/api\/tasks\/(\d+)$/.exec(path);
    if (q.method === 'DELETE' && del) {
      if (q.headers.authorization !== `Bearer ${token}`) { log[log.length - 1] += ' 401'; return send(s, 401, 'application/json', '{"error":"no session"}'); }
      st.tasks = st.tasks.filter(t => t.id !== +del[1]); return send(s, 200, 'application/json', '{}');
    }
    if (q.method === 'POST' && path === '/api/sync') { st.sync = !!(await body(q)).on; return send(s, 200, 'application/json', '{}'); }
    if (q.method === 'POST' && path === '/api/refresh') { await body(q); st.refreshes++; return send(s, 200, 'application/json', '{}'); }
    if (q.method === 'POST' && path === '/api/archive') { await body(q); st.archives++; st.tasks = []; return send(s, 200, 'application/json', '{}'); }
    if (q.method === 'POST' && path === '/api/telemetry') { await body(q); return send(s, 200, 'application/json', '{}'); }
    send(s, 404, 'text/plain', 'not found');
  }).listen(port, '127.0.0.1');
  const notes = createServer(async (q, s) => {
    const path = q.url.split('?')[0];
    if (path !== '/favicon.ico') log.push(`${q.method} notes${path}`);
    if (q.method === 'GET' && path === '/') return send(s, 200, 'text/html; charset=utf-8', notesPage());
    if (q.method === 'GET' && path === '/api/session') return send(s, 200, 'application/json', JSON.stringify({ token: notesToken }));
    if (/^\/api\/(note|pin|unpin|seen)$/.test(path) && q.headers.authorization !== `Bearer ${notesToken}`) { log[log.length - 1] += ' 401'; return send(s, 401, 'application/json', '{"error":"no session"}'); }
    if (q.method === 'GET' && path === '/api/note') return send(s, 200, 'application/json', JSON.stringify({ pinned: st.pinned, ping: st.ping }));
    if (q.method === 'POST' && path === '/api/seen') { await body(q); st.seen.push(Date.now()); return send(s, 200, 'application/json', '{}'); }
    if (q.method === 'POST' && (path === '/api/pin' || path === '/api/unpin')) {
      await body(q);
      const t0 = Date.now();
      if (st.ping && path === '/api/unpin') await new Promise(r => setTimeout(r, 1500));
      st.pinned = path === '/api/pin';
      if (path === '/api/unpin') st.unpins.push([t0, Date.now()]);
      return send(s, 200, 'application/json', '{}');
    }
    send(s, 404, 'text/plain', 'not found');
  }).listen(notesPort, '127.0.0.1');
  return {
    url: `http://127.0.0.1:${port}/`, help: `http://localhost:${port}/help`, notes: `127.0.0.1:${notesPort}`, log,
    state: () => ({ ...view(), refreshes: st.refreshes, archives: st.archives, pinned: st.pinned, seen: st.seen.slice(), unpins: st.unpins.slice() }),
    // What an earlier run could have left: a task, Sync on, a pinned note.
    seed: ({ tasks = [], sync = false, next, pinned = false } = {}) => { if (next) st.next = next; st.tasks = tasks.map(name => ({ id: st.next++, name })); st.sync = sync; st.pinned = pinned; },
    // The notes panel posts /api/seen every 150 ms while it's open, and Unpin takes 1.5 s: the app's own non-reads to
    // a host while an API undo's call to it is open.
    notePing: on => { st.ping = !!on; st.seen = []; st.unpins = []; },
    // Its catalog service: 'ok' (an empty list), 'cards' (one row), 'fail' (500 always), 'fail-on-type' (500 for the
    // lookup as you type) or 'drop' (no answer: the connection closed).
    catalog: mode => { st.catalog = mode; },
    suggest: on => { st.suggest = !!on; },
    status: text => { st.status = text || null; },
    chips: on => { st.chips = !!on; },
    moving: on => { st.moving = !!on; },
    notice: mode => { st.notice = mode || null; },
    extras: mode => { st.extras = mode || null; },
    counts: mode => { st.counts = mode || null; },
    presence: p => { st.presence = p || null; st.presenceBodies = []; },
    presenceBodies: () => st.presenceBodies.slice(),
    close: () => { server.close(); notes.close(); },
  };
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) { const f = startFixture(); console.log(`fixture: ${f.chat} ${f.admin}`); }
