// Where a step lands, proven (docs/engine/plan-format.md, "What proves a step"): what a run checks after each step,
// chosen from the recording and checked against it the way a run checks the live page. Rules-only plans, Copilot's
// (after its answer is grounded) and walkthroughs all go through proveLandings(); the offline walker checks with holds().
import { formatStep } from './plan.mjs';

// Compared the way a run compares: lowercased, quotes and invisible characters out, spaces as one.
export const pnorm = s => String(s == null ? '' : s).toLowerCase().replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '').replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim();
// A screen's words as a run reads the page (innerText, every frame): not what's in a closed dialog, not a text area's.
const shows = sc => ((sc && sc.items) || []).filter(i => !i.shut && i.tag !== 'textarea');
const read = new WeakMap();
export const pageWords = sc => { if (!sc) return ''; if (!read.has(sc)) read.set(sc, pnorm(shows(sc).map(i => i.text).join('\n'))); return read.get(sc); };
const STATE = { selected: c => c.selected === true, open: c => c.expanded === true, on: c => c.on === true || c.pressed === true, off: c => c.on === false || c.pressed === false };
const stateOf = c => Object.keys(STATE).find(k => STATE[k](c)) || null;

// Whether a proof holds on a screen as the reader read it: true or false, or null when there's nothing to check.
export function holds(sc, l) {
  if (!sc || !l || !l.kind) return null;
  const words = pageWords(sc), has = t => !!pnorm(t) && words.includes(pnorm(t));
  const named = n => (sc.controls || []).filter(c => !c.shut && pnorm(c.name) === pnorm(n));
  if (l.kind === 'words') return has(l.text);
  if (l.kind === 'control') return named(l.control).some(c => !l.state || (STATE[l.state] || (() => false))(c));
  if (l.kind === 'box') return named(l.box).some(c => !!c.editable && pnorm(c.value).startsWith(pnorm(l.says)));
  if (l.kind === 'gone') return !has(l.gone) && (!l.still || has(l.still));
  return null;
}
// A proof in words, for the review and for what a walk reports.
export function proofWords(l) {
  if (!l || !l.kind) return 'nothing';
  if (l.kind === 'words') return `“${l.text}”`;
  if (l.kind === 'control') return l.state ? `“${l.control}” ${l.state === 'open' ? 'open' : l.state === 'selected' ? 'selected' : `switched ${l.state}`}` : `the “${l.control}” control`;
  if (l.kind === 'box') return `“${l.says}” in “${l.box}”`;
  return `“${l.gone}” gone${l.still ? `, “${l.still}” still there` : ''}`;
}
const textsOf = l => (l.kind === 'words' ? [l.text] : l.kind === 'control' ? [l.control] : l.kind === 'box' ? [l.box, l.says] : l.kind === 'gone' ? [l.gone, l.still] : []).filter(Boolean);

