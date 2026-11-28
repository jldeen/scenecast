import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordOpts, loadDemo } from './demo.mjs';

test('a demo made before 0.4.3 gets the recorder\'s side-path budget, not its template\'s 240 s a screen', () => {
  const old = { record: { settleMs: 2500, auto: { maxS: 240, hoverMax: 40, clickMax: 25 } } };
  assert.deepEqual(recordOpts(old), { settleMs: 2500, auto: { hoverMax: 40, clickMax: 25 } });
  assert.equal(old.record.auto.maxS, 240, 'the demo itself is left as it is');
});

test('a budget the presenter set is kept', () => {
  assert.deepEqual(recordOpts({ record: { auto: { maxS: 60, hoverMax: 40, clickMax: 25 } } }).auto.maxS, 60);
  assert.deepEqual(recordOpts({ record: { auto: { maxS: 240, zoom: false } } }).auto, { maxS: 240, zoom: false });
  assert.deepEqual(recordOpts({}), {});
});

test('a recording never clicks what an app pack says the replica can\'t play (the admin center\'s Cloud Shell)', () => {
  const cfg = { apps: [{ id: 'admin', url: 'https://admin.cloud.microsoft/', match: 'admin.cloud.microsoft' }, { id: 'c', url: 'https://m365.cloud.microsoft/', match: 'm365.cloud.microsoft' }] };
  assert.deepEqual(recordOpts(cfg).dropClicks, { admin: ['Cloud Shell'] });
  assert.equal(recordOpts({ ...cfg, packs: false }).dropClicks, undefined);
});

test('a demo recorded in the capture browser takes its profile\'s own settings where demo.json leaves them out', () => {
  const home = mkdtempSync(join(tmpdir(), 'profiles-')), dir = mkdtempSync(join(tmpdir(), 'demo-'));
  writeFileSync(join(home, 'demo-tenant.json'), JSON.stringify({ tenant: 'example.com', account: 'presenter@example.com', guard: 'hold', allow: ['/^POST a\\.example\\.com\\/landing$/'] }));
  const make = cfg => { writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'd', apps: [], ...cfg })); return loadDemo(dir).cfg.capture; };
  process.env.STUNTDOUBLE_CAPTURE_HOME = home;
  try {
    const c = make({ recorder: 'capture', capture: { profile: 'demo-tenant', account: 'other@example.com', allow: ['/^POST b\\.example\\.com\\/x$/'] } });
    assert.equal(c.tenant, 'example.com');
    assert.equal(c.account, 'other@example.com');
    assert.equal(c.guard, 'hold');
    assert.deepEqual(c.allow, ['/^POST a\\.example\\.com\\/landing$/', '/^POST b\\.example\\.com\\/x$/']);
    // Recording in her own browser: nothing of the profile's.
    assert.equal(make({ capture: { profile: 'demo-tenant' } }).tenant, undefined);
  } finally { delete process.env.STUNTDOUBLE_CAPTURE_HOME; }
});
