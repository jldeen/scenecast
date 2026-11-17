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
  blob('https://fixture.invalid/a.css', 'css', '@import "b.css" screen; @font-face{src:url("missing.woff2")} .a{background:url(img.svg)}');
  blob('https://fixture.invalid/b.css', 'css', '.b{background:url("img.svg")}');
  blob('https://fixture.invalid/img.svg', 'svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(join(raw, 'urls.json'), JSON.stringify(urls));
  writeFileSync(join(raw, 'snaps', 'start.json'), JSON.stringify({ docs: [{
    key: 'main', parent: null, frameUrl: '', urls: ['https://fixture.invalid/a.css', 'https://fixture.invalid/img.svg'],
    inline: { canvas1: 'data:image/svg+xml,%3Csvg%3E' },
    meta: { title: 'Fixture', url: 'https://fixture.invalid/', viewport: { w: 800, h: 600, dpr: 1 }, colorScheme: 'light', customElements: [] },
    html: '<!doctype html><html><head><style data-d1-fetch="d1res://0"></style></head><body><img src="d1res://1"><canvas data-d1-canvas="canvas1"></canvas></body></html>',
  }] }));
  writeFileSync(join(demo, 'recording.json'), JSON.stringify({
    states: { start: { app: 'app', snap: 'start' } },
    beats: [{ label: 'Start', active: 'app', states: { app: 'start' } }],
  }));
  run(process.execPath, ['packages/kit/compile/flow.mjs', '--demo', demo]);
  run(process.execPath, ['packages/recorder/process.mjs', '--demo', demo, '--force']);
  const before = Object.fromEntries(['snaps', 'streams', 'assets'].map(dir => [dir, files(join(demo, 'data', dir))]));
  run(binary, ['build', '--demo', demo, '--force']);
  const after = Object.fromEntries(['snaps', 'streams', 'assets'].map(dir => [dir, files(join(demo, 'data', dir))]));
  assert.deepEqual(after, before);
  console.log('Rust asset and CSS resolution matches the JavaScript capture processor');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
