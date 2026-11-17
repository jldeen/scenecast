// The lab: a third fixture app, seeded with the problems the replica engine can't know about by itself, the ones the
// fidelity loop (scenecast fidelity) has to find in the real-vs-replica comparison and fix with a per-demo patch.
// Each one is how real products behave (docs/engine/lessons.md):
//   font swap      the report's font is loaded by script (the FontFace API), so no @font-face rule is in any stylesheet:
//                  a page capture has no font for it and falls back
//   missing asset  the hero image's URL is single-use (a one-time token): the browser's load uses it, and any later fetch
//                  answers with a sign-in page; the same image is also shown, unsigned, in the sidebar
//   late style     the More actions menu brings its styles as an adopted stylesheet when it opens and drops them when it
//                  closes; the click audit only sees <style> and <link>
//   pinned box     the Tasks composer is position:fixed, placed by script over a placeholder, and re-placed on resize
//   virtual list   the Tasks list renders only the rows in view, placed by transform, with no row index attribute
//   node examples/fixture-app/lab.mjs
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { labFont, png } from './lab-assets.mjs';

const FONT = labFont();
// The hero: bands of colour, big enough that a blank image is plainly different.
const HERO = png(480, 200, (x, y) => [[47, 95, 208], [138, 92, 246], [21, 160, 120], [235, 120, 40]][Math.floor(x / 120)].map(c => Math.max(0, c - (y >> 2))));
const TASKS = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, name: ['Inspect pump station', 'Replace filter', 'Calibrate sensor', 'Review work order', 'Order spare parts'][i % 5], status: i % 4 ? 'Open' : 'Done' }));

const css = `html,body{margin:0;height:100%;font:15px/1.4 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1b1b1b;background:#fff}
.app{display:flex;height:100vh}
.side{width:220px;flex:0 0 220px;background:#f6f7f9;border-right:1px solid #e3e5e8;padding:12px;box-sizing:border-box}
.brand{display:flex;gap:8px;align-items:center;font-weight:600;margin-bottom:14px}.brand img{width:48px;height:20px;border-radius:4px}
.nav-item{display:block;padding:8px;border-radius:8px;color:inherit;text-decoration:none}.nav-item.on{background:#e8eaee}
main{flex:1;display:flex;flex-direction:column;min-width:0}
.bar{display:flex;justify-content:space-between;align-items:center;height:52px;box-sizing:border-box;padding:0 16px 0 32px;border-bottom:1px solid #eef0f2;font-weight:600}
.more{border:1px solid #d5d8dc;background:#fff;border-radius:8px;height:30px;padding:0 12px}
#main{flex:1;display:flex;flex-direction:column;min-height:0}
.report{font-family:"Lab Blocks",Georgia,serif;padding:24px 32px}.report h1{font-size:34px;font-weight:400;margin:0 0 16px}.report p{font-size:20px;margin:0 0 12px;max-width:900px}
.hero{display:block;width:480px;height:200px;margin:8px 32px;border-radius:8px}
.tasks{flex:1;overflow:auto;position:relative;margin:12px 32px 0;border:1px solid #e3e5e8;border-radius:8px}
.tasks-inner{position:relative}
.task{position:absolute;left:0;right:0;top:0;height:32px;display:flex;align-items:center;gap:16px;padding:0 14px;border-bottom:1px solid #f0f1f3;box-sizing:border-box}
.task b{width:80px;font-weight:600;color:#555}.task .st{margin-left:auto;font-size:12px;border-radius:10px;padding:1px 8px;background:#eef3ff}.task .st.done{background:#e6f6ee}
.composer-slot{height:56px;margin:12px 32px 20px;flex:none}
.composer{position:fixed;box-sizing:border-box;height:56px;border:2px solid #6b4fd8;border-radius:14px;background:#f7f4ff;display:flex;align-items:center;padding:0 16px;color:#6b4fd8;font-weight:600}`;

// The menu's own styles: adopted while it's open, dropped when it closes.
const MENU_CSS = '.lab-menu{position:fixed;box-sizing:border-box;width:200px;background:rgb(255,244,214);border:2px solid #d9a400;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.18);padding:8px;z-index:30}.lab-menu-item{padding:9px 12px;border-radius:8px;font-size:14px;font-weight:600;color:#6b4a00}';

const page = once => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Lab</title>
<link rel="icon" href="/media/hero.png"><link rel="stylesheet" href="/lab.css">
</head><body>
<div class="app">
  <nav aria-label="Sidebar" class="side">
    <div class="brand"><img src="/media/hero.png" alt=""> <span>Lab</span></div>
    <a href="#overview" aria-label="Overview" class="nav-item on">Overview</a>
    <a href="#tasks" aria-label="Tasks" class="nav-item">Tasks</a>
  </nav>
  <main><header class="bar"><span>Fixture Lab</span><button class="more" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">More</button></header><div id="main"></div></main>
