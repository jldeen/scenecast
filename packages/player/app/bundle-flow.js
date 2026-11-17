// Adapt the bundle graph and its player-specific options to the morph engine's in-memory model.
export function flowFromBundle(bundle) {
  if (bundle.schema_version !== 'scenecast.bundle.v2') throw new Error('Unsupported bundle schema');
  const playback = bundle.playback || {};
  const flow = { ...(playback.options || {}), title: bundle.title };
  flow.apps = (bundle.apps || []).map(app => ({
    ...((playback.apps || {})[app.id] || {}),
    id: app.id, key: app.key, title: app.title,
  }));
  flow.states = {};
  for (const scene of bundle.graph.scenes) {
    if ((scene.kind || 'live-page') !== 'live-page' || !scene.live) continue;
    const data = (playback.scenes || {})[scene.id] || {};
    const snapshot = scene.live.snapshot;
    const match = /^data\/snaps\/(.+)\.html$/.exec(snapshot);
    const state = {
      ...(data.options || {}),
      app: scene.live.app, snap: match ? match[1] : scene.id,
      snapshot, title: scene.live.title || scene.title,
    };
    const ordered = (data.actions || []).map(a => ({ order: a.order, value: a.action }));
    const groups = new Map();
    for (const [index, transition] of (scene.transitions || []).entries()) {
      if (transition.trigger === 'escape') { state.esc = transition.target; continue; }
      const meta = transition.playback || { order: index };
      let action = groups.get(meta.order);
      if (!action) {
        action = { ...(meta.options || {}) };
        action[transition.trigger] = transition.matcher || {};
        if (transition.stream) action.stream = transition.stream;
        if (transition.app) action.app = transition.app;
        groups.set(meta.order, action);
        ordered.push({ order: meta.order, value: action });
      }
      if (meta.query_key !== undefined && meta.query_key !== null) {
        (action.query ||= {})[meta.query_key] = transition.target;
      } else {
        action.to = transition.target;
      }
    }
    state.on = ordered.sort((a, b) => a.order - b.order).map(x => x.value);
    flow.states[scene.id] = state;
  }
  flow.streams = Object.fromEntries((bundle.streams || []).map(stream => {
    const options = { ...((playback.streams || {})[stream.id] || {}) };
    const first = options.first_frame || 0;
    delete options.first_frame;
    return [stream.id, {
      ...options, to: stream.target, frames: [first, first + stream.frames - 1],
      timing: stream.timing, ...(stream.duration_ms !== undefined ? { ms: stream.duration_ms } : {}),
      ...(stream.prompt !== undefined ? { prompt: stream.prompt } : {}),
    }];
  }));
  flow.beats = (bundle.beats || []).map(beat => ({ label: beat.label, active: beat.active, states: beat.scenes }));
  flow.focus = (bundle.focus_points || []).map(point => ({
    ...((playback.focus_points || {})[point.id] || {}),
    ...point, states: point.scenes,
  }));
  if (!flow.beats.length && flow.apps.length) {
    const start = flow.states[bundle.graph.start_scene];
    if (!start) throw new Error('Start scene has no live page');
    const states = Object.fromEntries(flow.apps.map(app => {
      const found = Object.entries(flow.states).find(([, state]) => state.app === app.id);
      if (!found) throw new Error(`App ${app.id} has no live page`);
      return [app.id, app.id === start.app ? bundle.graph.start_scene : found[0]];
    }));
    flow.beats = [{ label: 'Reset', active: start.app, states }];
  }
  if (flow.focus.length && !(flow.modules || []).includes('/app/focus-module.js')) {
    flow.modules = ['/app/focus-module.js', ...(flow.modules || [])];
  }
  return flow;
}
