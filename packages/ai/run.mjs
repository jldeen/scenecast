// What the three modes share: the recorder (through its receiver, exactly as `scenecast cmd` reaches it), the page
// outline, waiting for the recorder to settle, and the presenter: questions and confirmations shown in the app,
// answered there (an answer file the app writes: .out/ai/answers/<id>.json), and a stop file.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { send } from '@stuntdouble/capture/cli.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const aiDir = demo => join(demo.out, 'ai');

export function rx(demo) {
  const port = process.env.REPLICA_RX_PORT || demo.cfg.receiverPort;
  return async (op, args = {}, tmo = 120) => {
    const r = await send({ op, ...args }, tmo, port);
    if (!r.ok) throw new Error(`${op}: ${String(r.error).split('\n')[0]}`);
    if (r.value && r.value.error) throw new Error(`${op}: ${r.value.error}`);
    return r.value;
  };
}

export const appTab = (demo, id) => { const a = demo.cfg.apps.find(x => x.id === id); return a ? a.match || a.url : null; };

export async function observe(cmd, demo, app, opts) {
  return cmd('observe', { tab: appTab(demo, app), opts }, 30);
}

// Until the recorder has captured what the last action changed: not busy, nothing being typed, twice in a row.
export async function settled(cmd, { maxS = 600, on } = {}) {
  await sleep(400);
  let ok = 0, last = null;
  const t0 = Date.now();
  while (Date.now() - t0 < maxS * 1000) {
    const s = await cmd('recordStatus', {}, 30);
    last = s;
    if (on) on(s);
    if (!s.recording) return s;
    if (!s.busy && !(s.typing || []).length) { if (++ok >= 2) return s; } else ok = 0;
    await sleep(300);
  }
  throw new Error(`the recorder was still busy after ${maxS} s (${JSON.stringify(last && last.side || '')})`);
}

// The presenter, through the app. ask() emits the question and waits for the answer file (or a line on stdin:
// "<id> <answer> [text]", for a terminal). stopped() is true once the presenter pressed Stop.
export function presenter(demo, emit) {
  const dir = join(aiDir(demo), 'answers');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  const stopFile = join(aiDir(demo), 'stop');
  rmSync(stopFile, { force: true });
  const typed = {};
  if (!process.stdin.isTTY) {
    let buf = '';
    process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const m = /^(\S+)\s+(\S+)\s*(.*)$/.exec(l); if (m) typed[m[1]] = { answer: m[2], text: m[3] || undefined }; } });
    process.stdin.on('error', () => {});
  }
  let n = 0;
  return {
    stopped: () => existsSync(stopFile),
    async ask(kind, data) {
      const id = `q${++n}`;
      emit({ event: kind, id, ...data });
      for (;;) {
        if (existsSync(stopFile)) return { answer: 'stop' };
        const f = join(dir, id + '.json');
        if (existsSync(f)) { try { const a = JSON.parse(readFileSync(f, 'utf8')); emit({ event: 'answered', id, answer: a.answer }); return a; } catch (e) {} }
        if (typed[id]) { emit({ event: 'answered', id, answer: typed[id].answer }); return typed[id]; }
        await sleep(250);
      }
    },
  };
}

// For the app and tests: answer a question, or stop.
export function answer(demo, id, a) {
  const dir = join(aiDir(demo), 'answers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id + '.tmp'), JSON.stringify(a));
  renameSync(join(dir, id + '.tmp'), join(dir, id + '.json'));
}
export function stop(demo) { mkdirSync(aiDir(demo), { recursive: true }); writeFileSync(join(aiDir(demo), 'stop'), '1'); }

// What the recorder captured: each screen's words, headings and dialog, from the raw snapshots.
export function screenOf(demo, rec, state) {
  const st = rec.states[state];
  if (!st) return null;
  let html = '';
  try { const s = JSON.parse(readFileSync(join(demo.raw, 'snaps', st.snap + '.json'), 'utf8')); html = (s.docs.find(d => d.key === 'main') || s.docs[0] || {}).html || ''; } catch (e) {}
  return pageText(html, st.title);
}
export function pageText(html, title) {
  const body = String(html).replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const strip = s => s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|ul|ol|h\d|tr|td|section|article|header|footer|nav|main|aside|button|a|label|dt|dd)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const headings = [...body.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => strip(m[1]).replace(/\s+/g, ' ')).filter(Boolean).slice(0, 12);
  const d = /<[^>]+role="(?:alert)?dialog"[^>]*>([\s\S]*?)<\/(?:div|section|aside)>/i.exec(body);
  const dialog = d ? (/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(d[1]) || [])[1] : null;
  return { title: title || '', headings, dialog: dialog ? strip(dialog).replace(/\s+/g, ' ') : null, text: strip(body).slice(0, 6000) };
}

// What an action is called, from the recorder's matcher for it.
export function nameOfSpec(m) {
  if (!m) return '';
  if (m.text) return m.text;
  const a = /\[aria-label="([^"]+)"\]/.exec(m.sel || '') || /\[(?:placeholder|aria-placeholder|data-placeholder|title|name)="([^"]+)"\]/.exec(m.sel || '');
  if (a) return a[1];
  if (m.textStarts) return m.textStarts + '…';
  return m.sel || '';
}
