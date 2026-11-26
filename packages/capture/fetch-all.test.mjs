import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEveryTarget } from './fetch-all.mjs';

// A DevTools connection that answers every call, except Fetch.enable on the sessions in `failOn`.
function fakeDevTools(failOn) {
  const sent = [];
  let socket = null;
  globalThis.fetch = async () => ({ json: async () => ({ webSocketDebuggerUrl: 'ws://fake' }) });
  globalThis.WebSocket = class {
    constructor() { socket = this; setTimeout(() => this.onopen && this.onopen()); }
    send(text) {
      const m = JSON.parse(text);
      sent.push(m);
      const error = m.method === 'Fetch.enable' && failOn.has(m.sessionId) ? { message: 'Fetch.enable failed' } : undefined;
      setTimeout(() => this.onmessage({ data: JSON.stringify({ id: m.id, ...(error ? { error } : { result: {} }) }) }));
    }
    close() {}
  };
  const emit = (method, params) => socket.onmessage({ data: JSON.stringify({ method, params }) });
  return { sent, emit };
}

const settle = () => new Promise(r => setTimeout(r, 20));

test('a target whose interception fails stays paused, and set() says so', async () => {
  const realFetch = globalThis.fetch, realWS = globalThis.WebSocket;
  try {
    const { sent, emit } = fakeDevTools(new Set(['bad']));
    const tf = await fetchEveryTarget(1);
    await tf.set([{ urlPattern: '*', requestStage: 'Request' }]);
    const attach = sessionId => emit('Target.attachedToTarget', { sessionId, targetInfo: { targetId: sessionId, type: 'page', url: 'about:blank' }, waitingForDebugger: true });
    attach('good'); attach('bad');
    await settle();
    const resumed = sent.filter(m => m.method === 'Runtime.runIfWaitingForDebugger').map(m => m.sessionId);
    assert.deepEqual(resumed, ['good']);
    await assert.rejects(tf.set([{ urlPattern: '*', requestStage: 'Request' }]), /Fetch\.enable failed/);
    // Gone before its Fetch started: nothing left to guard.
    emit('Target.detachedFromTarget', { sessionId: 'bad' });
    await tf.set([{ urlPattern: '*', requestStage: 'Request' }]);
    await tf.close();
  } finally {
    globalThis.fetch = realFetch; globalThis.WebSocket = realWS;
  }
});
