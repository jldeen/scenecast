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

test('a start check failing stops the run before it starts, said in plain words', () => {
  const lines = [{ text: 'chat: Added doesn\'t list the skill', status: 'wrong' }, { text: 'chat on cop-home: Recent is empty', status: 'cant', why: 'the plan never lands on cop-home', plan: true },
    { text: 'chat: Added lists the skill', status: 'cant', why: 'on the way there, Click "Plugins": it didn\'t land' },
    { text: 'chat: No skill the run saved', status: 'cant', why: 'nothing gives {skill}: the recording or the demo', setup: true }];
  const r = predictStops(PLAN, { ...walk(['reached', 'reached', 'reached', 'write']), check: { wrong: 1, cant: 3, lines } }, { writeKnown: known, names: { chat: 'Chat app' } });
  assert.deepEqual(r.stops.map(s => [s.beat, s.why, s.fix]), [
    [0, 'Before it starts, the demo isn\'t as it should be (Chat app: Added doesn\'t list the skill)', 'Put the demo back as it starts, then check again'],
    [0, 'Before it starts, it can\'t check this with the plan as it is (Chat app: Recent is empty)', 'Make the plan again: its start checks are made with it'],
    // Not the plan's doing: it says why, and making the plan again isn't the fix.
    [0, 'Before it starts, it couldn\'t check this (Chat app: Added lists the skill): on the way there, Click "Plugins": it didn\'t land', 'Open the demo where it starts, then check again'],
    // The check's own (a value, its pack): neither the plan nor the demo's start is the fix.
    [0, 'Before it starts, it can\'t check this (Chat app: No skill the run saved): the demo\'s reset or its app\'s pack doesn\'t say how', 'Fix that check in the demo\'s reset or the app\'s pack (what\'s missing is under Details), then check again']]);
  for (const s of r.stops) assert.doesNotMatch(`${s.why} ${s.fix}`, /reset\.md|\bcant\b|\bwrong\b|cop-home|lands on|\{skill\}/);
  assert.equal(r.stops[1].detail, 'the plan never lands on cop-home');
  assert.equal(r.stops[3].detail, 'nothing gives {skill}: the recording or the demo');
  // Checks that stopped with an error: what happened, a next step, and the error under Details.
  const err = predictStops(PLAN, { ...walk(['reached', 'reached', 'reached', 'write']), check: { error: 'Target page, context or browser has been closed' } }, { writeKnown: known });
  assert.deepEqual([err.stops[0].why, err.stops[0].fix, err.stops[0].detail], ['Before it starts, its checks stopped with an error', 'Check again. If it stops the same way, what went wrong is under Details', 'Target page, context or browser has been closed']);
});

test('her own status stops the run only when it isn\'t what the recording has', () => {
  const ok = walk(['reached', 'reached', 'reached', 'write']);
  assert.deepEqual(predictStops(PLAN, { ...ok, ownStatus: [{ app: 'teams', status: 'Available', expect: ['Available'], ok: true }] }, { writeKnown: known }).stops, []);
  assert.match(predictStops(PLAN, { ...ok, ownStatus: [{ app: 'teams', status: 'Away', expect: ['Available'], ok: false }] }, { writeKnown: known }).stops[0].why, /Away, not Available/);
});

