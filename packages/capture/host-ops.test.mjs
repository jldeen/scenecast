import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOps, apiTarget } from './host-ops.mjs';

const API = 'https://api.example.test';

test("an API undo's address: a plain path on the session's origin, else refused", () => {
  assert.equal(apiTarget('/v1/items/a%2Fb?resource=context', API).href, `${API}/v1/items/a%2Fb?resource=context`);
  for (const bad of ['/v1/items/../admin', '/v1/items/%2e%2e/admin', '//evil.test/x', 'https://evil.test/x', 'v1/items', '/v1\\x', '/v1/x#frag', '', null]) {
    assert.equal(apiTarget(bad, API), null, String(bad));
  }
});

// A capture browser with one tab: the portal page and the app's frame on its own origin.
function fakeBrowser({ from = 'https://frame.example.test' } = {}) {
  const calls = [], opened = [];
  const frame = (url, name) => ({ url: () => url, evaluate: async (fn, args) => { calls.push({ in: name, ...args }); return { status: 204 }; } });
  const main = frame('https://portal.example.test/home', 'portal'), inner = frame('https://frame.example.test/app', 'frame');
  const page = { url: () => main.url(), goto: async () => {}, frames: () => [main, inner], mainFrame: () => main, on() {}, evaluate: main.evaluate, isClosed: () => false };
  let auth = null;
  const g = {
    watchAuth(re) { if (re) auth = { origin: API, host: 'api.example.test', value: 'Bearer t', from }; },
    peekAuth: () => !!auth, takeAuth: () => { const a = auth; auth = null; return a; },
    pass(fn, o) { opened.push(o); return fn(); },
    stop: async () => {},
  };
  const ops = hostOps({ ctx: { pages: () => [page], on() {} }, guard: async () => g });
  return { ops, calls, opened };
}

test('a write opens the guard only on named hosts', async () => {
  const { ops, opened } = fakeBrowser();
  await ops.capGuard({});
  for (const c of [{}, { hosts: [] }, { hosts: 'api.example.test' }]) assert.ok((await ops.capOpen(c)).refused, JSON.stringify(c));
  assert.equal(opened.length, 0);
  assert.ok((await ops.capOpen({ hosts: ['api.example.test'] })).id);
});

test('an API undo opens its one call, from the frame that sent the app\'s own call', async () => {
  const { ops, calls, opened } = fakeBrowser();
  await ops.capGuard({});
  const r = await ops.capApi({ tab: 'portal', open: 'https://portal.example.test/home', host: 'api.example.test', method: 'delete', path: '/v1/items/a%2Fb?resource=context' });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'frame.example.test');
  assert.deepEqual(opened, [{ hosts: ['api.example.test'], method: 'DELETE', url: `${API}/v1/items/a%2Fb?resource=context` }]);
  assert.deepEqual(calls.map(c => [c.in, c.url, c.method]), [['frame', `${API}/v1/items/a%2Fb?resource=context`, 'DELETE']]);
});

test('with no frame of that origin, from the page; a path off the origin or a read is refused before anything opens', async () => {
  const { ops, calls, opened } = fakeBrowser({ from: 'https://elsewhere.example.test' });
  await ops.capGuard({});
  assert.equal((await ops.capApi({ tab: 'portal', open: 'x', host: 'api.example.test', method: 'PUT', path: '/v1/a', body: { stage: 0 } })).from, 'portal.example.test');
  for (const [method, path] of [['DELETE', '/v1/items/../admin'], ['DELETE', '//evil.test/x'], ['GET', '/v1/a']]) {
    assert.equal((await ops.capApi({ tab: 'portal', open: 'x', host: 'api.example.test', method, path })).ok, false, `${method} ${path}`);
  }
  assert.equal(opened.length, 1);
  assert.equal(calls.length, 1);
});
