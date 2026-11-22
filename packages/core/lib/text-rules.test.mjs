import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overrides } from './text-rules.mjs';
import { elementEnd } from '@stuntdouble/capture/compose.mjs';

test('text rules: visible text across tags, a drop, a raw swap; leftovers per rule from one text index', () => {
  const R = overrides([{ text: ['Nov 12', 'Dec 3'] }, { drop: 'Draft' }, { raw: ['PO-1', 'PO-9'] }, { text: ['Kestrel', 'Northwind'] }], { elementEnd });
  const out = R.html('<p>Ship <b>Nov</b> 12 Draft for PO-1</p>', 'teams-start');
  assert.equal(out, '<p>Ship <b>Dec 3</b> for PO-9</p>');
  assert.deepEqual(R.unused(), ['text: Kestrel']);
  assert.deepEqual(R.leftovers('<p>Nov 12 and Draft, PO-1, Kestrel</p>', 'teams-start'), ['Nov 12', 'Draft', 'PO-1', 'Kestrel']);
});

test('text rules: a streamed frame cut mid-phrase gets the start of the new text', () => {
  const R = overrides([{ text: ['shipment is late by two weeks', 'order ships on time'] }], { elementEnd });
  const frame = R.html('<p>The shipment is late</p>', 'stream:answer', { partial: true });
  assert.ok(!frame.includes('late'), frame);
});
