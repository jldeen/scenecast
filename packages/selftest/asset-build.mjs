import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'scenecast-assets-'));
const demo = join(temp, 'fixture'), raw = join(temp, 'raw');
const binary = process.env.SCENECAST_BIN ? resolve(process.env.SCENECAST_BIN) : resolve('target/debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
const env = { ...process.env, REPLICA_RAW: raw };
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
    key: 'f1', parent: 'main', frameUrl: 'https://fixture.invalid/frame', urls: [], inline: {},
    meta: { title: 'Frame', url: 'https://fixture.invalid/frame', viewport: { w: 800, h: 600, dpr: 1 }, colorScheme: 'light', customElements: [] },
    html: '<!doctype html><html><body>Frame</body></html>',
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
  writeFileSync(join(demo, 'recording.json'), JSON.stringify({
    states: { start: { app: 'app', snap: 'start' }, part: { app: 'app', snap: 'part' } },
    streams: { s1: { to: 'start', frames: [0, 1] } },
    beats: [{ label: 'Start', active: 'app', states: { app: 'start' } }],
  }));
  writeFileSync(join(demo, 'flow.overrides.mjs'), `export default flow => {
    flow.compose = [{ from: 'part', marker: 'source part', tag: 'div', anchor: 'replace this' }];
    flow.apps[0].layout.responsive = [{ part: { css: '<body[ >]', up: 0 }, variant: 'part' }];
  };\n`);
  run(process.execPath, ['packages/kit/compile/flow.mjs', '--demo', demo]);
  run(process.execPath, ['packages/recorder/process.mjs', '--demo', demo, '--force']);
  const before = Object.fromEntries(['snaps', 'streams', 'assets'].map(dir => [dir, files(join(demo, 'data', dir))]));
  run(binary, ['build', '--demo', demo, '--force']);
  const after = Object.fromEntries(['snaps', 'streams', 'assets'].map(dir => [dir, files(join(demo, 'data', dir))]));
  assert.deepEqual(after, before);
  assert.match(readFileSync(join(demo, 'data', 'snaps', 'start.html'), 'utf8'), /data-d1-compose=""[^]*@keyframes spin/);
  assert.match(readFileSync(join(demo, 'data', 'streams', 's1', '000.html'), 'utf8'), /<div><div class="card root-123">source part<\/div><\/div>/);
  assert.match(readFileSync(join(demo, 'data', 'snaps', 'part.html'), 'utf8'), /class="card d1v-root-123"/);
  console.log('Rust asset and CSS resolution matches the JavaScript capture processor');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
