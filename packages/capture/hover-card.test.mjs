import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMatch, cardNorm, defCard } from './hover-card.mjs';

test("a hover's card: the same words, numbers aside; a built hover's words from its popup or what it adds in place", () => {
  assert.equal(cardNorm('Credits in use,  <b>99%</b> remaining'), 'credits in use, #% remaining');
  assert.ok(cardMatch('Credits in use, 99% remaining', 'credits in use, 12% remaining'));
  assert.ok(!cardMatch('Share', 'Share now'));
  assert.ok(!cardMatch('', ''));
  assert.ok(cardMatch(`Kestrel ship-date change, updated ${'x'.repeat(40)} on Nov 19`, `Kestrel ship-date change, updated ${'x'.repeat(40)} on Nov 25, with more after`));
  // A card whose app moved a line: the same words, in another order, with a date added.
  assert.ok(cardMatch('Credit usage for Cowork 14% remaining • Using credits Credit limits are managed by your admin', 'Credit usage for Cowork Using credits 99% remaining Resets Nov 30 Credit limits are managed by your admin'));
  assert.ok(!cardMatch('Name: Adobe Description: Design, combine, and edit with Adobe pro tools', 'Name: DrugBank Description: Decision-ready biopharma data'));
  assert.ok(!cardMatch('Open the docs', 'Open the docs folder now please'));
  assert.equal(defCard({ portals: [{ text: 'Open the docs' }] }), 'Open the docs');
  assert.equal(defCard({ ops: [{ kind: 'add', html: '<div class="tip">Rename</div>' }, { kind: 'attr', set: { class: 'on' } }] }), 'Rename');
  assert.equal(defCard({ ops: [{ kind: 'attr', set: { class: 'on' } }] }), '');
});