test('a start screen that isn\'t as the plan has it, a write after a miss, and a write proven by the app\'s words all stop', () => {
  const ok = walk(['reached', 'reached', 'reached', 'write']);
  assert.equal(predictStops(PLAN, { ...ok, starts: [{ app: 'chat', ok: false, why: 'its start step "Go to chat": not signed in' }] }, { writeKnown: known, names: { chat: 'Chat app' } }).stops[0].why, 'Chat app isn\'t where the demo starts: its start step "Go to chat": not signed in');
  assert.equal(predictStops(PLAN, { ...ok, starts: [{ app: 'chat', ok: false, why: 'chat isn\'t on its recorded start screen' }] }, { writeKnown: known, names: { chat: 'Chat app' } }).stops[0].why, 'Chat app isn\'t where the demo starts: Chat app isn\'t on its recorded start screen');
  // Beat 2 misses its first click; its write still stops the run.
  const missed = walk([{ status: 'missed', why: 'no "Search"' }, { status: 'after-miss' }, { status: 'after-miss' }, { status: 'after-miss' }].map(x => x.status));
  missed.beats[1].steps[0].why = 'no "Search"';
  const r = predictStops(PLAN, missed, { writeKnown: known });
  assert.deepEqual(r.stops.map(x => [x.beat, x.step]), [[2, 4]]);
  const quoted = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n- Click "Save" — ask first\n  Writes: saves it · chat:save-skill\n  Lands on: chat-saved · "Your skill is saved and ready to use"\n`);
  assert.match(predictStops(quoted, { beats: [{ steps: [{ status: 'reached' }, { status: 'write' }] }] }, { writeKnown: known }).stops[0].why, /words the app makes up/);
  // A send proven by the name the app gave the new chat (the recorded screen's title), or by a greeting.
  const titled = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n- Press Enter — ask first\n  Writes: sends prompt 1 · chat:new-task\n  Lands on: chat-answer · "Kestrel PO-450101 Ship-Date Risk Summary"\n`);
  const sent = { beats: [{ steps: [{ status: 'reached' }, { status: 'write' }] }] };
  const titleOf = id => id === 'chat-answer' ? 'Kestrel PO-450101 Ship-Date Risk Summary' : null;
  assert.deepEqual(predictStops(titled, sent, { writeKnown: known, titleOf }).stops.map(x => [x.beat, x.step, x.fix]), [[1, 2, 'Prove it by a control on that screen, such as its message box']]);
  assert.deepEqual(predictStops(titled, sent, { writeKnown: known }).stops, []);
  // A one-word name is made up too; a title the screen already had before the write isn't.
  const kestrel = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n  Lands on: chat-home · "Chat"\n- Press Enter — ask first\n  Writes: sends prompt 1 · chat:new-task\n  Lands on: chat-answer · "Kestrel"\n`);
  assert.equal(predictStops(kestrel, sent, { writeKnown: known, titleOf: id => id === 'chat-answer' ? 'Kestrel' : 'New chat' }).stops.length, 1);
  // The name as a control's (the new chat's link in Recent) is made up too.
  const linked = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n- Press Enter — ask first\n  Writes: sends prompt 1 · chat:new-task\n  Lands on: chat-answer · control "Kestrel"\n`);
  assert.equal(predictStops(linked, sent, { writeKnown: known, titleOf: id => id === 'chat-answer' ? 'Kestrel PO-450101 Ship-Date Risk Summary' : 'New chat' }).stops.length, 1);
  const fixed = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to notes\n  Lands on: notes-home · "Saved notes"\n- Click "Save" — ask first\n  Writes: saves it · chat:save-skill\n  Lands on: notes-saved · "Saved notes"\n`);
  assert.deepEqual(predictStops(fixed, sent, { writeKnown: known, titleOf: () => 'Saved notes' }).stops, []);
  const hello = parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n- Press Enter — ask first\n  Writes: sends prompt 1 · chat:new-task\n  Lands on: chat-answer · "Good morning"\n`);
  assert.match(predictStops(hello, sent, { writeKnown: known }).stops[0].why, /words the app makes up \("Good morning"\)/);
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

test('a wait after a doubt isn\'t carried: its unproven landing still stops the write after a proven step', () => {
  const text = `# T

## Beat 1 · A

- Go to chat
  Lands on: chat-home · "New chat"
- Click "Plugins"
  Lands on: chat-plugins · "Roles & Industry"
- Wait for the list
- Click "Roles"
  Lands on: chat-roles · "Roles & Industry"
- Click "Turn on" — ask first
  Writes: turns the plugin on · chat:plugin-switch
`;
  const walked = { beats: [{ steps: ['reached', 'drifted', 'unproven', 'reached', 'write'].map(status => ({ status })) }] };
  const r = predictStops(parsePlan(text), walked, { writeKnown: known });
  assert.equal(r.stops.length, 1);
  assert.match(r.stops[0].why, /step 3/);
  // A hover there is proven by its own control in a run, or only marked: no stop.
  assert.deepEqual(predictStops(parsePlan(text.replace('- Wait for the list', '- Hover over "Roles"')), walked, { writeKnown: known }).stops, []);
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
