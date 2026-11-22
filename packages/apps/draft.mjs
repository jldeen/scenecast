// Drafts an app pack from a new app's first capture (a recorder raw folder): the pages' host and start URL, the names
// its page titles use, its design system and how it themes, frames to skip, sign-in tokens to strip, and candidates
// to confirm (busy markers, things that change by themselves, step-group buttons, script-placed popups, CSS the
// capture lost, controls that write). Nothing is guessed into the pack's rules: candidates stay in `draft` for a
// person (or Copilot) to confirm, and checkPack lists what the pack still needs.
//   node packages/apps/draft.mjs --raw <raw folder> [--match <host>] [--id <id>] [--out <pack folder>]
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkPack, packFor, PACK_KIND, PACK_VERSION } from './index.mjs';

const host = u => { try { return new URL(u).host; } catch (e) { return ''; } };
const top = (m, n = 8) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const bump = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by);
const WRITE_WORDS = /^(send|post|reply|comment|save|delete|remove|approve|merge|confirm|publish|submit|add|create|certify|endorse|resolve|archive|commit|share|invite)\b/i;

export function draftPack(raw, { match, id } = {}) {
  const dir = join(raw, 'snaps');
  const snaps = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('x-')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const hosts = new Map();
  for (const s of snaps) { const m = s.docs.find(d => d.key === 'main'); if (m) bump(hosts, host(m.meta.url)); }
  const want = match || (top(hosts, 1)[0] || [''])[0];
  const pages = snaps.filter(s => { const m = s.docs.find(d => d.key === 'main'); return m && host(m.meta.url).endsWith(want); });
  const urlIndex = existsSync(join(raw, 'urls.json')) ? JSON.parse(readFileSync(join(raw, 'urls.json'), 'utf8')) : {};
  const sheets = new Map();
  const cssOf = d => (d.urls || []).map(u => { const e = urlIndex[u]; if (!e || !e.file || !e.file.endsWith('.css')) return ''; if (!sheets.has(e.file)) { const p = join(raw, 'blobs', e.file); sheets.set(e.file, existsSync(p) ? readFileSync(p, 'utf8') : ''); } return sheets.get(e.file); }).join('\n');
  const seenSheets = new Set();
  const F = { frames: new Map(), titles: new Map(), busy: new Map(), ignore: new Map(), groups: new Map(), float: new Map(), pin: new Map(), lost: new Map(), writes: new Map(), tokens: new Set(), system: new Map(), scheme: 0, docs: 0 };
  let start = null;
  for (const s of pages) {
    for (const d of s.docs) {
      const h = d.html || '';
      // The page's stylesheets (captured as files), each read once.
      const css = (d.urls || []).filter(u => { const e = urlIndex[u]; return e && e.file && !seenSheets.has(e.file) && seenSheets.add(e.file); }).length ? cssOf(d) : '';
      if (d.key === 'main') {
        F.docs++;
        start = start || d.meta.url.split(/[?#]/)[0];
        const parts = (d.meta.title || '').split(/\s+[|·—–-]\s+/);
        for (const p of new Set(parts.map(x => x.trim()))) if (p.length < 40) bump(F.titles, p);
      } else if (d.frameUrl && /^https?:/.test(d.frameUrl)) bump(F.frames, host(d.frameUrl));
      // Design system and theme markers.
      if (/data-color-mode=/.test(h)) bump(F.system, 'primer');
      if (/\bfui-[A-Z]/.test(h) || /--colorNeutralBackground1\b/.test(h)) bump(F.system, 'fluent');
      if (/\bms-Fabric\b|--themePrimary\b/.test(h)) bump(F.system, 'fluent-v8');
      if (/prefers-color-scheme\s*:\s*dark/.test(h + css)) F.scheme++;
      // Things that change by themselves: relative times and live clocks.
      for (const m of h.matchAll(/<(relative-time|time-ago|local-time|time)\b/g)) bump(F.ignore, m[1]);
      // Busy markers.
      for (const m of h.matchAll(/<[a-z][^>]*(?:aria-busy="true"|role="progressbar"|data-testid="[^"]*loading[^"]*"|aria-label="(?:Stop|Loading)[^"]*")[^>]*>/gi)) {
        const k = (/data-testid="([^"]*)"/.exec(m[0]) || [])[1] ? `[data-testid="${/data-testid="([^"]*)"/.exec(m[0])[1]}"]` : /role="progressbar"/.test(m[0]) ? '[role=progressbar]' : /aria-busy/.test(m[0]) ? '[aria-busy=true]' : `[aria-label="${/aria-label="([^"]*)"/.exec(m[0])[1]}"]`;
        bump(F.busy, k);
      }
      // Step groups: buttons that expand something, by the attribute that names them.
      for (const m of h.matchAll(/<button\b[^>]*aria-expanded="(?:true|false)"[^>]*>/g)) {
        const a = /(data-telemetry-id|data-testid|data-tid)="([^"]*)"/.exec(m[0]);
        if (a) bump(F.groups, `button[${a[1]}="${a[2]}"]`);
      }
      // Popups placed by script (float) and fixed parts (pin).
      for (const m of h.matchAll(/<div\b[^>]*role="(presentation|tooltip|menu|dialog|listbox)"[^>]*style="[^"]*translate3d/g)) bump(F.float, `div[role=${m[1]}][style*="translate3d"]`);
      for (const m of h.matchAll(/<(div|header|footer|nav)\b[^>]*style="[^"]*position:\s*fixed/g)) bump(F.pin, m[1]);
      // CSS the capture lost: declarations Chrome's CSSOM wrote back empty (a var() shorthand overridden in part).
      for (const line of (h + '\n' + css).split('\n')) if (/\{[^}]*:\s*;/.test(line)) bump(F.lost, line.trim().split('{')[0].trim().slice(0, 80));
      // Sign-in tokens kept in markup: an attribute named like one (the recorder blanks known ones).
      for (const m of h.matchAll(/\s([a-z][a-z0-9-]*(?:access-token|auth-token|-token|_token))="/gi)) F.tokens.add(m[1].toLowerCase());
      // Controls that write, by their names.
      for (const m of h.matchAll(/<button\b[^>]*>([\s\S]{0,200}?)<\/button>/g)) {
        const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const label = (/aria-label="([^"]*)"/.exec(m[0]) || [])[1] || t;
        if (label && label.length < 40 && WRITE_WORDS.test(label)) bump(F.writes, label);
      }
    }
  }
  // The app's name: a part of the page titles most pages have that carries the host's name ("· GitHub" on github.com);
  // else the host's name ("sentry.io": Sentry). Never an organization or project a title names.
  const parts = want.split('.');
  const label = parts.length > 2 && !/^(www|app)$/.test(parts[0]) ? parts[0] : parts.at(-2) || want;
  const squash = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const [named] = top(F.titles, 50).find(([t, n]) => n >= 0.5 * F.docs && squash(t).includes(squash(label))) || [];
  const title = named || (label.length <= 3 ? label.toUpperCase() : label[0].toUpperCase() + label.slice(1));
  const pid = id || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || want.split('.')[0];
  const system = (top(F.system, 1)[0] || ['unknown'])[0];
  const pack = {
    kind: PACK_KIND, version: PACK_VERSION, id: pid, title, names: [title],
    match: [want],
    // The start page is the root of the match (--match sentry.io for an app with a subdomain per organization): an
    // organization's subdomain or path is the demo's, not the app's.
    start: { url: start ? `https://${want}/` : '' },
    record: { ...([...F.ignore.keys()].some(k => k !== 'time') ? { ignore: top(F.ignore).map(([k]) => k).filter(k => k !== 'time') } : {}) },
    ...(F.tokens.size ? { build: { strip: { attrs: [...F.tokens] } } } : {}),
    theme: { system, follows: F.scheme ? 'system' : 'setting', themes: {} },
    platform: { frame: 'browser', shortcuts: {} },
    writes: [], effects: [],
    draft: {
      from: { pages: F.docs, stylesheets: sheets.size, note: 'A draft: confirm or drop each candidate below, then remove draft. Check the names and URLs hold no organization or tenant before committing.' },
      frames: top(F.frames).map(([h, n]) => ({ host: h, pages: n, note: packFor('https://' + h + '/') ? `known: pack ${packFor('https://' + h + '/').id}` : 'a frame host: add to frames.match if it is the app\'s, or frames.skip if it never draws anything' })),
      busy: top(F.busy).map(([sel, n]) => ({ sel, pages: n })),
      ignore: F.ignore.has('time') ? [{ tag: 'time', pages: F.ignore.get('time'), note: 'only if these show relative times ("5 minutes ago")' }] : [],
      groups: top(F.groups).map(([button, n]) => ({ button, seen: n })),
      float: top(F.float).map(([el, n]) => ({ el, seen: n, note: 'placed by script: a float rule needs its anchor' })),
      pin: top(F.pin).map(([tag, n]) => ({ tag, seen: n })),
      lostCss: { rules: F.lost.size, top: top(F.lost, 10).map(([sel, n]) => `${sel} (${n})`), note: F.lost.size ? 'declarations the capture wrote back empty: make a repair map (build.repairs.css) from the live page' : 'none' },
      writes: top(F.writes, 20).map(([name, n]) => ({ name, seen: n, note: 'confirm: what it changes, its undo (plan steps), and a read-only check' })),
      system: Object.fromEntries(top(F.system)),
      theme: F.scheme ? 'prefers-color-scheme rules found: the other theme is likely in every page (try the scheme flip before a theme pack)' : 'no prefers-color-scheme rules: the app loads one theme; capture the other once for a theme pack (spike A)',
    },
  };
  return { pack, problems: checkPack(pack) };
}

if (process.argv[1] && process.argv[1].endsWith('draft.mjs')) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  const raw = (opt('raw') || '').replace(/^~(?=\/)/, homedir());
  if (!raw || !existsSync(join(raw, 'snaps'))) { console.error('usage: node packages/apps/draft.mjs --raw <raw folder with snaps/> [--match <host>] [--id <id>] [--out <folder>]'); process.exit(2); }
  const { pack, problems } = draftPack(raw, { match: opt('match'), id: opt('id') });
  const out = opt('out');
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'pack.json'), JSON.stringify(pack, null, 2) + '\n'); }
  console.log(JSON.stringify(pack, null, 1));
  if (problems.length) console.log('still needed: ' + problems.join('; '));
}
