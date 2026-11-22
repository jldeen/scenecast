import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFlowOverrides, flowFromBundle, withEngineModule } from './app/bundle-flow.js';

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

test('explicit fallback scenes join the live graph without becoming live pages', () => {
  const bundle = {
    schema_version: 'scenecast.bundle.v2', title: 'Fixture',
    apps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    graph: { start_scene: 'live', scenes: [
      { id: 'live', title: 'Live', live: { app: 'a', snapshot: 'data/snaps/live.html' },
        transitions: [{ trigger: 'click', target: 'still', matcher: { sel: 'button' } }] },
      { id: 'still', title: 'Still', kind: 'screenshot', assets: { screenshot: 'captures/still.png' },
        hotspots: [{ id: 'next', target: 'live', bounds: { x: 1, y: 2, width: 3, height: 4 } }] },
      { id: 'other', title: 'Other', live: { app: 'b', snapshot: 'data/snaps/other.html' } },
    ] },
    beats: [{ active: 'a', scenes: { a: 'live', b: 'other' } }],
  };
  const state = flowFromBundle(bundle).states.still;
  assert.equal(state.app, 'a');
  assert.equal(state.snap, '@fallback:still');
  assert.equal(state.fallback.assets.screenshot, 'captures/still.png');
  assert.equal(state.fallback.hotspots[0].target, 'live');
  bundle.graph.scenes[2].transitions = [{ trigger: 'click', target: 'still' }];
  assert.throws(() => flowFromBundle(bundle), /Cannot determine app for fallback scene still/);
});

test('an engine module is added unless the demo brings its own of that name', () => {
  assert.deepEqual(withEngineModule(['/demo/keys-module.js'], 'focus-module.js'), ['/app/focus-module.js', '/demo/keys-module.js']);
  assert.deepEqual(withEngineModule(['/demo/focus-module.js'], 'focus-module.js'), ['/demo/focus-module.js']);
  assert.deepEqual(withEngineModule(['/demo/presenter-module.js', '/demo/slide-module.js'], 'presenter-module.js', { first: false }), ['/demo/presenter-module.js', '/demo/slide-module.js']);
  assert.deepEqual(withEngineModule(['/app/focus-module.js'], 'presenter-module.js', { first: false }), ['/app/focus-module.js', '/app/presenter-module.js']);
});
