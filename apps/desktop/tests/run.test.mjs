// Copilot's run in a separate browser, as the Record screen shows it (ui/run.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNow, makeAfterRun } from '../ui/run.js';

test('the run panel says what the run is doing now, and that it stopped, as soon as it does', () => {
  const step = { seq: 2, event: 'step', data: { n: 4, of: 39, text: 'Press Enter' } };
  assert.equal(runNow({ events: [step], stages: [{ seq: 1, label: 'Starting the recording' }] }), 'Step 4 of 39: Press Enter');
  // A stop, then saving and putting the demo back: never "Step 4 of 39" again.
  const stopped = { seq: 3, event: 'stopped', data: { why: 'Press Enter: "Kestrel" isn\u2019t on the screen', at: { beat: 1, step: 2, text: 'Press Enter' } } };
  const j = { events: [step, stopped], stages: [{ seq: 1, label: 'Starting the recording' }, { seq: 4, label: 'Putting the demo back as it started' }] };
  assert.equal(runNow(j), 'Stopped: Beat 2, Press Enter: "Kestrel" isn\u2019t on the screen. Putting the demo back as it started\u2026');
  // A stage after the last step (saving the recording at the end) is what it's doing.
  assert.equal(runNow({ events: [step], stages: [{ seq: 5, label: 'Saving the recording' }] }), 'Saving the recording');
});

test('a run that stopped part way never replaces a replica the demo already has', () => {
  const stopped = { stopped: { why: 'x' }, summary: { states: 5 } }, done = { summary: { states: 25 } };
  assert.equal(makeAfterRun(stopped, { away: true, built: true }), false);
  assert.equal(makeAfterRun(stopped, { away: true, built: false }), true);
  assert.equal(makeAfterRun(done, { away: true, built: true }), true);
  assert.equal(makeAfterRun({ stopped: { why: 'x' }, summary: { states: 0 } }, { away: true, built: false }), false);
});
