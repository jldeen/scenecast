import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMatch, cardNorm, defCard } from './hover-card.mjs';

test("a hover's card: the same words, numbers aside; a built hover's words from its popup or what it adds in place", () => {
  assert.equal(cardNorm('Credits in use,  <b>99%</b> remaining'), 'credits in use, #% remaining');
  assert.ok(cardMatch('Credits in use, 99% remaining', 'credits in use, 12% remaining'));
  assert.ok(!cardMatch('Share', 'Share now'));
  assert.ok(!cardMatch('', ''));
  assert.ok(cardMatch(`Kestrel ship-date change, updated ${'x'.repeat(40)} on Nov 19`, `Kestrel ship-date change, updated ${'x'.repeat(40)} on Nov 25, with more after`));
  assert.equal(defCard({ portals: [{ text: 'Open the docs' }] }), 'Open the docs');
  assert.equal(defCard({ ops: [{ kind: 'add', html: '<div class="tip">Rename</div>' }, { kind: 'attr', set: { class: 'on' } }] }), 'Rename');
  assert.equal(defCard({ ops: [{ kind: 'attr', set: { class: 'on' } }] }), '');
});
