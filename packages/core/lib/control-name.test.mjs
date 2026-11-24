import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlOf } from './control-name.mjs';

test('one rule for what\'s a control, its role and its name, the same after a trip through toString() (a run sends it to the page)', () => {
  // A small DOM: elements as { tag, attrs, text }, found by id.
  const els = {};
  const el = (tag, attrs = {}, text = '') => { const e = { tag, attrs, text }; if (attrs.id) els[attrs.id] = e; return e; };
  const acc = { tag: e => e.tag, attr: (e, n) => (n in e.attrs ? e.attrs[n] : null), text: e => e.text, byId: id => els[id] || null };
  el('span', { id: 'l1' }, 'Search'); el('span', { id: 'l2' }, 'tools');
  const cases = [
    [el('button', { 'aria-label': 'Close panel' }, 'X'), { control: true, role: 'button', name: 'Close panel' }],
    [el('div', { role: 'tab', 'aria-labelledby': 'l1 l2 nope' }, 'ignored'), { control: true, role: 'tab', name: 'Search tools' }],
    [el('a', { href: '/x' }, '  Share\u200B   Share '), { control: true, role: 'link', name: 'Share' }],
    [el('input', { type: 'search', placeholder: 'Search tools by name', value: 'IQ' }), { control: true, role: 'searchbox', name: 'Search tools by name' }],
    [el('span', { role: 'textbox', contenteditable: 'true', 'aria-label': '' }, 'what was typed'), { control: true, role: 'textbox', name: '' }],
    [el('div', { contenteditable: 'plaintext-only', 'data-placeholder': 'Group title' }, 'what was typed'), { control: true, role: 'textbox', name: 'Group title' }],
    [el('div', { contenteditable: 'false' }, 'Not editable'), { control: false, role: 'div', name: '' }],
    [el('input', { type: 'hidden', value: 'x' }), { control: false, role: 'textbox', name: '' }],
    [el('input', { type: 'Submit', value: 'Go' }), { control: true, role: 'button', name: 'Go' }],
    [el('div', { role: 'row', tabindex: '-1' }, 'Row'), { control: true, role: 'row', name: 'Row' }],
    [el('div', {}, 'Just words'), { control: false, role: 'div', name: '' }],
    [el('summary', {}, Array.from({ length: 60 }, (_, i) => i).join(' ')), { control: true, role: 'button', name: Array.from({ length: 60 }, (_, i) => i).join(' ').slice(0, 90) }],
  ];
  const sent = new Function(`return (${controlOf})`)();
  for (const [e, want] of cases) { assert.deepEqual(controlOf(e, acc), want, JSON.stringify(e)); assert.deepEqual(sent(e, acc), want); }
});
