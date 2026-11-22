import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'scenecast-assets-'));
const demo = join(temp, 'fixture'), raw = join(temp, 'raw');
const binary = process.env.SCENECAST_BIN ? resolve(process.env.SCENECAST_BIN) : resolve('target/debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
// STUNTDOUBLE_PACKS empty: built-in app packs only, never a private pack on this computer.
const env = { ...process.env, REPLICA_RAW: raw, STUNTDOUBLE_PACKS: '' };
const run = (command, args) => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
const files = root => {
  const result = {};
  const visit = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else result[path.slice(root.length + 1).replace(/\\/g, '/')] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return result;
};
try {
  run(binary, ['new', 'fixture', '--dir', temp, '--app', 'app=https://fixture.invalid']);
  for (const dir of ['blobs', 'snaps', 'streams']) mkdirSync(join(raw, dir), { recursive: true });
  const urls = {};
  function blob(url, ext, value) {
    const file = createHash('sha256').update(value).digest('hex').slice(0, 24) + '.' + ext;
    writeFileSync(join(raw, 'blobs', file), value);
    urls[url] = { file };
  }
  blob('https://fixture.invalid/a.css', 'css', '@import "b.css" screen; @font-face{src:url("missing.woff2")} .a{background:url(img.svg);content:"</style"}');
  blob('https://fixture.invalid/b.css', 'css', '.b{background:url("img.svg")}');
  blob('https://fixture.invalid/img.svg', 'svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(join(raw, 'urls.json'), JSON.stringify(urls));
  writeFileSync(join(raw, 'snaps', 'start.json'), JSON.stringify({ docs: [{
    key: 'main', parent: null, frameUrl: '', urls: ['https://fixture.invalid/a.css', 'https://fixture.invalid/img.svg', 'https://fixture.invalid/missing.css'],
    inline: { canvas1: 'data:image/svg+xml,%3Csvg%3E' },
    meta: { title: 'Fixture', url: 'https://fixture.invalid/', viewport: { w: 800, h: 600, dpr: 1 }, colorScheme: 'light', customElements: [] },
    html: '<!doctype html><html><head><style data-d1-fetch="d1res://0"></style><style data-d1-fetch="d1res://2"></style></head><body focusgroup="x" style="appearance:slider-vertical"><div>replace this</div><img src="d1res://1"><canvas data-d1-canvas="canvas1"></canvas><iframe sandbox="" csp="" src="d1frame://f1"></iframe><iframe src="d1frame://f9"></iframe></body></html>',
  }, {
    // A GitHub page in a frame: the github app pack's build rules apply to it by its own URL (the staff toggle goes).
    key: 'f1', parent: 'main', frameUrl: 'https://github.com/o/r', urls: [], inline: {},
    meta: { title: 'Frame', url: 'https://github.com/o/r', viewport: { w: 800, h: 600, dpr: 1 }, colorScheme: 'light', customElements: [] },
    html: '<!doctype html><html><body>Frame<form class="js-stats-toggle">staff</form></body></html>',
  }] }));
  writeFileSync(join(raw, 'snaps', 'part.json'), JSON.stringify({ docs: [{
    key: 'main', parent: null, frameUrl: '', urls: [], inline: {},
    meta: { title: 'Part', url: 'https://fixture.invalid/', viewport: { w: 800, h: 600, dpr: 1 }, colorScheme: 'light', customElements: [] },
    html: '<!doctype html><html><head><style>.card{animation:spin 1s}.root-123{color:green}@media screen{.card{color:red}.other{color:blue}}@keyframes spin{from{opacity:0}to{opacity:1}}</style></head><body><div class="card root-123">source part</div></body></html>',
  }] }));
  mkdirSync(join(raw, 'streams', 's1'));
  for (const n of [0, 1]) writeFileSync(join(raw, 'streams', 's1', `${n}.json`), JSON.stringify({
    n, t: n * 100, urls: ['https://fixture.invalid/img.svg'], inline: { canvas1: 'data:image/svg+xml,%3Csvg%3E' },
    html: '<body focusgroup="x" style="appearance:slider-vertical"><div><div>replace this</div></div><img src="d1res://0"><canvas data-d1-canvas="canvas1"></canvas></body>',
  }));
  const ops = [
    { kind: 'remove', restTag: 'span', restText: '', path: [0] },
    { kind: 'attr', set: { style: 'color:red;--anchor:a' }, was: { style: 'color:red;--anchor:b' }, path: [0] },
    { kind: 'attr', set: { style: 'display:block' }, was: { style: 'display:none' }, path: [0] },
  ];
  for (const dir of ['page', 'click-page']) mkdirSync(join(raw, 'hovers', dir), { recursive: true });
  writeFileSync(join(raw, 'hovers', 'page', '0.json'), JSON.stringify({
    n: 0, kind: 'send-hover', cand: { text: 'Trigger' }, parts: [], urls: [], inline: {}, firstMs: 100,
    viewport: [800, 600], res: { anchor: { sel: 'button', text: 'Trigger' }, anchorRect: { w: 20, h: 20 }, ops },
  }));
  writeFileSync(join(raw, 'hovers', 'click-page', '0.json'), JSON.stringify({
    n: 0, kind: 'click', cand: { text: 'Trigger' }, ctl: { spec: { sel: 'button' }, rect: {}, attrs: {} },
    parts: [], urls: [], inline: {}, restore: 'again', res: { up: 1, anchorTag: 'div', ops },
  }));
  writeFileSync(join(demo, 'recording.json'), JSON.stringify({
    states: { start: { app: 'app', snap: 'start' }, part: { app: 'app', snap: 'part' } },
    streams: { s1: { to: 'start', frames: [0, 1] } },
    beats: [{ label: 'Start', active: 'app', states: { app: 'start' } }],
  }));
  writeFileSync(join(demo, 'flow.overrides.mjs'), `export default flow => {
    flow.compose = [{ from: 'part', marker: 'source part', tag: 'div', anchor: 'replace this' }];
    flow.apps[0].layout.responsive = [{ part: { css: '<body[ >]', up: 0 }, variant: 'part' }];
    flow.hoverPages = [{ page: 'page', app: 'app', base: 'start' }];
    flow.clickPages = [{ page: 'page', app: 'app', base: 'start' }];
  };\n`);
  run(process.execPath, ['packages/core/compile/flow.mjs', '--demo', demo]);
  run(process.execPath, ['packages/capture/process.mjs', '--demo', demo, '--force']);
  const before = Object.fromEntries(['snaps', 'streams', 'assets'].map(dir => [dir, files(join(demo, 'data', dir))]));
  run(binary, ['build', '--demo', demo, '--force']);
  const after = Object.fromEntries(['snaps', 'streams', 'assets'].map(dir => [dir, files(join(demo, 'data', dir))]));
  assert.deepEqual(after, before);
  assert.match(readFileSync(join(demo, 'data', 'snaps', 'start.html'), 'utf8'), /data-d1-compose=""[^]*@keyframes spin/);
  assert.match(readFileSync(join(demo, 'data', 'streams', 's1', '000.html'), 'utf8'), /<div><div class="card root-123">source part<\/div><\/div>/);
  assert.match(readFileSync(join(demo, 'data', 'snaps', 'part.html'), 'utf8'), /class="card d1v-root-123"/);
  assert.equal(readFileSync(join(demo, 'data', 'snaps', 'start.f1.html'), 'utf8'), '<!doctype html><html><body>Frame</body></html>');
  const interactions = JSON.parse(readFileSync(join(demo, 'data', 'snaps', 'hovers-app.json'), 'utf8'));
  assert.equal(interactions.defs[0].ops.length, 1);
  assert.equal(interactions.clicks[0].ops.length, 1);
  console.log('Rust asset and CSS resolution matches the JavaScript capture processor');

  // The build's caches (the scrub's, by content; the fingerprints) change nothing: a build that finds everything in
  // them, and one after a capture changed, are byte for byte what a clean --force build with no cache makes.
  const output = dir => {
    const out = { ...files(join(dir, 'data')), 'manifest.json': readFileSync(join(dir, 'manifest.json')).toString('base64'), 'flow.json': readFileSync(join(dir, 'flow.json')).toString('base64'), 'scrub.json': readFileSync(join(dir, '.out', 'scrub.json')).toString('base64') };
    // build.json says when it was built, how long it took and what changed since the build before.
    const { at, ms, changed, ...rest } = JSON.parse(readFileSync(join(dir, 'data', 'build.json'), 'utf8'));
    out['build.json'] = JSON.stringify(rest);
    return out;
  };
  const clean = (label, extra = {}) => {
    const copy = join(temp, label);
    cpSync(demo, copy, { recursive: true, filter: f => !/[\\/](data|\.out)$|manifest\.json$/.test(f) });
    const r = spawnSync(binary, ['build', '--demo', copy, '--force'], { env: { ...env, SCENECAST_SCRUB_CACHE: 'off', ...extra }, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return output(copy);
  };
  run(binary, ['build', '--demo', demo]);
  assert.ok(readFileSync(join(demo, '.out', 'scrub-cache.txt'), 'utf8').split('\n').length > 5, 'the scrub cache is kept');
  assert.deepEqual(output(demo), clean('clean-1'), 'everything from the cache: as a clean build');
  const snap = join(raw, 'snaps', 'part.json');
  writeFileSync(snap, readFileSync(snap, 'utf8').replace('source part', 'source part, again'));
  run(binary, ['build', '--demo', demo]);
  assert.match(readFileSync(join(demo, 'data', 'snaps', 'start.html'), 'utf8'), /source part, again/);
  assert.deepEqual(output(demo), clean('clean-2'), 'one capture changed: as a clean build');
  // A token planted in a capture is caught whether the capture is new or its content was scanned before, the same as
  // without the cache.
  const token = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
  const findings = r => JSON.parse(readFileSync(join(r, '.out', 'scrub.json'), 'utf8')).findings.filter(f => f.credential).map(f => `${f.source} ${f.file} ${f.kind}`).sort();
  const stops = (dir, extra = {}) => spawnSync(binary, ['build', '--demo', dir], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 }).status;
  writeFileSync(join(raw, 'snaps', 'leak.json'), JSON.stringify({ docs: [], note: token }));
  assert.equal(stops(demo), 1, 'a new capture with a token stops the build');
  const caught = findings(demo);
  assert.ok(caught.some(f => f === 'raw snaps/leak.json github-token'), caught.join('; '));
  assert.equal(stops(demo), 1, 'and again, from the cache');
  assert.deepEqual(findings(demo), caught);
  assert.equal(stops(demo, { SCENECAST_SCRUB_CACHE: 'off' }), 1);
  assert.deepEqual(findings(demo), caught, 'the same findings without the cache');
  rmSync(join(raw, 'snaps', 'leak.json'));
  console.log('cached builds match a clean build byte for byte, and planted tokens are still caught');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
