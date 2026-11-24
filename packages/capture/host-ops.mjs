// The capture host's own commands, added to the recorder's (OPS) in the capture browser only: what an unattended run
// needs and the extension can't give. Each takes the command's arguments, as the recorder's do.
//   capInfo()                       { capture: true, mode }
//   capGuard({ hosts, allow, mode }) the read-only guard on (browser.mjs guard): every request that isn't a read,
//                                    to a guarded host, held before it leaves; mode 'watch' only logs
//   capOpen({ hosts }) → { id }     a planned write's way through, for its one step; capClose({ id })
//   capGuardOff()
//   capLog({ since })               what the guard held (method, host, path shape; never a body), from `since`
//   capEvents({ since })            what happened that a plan can't: a page opening another window, a native dialog
//                                    (dismissed: a confirm is never accepted), a tab leaving for another host
//   capShot({ tab, file })          a picture of a tab, for a stop
//   capBack({ tab })                the tab's previous page (the walker's way back from an off-plan landing)
//   capUrl({ tab })                 where a tab is now (one that left the app has lost its mark)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function hostOps(cb, { log = () => {}, base = null } = {}) {
  const events = [];
  const at = () => new Date().toISOString();
  const hostOf = u => { try { return new URL(u).host; } catch (e) { return ''; } };
  const watched = new WeakSet();
  const watch = p => {
    if (watched.has(p)) return;
    watched.add(p);
    p.on('popup', q => { events.push({ kind: 'popup', from: hostOf(p.url()), host: hostOf(q.url()), at: at() }); });
    p.on('dialog', d => { events.push({ kind: 'dialog', type: d.type(), host: hostOf(p.url()), at: at() }); d.dismiss().catch(() => {}); });
    p.on('framenavigated', f => { if (f === p.mainFrame()) events.push({ kind: 'navigated', host: hostOf(f.url()), path: (() => { try { return new URL(f.url()).pathname; } catch (e) { return ''; } })(), at: at() }); });
  };
  for (const p of cb.ctx.pages()) watch(p);
  cb.ctx.on('page', watch);
  // A tab by part of its address (the demo's match), as the recorder finds one.
  // Each one found is remembered: a tab that left for another host (an off-plan landing) has neither the address nor
  // its mark (sessionStorage is per site), and the walker still needs its picture and its way back.
  const known = new Map();
  const tabOf = async spec => {
    const pages = cb.ctx.pages().filter(p => /^https?:/.test(p.url()));
    if (!spec) return pages[0];
    let hit = pages.find(p => p.url().includes(spec));
    for (const p of hit ? [] : pages) { const m = await p.evaluate(() => sessionStorage.getItem('d1tab')).catch(() => null); if (m === spec) { hit = p; break; } }
    if (hit) { known.set(spec, hit); return hit; }
    const k = known.get(spec);
    if (k && !k.isClosed()) return k;
    throw new Error(`no tab for ${spec}`);
  };
  let guard = null, opens = new Map(), n = 0;
  return {
    async capInfo() { return { capture: true, mode: cb.mode, guarded: !!base }; },
    async capGuard(c) {
      if (guard) await guard.stop();
      guard = await cb.guard({ hosts: c.hosts || null, allow: c.allow || [], mode: c.mode || 'hold', local: !!c.local });
      log(`guard on (${c.mode || 'hold'}): ${(c.hosts || ['every web host']).join(', ')}; ${(c.allow || []).length} allowed`);
      return { on: true };
    },
    async capOpen(c) {
      if (!guard) return { id: null };
      const id = `w${++n}`;
      let close;
      const opened = new Promise(r => { close = r; });
      opens.set(id, close);
      guard.pass(() => opened, { hosts: c.hosts || null });
      log(`guard open for one write (${id}): ${(c.hosts || ['every host']).join(', ')}`);
      return { id };
    },
    async capClose(c) { const close = opens.get(c.id); if (close) { close(); opens.delete(c.id); } return { closed: !!close }; },
    async capGuardOff() { for (const close of opens.values()) close(); opens.clear(); if (guard) await guard.stop(); guard = null; if (base) await base(); return { on: !!base }; },
    // A run's guard, else the one on from the start.
    async capLog(c) { const g = guard || (base && base.guard); const held = g ? g.held() : []; return { held: held.slice(c.since || 0), total: held.length, counts: g ? g.counts() : {} }; },
    async capEvents(c) { return { events: events.slice(c.since || 0), total: events.length }; },
    async capUrl(c) { const p = await tabOf(c.tab); return { url: p.url(), title: await p.title().catch(() => '') }; },
    async capShot(c) { const p = await tabOf(c.tab); mkdirSync(dirname(c.file), { recursive: true }); writeFileSync(c.file, await p.screenshot()); return { file: c.file }; },
    async capBack(c) { const p = await tabOf(c.tab); await p.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null); return { url: p.url() }; },
  };
}
