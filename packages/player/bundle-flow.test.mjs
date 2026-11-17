import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFlowOverrides, flowFromBundle } from './app/bundle-flow.js';

test('bundle graph drives scenes, queries, streams and focus', () => {
  const bundle = {
    schema_version: 'scenecast.bundle.v2', title: 'Fixture',
    apps: [{ id: 'chat', title: 'Chat', key: 'C' }],
    graph: { start_scene: 'start', scenes: [
      { id: 'start', title: 'Start', kind: 'live-page', live: { app: 'chat', snapshot: 'data/snaps/home.html' },
        transitions: [
          { trigger: 'enter', matcher: { sel: 'input' }, target: 'start', playback: { order: 0, query_key: '', options: { scroll: 'keep' } } },
          { trigger: 'enter', matcher: { sel: 'input' }, target: 'answer', playback: { order: 0, query_key: 'answer', options: { scroll: 'keep' } } },
        ] },
      { id: 'answer', title: 'Answer', kind: 'live-page', live: { app: 'chat', snapshot: 'data/snaps/answer.html' }, transitions: [] },
    ] },
    streams: [{ id: 's1', target: 'answer', frames: 3, timing: 'real', duration_ms: 500 }],
    beats: [{ label: 'Reset', active: 'chat', scenes: { chat: 'start' } }],
    focus_points: [{ id: 'f', beat: 0, app: 'chat', scenes: ['answer'], find: 'text', mark: 'arrow' }],
    playback: {
      options: { pace: 5 }, apps: { chat: { layout: { chips: [] } } },
      scenes: { start: { options: { fill: [{ value: 'hello' }] }, actions: [{ order: 1, action: { click: { sel: 'button' }, flag: 'x' } }] } },
      streams: { s1: { first_frame: 2, raw: 'original' } }, focus_points: { f: { grow: [1, 2, 3, 4] } },
    },
  };
  const flow = flowFromBundle(bundle);
  assert.equal(flow.states.start.snap, 'home');
  assert.deepEqual(flow.states.start.on[0], { scroll: 'keep', enter: { sel: 'input' }, query: { '': 'start', answer: 'answer' } });
  assert.equal(flow.states.start.on[1].flag, 'x');
  assert.deepEqual(flow.streams.s1.frames, [2, 4]);
  assert.equal(flow.streams.s1.to, 'answer');
  assert.deepEqual(flow.focus[0].states, ['answer']);
  assert.deepEqual(flow.focus[0].grow, [1, 2, 3, 4]);
  bundle.graph.scenes[0].transitions[1].target = 'start';
  assert.equal(flowFromBundle(bundle).states.start.on[0].query.answer, 'start');
  bundle.graph.scenes[0].live.snapshot = 'snaps/home.html';
  assert.equal(flowFromBundle(bundle).states.start.snap, 'home');
});

test('live override paths cannot mutate object prototypes', () => {
  assert.throws(() => applyFlowOverrides({}, [{ path: ['__proto__', 'polluted'], value: true }]), /Invalid override path/);
  assert.equal({}.polluted, undefined);
});