// Words that change between runs, or between a Mac and a PC, never prove a step: a time or a date, a duration, a size,
// a long number, a shortcut's keys.
const VOLATILE = /\d+(?:[.,]\d+)?\s?(?:ms|s|secs?|seconds?|mins?|minutes?|hrs?|hours?|kb|mb|gb)\b|\bago\b|\bjust now\b|\b\d{1,2}:\d{2}\b|\d{8,}/i;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE = new RegExp(`\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+${MONTH}(?![a-z])|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');
// A shortcut's keys differ between a Mac and a Windows PC (⌘⇧B, Ctrl+Shift+B).
const KEYS = /[⌘⌥⇧⌃]|\b(?:ctrl|cmd|alt|shift|option)\s*\+/i;
export const changes = t => VOLATILE.test(t) || DATE.test(t) || KEYS.test(t);

const count = t => String(t).split(/\s+/).filter(Boolean).length;
// The start of a long text, whole words up to n characters, before any straight quote (a plan line can't hold one).
const lead = (t, n = 60) => { let out = ''; for (const w of String(t).split('"')[0].split(/\s+/).filter(Boolean)) { if ((out + ' ' + w).trim().length > n) break; out = (out + ' ' + w).trim(); } return out; };

// What half a site's pages or more show (its sidebar, its top bar): a page's own words come before these. A site: the
// pages on the app's host (one demo's pull requests, its org and its settings are one site); a page: an address, all
// its screens together (an app that's one page with panels over it has no frame). Fewer than four pages, and there's
// no frame. In the bar or nav of nearly all the site's screens (frame.always: "Microsoft 365 admin center"), a number
// doesn't change.
const frames = new WeakMap();
const hostOf = u => { try { return new URL(u).host || null; } catch (e) { return null; } };
function frameOf(walker, app) {
  let m = frames.get(walker);
  if (!m) frames.set(walker, m = {});
  if (m[app]) return m[app];
  const url = id => (walker.view && (walker.view(id) || {}).url) || null;
  const mine = walker.states.filter(id => (walker.flow.states[id] || {}).app === app);
  const host = mine.map(id => hostOf(url(id))).find(Boolean);
  const ids = host ? walker.states.filter(id => hostOf(url(id)) === host) : mine;
  const pages = new Map(), onScreens = {};
  for (const id of ids) {
    const k = String(url(id) || id).split('#')[0], its = (walker.screen(id) || {}).items || [];
    if (!pages.has(k)) pages.set(k, new Set());
    for (const t of new Set(its.map(i => pnorm(i.text)))) pages.get(k).add(t);
    for (const t of new Set(its.filter(i => i.nav).map(i => pnorm(i.text)))) onScreens[t] = (onScreens[t] || 0) + 1;
  }
  const frame = new Set(), onPages = {};
  frame.always = new Set(ids.length >= 4 ? Object.keys(onScreens).filter(t => onScreens[t] >= ids.length * 0.8) : []);
  if (pages.size < 4) return (m[app] = frame);
  for (const texts of pages.values()) for (const t of texts) onPages[t] = (onPages[t] || 0) + 1;
  for (const [t, k] of Object.entries(onPages)) if (k >= pages.size * 0.5) frame.add(t);
  return (m[app] = frame);
}
// A number that can change: not one in a name that only identifies (#2, PO-1001).
const numbered = t => /\d/.test(String(t).replace(/#\d+\b|\b[a-z]{1,6}-\d{2,}\b/gi, ''));

// The proof for one step, from the screen before it (`from`; for "Go to X", where the plan was) to the one it lands on
// (`to`). In this order, words without a number first, then with one (flagged): words the new screen shows that the
// one before didn't; a control's state; what a box says; a control only the new screen has; words gone, with words of
// the page's own still there. A Type step: its own words. typed: what other steps type (never a proof).
// → { lands: { kind, … }, number, differs, why }: lands.kind is null when nothing proves the step, and `why` says so.
export function chooseProof(s, from, to, walker, { typed = [] } = {}) {
  const after = walker.screen(to);
  const before = from ? [walker.screen(from), walker.shown(from)].filter(Boolean) : [];
  const none = why => ({ lands: { kind: null, text: null }, why });
  if (!after) return none(`there's no screen ${to}`);
  const app = (walker.flow.states[to] || {}).app, fromApp = from && (walker.flow.states[from] || {}).app;
  const frame = frameOf(walker, app);
  // Another step's words: what it types, a stretch of it (four words or more), or words holding the start of a
  // sentence it types (a search term inside other words is only a word on the page).
  const typedIn = t => { const n = pnorm(t); return n.length > 1 && typed.some(v => { const m = pnorm(v); return !!m && (n === m || (m.includes(n) && (count(n) >= 4 || n.length >= 25)) || (count(m) >= 4 && n.includes(m.slice(0, 24)))); }); };
  const stable = t => !!t && /[a-z]/i.test(t) && !changes(t) && !(walker.written && walker.written(t)) && !(walker.unstable && walker.unstable(t, app)) && !typedIn(t);
  const proves = l => holds(after, l) === true && before.every(b => holds(b, l) === false);

  if (s.kind === 'type' && s.value) {
    const r = typing(s, from, after, before, walker);
    if (r) return r;
  }
  if (from === to) return none('it lands where it already was');
  if (!pageWords(after) && !(after.controls || []).length) return none(`the screen it lands on (${to}) has no words`);

  const usable = i => !i.shut && !i.live && !i.time && i.tag !== 'textarea' && !(walker.writtenItem && walker.writtenItem(i, after));
  const all = shows(after), items = all.filter(usable);
  const bad = new Set(all.filter(i => !usable(i)).map(i => pnorm(i.text)));
  const lines = items.filter(i => i.kind === 'text').map(i => i.text), labels = items.filter(i => i.kind !== 'text').map(i => i.text);
  const heads = (after.headings || []).filter(h => !bad.has(pnorm(h)));
  // The page's own words before its frame's: what most of the app's screens show, or only its nav, header or aside.
  const framed = t => { const n = pnorm(t), at = all.filter(i => pnorm(i.text) === n); return frame.has(n) || (at.length > 0 && at.every(i => i.nav)); };
  const ranked = [
    ...heads.filter(t => count(t) >= 2 && t.length < 70),
    ...lines.filter(t => count(t) >= 2 && t.length < 70),
    ...labels.filter(t => count(t) >= 2 && t.length < 70),
    ...[...lines, ...labels].filter(t => t.length >= 70).map(t => lead(t)).filter(t => count(t) >= 3),
    ...[...heads, ...lines, ...labels].filter(t => count(t) === 1 && t.length >= 4),
  ];
  const ctlOk = c => !c.shut && !c.live && !c.time && c.name && c.name.length < 70;
  const hit = s.target && walker.control ? walker.control(after, s.target) : null;
  const controls = [...new Set([hit && hit.el, ...(after.controls || [])].filter(Boolean))].filter(ctlOk);
  const l0 = s.lands || {};
  const own = l0.kind ? Object.fromEntries(Object.entries(l0).filter(([k]) => k !== 'screen')) : l0.text ? { kind: 'words', text: l0.text } : null;
  const gone = s.kind !== 'app' && from && fromApp === app ? stillFor(after, before, frame, stable) : null;

  for (const digits of [false, true]) {
    // A number in what nearly all the site's screens show (its name: "Microsoft 365") doesn't change from screen to screen.
    const fine = t => stable(t) && (digits || !numbered(t) || frame.always.has(pnorm(t)));
    const pick = l => textsOf(l).every(fine) && proves(l);
    const found = l => ({ lands: l, number: textsOf(l).some(t => numbered(t) && !frame.always.has(pnorm(t))) });
    // The plan's own proof, while it still proves the step.
    if (own && pick(own)) return found(own);
    for (const mine of [true, false]) for (const t of ranked) if ((!mine || !framed(t)) && pick({ kind: 'words', text: t })) return found({ kind: 'words', text: t });
    for (const c of controls) { const st = stateOf(c); if (st && pick({ kind: 'control', control: c.name, state: st })) return found({ kind: 'control', control: c.name, state: st }); }
    for (const c of controls) if (c.editable && c.value && pick({ kind: 'box', box: c.name, says: lead(c.value, 40) })) return found({ kind: 'box', box: c.name, says: lead(c.value, 40) });
    for (const mine of [true, false]) for (const c of controls) if ((!mine || !(frame.has(pnorm(c.name)) || c.nav)) && pick({ kind: 'control', control: c.name, state: null })) return found({ kind: 'control', control: c.name, state: null });
    if (gone) for (const x of goneFrom(before[0], after)) if (pick({ kind: 'gone', gone: x, still: gone })) return found({ kind: 'gone', gone: x, still: gone });
  }
  return none(`nothing on ${to} tells it from the screen before`);
}

