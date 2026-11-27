// Where a step lands, proven (docs/engine/plan-format.md, "What proves a step"): what a run checks after each step,
// chosen from the recording and checked against it the way a run checks the live page. Rules-only plans, Copilot's
// (after its answer is grounded) and walkthroughs all go through proveLandings(); the offline walker checks with holds().
import { formatStep } from './plan.mjs';
import { answerLike } from './check-script.mjs';

// Compared the way a run compares: lowercased, quotes and invisible characters out, spaces as one.
export const pnorm = s => String(s == null ? '' : s).toLowerCase().replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '').replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim();
// Not on the screen as a run reads it (innerText): in a closed dialog or a template, in a tooltip (shown only while its
// control is hovered), or in a row a capture put back (a list that shows only the rows in view: a live page doesn't
// have it until it's scrolled to). Nor what she leaves out of the replica (left: reset.md's Leave out, which the capture
// browser filters before the page draws it). Never a proof, before a step or after it.
export const unseen = x => !!(x && (x.shut || x.tip || x.restored || x.left));
// What her Leave out takes from a screen (reset.md: a line's words in quotes, for its app): a list's row that has them
// in its words or in a control named for one thing (under 80 characters: not a tree's "Teams and channels …", named by
// everything under it), and all that's in the row; outside a list, the words or the control themselves. → a copy with
// those marked left, or the screen itself when there's none.
export function leftOut(sc, values) {
  if (!sc || !(values || []).length) return sc;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = values.map(pnorm).filter(Boolean).map(v => new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc(v)}(?:$|[^\\p{L}\\p{N}])`, 'u'));
  const hit = t => !!t && res.some(re => re.test(pnorm(t)));
  const rows = new Set(), lone = new Set(), at = x => `${x.list}|${x.row}`;
  for (const i of sc.items || []) if (hit(i.text)) (i.row !== undefined ? rows.add(at(i)) : lone.add(i));
  for (const c of sc.controls || []) if (c.name && c.name.length < 80 && hit(c.name)) (c.row !== undefined ? rows.add(at(c)) : lone.add(c));
  if (!rows.size && !lone.size) return sc;
  const left = x => lone.has(x) || (x.row !== undefined && rows.has(at(x)));
  return { ...sc, items: (sc.items || []).map(i => left(i) ? { ...i, left: true } : i), controls: (sc.controls || []).map(c => left(c) ? { ...c, left: true } : c) };
}
// A screen's words as a run reads the page (innerText, every frame): not what's unseen, not a text area's.
const shows = sc => ((sc && sc.items) || []).filter(i => !unseen(i) && i.tag !== 'textarea');
const read = new WeakMap();
export const pageWords = sc => { if (!sc) return ''; if (!read.has(sc)) read.set(sc, pnorm(shows(sc).map(i => i.text).join('\n'))); return read.get(sc); };
const STATE = { selected: c => c.selected === true, open: c => c.expanded === true, on: c => c.on === true || c.pressed === true, off: c => c.on === false || c.pressed === false };
const stateOf = c => Object.keys(STATE).find(k => STATE[k](c)) || null;
// A box you type in: an editable control, or a text box, search box or combo box.
export const isBox = c => !!c.editable || /^(textbox|searchbox|combobox)$/.test(c.role || '');

// Whether a proof holds on a screen as the reader read it: true or false, or null when there's nothing to check.
export function holds(sc, l) {
  if (!sc || !l || !l.kind) return null;
  const words = pageWords(sc), has = t => !!pnorm(t) && words.includes(pnorm(t));
  const named = n => (sc.controls || []).filter(c => !unseen(c) && pnorm(c.name) === pnorm(n));
  if (l.kind === 'words') return has(l.text);
  if (l.kind === 'control') return named(l.control).some(c => !l.state || (STATE[l.state] || (() => false))(c));
  if (l.kind === 'box') return named(l.box).some(c => isBox(c) && pnorm(c.value).startsWith(pnorm(l.says)));
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
// a long number, a shortcut's keys, someone's presence.
const VOLATILE = /\d+(?:[.,]\d+)?\s?(?:ms|s|secs?|seconds?|mins?|minutes?|hrs?|hours?|kb|mb|gb)\b|\bago\b|\bjust now\b|\b\d{1,2}:\d{2}\b|\d{8,}/i;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE = new RegExp(`\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+${MONTH}(?![a-z])|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');
// A shortcut's keys differ between a Mac and a Windows PC (⌘⇧B, Ctrl+Shift+B).
const KEYS = /[⌘⌥⇧⌃]|\b(?:ctrl|cmd|alt|shift|option)\s*\+/i;
// Someone's presence ("Your profile, status Available"): it's whatever they're set to when the page is read.
const PRESENCE = /\b(?:status|presence)\b[\s:,-]*(?:is\s+|set to\s+)?(?:available|away|busy|do not disturb|be right back|appear(?:ing)? (?:offline|away)|offline|in a (?:meeting|call)|on a call|presenting|out of (?:the )?office|focusing|inactive)\b|\b(?:do not disturb|be right back)\b/i;
export const presence = t => PRESENCE.test(String(t || ''));
export const changes = t => VOLATILE.test(t) || DATE.test(t) || KEYS.test(t) || PRESENCE.test(t);

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
// The site's pages, to tell a screen's page from the others: each address on its host (as the frame's), with all its
// screens' words and control names. → { own: its address, pages: Map(address → { words: [text], controls: Set }) }
const sites = new WeakMap();
function siteOf(walker, to) {
  let m = sites.get(walker);
  if (!m) sites.set(walker, m = new Map());
  const url = id => (walker.view && (walker.view(id) || {}).url) || null, host = hostOf(url(to));
  if (!host) return null;
  if (!m.has(host)) {
    const pages = new Map();
    for (const id of walker.states) {
      const sc = hostOf(url(id)) === host && walker.screen(id);
      if (!sc) continue;
      const k = String(url(id)).split('#')[0], p = pages.get(k) || { words: [], controls: new Set() };
      p.words.push(pageWords(sc));
      for (const c of sc.controls || []) if (!unseen(c)) p.controls.add(pnorm(c.name));
      pages.set(k, p);
    }
    m.set(host, pages);
  }
  return { own: String(url(to)).split('#')[0], pages: m.get(host) };
}
// A number that can change: not one in a name that only identifies (#2, PO-1001).
const numbered = t => /\d/.test(String(t).replace(/#\d+\b|\b[a-z]{1,6}-\d{2,}\b/gi, ''));
// A skip link ("Skip to main content"): the app's chrome, on every one of its pages, not what the page says.
const SKIP = /^skip (?:to|navigation|nav)\b/i;
// Words that show only inside a message (an article: a chat message, a post, a comment), where a run can't tell the
// app's words from what Copilot wrote (a review comment's heading): every innermost item holding them is in one.
const within = (b, a) => !!(a.box && b.box) && a.box[0] < b.box[0] && b.box[2] <= a.box[2];
function inMessage(sc, t) {
  const n = pnorm(t);
  if (!sc || !n) return false;
  const its = shows(sc).filter(i => pnorm(i.text).includes(n)), inner = its.filter(a => !its.some(b => b !== a && within(b, a)));
  return inner.length > 0 && inner.every(i => i.article !== undefined);
}
// A write its app pack names (`· pack:write` on its Writes line) and checks, read-only, after it runs: a run proves
// that write by the pack's check (packs: make.mjs loadPacks()'s).
export const packChecked = packs => s => {
  const m = / · ([\w.-]+):([\w.-]+)$/.exec((s && s.writes) || '');
  const p = m && packs && Object.values(packs.forApp || {}).find(x => x && x.id === m[1]);
  return !!(p && (p.writes || []).some(w => w.id === m[2] && w.check));
};

// The proof for one step, from the screen before it (`from`; for "Go to X", where the plan was) to the one it lands on
// (`to`). In this order, words without a number first, then with one (flagged): the control the plan's next step
// clicks, when it's in a live region (an approval card); words the new screen shows that the one before didn't; a
// control's state; what a box says; a control only the new screen has; words gone, with words of the page's own still
// there. Words that show only inside a message (a chat message, a post, a comment) come after all of those (message). A Type step: its own words. typed: what other steps type (never a proof). next: the plan's next step that
// acts on the page (not a wait or a scroll). first: proofs to try right after the plan's own, by the same rules.
// live (reground.mjs): the step's screen as the product shows it today (afters: its reads, once the page was quiet)
// and the screen before it today (befores). The proof is chosen from today's first read; it must hold on every read
// and on the recording, and on none of the screens before, the recording's or today's. With live.only, today's alone:
// the product changed since the recording. live.unstable: words today's reads can't count on.
// → { lands: { kind, … }, number, message, differs, why }: lands.kind is null when nothing proves the step, and `why`
// says so.
// answer: the screen is what a write in this beat made (a prompt's answer, a save's card). A plan's proof there is never
// the words the app wrote (a sentence, a quoted name: they change from run to run), so a run on another day finds it.
export function chooseProof(s, from, to, walker, { typed = [], next = null, live = null, first = [], answer = false } = {}) {
  const rec = walker.screen(to);
  const recBefore = from ? [walker.screen(from), walker.shown(from)].filter(Boolean) : [];
  const reads = live ? (live.afters || []).filter(Boolean) : [], readsBefore = live ? (live.befores || []).filter(Boolean) : [];
  const after = live ? reads[0] : rec;
  const afters = live ? [...(live.only || !rec ? [] : [rec]), ...reads] : [rec];
  const before = live ? [...(live.only ? [] : recBefore), ...readsBefore] : recBefore;
  const none = why => ({ lands: { kind: null, text: null }, why });
  if (!after) return none(`there's no screen ${to}`);
  const app = (walker.flow.states[to] || {}).app, fromApp = from && (walker.flow.states[from] || {}).app;
  const frame = frameOf(walker, app);
  // Another step's words: what it types, a stretch of it (four words or more), or words holding the start of a
  // sentence it types (a search term inside other words is only a word on the page).
  const typedIn = t => { const n = pnorm(t); return n.length > 1 && typed.some(v => { const m = pnorm(v); return !!m && (n === m || (m.includes(n) && (count(n) >= 4 || n.length >= 25)) || (count(m) >= 4 && n.includes(m.slice(0, 24)))); }); };
  const stable = t => !!t && /[a-z]/i.test(t) && !GREETING.test(String(t).trim()) && !changes(t) && !(walker.written && walker.written(t)) && !(walker.unstable && walker.unstable(t, app)) && !(live && live.unstable && live.unstable(t)) && !typedIn(t);
  const proves = l => afters.every(sc => holds(sc, l) === true) && before.every(b => holds(b, l) === false);

  if (s.kind === 'type' && s.value) {
    const r = typing(s, from, after, before, walker, live && { reads, befores: readsBefore });
    if (r) return r;
  }
  if (from && from === to) return none('it lands where it already was');
  if (!pageWords(after) && !(after.controls || []).length) return none(`the screen it lands on (${to}) has no words`);

  // Today's words alone can't be told from Copilot's (the recording's streams show what it wrote): never a message's.
  const usableOn = sc => i => !unseen(i) && !i.live && !i.time && i.tag !== 'textarea' && !(walker.writtenItem && walker.writtenItem(i, sc)) && !(live && live.only && i.article !== undefined);
  const usable = usableOn(after);
  const all = shows(after), items = all.filter(usable);
  // What a proof reads must come from words a run can count on, not only from a toast, a time or Copilot's words.
  const sound = sc => pnorm(shows(sc).filter(usableOn(sc)).map(i => i.text).join('\n'));
  const soundAfters = afters.map(sound);
  const soundBefores = (live ? [live.only ? null : recBefore[0], readsBefore[0]] : [before[0]]).filter(Boolean).map(sound);
  const soundCtl = (sc, n) => (sc.controls || []).some(c => !unseen(c) && !c.live && !c.time && pnorm(c.name) === pnorm(n));
  const fromSound = l => l.kind === 'words' ? soundAfters.every(w => w.includes(pnorm(l.text)))
    : l.kind === 'control' || l.kind === 'box' ? afters.every(sc => soundCtl(sc, l.kind === 'box' ? l.box : l.control))
    : l.kind === 'gone' ? soundAfters.every(w => w.includes(pnorm(l.still))) && soundBefores.length > 0 && soundBefores.every(w => w.includes(pnorm(l.gone))) : false;
  const bad = new Set(all.filter(i => !usable(i)).map(i => pnorm(i.text)));
  const lines = items.filter(i => i.kind === 'text').map(i => i.text), labels = items.filter(i => i.kind !== 'text').map(i => i.text);
  const heads = (after.headings || []).filter(h => !bad.has(pnorm(h)));
  // The page's own words before its frame's: what most of the app's screens show, or only its nav, header or aside.
  const framed = t => { const n = pnorm(t), at = all.filter(i => pnorm(i.text) === n); return frame.has(n) || SKIP.test(t) || (at.length > 0 && at.every(i => i.nav)); };
  const ranked = [
    ...heads.filter(t => count(t) >= 2 && t.length < 70),
    ...lines.filter(t => count(t) >= 2 && t.length < 70),
    ...labels.filter(t => count(t) >= 2 && t.length < 70),
    ...[...lines, ...labels].filter(t => t.length >= 70).map(t => lead(t)).filter(t => count(t) >= 3),
    ...[...heads, ...lines, ...labels].filter(t => count(t) === 1 && t.length >= 4),
  ];
  const ctlOk = c => !unseen(c) && !c.live && !c.time && c.name && c.name.length < 70;
  const hit = s.target && walker.control ? walker.control(after, s.target) : null;
  const controls = [...new Set([hit && hit.el, ...(after.controls || [])].filter(Boolean))].filter(ctlOk);
  const l0 = s.lands || {};
  const own = l0.kind ? Object.fromEntries(Object.entries(l0).filter(([k]) => k !== 'screen')) : l0.text ? { kind: 'words', text: l0.text } : null;
  // Words gone: within one app, from the screen before (live, with no recording, the page as it was before the step).
  // Its `still`: the page's own words, outside a message first.
  const goneOk = s.kind !== 'app' && !!((from && fromApp === app) || (live && live.only && !from && readsBefore.length));
  const gone = goneOk ? stillFor(after, before, frame, stable) : null;
  const stillEarly = !goneOk ? null : gone && !inMessage(after, gone) ? gone : stillFor(after, before, frame, t => stable(t) && !inMessage(after, t));
  // A control in a live region proves a step only when the plan's next step clicks it (the same name, and its role
  // when the step gives one): that step needs exactly it. Live-region words never do.
  const nextHit = next && next.kind === 'click' && next.target && walker.control ? walker.control(after, next.target, undefined, to) : null;
  const nextCtl = nextHit && nextHit.el && nextHit.el.live && !unseen(nextHit.el) && !nextHit.el.time && pnorm(nextHit.el.name) === pnorm(next.target) && (!next.role || nextHit.el.role === next.role) ? nextHit.el : null;

  // Words only inside a message come last, after every other proof (late), and say so (message).
  const goneBefore = readsBefore[0] || before[0];
  const msgOf = l => l.kind === 'words' ? inMessage(after, l.text) : l.kind === 'gone' ? inMessage(after, l.still) || inMessage(goneBefore, l.gone) : false;
  const r = (() => {
    for (const late of [false, true]) for (const digits of [false, true]) {
      // A number in what nearly all the site's screens show (its name: "Microsoft 365") doesn't change from screen to screen.
      const fine = t => stable(t) && (digits || !numbered(t) || frame.always.has(pnorm(t)));
      const pick = l => msgOf(l) === late && textsOf(l).every(fine) && fromSound(l) && proves(l) && !(answer && l.kind === 'words' && answerLike(l.text));
      const found = l => ({ lands: l, number: textsOf(l).some(t => numbered(t) && !frame.always.has(pnorm(t))), message: late });
      // The plan's own proof, while it still proves the step.
      if (own && pick(own)) return found(own);
      // What the caller expects first (liveProof: the step's own control in a new state, the next step's control).
      for (const f of first) if (pick(f)) return found(f);
      if (nextCtl && !late) { const l = { kind: 'control', control: nextCtl.name, state: null }; if (textsOf(l).every(fine) && proves(l)) return found(l); }
      // Where an app starts: the page's own box (its message or search box) before any words, which may be a banner's
      // or a drop zone's ("Drop your files here") and not there on another day.
      if (s.kind === 'app') for (const c of controls) if (isBox(c) && !c.nav && pick({ kind: 'control', control: c.name, state: null })) return found({ kind: 'control', control: c.name, state: null });
      for (const mine of [true, false]) for (const t of ranked) if ((!mine || !framed(t)) && pick({ kind: 'words', text: t })) return found({ kind: 'words', text: t });
      for (const c of controls) { const st = stateOf(c); if (st && pick({ kind: 'control', control: c.name, state: st })) return found({ kind: 'control', control: c.name, state: st }); }
      for (const c of controls) if (isBox(c) && c.value && pick({ kind: 'box', box: c.name, says: lead(c.value, 40) })) return found({ kind: 'box', box: c.name, says: lead(c.value, 40) });
      for (const mine of [true, false]) for (const c of controls) if ((!mine || !(frame.has(pnorm(c.name)) || c.nav)) && pick({ kind: 'control', control: c.name, state: null })) return found({ kind: 'control', control: c.name, state: null });
      const still = late ? gone : stillEarly;
      if (still) for (const x of goneFrom(goneBefore, after)) if (pick({ kind: 'gone', gone: x, still })) return found({ kind: 'gone', gone: x, still });
    }
    return none(`nothing on ${to} tells it from the screen before`);
  })();
  return s.kind === 'app' && r.lands.kind ? whichPage(r, { walker, to, ranked, stable, frame, fromSound, proves, msgOf }) : r;
}

// A Go to step lands on one page of its site: when other pages show its proof too ("Status and details" is on every
// pull request's page), words its page names itself by (in its title: the pull request's) that none of them show come
// first, in the same order, when there are some.
const wordsOf = t => new Set(pnorm(t).split(/[^a-z0-9]+/).filter(Boolean));
function whichPage(r, { walker, to, ranked, stable, frame, fromSound, proves, msgOf }) {
  const site = siteOf(walker, to), title = (walker.screen(to) || {}).title;
  if (!site || site.pages.size < 2 || !title) return r;
  const shows = (p, l) => l.kind === 'words' ? p.words.some(w => w.includes(pnorm(l.text))) : l.kind === 'control' ? p.controls.has(pnorm(l.control)) : false;
  const also = [...site.pages].filter(([k, p]) => k !== site.own && shows(p, r.lands)).map(([, p]) => p);
  if (!also.length) return r;
  const named = wordsOf(title), names = t => { const w = wordsOf(t); return w.size > 0 && [...w].every(x => named.has(x)); };
  for (const digits of r.number ? [false, true] : [false]) {
    const fine = t => stable(t) && (digits || !numbered(t) || frame.always.has(pnorm(t)));
    for (const t of ranked) {
      const l = { kind: 'words', text: t };
      if (names(t) && fine(t) && !msgOf(l) && fromSound(l) && proves(l) && !also.some(p => shows(p, l))) return { lands: l, number: numbered(t) && !frame.always.has(pnorm(t)), message: false };
    }
  }
  return r;
}

// Typing: the start of its own words, in the page's words when it's an editable area (they show there), else as what
// the box says. When the recorded screen has other words in that box, the step says so (Differs): the recording can't
// show these. live: today's reads after it, and before it: the proof is what they show it typed, in the box the
// recording names, else in the box that has it now; the recording may have other words there.
function typing(s, from, after, before, walker, live = null) {
  const own = lead(s.value);
  if (!own) return null;
  const r = from && walker.recorded ? walker.recorded(from, s) : null, field = r && r.control;
  const seen = before.some(b => pageWords(b).includes(pnorm(own)));
  let lands = field && field.editable === 'content' && !seen ? { kind: 'words', text: own } : field && field.name ? { kind: 'box', box: field.name, says: own } : null;
  if (live) {
    const shown = l => !!l && live.reads.every(sc => holds(sc, l) === true) && live.befores.every(b => holds(b, l) === false);
    if (!shown(lands)) { const c = (after.controls || []).find(x => isBox(x) && !unseen(x) && x.name && pnorm(x.value).startsWith(pnorm(own))); lands = c ? { kind: 'box', box: c.name, says: own } : null; }
    if (!shown(lands)) lands = !seen && shown({ kind: 'words', text: own }) ? { kind: 'words', text: own } : null;
    return lands ? { lands, number: false, differs: null } : null;
  }
  if (!lands) return null;
  // Other words in that box on the recorded screen, or typed in another box, and not these anywhere: the recording
  // can't show this step.
  const typedIn = holds(after, lands) === false ? (after.controls || []).filter(c => isBox(c) && c.value) : [];
  const box = typedIn.find(c => field.name && pnorm(c.name) === pnorm(field.name)), other = !box && typedIn.find(c => pnorm(c.value).startsWith(pnorm(own)));
  const said = t => `“${lead(t, 50)}${t.length > lead(t, 50).length ? '…' : ''}”`;
  const differs = box && !pnorm(box.value).startsWith(pnorm(own)) ? `the recording has ${said(box.value)} typed here`
    : other ? `the recording typed it in “${other.name}”` : null;
  return { lands, number: false, differs };
}

// Words that show the page is still the one it was, with only something closed: the page's own (not its frame: a nav,
// an aside, its header, a skip link), a heading first, no number, on the screen before and after, and not also in its
// frame (a sidebar that lists the page by the same name proves only that it's still the app).
function stillFor(after, before, frame, stable) {
  const nav = pnorm(shows(after).filter(i => i.nav).map(i => i.text).join('\n'));
  const own = shows(after).filter(i => !i.nav && !i.live && !i.time);
  const ok = t => { const n = pnorm(t); return n.length >= 4 && t.length < 60 && !numbered(t) && !SKIP.test(t) && stable(t) && !frame.has(n) && !nav.includes(n) && before.every(b => pageWords(b).includes(n)); };
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
// you (kind "landing"), and so does one proven by a number (kind "number": it can change), or only by words in a
// message (kind "message"), unless it's a write its app pack checks (checked: packChecked(packs)): a run proves that
// by the pack's check.
export function proveLandings(plan, walker, flags = [], { checked = null } = {}) {
  if (!walker) return flags;
  const steps = plan.beats.flatMap((b, bi) => b.steps.map(s => [s, bi]));
  const typedAll = [...(walker.typedTexts ? walker.typedTexts() : []), ...steps.map(([s]) => s.kind === 'type' ? s.value : null).filter(Boolean)];
  let cur = null, wrote = -1;
  for (const [k, [s, bi]] of steps.entries()) {
    if (s.writes) wrote = bi;
    const to = s.lands && s.lands.screen, from = cur;
    if (!to) continue;
    cur = to;
    if (!walker.screen(to)) continue;
    const next = (steps.slice(k + 1).find(([x]) => !/^(wait|scroll)$/.test(x.kind)) || [])[0] || null;
    const r = chooseProof(s, from, to, walker, { typed: typedAll.filter(v => !(s.kind === 'type' && v === s.value)), next, answer: wrote === bi });
    s.lands = { screen: to, ...r.lands, text: r.lands.kind === 'words' ? r.lands.text : null };
    if (r.differs && !s.differs) s.differs = r.differs;
    const flag = !r.lands.kind ? { kind: 'landing', text: `${formatStep(s)}: ${r.why}, so a run can't tell whether it worked` }
      : r.message && !(checked && checked(s)) ? { kind: 'message', text: `${formatStep(s)}: a run checks it by ${proofWords(r.lands)}, words inside a message, which can be different on another run` }
      : r.number ? { kind: 'number', text: `${formatStep(s)}: a run checks it by ${proofWords(r.lands)}, a number that can change` } : null;
    if (flag && !flags.some(f => f.kind === flag.kind && f.text === flag.text && f.at === (s.line || null))) flags.push({ ...flag, beat: bi + 1, line: s.line || null, at: s.line || null });
  }
  return flags;
}

// With no recording behind a step: nothing recorded to compare with (no frame, no other captures), and a control found
// by its exact name.
// A greeting ("Hi, try asking me to recap a meeting", "Good morning, Jessica", "Welcome back, Jessica"): an app picks
// another on each visit, so a run can't count on it, even where the recording caught only one. A product's own fixed
// heading ("Welcome to Contoso Admin") isn't one.
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|welcome back)\b/i;
const NONE = { screen: () => null, shown: () => null, flow: { states: {} }, states: [],
  control: (sc, name) => { const el = ((sc && sc.controls) || []).find(c => !unseen(c) && pnorm(c.name) === pnorm(name)); return el ? { el, score: 100 } : null; } };
const sameProof = (a, b) => !!a && !!b && a.kind === b.kind && (a.state || null) === (b.state || null) && textsOf(a).map(pnorm).join('\n') === textsOf(b).map(pnorm).join('\n');

// A step's landing proven on the live page (docs/engine/plan-format.md, "What runs on its own"), with or without a
// recording: before, the page before the step, and afters, its reads after it once the page is quiet (two, about a
// second apart), each as the reader reads it. The plan's own proof while it holds there; else what the plan expects
// (the step's own control in a new state, the next step's control), else the first proof the page gives, by
// chooseProof's rules. The exclusions apply to all of them, the plan's own words included: never Copilot's words,
// another step's typing, a time or a live region's words. walker: the recording when there is one (its frame, what
// Copilot wrote, the words its captures show differently), never its screens. next: the plan's next step that acts.
// → { lands, strength, why }, strength:
//   strong  the plan's own proof; the step's own control in its new state (the tab it clicked selected, a menu it
//           opened, "Show more X" now "Show less X", what it typed in its box); or the control the plan's next step
//           needs, there now
//   weak    the page changed, in a way the plan doesn't name (new words, another control, words gone), or by a number
//   none    nothing a run can count on changed
export function liveProof(s, { before = [], afters = [], next = null, typed = [], walker = null } = {}) {
  const screen = (s.lands && s.lands.screen) || null, reads = afters.filter(Boolean);
  if (!reads.length) return { lands: { screen, kind: null, text: null }, strength: 'none', why: "the page after it wasn't read" };
  const states = s.target && s.kind !== 'type' ? Object.keys(STATE).map(state => ({ kind: 'control', control: s.target, state })) : [];
  // A "Show more X" that was clicked is a "Show less X", open (and "Show less X" a "Show more X"): the step's own
  // control in its new state.
  const flip = s.kind === 'click' && /^show (more|less)\b/i.exec(s.target || '');
  const toggled = flip ? [{ kind: 'control', control: s.target.replace(/^(show )(more|less)/i, (m, a, b) => a + ({ more: 'less', less: 'more', More: 'Less', Less: 'More' }[b] || b)), state: /^more$/i.test(flip[1]) ? 'open' : null }] : [];
  const expected = [...states, ...toggled, ...(next && next.target ? [{ kind: 'control', control: next.target, state: null }] : [])];
  const r = chooseProof(s, null, screen, walker || NONE, { typed, next, first: expected, live: { afters: reads, befores: before.filter(Boolean), only: true } });
  const l = r.lands, lands = { screen, ...l, text: l.kind === 'words' ? l.text : null };
  if (!l.kind) return { lands, strength: 'none', why: r.why };
  const own = s.lands && s.lands.kind ? s.lands : s.lands && s.lands.text ? { kind: 'words', text: s.lands.text } : null;
  const is = (a, b) => !!a && !!b && pnorm(a) === pnorm(b);
  const typedOwn = s.kind === 'type' && !!s.value && ((l.kind === 'box' && is(l.says, lead(s.value))) || (l.kind === 'words' && is(l.text, lead(s.value))));
  const strong = sameProof(l, own) || (!r.number && (typedOwn || expected.some(e => sameProof(l, e))));
  return { lands, strength: strong ? 'strong' : 'weak', why: strong ? null : r.number ? `${proofWords(l)}, a number that can change` : `${proofWords(l)}: the page changed, in a way the plan doesn't name` };
}

// Before an unattended run makes a write: whether it goes on (docs/engine/plan-format.md, "What runs on its own").
// landings: the run's so far, in order, each { app, strength, wrote, step }. The write goes on only when the app's
// last landing is strong and nothing in that app since its last write (or since the run began) was weak or unproven.
// Otherwise the run stops before it, keeps a picture and both reads, runs the reset, and lists the step under Needs
// you: once she's away, a run never waits on her. → { ok, why }
export function writeGate(landings, app) {
  const mine = (landings || []).filter(x => x.app === app);
  if (!mine.length) return { ok: false, why: `nothing in ${app} is proven yet` };
  const lastWrite = mine.map(x => !!x.wrote).lastIndexOf(true);
  const last = mine[mine.length - 1], since = mine.slice(lastWrite + 1);
  // "carried": a wait, hover, scroll or step-group expand right after a proven step, on the screen it proved. Right
  // after the last write, that's the write's own landing.
  const scan = !since.length ? [last] : since[0].strength === 'carried' && lastWrite >= 0 ? mine.slice(lastWrite) : since;
  const shaky = scan.find(x => x.strength !== 'strong' && x.strength !== 'carried');
  if (!shaky) return { ok: true, why: null };
  const what = shaky.step ? `“${shaky.step}”` : 'a step';
  return { ok: false, why: `${what} ${shaky.strength === 'weak' ? 'only shows the page changed' : "isn't proven"}${shaky === last || shaky.wrote ? '' : `, since the last write in ${app}`}` };
}
