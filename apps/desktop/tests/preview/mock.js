// A stand-in for the app's Rust side (window.__TAURI__), for the preview (serve.mjs). Each scenario is a believable
// state of one demo; job commands play their progress events like the app does. Look-only: nothing is real.
(() => {
  const q = new URLSearchParams(location.search);
  const SC = q.get('s') || 'record';
  const OS = q.get('os') === 'windows' ? 'windows' : 'macos';
  const now = Date.now();
  const listeners = {};
  const emit = (event, payload) => (listeners[event] || []).forEach(f => f({ event, payload }));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const job = (demo, job, update) => emit('job', { demo, job, update });

  const apps = [
    { id: 'teams', url: 'https://teams.cloud.microsoft/', key: 't' },
    { id: 'copilot', url: 'https://m365.cloud.microsoft/chat', key: 'c' },
    { id: 'iq', url: 'https://daily.iq.microsoft.com/', key: 'i' },
    { id: 'admin', url: 'https://admin.cloud.microsoft/', key: 'a' },
  ];
  const stage = { empty: 'new', library: 'checked', record: 'new', copilot: 'new', recording: 'new', recorded: 'recorded', review: 'built', present: 'checked', share: 'checked' }[SC] || 'new';
  const after = s => ['recorded', 'built', 'checked'].indexOf(stage) >= ['recorded', 'built', 'checked'].indexOf(s);
  const status = {
    recorded: after('recorded'), recordedAt: after('recorded') ? now - 3600e3 : null, screens: after('recorded') ? 22 : 0,
    built: after('built'), builtAt: after('built') ? now - 1800e3 : null, liveScenes: after('built') ? 22 : 0, fallbackScenes: 0,
    fidelity: after('built') ? { pass: stage === 'checked', within: stage === 'checked' ? 22 : 21, total: 22, score: stage === 'checked' ? 100 : 95.5, fontsOk: true, at: now - 900e3 } : null,
    checks: after('built') ? { pass: true, passed: 41, failed: 0, quick: true, at: now - 900e3 } : null,
    focusPoints: after('built') ? 26 : 0, hasScript: after('built'), lastChecked: after('built') ? now - 900e3 : null, stage,
  };
  const home = OS === 'macos' ? '/Users/jessica/Documents/Scenecast' : 'C:\\Users\\jessica\\Documents\\Scenecast';
  const demo = {
    id: 'innovation-act-1-demo-1', title: 'Innovation Act 1 · Demo 1', dir: `${home}/innovation-act-1-demo-1`, port: 47811,
    apps, browser: OS === 'macos' ? 'chrome' : 'edge', profile: 'Profile 10', mode: SC === 'copilot' ? 'record' : 'manual', slot: 480, status,
  };
  const others = [
    { ...demo, id: 'supplier-delay', title: 'Supplier delay walkthrough', status: { ...status, stage: 'checked', recorded: true, built: true, screens: 14, liveScenes: 14 } },
    { ...demo, id: 'admin-tour', title: 'Admin center tour', status: { ...status, stage: 'checked', recorded: true, built: true, screens: 9, liveScenes: 9 } },
  ];
  const demos = SC === 'empty' ? [] : SC === 'library' ? [demo, ...others] : [demo, ...others];
  const signedIn = q.get('signed') !== '0' && SC !== 'empty';

  const preflightItems = [
    { id: 'receiver', status: 'ok', detail: `up on 47621 → ${home}/../.scenecast/innovation-act-1-demo-1/raw` },
    { id: 'browser', status: 'ok', detail: `the recorder is connected, so ${OS === 'macos' ? 'Chrome' : 'Edge'} is running, profile "Jessica" (Profile 10) (not touched)` },
    { id: 'recorder', status: 'ok', detail: 'extension 0.5.0 connected' },
    ...apps.map(a => ({ id: `app ${a.id}`, status: 'ok', detail: `${a.url} · light` })),
  ];
  const H = {
    app_info: () => ({ version: q.get('v') || '0.5.0', os: OS, library: home, engine: '/Applications/Scenecast.app/Contents/Resources/packages', engineError: null, noOpen: false }),
    list_demos: () => demos,
    get_demo: ({ id }) => demos.find(d => d.id === id) || Promise.reject(`no demo ${id}`),
    servers: () => ({ edit: {}, present: {} }),
    ai_status: () => ({ signedIn, login: 'jldeen', settings: { model: 'auto', pageText: true }, runtime: { ready: true, mb: 80 } }),
    ai_models: () => ({ models: [{ id: 'auto', name: 'Automatic' }] }),
    check_updates: () => ({ current: '0.5.0', available: null }),
    receiver_ensure: () => ({ receiver: { running: true, port: 47621, connected: true }, extension: { dir: `${home}/Recorder Extension`, version: '0.5.0' } }),
    receiver_status: () => ({ receiver: { running: true, port: 47621, connected: true }, extension: { dir: `${home}/Recorder Extension`, version: '0.5.0' } }),
    browser_profiles: ({ browser }) => ({ browser: browser || demo.browser, picked: 'Profile 10', running: true, profiles: [
      { dir: 'Profile 10', name: 'Jessica', email: 'jessica@contoso.com', open: true, color: '#6b4fbb', ...(SC === 'empty' ? {} : { extension: { id: 'kfmgcj', enabled: true, devMode: true } }) },
      { dir: 'Default', name: 'Personal', color: '#0f6cbd' } ] }),
    ai_get: () => ({ goal: 'A buyer finds out PO-450101 is late, asks Copilot what it holds up, finds who can approve the expedite in Microsoft IQ, and IT rolls the agent out.', source: '', plan: '', sent: [], run: null }),
    ai_save: a => a, ai_settings: ({ set }) => ({ model: 'auto', pageText: true, ...set }),
    key_reference: () => {
      const m = OS === 'macos' ? '⌥' : 'Ctrl+Alt+';
      return { title: demo.title, os: OS, modifier: OS === 'macos' ? '⌥' : 'Ctrl+Alt', exit: OS === 'macos' ? '⌃⌘F leaves full screen; close the window to stop.' : 'F11 leaves full screen; close the window to stop.',
        groups: [
          { title: 'Beats', rows: [{ keys: `${m}0`, what: 'Back to the start' }, { keys: `${m}1`, what: 'The late shipment lands in Teams' }, { keys: `${m}2`, what: 'Ask Copilot about PO-450101' }, { keys: `${m}3`, what: 'Who can approve the expedite' }, { keys: `${m}4`, what: 'IT turns it on for everyone' }] },
          { title: 'Apps', rows: apps.map(a => ({ keys: `${m}${a.key.toUpperCase()}`, what: `Show ${a.id}` })) },
          { title: 'Focus points', rows: [{ keys: `${m}F`, what: 'Zoom to the next focus point' }, { keys: `${m}⇧F`, what: 'Back one' }, { keys: `${m}P`, what: 'Type the scripted prompt' }, { keys: `${m}G`, what: 'Open the presenter guide' }] },
        ] };
    },
    guide_status: () => after('built') ? { title: demo.title, beats: 4, pictures: 4, missingPictures: 0, script: 'script.md' } : null,
    fidelity_last: () => null, script_get: () => ({ text: '', name: 'script.md' }), last_scrub: () => null,
    default_export_dir: () => (OS === 'macos' ? '/Users/jessica/Desktop' : 'C:\\Users\\jessica\\Desktop'),
    file_url: () => 'about:blank', logs_dir: () => `${home}/../Library/Application Support/Scenecast/logs`,
    reveal: () => null, open_url: () => null, open_file: () => null, set_browser: () => null, set_profile: () => null,
    set_slot: ({ slot }) => { demo.slot = slot; return null; }, script_save: () => 'script.md', create_demo: () => demo,
    preflight: async ({ id }) => {
      for (const item of preflightItems) { job(id, 'preflight', { type: 'preflight', item }); await wait(60); }
      return { ready: true, secs: 0.8, items: preflightItems };
    },
    record_start: async ({ id }) => {
      if (SC === 'record-error') throw 'not open: teams (a tab whose address has teams.cloud.microsoft), admin (a tab whose address has admin.cloud.microsoft). Open them in the browser the recorder is in, then start again';
      job(id, 'record', { type: 'record', status: { recording: true, busy: false, count: 14, actions: 9, streams: 1, timing: { recorderSecs: 41, productSecs: 120 } } });
      return { ok: true };
    },
    record_stop: async () => ({ states: 22, steps: 41, streams: 2, beats: 4, secs: 370, timing: { recorderSecs: 124, productSecs: 246 }, notes: [], autos: [] }),
  };

  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        const h = H[cmd];
        if (!h) { console.warn('preview: no stand-in for', cmd, args); return null; }
        return h(args);
      },
    },
    event: { async listen(event, f) { (listeners[event] ||= []).push(f); return () => {}; } },
  };
  window.__preview = { scenario: SC, os: OS, emit, demo };

  // Scenarios that need more than data: open the demo, run its check, start a recording.
  addEventListener('load', () => setTimeout(async () => {
    const S = window.__scenecast;
    const ready = () => { document.documentElement.dataset.previewReady = '1'; };
    if (!S || SC === 'empty' || SC === 'library') return ready();
    if (SC === 'new') { document.querySelector('#new-demo')?.click(); await wait(200); return ready(); }
    document.querySelector(`[data-open="${demo.id}"]`)?.click();
    await wait(200);
    const gate = { review: 'review', present: 'present', share: 'share' }[SC];
    if (gate) { document.querySelector(`[data-gate="${gate}"]`)?.click(); await wait(200); }
    if (q.get('details') === '1') document.querySelector('[data-action="details"]')?.click();
    if (['record', 'copilot', 'recording', 'record-error'].includes(SC)) document.querySelector('[data-action="preflight"]')?.click();
    if (SC === 'recording' || SC === 'record-error') { await wait(500); document.querySelector('[data-action="record-start"]')?.click(); }
    document.documentElement.dataset.previewReady = '1';
  }, 300));
})();
