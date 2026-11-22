import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows, childrenOf, assetSubstitute, applyFixesToFlow, refOf, refResolver, patchKey } from './patches.mjs';
import { fontFamilyName } from './rules.mjs';
import { labFont } from '../../../examples/fixture-app/lab-assets.mjs';

test('rows: the other capture\'s rows are added once, keyed by place, with their resources renumbered', () => {
  const row = (y, img) => `<div class="r" style="transform:translateY(${y}px)">${img ? `<img src="d1res://${img}">` : ''}T${y}</div>`;
  const doc = { html: `<div class="list"><div class="inner" style="height:400px">${row(0)}${row(32)}</div></div><p>after</p>`, urls: ['https://x/a.png'] };
  const from = { html: `<div class="inner" style="height:400px">${row(0)}${row(32)}${row(64, 1)}${row(96)}</div>`, urls: ['https://x/a.png', 'https://x/b.png'] };
  const { doc: out, added } = mergeRows(doc, from, 'class="inner"');
  assert.equal(added, 2);
  assert.deepEqual(childrenOf(out.html, 'class="inner"').kids.map(k => /translateY\((\d+)/.exec(k.tag)[1]), ['0', '32', '64', '96']);
  assert.ok(out.html.endsWith('</div></div><p>after</p>'));
  assert.ok(out.html.includes('<img src="d1res://1">T64') && out.urls[1] === 'https://x/b.png');
  assert.equal(mergeRows(out, from, 'class="inner"').added, 0);
});

test('asset: only an unusable capture is pointed at the same resource from another URL', () => {
  const urls = { 'https://x/hero.png?once=1': {}, 'https://x/hero.png': {}, 'https://x/other.png?once=2': {} };
  const usable = u => !u.includes('once');
  const sub = assetSubstitute([{ kind: 'asset', path: 'https://x/hero.png', use: refOf('https://x/hero.png') }], usable, refResolver(urls));
  assert.equal(sub('https://x/hero.png?once=1'), 'https://x/hero.png');
  assert.equal(sub('https://x/other.png?once=2'), 'https://x/other.png?once=2');
  assert.equal(sub('https://x/hero.png'), 'https://x/hero.png');
  assert.ok(!JSON.stringify(refOf('https://x/hero.png?sig=secret')).includes('secret'), 'a ref never holds the query');
});

test('flow: layout and click fixes land where the player and build read them; hand edits run after', () => {
  const flow = { apps: [{ id: 'a', layout: {} }], clickPages: [{ app: 'a', page: 'p', css: ['x'] }] };
  const patches = [
    { kind: 'pin', app: 'a', el: '.c', anchor: '.slot' }, { kind: 'pin', app: 'a', el: '.c', anchor: '.slot' },
    { kind: 'set', app: 'a', sel: '.pane', style: { height: 'calc(100vh + -54px)' } },
    { kind: 'clickCss', app: 'a', page: 'p', name: 'More', from: ['y'] },
    { kind: 'font', app: 'a', family: 'F', weight: '400', style: 'normal', src: { ref: 'r' } },
    { kind: 'screenshot', app: 'a' },
  ];
  applyFixesToFlow(flow, { patches });
  assert.deepEqual(flow.apps[0].layout.pin, [{ el: '.c', anchor: '.slot' }]);
  assert.deepEqual(flow.apps[0].layout.set, [{ sel: '.pane', style: { height: 'calc(100vh + -54px)' } }]);
  assert.deepEqual(flow.clickPages[0].css, ['x', 'y']);
  assert.deepEqual(flow.fixes.map(p => p.kind), ['font']);
  assert.notEqual(patchKey(patches[0]), patchKey(patches[2]));
});

test('fonts: a font file\'s family from its name table', () => {
  assert.equal(fontFamilyName(labFont('Lab Blocks')), 'Lab Blocks');
  assert.equal(fontFamilyName(Buffer.from('wOF2 not parsed')), null);
});
