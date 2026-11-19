// Local testing only (cargo feature `auditaur`, see tests/auditaur-smoke.mjs): Auditaur's frontend collector, put in
// front of the window's commands so each command and its answer or error lands in Auditaur's SQLite, and its drive
// bridge can click the app's buttons. Runs as an init script, before app.js.
import { initAuditaur } from '@auditaur/api';

// What went wrong, where the drive bridge can read it (#auditaur-debug): the window's CSP allows no eval.
const debug = msg => { const put = () => { let el = document.getElementById('auditaur-debug'); if (!el) { el = document.createElement('div'); el.id = 'auditaur-debug'; el.hidden = true; document.body.append(el); } el.textContent += msg + '\n'; }; document.body ? put() : addEventListener('DOMContentLoaded', put); };
const client = initAuditaur({ serviceName: 'scenecast-desktop', driveBridge: true, onExportError: e => debug('export: ' + (e && (e.message || JSON.stringify(e)))) });
client.catch(e => debug('init: ' + e));
// window.__TAURI__.core is frozen: app.js gets a copy whose invoke and listen go through the collector (which calls
// __TAURI_INTERNALS__ itself, so nothing loops).
const wrap = g => {
  if (!g || !g.core || g.__auditaur) return g;
  const invoke = g.core.invoke;
  const core = { ...g.core, invoke: (cmd, args, opts) => client.then(c => c.invoke(cmd, args), () => invoke(cmd, args, opts)) };
  const listen = g.event && g.event.listen;
  const event = listen ? { ...g.event, listen: (ev, fn) => client.then(c => c.listen(ev, fn), () => listen(ev, fn)) } : g.event;
  return { ...g, core, event, __auditaur: true };
};
let v = wrap(window.__TAURI__);
Object.defineProperty(window, '__TAURI__', { configurable: true, enumerable: true, get: () => v, set: x => { v = wrap(x); } });