</div>
<script>
const $ = s => document.querySelector(s);
const ONCE = ${JSON.stringify(once)};
const TASKS = ${JSON.stringify(TASKS)};
// The report's font, loaded by script: no @font-face rule anywhere.
const face = new FontFace('Lab Blocks', 'url(/fonts/lab-blocks.ttf)');
document.fonts.add(face); face.load();
function overview() {
  composerOff();
  $('#main').innerHTML = '<div class="report"><h1>Quarterly field report</h1><p>Pump stations ran at 97 percent uptime this quarter.</p><p>Two filters and one sensor are due next week.</p></div><img class="hero" alt="Field map" src="/media/hero.png?once=' + ONCE + '">';
}
// Tasks: a virtualized list (rows in view only, placed by transform, no index attribute) and a composer placed by script.
let box = null;
function draw() {
  if (!box) return;
  const inner = box.firstElementChild, first = Math.max(0, Math.floor(box.scrollTop / 32) - 2), last = Math.min(TASKS.length, first + Math.ceil(box.clientHeight / 32) + 4);
  inner.innerHTML = TASKS.slice(first, last).map(t => '<div class="task" role="listitem" style="transform:translateY(' + (t.n - 1) * 32 + 'px)"><b>T-' + String(t.n).padStart(3, '0') + '</b><span>' + t.name + '</span><span class="st' + (t.status === 'Done' ? ' done' : '') + '">' + t.status + '</span></div>').join('');
}
function tasks() {
  $('#main').innerHTML = '<div class="tasks" role="list" aria-label="Tasks"><div class="tasks-inner" style="height:' + TASKS.length * 32 + 'px"></div></div><div class="composer-slot"></div>';
  box = $('.tasks'); box.addEventListener('scroll', draw); draw();
  if (!$('.composer')) document.body.insertAdjacentHTML('beforeend', '<div class="composer" data-testid="task-composer">Add a task</div>');
  pin();
}
function pin() {
  const c = $('.composer'), slot = $('.composer-slot'); if (!c || !slot) return;
  const r = slot.getBoundingClientRect();
  c.style.left = Math.round(r.left) + 'px'; c.style.top = Math.round(r.top) + 'px'; c.style.width = Math.round(r.width) + 'px';
}
function composerOff() { const c = $('.composer'); if (c) c.remove(); box = null; }
addEventListener('resize', () => { pin(); draw(); });
document.addEventListener('click', e => {
  const a = e.target.closest('a.nav-item'); if (!a) return;
  e.preventDefault();
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('on', n === a));
  closeMenu();
  // Each view is its own route, as in a single-page app.
  history.pushState(null, '', a.matches('[aria-label=Tasks]') ? '/tasks' : '/');
  if (a.matches('[aria-label=Tasks]')) tasks(); else overview();
});
// More actions: its styles are an adopted stylesheet while it's open.
const menuSheet = new CSSStyleSheet(); menuSheet.replaceSync(${JSON.stringify(MENU_CSS)});
function closeMenu() {
  const m = $('.lab-menu'); if (!m) return;
  m.remove(); document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== menuSheet);
  $('.more').setAttribute('aria-expanded', 'false');
}
$('.more').addEventListener('click', e => {
  if ($('.lab-menu')) return closeMenu();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, menuSheet];
  const r = e.currentTarget.getBoundingClientRect();
  document.body.insertAdjacentHTML('beforeend', '<div role="menu" class="lab-menu" style="left:' + Math.round(r.right - 200) + 'px;top:' + Math.round(r.bottom + 6) + 'px"><div role="menuitem" class="lab-menu-item">Export report</div><div role="menuitem" class="lab-menu-item">Share</div><div role="menuitem" class="lab-menu-item">Archive</div></div>');
  e.currentTarget.setAttribute('aria-expanded', 'true');
});
document.addEventListener('mousedown', e => { if ($('.lab-menu') && !e.target.closest('.lab-menu,.more')) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
if (location.pathname === '/tasks') { document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('on', n.matches('[aria-label=Tasks]'))); tasks(); } else overview();
</script></body></html>`;

const signIn = '<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in to continue</h1><script>location.href="/login"</script></body></html>';

export function startLab({ port = 47803 } = {}) {
  const tokens = new Set();
  const srv = createServer((q, s) => {
    const u = new URL(q.url, 'http://x');
    const send = (type, body, cache = 'no-store') => { s.writeHead(200, { 'content-type': type, 'cache-control': cache }); s.end(body); };
    if (u.pathname === '/' || u.pathname === '/tasks') { const t = randomBytes(8).toString('hex'); tokens.add(t); return send('text/html; charset=utf-8', page(t)); }
    if (u.pathname === '/lab.css') return send('text/css', css);
    if (u.pathname === '/fonts/lab-blocks.ttf') return send('font/ttf', FONT);
    if (u.pathname === '/media/hero.png') {
      const t = u.searchParams.get('once');
      if (t === null) return send('image/png', HERO);
      // A one-time link: the first load gets the image, every later one a sign-in page (with a 200, as real apps do).
      if (tokens.delete(t)) return send('image/png', HERO, 'private, max-age=3600');
      return send('text/html; charset=utf-8', signIn);
    }
    s.writeHead(404); s.end();
  }).listen(port, '127.0.0.1');
  return { url: `http://127.0.0.1:${port}/`, close: () => srv.close() };
}

if (process.argv[1] && process.argv[1].endsWith('lab.mjs')) console.log('lab: ' + startLab().url);
