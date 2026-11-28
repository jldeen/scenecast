import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseLoaded, loadedFace, dataBytes, srcParts, declValue, fontVerdicts } from './fonts.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const face = (family, weight, src) => ({ family, weight, style: 'normal', src });

test('a font the replica carries is a match, however its rule names it: a weight range, inline data, an installed font', () => {
  // A variable font's weight range, as document.fonts names it: the family isn't "Segoe Serif 420".
  assert.deepEqual(parseLoaded('Segoe Serif 420 625 normal'), { family: 'segoe serif', name: 'Segoe Serif', weight: '420 625', style: 'normal' });
  assert.deepEqual(parseLoaded('"Segoe UI" 600 normal'), { family: 'segoe ui', name: 'Segoe UI', weight: '600', style: 'normal' });
  assert.equal(parseLoaded('FabricMDL2Icons-1 normal normal').weight, '400');
  // A family that ends in a number, where the page declares it so; and from the capture's parts, whatever the page declares.
  assert.deepEqual(parseLoaded('Font 2 400 normal', new Set(['font 2'])), { family: 'font 2', name: 'Font 2', weight: '400', style: 'normal' });
  assert.deepEqual(loadedFace({ family: '"Font 2"', weight: '400', style: 'normal' }), { family: 'font 2', name: 'Font 2', weight: '400', style: 'normal' });
  assert.equal(loadedFace({ family: 'Segoe Serif', weight: '420 625', style: 'normal' }).weight, '420 625');
  // Percent-escaped inline data is bytes, whatever they are.
  assert.deepEqual([...dataBytes('data:font/woff,%B4%00ab')], [0xb4, 0, 0x61, 0x62]);

  const woff = Buffer.from('wOFF inline icon font');
  const inline = `url("data:font/woff;charset=utf-8;base64,${woff.toString('base64')}") format("woff")`;
  assert.deepEqual(srcParts(`local("Segoe UI Semibold"), ${inline}`), { data: [sha(woff)], locals: ['segoe ui semibold'] });
  // A quoted argument is read whole: a ) in inline data, a quote in a font's name.
  assert.deepEqual(srcParts(`local("Albert's Font"), url("data:font/woff,wOFF%00)%00") format("woff")`), { data: [sha(Buffer.from([0x77, 0x4f, 0x46, 0x46, 0, 0x29, 0]))], locals: ["albert's font"] });
  assert.equal(declValue('font-family: X; src: url("data:font/woff;base64,AAA") format("woff"), local("a;b"); font-weight: 400', 'src'), 'url("data:font/woff;base64,AAA") format("woff"), local("a;b")');

  const real = [
    // Loaded from a file the replica serves too.
    { family: 'segoe serif', name: 'Segoe Serif', weight: '420 625', style: 'normal', by: 'stylesheet', files: [{ url: 'https://cdn/segoe-serif.woff2', sha256: 'aa' }], candidates: [], data: [], locals: ['segoe serif'] },
    // Carried in the stylesheet itself.
    { family: 'shellfabricmdl2iconslite', name: 'ShellFabricMDL2IconsLite', weight: '400', style: 'normal', by: 'stylesheet', files: [], candidates: [], data: [sha(woff)], locals: [] },
    // Installed on the computer.
    { family: 'segoe ui', name: 'Segoe UI', weight: '600', style: 'normal', by: 'stylesheet', files: [], candidates: [], data: [], locals: ['segoe ui semibold'] },
    // Loaded by script: no rule in the replica.
    { family: 'brand', name: 'Brand', weight: '400', style: 'normal', by: 'script', files: [], candidates: [{ url: 'https://cdn/brand.woff2', sha256: 'bb' }], data: [], locals: [] },
  ];
  const rep = { loaded: [{ family: 'Segoe Serif', weight: '420 625', style: 'normal' }, { family: 'ShellFabricMDL2IconsLite', weight: '400', style: 'normal' }, { family: 'Segoe UI', weight: '600', style: 'normal' }], faces: [
    face('"Segoe Serif"', '420 625', 'local("Segoe Serif"), url("/assets/serif.woff2") format("woff2")'),
    face('ShellFabricMDL2IconsLite', 'normal', inline),
    face('"Segoe UI"', '600', 'local("Segoe UI Semibold")'),
  ] };
  const v = fontVerdicts(real, rep, src => /\/assets\/serif\.woff2/.test(src) ? ['aa'] : []);
  assert.deepEqual(v.map(x => [x.name, x.status]), [['Segoe Serif', 'match'], ['ShellFabricMDL2IconsLite', 'match'], ['Segoe UI', 'match'], ['Brand', 'substituted']]);
  // Inline data that isn't the real page's is another font.
  const other = { ...rep, faces: [face('ShellFabricMDL2IconsLite', 'normal', 'url("data:font/woff;base64,b3RoZXI=")')] };
  assert.equal(fontVerdicts([real[1]], other, () => [])[0].status, 'different-file');
  // An installed font the replica didn't load here isn't shown as the same: it may not be on this computer.
  assert.equal(fontVerdicts([real[2]], { ...rep, loaded: [] }, () => [])[0].status, 'unverified');
});
