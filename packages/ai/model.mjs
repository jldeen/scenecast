// The model behind the three AI modes, pluggable: GitHub Copilot (the presenter's own sign-in: copilot.mjs), or
// the deterministic stand-in (stub.mjs) every test runs on, with no network and no account. A demo or a test can
// also plug in its own: SCENECAST_AI_MODEL=<file.mjs> exporting ask(task, input).
//
// Tasks, each a JSON answer:
//   plan    { goal, source, apps: [{ id, url, outline }] }        → { title, beats: [{ title, steps: [str], say: [str] }] }
//   adapt   { goal, step, beat, app, outline, tried }               → { do: str } | { ask: str } | { skip: str }
//   next    { goal, done: [str], app, outline }                     → { step: str|null, say: str|null }
//   script  { title, goal, beats: [{ app, actions, screen }] }     → { title, beats: [{ title, do, lines: [str] }] }
//   script-plan { script, apps, screens: [{ id, app, title, headings, controls, moves }] }
//                                                                   → { beats: [{ n, lines: [{ id, steps: [str], point }] }] }
//
// Only what a task needs leaves the computer: the goal, the plan, and for the screen at hand its controls (role and
// name) and, unless the presenter turned it off (Settings → Copilot: "Send page text"), its words. Email addresses,
// IDs, tokens and URL queries are taken out first, and every request is written to the demo's .out/ai/sent/ so the
// presenter can see exactly what was sent.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as stub from './stub.mjs';

export function redact(s) {
  return String(s ?? '')
    .replace(/https?:\/\/[^\s"'<>)]+/g, u => { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return u; } })
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, '[token]')
    .replace(/\b(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}\b/g, '[token]');
}

// The screen, as sent: controls by role and name; headings; the open dialog; and the words, if allowed.
export function compactOutline(o, { pageText = true } = {}) {
  if (!o) return null;
  return {
    title: redact(o.title), url: redact(o.url),
    controls: (o.items || []).map(it => `[${it.i}] ${it.role} "${redact(it.name)}"${it.multiline ? ' (multi-line field)' : it.editable ? ' (field)' : ''}${it.focused ? ' (focused)' : ''}${it.expanded === false ? ' (collapsed)' : it.expanded ? ' (expanded)' : ''}${it.disabled ? ' (disabled)' : ''}`),
    headings: (o.headings || []).map(redact),
    dialog: o.dialog ? redact(o.dialog) : null,
    ...(pageText ? { text: redact(o.text || '').slice(0, 3500) } : {}),
  };
}

const RULES = `You help a presenter record a live demo of a web app. You never invent what isn't on screen. Steps are in plain words, one action each, exactly in these forms:
Go to <app id> | Click "<name of a control on screen>" | Hover over "<name>" | Type "<text>" in "<field name>" | Press Enter | Press Escape | Wait for the answer | Scroll down | You: <something only the presenter can do>
Answer with one JSON object and nothing else.`;
export const SYSTEM = {
  plan: `${RULES}
Draft the demo plan from the presenter's goal and material and the apps' start screens: a few beats (2–6), each a short story moment with its steps and one to three lines for the presenter to say (plain, first person, no hype). Use the controls' names as they appear. After a question is sent to an AI assistant, add "Wait for the answer". Prefer read-only and draft actions; never plan to delete, buy or change settings.
JSON: {"title": str, "beats": [{"title": str, "steps": [str], "say": [str]}]}`,
  adapt: `${RULES}
A step of the plan doesn't fit the screen as it is. Say what to do instead (one step, using a control that is on this screen), or ask the presenter a short question, or skip the step if it's already done or not needed.
JSON: {"do": str} or {"ask": str} or {"skip": str}`,
  next: `${RULES}
The presenter is clicking through the demo themselves. Suggest the very next step toward the goal from what's on screen now, and the line to say while doing it. If the goal is done, step is null.
JSON: {"step": str|null, "say": str|null}`,
  'script-plan': `You turn a presenter's talk track into the steps of her demo, on screens that were recorded before. You never invent a control: every Click, Hover and Type uses a control that a screen lists.
Input: "script" has her beats in order. Each line is what she says ("say"), with what she does ("do") and what's on screen ("screen") when her script says so. "prompts" are the exact words she types. "apps" are the apps, each with the screen it starts on. "screens" are the recorded screens: each one's app, title, headings, controls, and "moves" (a recorded step on that screen, then the screen it leads to after "→"), and "words" when the presenter allows them (what it shows, line by line; "opened": what its step lists show once the step named in "by" opens them). "beats", when given, are the demo's beats as its replica has them: the app and screen each one opens (her script's ⌥ keys and → go to them).
Each app keeps its own screen: "Go to <app id>" shows that app where it was left (its start screen the first time). From a screen, a move's step leads to the screen after "→"; a control that isn't in a move stays on the same screen. "Beat <n>" opens beat n's app on its screen.
For every line, in order: "steps" are what she does before or while saying it (often none), so that the screen the line is about is showing when she says it. A line's "draft" is the steps found for it from her words, on these screens, and "issues" what didn't fit: keep the draft's steps that fit, fix the ones an issue is about, and add what the line needs that the draft doesn't have. Use her "do" and "screen" words when the line or its beat has them: her clicks, in her order, with the controls' names as the screens give them. When her script doesn't say what to click, choose the recorded moves that reach the screens her lines talk about, in the order she tells the story. Type a prompt with its exact words from "prompts" ("Type \"…\" in \"<field>\""), then "Press Enter", then "Wait for the answer" when an answer comes in. A field with words recorded in it: "Type in \"<field>\"". The boxes of a form: "Fill each box".
"point" is up to three things the line talks about, on the screen showing when she says it (a line said before its steps: the screen before them), in the order she says them. Each is a control's name, a heading or, when a screen has "words", the words on it that state what she says: the phrase or one sentence with the fact itself (the date, number, name or step she means, even when she says it in other words), copied exactly. Things she lists or names together are one point: "texts", one entry each. Without words, a short phrase of her own will do.
Steps, exactly in these forms: Go to <app id> | Beat <n> | Click "<control>" | Hover over "<control>" | Type "<text>" in "<field>" | Type in "<field>" | Fill each box | Press Enter | Press Escape | Wait for the answer | Scroll down | Scroll up | You: <what only she can do>
JSON: {"beats": [{"n": <beat n>, "lines": [{"id": "<line id>", "steps": [str], "point": [{"text": str, "screen": str} or {"texts": [str, str], "screen": str}]}]}]}`,
  script: `You write a presenter's talk track for a recorded web demo, from what actually happened. The input has the demo's beats in order; each beat starts on a screen ("starts": how it got there, its headings and words, and "answer": what an AI assistant just streamed in, if anything), then lists what the presenter did on it ("then": each action and what it showed). Write exactly one output beat per input beat, in the same order: a short title, "do" (what the presenter clicks or types in that beat, plainly) and one to three lines to say over that beat's screens. Plain, warm, first person; short sentences people can say out loud. When a line states a fact, number or name, use the screen's own words for it, so the line can be matched to that screen. Don't claim anything the screens don't show. If a plan is given, keep its intent and wording where the screens agree.
JSON: {"title": str, "beats": [{"title": str, "do": str, "lines": [str]}]}`,
};

function parseJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('the answer was not JSON: ' + t.slice(0, 200));
}