// Typing: the start of its own words, in the page's words when it's an editable area (they show there), else as what
// the box says. When the recorded screen has other words in that box, the step says so (Differs): the recording can't
// show these.
function typing(s, from, after, before, walker) {
  const own = lead(s.value);
  if (!own) return null;
  const r = from && walker.recorded ? walker.recorded(from, s) : null, field = r && r.control;
  const seen = before.some(b => pageWords(b).includes(pnorm(own)));
  const lands = field && field.editable === 'content' && !seen ? { kind: 'words', text: own } : field && field.name ? { kind: 'box', box: field.name, says: own } : null;
  if (!lands) return null;
  // Other words in that box on the recorded screen, and not these anywhere: the recording can't show this step.
  const box = field.name && holds(after, lands) === false ? (after.controls || []).find(c => c.editable && c.value && pnorm(c.name) === pnorm(field.name)) : null;
  const was = box && box.value;
  const differs = was && !pnorm(was).startsWith(pnorm(own)) ? `the recording has “${lead(was, 50)}${was.length > lead(was, 50).length ? '…' : ''}” typed here` : null;
  return { lands, number: false, differs };
}

// Words that show the page is still the one it was, with only something closed: the page's own (not its frame: a nav,
// an aside, its header), a heading first, no number, on the screen before and after, and not also in its frame (a
// sidebar that lists the page by the same name proves only that it's still the app).
function stillFor(after, before, frame, stable) {
  const nav = pnorm(shows(after).filter(i => i.nav).map(i => i.text).join('\n'));
  const own = shows(after).filter(i => !i.nav && !i.live && !i.time);
  const ok = t => { const n = pnorm(t); return n.length >= 4 && t.length < 60 && !numbered(t) && stable(t) && !frame.has(n) && !nav.includes(n) && before.every(b => pageWords(b).includes(n)); };
  const heads = own.filter(i => i.role === 'heading').map(i => i.text);
  const short = own.filter(i => count(i.text) >= 2 && count(i.text) <= 4).map(i => i.text);
  const longer = own.filter(i => count(i.text) >= 2 && count(i.text) <= 8).map(i => i.text);
  return [...heads, ...short, ...longer].find(ok) || null;
}
// What the screen before showed that the new one doesn't: its headings, then short lines, then single words.
function goneFrom(b, after) {
  if (!b) return [];
  const words = pageWords(after);
  const its = shows(b).filter(i => !i.live && !i.time && !words.includes(pnorm(i.text)));
  const heads = its.filter(i => i.role === 'heading').map(i => i.text);
  const short = its.filter(i => count(i.text) >= 2 && count(i.text) <= 6 && i.text.length < 70).map(i => i.text);
  const single = its.filter(i => count(i.text) === 1 && i.text.length >= 4).map(i => i.text);
  return [...new Set([...heads, ...short, ...single])];
}

