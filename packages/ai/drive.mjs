// Record for me: the approved plan, run in the presenter's own signed-in browser through the recorder extension (the
// same one that's recording), step by step, while the recorder captures every screen and side state as it would for
// a person. Before each step it reads the screen (the page outline); a control that isn't there is waited for, then
// the model is asked what to do instead, then the presenter. Anything that could send, post, approve, buy, delete or
// change a setting (plan.mjs risk()) waits for the presenter's go-ahead in the app: Do it, I'll click it myself,
// Skip, or Stop. Afterwards: run.json (what was done, on which screen), then the talk track (write.mjs).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseStep, formatStep, risk, stepCount } from './plan.mjs';
import { compactOutline } from './model.mjs';
import { findItem, composer, searchBox } from './find.mjs';
import { recordOpts } from '@stuntdouble/core/lib/demo.mjs';
import { rx, observe, settled, presenter, appTab, aiDir, sleep } from './run.mjs';
import { readPlan, readGoal } from './draft.mjs';

export async function recordForMe({ demo, model, settings = {}, emit = () => {}, cmd: viaCmd }) {
  const plan = readPlan(demo);
  if (!plan || !stepCount(plan)) throw new Error('draft and approve the plan first');
  const goal = readGoal(demo).goal || '';
  const cmd = viaCmd || rx(demo);
  const P = presenter(demo, emit);
  const apps = demo.cfg.apps.map(a => a.id);
  const appOf = name => apps.find(a => a === name) || apps.find(a => a.startsWith(name) || name.startsWith(a)) || null;
  const firstStep = plan.beats.flatMap(b => b.steps)[0];
  let app = firstStep && firstStep.kind === 'app' && appOf(firstStep.app) || apps[0];
  const status0 = await cmd('recordStatus', {}, 30);
  if (status0.recording) throw new Error('the recorder is already recording: stop that recording first');

  emit({ event: 'stage', name: 'start', label: 'Starting the recording' });
  await cmd('recordStart', { apps: demo.cfg.apps.map(a => ({ id: a.id, match: a.match })), record: recordOpts(demo.cfg), zooms: demo.cfg.zooms, first: app }, 300);
  let status = await settled(cmd, { on: s => emit({ event: 'record', status: s }) });
  const wait = async maxS => { status = await settled(cmd, { maxS, on: s => emit({ event: 'record', status: s }) }); return status; };
  let lastField = null;

  const look = async (tries = 1) => {
    let o = null;
    for (let i = 0; i < tries; i++) { o = await observe(cmd, demo, app); if (i < tries - 1) await sleep(700); }
    return o;
  };
  // A control by name, given a few seconds to show up (a pane still opening, a list still loading).
  const locate = async (name, kind) => {
    for (let i = 0; i < 6; i++) {
      const o = await observe(cmd, demo, app);
      const el = kind === 'composer' ? composer(o.items) : findItem(o.items, name, kind);
      if (el) return { el, o };
      if (i < 5) await sleep(800);
    }
    const o = await observe(cmd, demo, app);
    // What was there instead (the control disabled, another of that name), and the recorder's count of input it held
    // back while capturing: for the log when a step can't find its control.
    const like = (o.items || []).filter(it => String(it.name || '').toLowerCase().includes(String(name).toLowerCase())).slice(0, 4);
    const st = await cmd('recordStatus', {}, 30).catch(() => ({}));
    emit({ event: 'note', text: `couldn't find "${name}" (${kind}): ${JSON.stringify(like)}; held back while capturing: ${st.blocked || 0}` });
    return { el: null, o };
  };
  // The page holds each click, Enter or keystroke back until the recorder's loop picks it up and does it for real. On
  // a real app (Nov 20, the admin center: 10 frames) a pass of that loop takes over a second, so "not busy" right
  // after an action didn't mean it was done: the last click was still held when Stop came, and was dropped. Wait for
  // the recorder to count it first.
  // Picked up: counted, or being captured now (a click's new screen is counted only after its side states).
  const actions = async () => (await cmd('recordStatus', {}, 30)).actions || 0;
  const seen = async (before, maxS = 30) => {
    for (let t0 = Date.now(); Date.now() - t0 < maxS * 1000;) { const s = await cmd('recordStatus', {}, 30); if ((s.actions || 0) > before || s.busy || (s.typing || []).length) return true; await sleep(250); }
    emit({ event: 'note', text: `the recorder didn't see that step within ${maxS} s` });
    return false;
  };
  const rawClick = el => cmd('click', { tab: appTab(demo, app), x: el.x, y: el.y }, 60);
  const click = async el => { const before = await actions(); await rawClick(el); await seen(before); };
  // The presenter does it: wait for the recorder to see an action, then for it to settle.
  const byPresenter = async () => {
    const before = status.actions || 0;
    emit({ event: 'waiting', text: 'Your turn: do it in the browser. Recording carries on when the screen settles.' });
    for (let i = 0; i < 3600 && !P.stopped(); i++) { const s = await cmd('recordStatus', {}, 30); if ((s.actions || 0) > before) break; await sleep(500); }
    await wait(900);
    return { did: 'presenter' };
  };
  const confirm = async (step, why) => {
    const a = await P.ask('confirm', { step: formatStep(step), why, app });
    return a.answer;
  };
  const instead = async (step, o, depth, why) => {
    if (depth > 1) return askPresenter(step, why, depth);
    let r = null;
    try { r = await model.ask('adapt', { goal, step: formatStep(step), beat: beatTitle, app, outline: compactOutline(o, settings), why }); } catch (e) { emit({ event: 'note', text: `the AI couldn't help with "${formatStep(step)}": ${e.message}` }); }
    if (r && r.do) { emit({ event: 'adapted', from: formatStep(step), to: r.do }); return run(parseStep(r.do), depth + 1); }
    if (r && r.skip) { emit({ event: 'skipped', step: formatStep(step), why: r.skip }); return { did: 'skipped', why: r.skip }; }
    return askPresenter(step, (r && r.ask) || why, depth);
  };
  const askPresenter = async (step, why, depth) => {
    const a = await P.ask('question', { step: formatStep(step), text: why, app });
    if (a.answer === 'stop') return { stop: true };
    if (a.answer === 'skip') return { did: 'skipped', why: 'the presenter skipped it' };
    if (a.answer === 'done') { await wait(900); return { did: 'presenter' }; }
    if (a.answer === 'self') return byPresenter();
    if (a.answer === 'do' && a.text) return run(parseStep(a.text), depth + 1);
    return { did: 'skipped' };
  };

  async function run(step, depth = 0) {
    switch (step.kind) {
      case 'app': {
        const to = appOf(step.app);
        if (!to) return askPresenter(step, `There's no app called "${step.app}" in this demo (it has ${apps.join(', ')}).`, depth);
        app = to;
        await cmd('front', { tab: appTab(demo, app) }, 30);
        await sleep(300);
        return { did: 'switched' };
      }
      case 'wait': await wait(900); return { did: 'waited' };
      case 'scroll': {
        const o = await look();
        await cmd('wheel', { tab: appTab(demo, app), x: Math.round(o.vw / 2), y: Math.round(o.vh / 2), dy: step.dir === 'up' ? -600 : 600 }, 30);
        await wait(300);
        return { did: 'scrolled' };
      }
      case 'manual': {
        const a = await P.ask('you-do', { step: formatStep(step), text: step.what, app });
        if (a.answer === 'stop') return { stop: true };
        if (a.answer === 'skip') return { did: 'skipped' };
        await wait(900);
        return { did: 'presenter' };
      }
      case 'free': return instead(step, await look(), depth, `"${step.text}" isn't one of the steps I know how to do`);
      case 'click': case 'hover': {
        const { el, o } = await locate(step.target);
        if (!el) return instead(step, o, depth, `I can't find "${step.target}" on this screen`);
        if (step.kind === 'hover') { await cmd('hover', { tab: appTab(demo, app), x: el.x, y: el.y }, 30); await wait(300); return { did: 'hovered', on: el.name }; }
        const why = risk(step, el);
        if (why) {
          const a = await confirm(step, why);
          if (a === 'stop') return { stop: true };
          if (a === 'skip') return { did: 'skipped', why: 'the presenter said no' };
          if (a === 'self') return byPresenter();
        }
        await click(el);
        await wait(900);
        return { did: 'clicked', on: el.name, confirmed: !!why };
      }
      case 'type': {
        let field = null, o = null;
        if (step.target) { ({ el: field, o } = await locate(step.target, 'field')); if (!field) return instead(step, o, depth, `I can't find the "${step.target}" box`); }
        else {
          o = await look();
          field = o.items.find(it => it.focused && (it.editable || /textbox|searchbox|combobox/.test(it.role))) || composer(o.items) || searchBox(o.items);
          if (!field) return instead(step, o, depth, 'there\'s no box to type in on this screen');
        }
        if (!field.focused) { await rawClick(field); await sleep(250); }
        // Typing replaces what's in the box (Copilot keeps an unsent prompt there).
        await cmd('clear', { tab: appTab(demo, app) }, 30).catch(() => {});
        const before = await actions();
        await cmd('type', { tab: appTab(demo, app), text: step.value, delay: 18 }, 120);
        await seen(before, 15);
        lastField = field;
        await wait(120);
        return { did: 'typed', in: field.name };
      }
      case 'press': {
        const o = await look();
        const field = o.items.find(it => it.focused && (it.editable || /textbox|searchbox|combobox/.test(it.role))) || (step.key === 'Enter' ? lastField : null);
        const why = risk(step, null, field);
        if (why) {
          const a = await confirm(step, why);
          if (a === 'stop') return { stop: true };
          if (a === 'skip') return { did: 'skipped', why: 'the presenter said no' };
          if (a === 'self') return byPresenter();
        }
        const before = await actions();
        await cmd('press', { tab: appTab(demo, app), key: step.key }, 30);
        if (/^(Enter|Escape)$/.test(step.key)) await seen(before);
        if (step.key === 'Enter') lastField = null;
        await wait(900);
        return { did: 'pressed', key: step.key, confirmed: !!why };
      }
      default: return { did: 'skipped' };
    }
  }

  const done = [];
  let stopped = false, beatTitle = '';
  const total = stepCount(plan);
  let n = 0;
  outer: for (const [bi, beat] of plan.beats.entries()) {
    beatTitle = beat.title;
    emit({ event: 'beat', beat: bi, title: beat.title });
    for (const [si, step] of beat.steps.entries()) {
      if (P.stopped()) { stopped = true; break outer; }
      emit({ event: 'step', beat: bi, step: si, n: ++n, of: total, text: formatStep(step) });
      let r;
      try { r = await run(step); } catch (e) {
        emit({ event: 'note', text: `"${formatStep(step)}" failed: ${e.message}` });
        r = await askPresenter(step, `That didn't work (${e.message.slice(0, 160)}). Do it yourself and press Done, or skip it.`, 1);
      }
      if (r.stop) { stopped = true; emit({ event: 'step-done', beat: bi, step: si, did: 'stopped' }); break outer; }
      const s = await cmd('recordStatus', {}, 30);
      done.push({ beat: bi, step: si, text: formatStep(step), ...r, app, state: s.states ? s.states[app] : null });
      emit({ event: 'step-done', beat: bi, step: si, ...r, state: s.states ? s.states[app] : null });
    }
  }
  emit({ event: 'stage', name: 'stop', label: 'Saving the recording' });
  const summary = await cmd('recordStop', {}, 600);
  mkdirSync(aiDir(demo), { recursive: true });
  const runInfo = { at: new Date().toISOString(), title: plan.title, goal, stopped, steps: done, beats: plan.beats.map(b => ({ title: b.title, say: b.say })) };
  writeFileSync(join(aiDir(demo), 'run.json'), JSON.stringify(runInfo, null, 1));
  return { summary, steps: done.length, stopped, confirmed: done.filter(d => d.confirmed).length, adapted: done.filter(d => d.did === 'presenter').length };
}
