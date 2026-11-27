import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictStops, answerLike } from './check-script.mjs';
import { parsePlan } from './plan.mjs';

// The shape of a real plan: a prompt, its answer, a save card, then a hover and a scroll in a read-only beat.
const PLAN = parsePlan(`# T

## Beat 1 · Ask

- Go to chat
  Lands on: chat-home · "New chat"
- Type "What does this put at risk?" in "Message"
  Lands on: chat-typed · box "Message" says "What does this put at risk?"
- Press Enter — ask first
  Writes: sends the prompt · chat:new-task
  Lands on: chat-answer · control "Save: Save skill"
- Wait for the answer
- Click "Save: Save skill" — ask first
  Writes: saves the skill · chat:save-skill
  Lands on: chat-saved · "Background task ran for"
- Click "Open triage skill"
  Lands on: chat-skill · control "Show details panel"

## Beat 2 · Look

- Hover over "Search"
- Scroll down
- Click "Plugins"
  Lands on: chat-plugins · "Roles & Industry"
- Click "Turn on" — ask first
  Writes: turns the plugin on · chat:plugin-switch
`);
const walk = (b2, b1 = ['reached', 'reached', 'write', 'after-write', 'after-write', 'after-write']) => ({ beats: [b1, b2].map((st, bi) => ({ beat: bi + 1, steps: st.map((status, si) => ({ step: si, status, why: status === 'unproven' ? 'the plan gives it no proof' : null })) })) });
const known = () => ({ ok: true });

test('a plan whose answer steps prove themselves by controls and the product\'s own phrases has no stops', () => {
  const r = predictStops(PLAN, walk(['reached', 'reached', 'reached', 'write']), { writeKnown: known });
  assert.deepEqual(r.stops, []);
  assert.deepEqual(r.marks, []);
  assert.equal(r.unchecked, 3);
});

test('an unproven click before a write in the same app stops the run at the write; on its own it only marks the beat', () => {
  // The hover carries the screen before it, as a run does; the click has no proof.
  const r = predictStops(PLAN, walk(['unproven', 'reached', 'unproven', 'write']), { writeKnown: known });
  assert.equal(r.stops.length, 1);
  assert.equal(r.stops[0].beat, 2);
  assert.equal(r.stops[0].step, 4);
  assert.match(r.stops[0].why, /step 3/);
  assert.deepEqual(r.marks.map(m => m.step), [3]);
});

test('a step the walk missed only because it needs a write the walk didn\'t run is checked by rule, not a doubt', () => {
  const b2 = [{ status: 'missed', needs: "beat 1's write: Press Enter" }, { status: 'after-miss' }, { status: 'after-miss' }, { status: 'after-miss' }];
  const w = walk([]); w.beats[1].steps = b2;
  const r = predictStops(PLAN, w, { writeKnown: known });
  assert.deepEqual(r.stops, []);
  assert.equal(r.unchecked, 7);
});