// Every "Lands on" in a plan, in order, each against the screen the plan was on before its step. Its proof is kept
// while it still proves the step; otherwise chooseProof() picks one. A step nothing proves goes on the review's Needs
// you (kind "landing"), and so does one proven by a number (kind "number": it can change).
export function proveLandings(plan, walker, flags = []) {
  if (!walker) return flags;
  const steps = plan.beats.flatMap((b, bi) => b.steps.map(s => [s, bi]));
  const typedAll = [...(walker.typedTexts ? walker.typedTexts() : []), ...steps.map(([s]) => s.kind === 'type' ? s.value : null).filter(Boolean)];
  let cur = null;
  for (const [s, bi] of steps) {
    const to = s.lands && s.lands.screen, from = cur;
    if (!to) continue;
    cur = to;
    if (!walker.screen(to)) continue;
    const r = chooseProof(s, from, to, walker, { typed: typedAll.filter(v => !(s.kind === 'type' && v === s.value)) });
    s.lands = { screen: to, ...r.lands, text: r.lands.kind === 'words' ? r.lands.text : null };
    if (r.differs && !s.differs) s.differs = r.differs;
    const flag = !r.lands.kind ? { kind: 'landing', text: `${formatStep(s)}: ${r.why}, so a run can't tell whether it worked` }
      : r.number ? { kind: 'number', text: `${formatStep(s)}: a run checks it by ${proofWords(r.lands)}, a number that can change` } : null;
    if (flag && !flags.some(f => f.kind === flag.kind && f.text === flag.text && f.at === (s.line || null))) flags.push({ ...flag, beat: bi + 1, line: s.line || null, at: s.line || null });
  }
  return flags;
}
