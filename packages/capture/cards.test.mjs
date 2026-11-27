import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardIn, shownIn } from './cards.mjs';

const CARD = 'Kestrel Ledger Tracks every shipment, and what it costs. Plugin';
test('a card in a service\'s list: its name where the card starts and its description the rest, whatever the fields are called', () => {
  const body = { value: [{ id: 'p1', displayName: 'Contoso Notes', summary: 'Notes.' }, { id: 'p2', displayName: 'Kestrel Ledger', summary: 'Tracks every shipment, and what it costs.' }] };
  assert.equal(cardIn(body, CARD, { suffix: ' Plugin' }), 'Kestrel Ledger');
  assert.equal(cardIn({ plugins: [{ meta: { title: 'Kestrel  ledger', about: 'Tracks every shipment, and what it costs.' } }] }, CARD, { suffix: ' Plugin' }), 'Kestrel  ledger');
  // Its name alone, or another's description, isn't the card.
  assert.equal(cardIn({ value: [{ displayName: 'Kestrel Ledger', summary: 'Tracks every order.' }] }, CARD, { suffix: ' Plugin' }), null);
  assert.equal(cardIn({ value: [] }, CARD, { suffix: ' Plugin' }), null);
  assert.deepEqual(shownIn(body), ['Contoso Notes', 'Kestrel Ledger']);
  assert.deepEqual(shownIn({ value: [] }), []);
});