test('a proof that quotes the answer, then a write, stops; a write with no pack undo stops', () => {
  const plan = parsePlan(`# T

## Beat 1 · Ask

- Go to chat
- Press Enter — ask first
  Writes: sends the prompt · chat:new-task
- Wait for the answer
  Lands on: chat-answer · "The original Nov 12 date is 6 days away, so anything planned"
- Click "Save: Save skill" — ask first
  Writes: saves the skill · chat:save-skill
  Lands on: chat-saved · "Completed 'Save skill'"
`);
  const r = predictStops(plan, { beats: [{ steps: [{ status: 'reached' }, { status: 'write' }, { status: 'after-write' }, { status: 'after-write' }] }] }, { writeKnown: (p, w) => w === 'save-skill' ? { ok: false, why: 'chat has no save-skill' } : { ok: true } });
  // Its own proof, "Completed 'Save skill'", is the app's words too (what stopped a real run): a third stop.
  assert.deepEqual(r.stops.map(s => s.step), [4, 4, 4]);
  assert.match(r.stops[0].why, /couldn't prove \(step 3/);
  assert.match(r.stops[1].why, /no undo/);
  assert.match(r.stops[2].why, /Completed 'Save skill'/);
  assert.equal(r.marks.length, 2);
});

test('reset.md\'s Check failing stops the run before it starts', () => {
  const r = predictStops(PLAN, { ...walk(['reached', 'reached', 'reached', 'write']), check: { wrong: 1, cant: 0, lines: [{ text: 'Added doesn\'t list the skill', status: 'wrong' }] } }, { writeKnown: known });
  assert.equal(r.stops.length, 1);
  assert.equal(r.stops[0].beat, 0);
});

test('her own status stops the run only when it isn\'t what the recording has', () => {
  const ok = walk(['reached', 'reached', 'reached', 'write']);
  assert.deepEqual(predictStops(PLAN, { ...ok, ownStatus: [{ app: 'teams', status: 'Available', expect: ['Available'], ok: true }] }, { writeKnown: known }).stops, []);
  assert.match(predictStops(PLAN, { ...ok, ownStatus: [{ app: 'teams', status: 'Away', expect: ['Available'], ok: false }] }, { writeKnown: known }).stops[0].why, /Away, not Available/);
});

test('a start screen that isn\'t as the plan has it, a write after a miss, and a write proven by the app\'s words all stop', () => {
  const ok = walk(['reached', 'reached', 'reached', 'write']);
  assert.match(predictStops(PLAN, { ...ok, starts: [{ app: 'chat', ok: false, why: 'its start step "Go to chat": not signed in' }] }, { writeKnown: known }).stops[0].why, /chat's start screen: .*not signed in/);
  // Beat 2 misses its first click; its write still stops the run.
  const missed = walk([{ status: 'missed', why: 'no "Search"' }, { status: 'after-miss' }, { status: 'after-miss' }, { status: 'after-miss' }].map(x => x.status));
  missed.beats[1].steps[0].why = 'no "Search"';
  const r = predictStops(PLAN, missed, { writeKnown: known });
  assert.deepEqual(r.stops.map(x => [x.beat, x.step]), [[2, 4]]);
  const quoted = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n- Click "Save" — ask first\n  Writes: saves it · chat:save-skill\n  Lands on: chat-saved · "Your skill is saved and ready to use"\n`);
  assert.match(predictStops(quoted, { beats: [{ steps: [{ status: 'reached' }, { status: 'write' }] }] }, { writeKnown: known }).stops[0].why, /quotes words the app wrote/);
});

test('answer words and the product\'s own phrases', () => {
  assert.equal(answerLike('Background task ran for'), false);
  assert.equal(answerLike('Roles & Industry'), false);
  assert.equal(answerLike("Completed 'Save skill'"), true);
  assert.equal(answerLike('Your skill is saved and ready to use'), true);
  // Her own words in a box are hers, whatever their length.
  const typed = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n- Type "Turn this investigation into a skill I can reuse." in "Message"\n  Lands on: chat-typed · "Turn this investigation into a skill I can reuse."\n- Press Enter — ask first\n  Writes: sends it · chat:new-task\n`);
  assert.deepEqual(predictStops(typed, { beats: [{ steps: [{ status: 'reached' }, { status: 'reached' }, { status: 'write' }] }] }).marks, []);
});

test('a doubt lasts until the next write: unproven, then reached, then a write still stops at the write', () => {
  const plan = parsePlan(`# T

## Beat 1 · A

- Go to chat
  Lands on: chat-home · "New chat"
- Click "Plugins"
- Click "Roles"
  Lands on: chat-roles · "Roles & Industry"
- Click "Turn on" — ask first
  Writes: turns the plugin on · chat:plugin-switch
`);
  const r = predictStops(plan, { beats: [{ steps: ['reached', 'unproven', 'reached', 'write'].map(status => ({ status })) }] }, { writeKnown: known });
  assert.equal(r.stops.length, 1);
  assert.match(r.stops[0].why, /a write after a step it couldn't prove \(step 2/);
});

test('a drifted or missed step is only marked in a run: a proven step after it clears it before the write', () => {
  const plan = parsePlan(`# T

## Beat 1 · A

- Go to chat
  Lands on: chat-home · "New chat"
- Click "Plugins"
  Lands on: chat-plugins · "Roles & Industry"
- Click "Roles"
  Lands on: chat-roles · "Roles & Industry"
- Click "Turn on" — ask first
  Writes: turns the plugin on · chat:plugin-switch
`);
  for (const miss of ['drifted', 'missed']) {
    const r = predictStops(plan, { beats: [{ steps: ['reached', miss, 'reached', 'write'].map(status => ({ status })) }] }, { writeKnown: known });
    assert.deepEqual(r.stops, [], miss);
    assert.equal(r.marks.length, 1, miss);
  }
});

test('a step that\'s hers to do, or one a run can\'t do, is a stop even with no write after it', () => {
  const plan = parsePlan(`# T

## Beat 1 · A

- Go to chat
  Lands on: chat-home · "New chat"
- You: point at the chart
- Wave at the audience
`);
  const r = predictStops(plan, { beats: [{ steps: ['reached', 'reached', 'reached'].map(status => ({ status })) }] }, { writeKnown: known });
  assert.deepEqual(r.stops.map(s => s.step), [2, 3]);
  assert.equal(r.ok, false);
});