// cacheDir: answers kept by what was asked (the task, its instructions, the input and the model), so asking the same
// thing again sends nothing. stats: how many questions went to the model, how many came from the cache, and how long
// the model took.
// cacheOnly: answer from the cache or not at all (evaluations that mustn't ask again).
export async function makeModel({ kind, sentDir, settings = {}, on = () => {}, cacheDir = null, timeoutMs, cacheOnly = false } = {}) {
  kind = kind || process.env.SCENECAST_AI_MODEL || 'copilot';
  let custom = null;
  if (kind !== 'copilot' && kind !== 'stub') custom = await import(pathToFileURL(resolve(kind)).href);
  let n = 0;
  if (sentDir) { mkdirSync(sentDir, { recursive: true }); n = readdirSync(sentDir).length; }
  const prompts = { pageText: settings.pageText !== false };
  const stats = { calls: 0, cached: 0, ms: 0, sentChars: 0, gotChars: 0 };
  return {
    kind: custom ? 'custom' : kind,
    stats,
    async ask(task, input) {
      const sent = JSON.stringify(input, null, 1);
      const key = cacheDir ? createHash('sha256').update(JSON.stringify([task, SYSTEM[task] || '', sent, kind, settings.model || 'auto'])).digest('hex').slice(0, 32) : null;
      const cached = key && join(cacheDir, `${task}-${key}.json`);
      if (cached && existsSync(cached)) { stats.cached++; on({ event: 'cached', task, file: cached }); return JSON.parse(readFileSync(cached, 'utf8')).answer; }
      if (cacheOnly) throw new Error('not in the cache');
      const keep = answer => { if (cached && answer != null) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cached, JSON.stringify({ task, at: new Date().toISOString(), answer }, null, 1)); } return answer; };
      const record = { task, model: kind === 'copilot' ? `copilot (${settings.model || 'auto'})` : kind, at: new Date().toISOString(), pageText: prompts.pageText, system: SYSTEM[task], prompt: sent };
      let file = null;
      if (sentDir) { file = join(sentDir, `${String(++n).padStart(3, '0')}-${task}.json`); writeFileSync(file, JSON.stringify(record, null, 1)); }
      on({ event: 'sent', task, file, chars: sent.length });
      if (custom) return keep(await custom.ask(task, input));
      if (kind === 'stub') return stub.ask(task, input);
      const { ask } = await import('./copilot.mjs');
      let last;
      for (let i = 0; i < 2; i++) {
        stats.calls++; stats.sentChars += sent.length;
        const t1 = Date.now();
        const text = await ask({ system: SYSTEM[task], prompt: i ? sent + '\n\nAnswer with the JSON object only.' : sent, model: settings.model, ...(timeoutMs ? { timeoutMs } : {}) });
        stats.ms += Date.now() - t1; stats.gotChars += String(text || '').length;
        try { return keep(parseJson(text)); } catch (e) { last = e; }
      }
      throw last;
    },
  };
}
