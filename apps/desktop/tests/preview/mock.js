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

  const PLAN = `# Innovation Act 1
## Beat 1 · The late shipment lands in Teams
- Go to teams
- Click "Procurement"
- Click the message from Kestrel
- You: read the ship date out loud
> Kestrel just told us PO-450101 will ship six days late.
## Beat 2 · Ask Copilot about PO-450101
- Go to copilot
- Type "What does the delay on PO-450101 hold up?" in "Message"
- Press Enter — ask first
  Writes: sends the question (a new task in Recent)
  Lands on: copilot-answer · "Kestrel moved the ship date"
- Wait for the answer
- Click "Save: Save skill" — ask first
  Script: Click Approve on the Copy file card
  Differs: the product shows "Save: Save skill" here, not "Approve"
  Writes: saves the skill
> Copilot pulls it together from Teams, email and the ERP.
## Beat 3 · Who can approve the expedite
- Go to iq
- Click "Approvers"
> Microsoft IQ knows who can sign off.
## Beat 4 · IT turns it on for everyone
- Go to admin
- Click "Agents"
- Click "Publish" — ask first
> And IT rolls it out to everyone.`;
  const apps = [
    { id: 'teams', url: 'https://teams.cloud.microsoft/', key: 't' },
    { id: 'copilot', url: 'https://m365.cloud.microsoft/chat', key: 'c' },
    { id: 'iq', url: 'https://preview.iq.example.com/', key: 'i' },
    { id: 'admin', url: 'https://admin.cloud.microsoft/', key: 'a' },
  ];
  const stage = { empty: 'new', library: 'checked', record: 'new', 'record-pick': 'new', copilot: 'new', 'copilot-plan': 'new', 'copilot-separate': 'new', recording: 'new', paused: 'new', recorded: 'recorded', review: 'built', 'review-ok': 'built', making: 'new', present: 'checked', presenting: 'checked', share: 'checked' }[SC] || 'new';
  const after = s => ['recorded', 'built', 'checked'].indexOf(stage) >= ['recorded', 'built', 'checked'].indexOf(s);
  const status = {
    recorded: after('recorded'), raw: after('recorded'), recordedAt: after('recorded') ? now - 3600e3 : null, screens: after('recorded') ? 22 : 0,
    built: after('built'), builtAt: after('built') ? now - 1800e3 : null, liveScenes: after('built') ? 22 : 0, fallbackScenes: 0,
    fidelity: after('built') ? { pass: stage === 'checked', within: stage === 'checked' ? 22 : 21, total: 22, score: stage === 'checked' ? 100 : 95.5, fontsOk: true, at: now - 900e3 } : null,
    checks: after('built') ? { pass: true, passed: 41, failed: 0, quick: true, at: now - 900e3 } : null,
    focusPoints: after('built') ? 26 : 0, hasScript: after('built'), lastChecked: after('built') ? now - 900e3 : null, stage,
  };
  const home = OS === 'macos' ? '/Users/jessica/Documents/Scenecast' : 'C:\\Users\\jessica\\Documents\\Scenecast';
  const demo = {
    id: 'innovation-act-1-demo-1', title: 'Innovation Act 1 · Demo 1', dir: `${home}/innovation-act-1-demo-1`, port: 47811,
    apps, browser: OS === 'macos' ? 'chrome' : 'edge', mode: /^copilot/.test(SC) ? 'record' : 'manual', profile: null, slot: 480, status,
  };
  const others = [
    { ...demo, id: 'supplier-delay', title: 'Supplier delay walkthrough', status: { ...status, stage: 'checked', recorded: true, built: true, screens: 14, liveScenes: 14 } },
    { ...demo, id: 'admin-tour', title: 'Admin center tour', status: { ...status, stage: 'checked', recorded: true, built: true, screens: 9, liveScenes: 9 } },
    // Opened from a shared file: the build's copy of the take and the checks it was shared with, no raw recording.
    { ...demo, id: 'shared-demo', title: 'Shared demo from a colleague', status: { ...status, stage: 'checked', recorded: true, raw: false, recordedAt: now - 26 * 3600e3, built: true, screens: 44, liveScenes: 44, fidelity: { pass: false, within: 35, total: 43, viewsDiffer: 0, score: 81.4, fontsOk: false, at: now - 26 * 3600e3 } } },
  ];
  const demos = SC === 'empty' ? [] : SC === 'library' ? [demo, ...others] : [demo, ...others];
  const signedIn = q.get('signed') !== '0' && SC !== 'empty';

  const preflightItems = [
    { id: 'receiver', status: 'ok', detail: `up on 47621 → ${home}/../.scenecast/innovation-act-1-demo-1/raw` },
    { id: 'browser', status: 'ok', detail: `the recorder is connected, so ${OS === 'macos' ? 'Chrome' : 'Edge'} is running, profile "Jessica" (Profile 10) (not touched)` },
    { id: 'recorder', status: 'ok', detail: 'extension 0.5.0 connected' },
    ...apps.map(a => ({ id: `app ${a.id}`, status: 'ok', detail: `${a.url} · light` })),
  ];
  // The capture window (capture.html?cap=…): ready, busy, early (a click came too soon), paused, bar (the debugging bar
  // was closed), off (a tab isn't where it was paused), copilot, ask (Copilot asks first).
  const CAP = q.get('cap');
  const capStatus = { recording: true, busy: CAP === 'busy' || CAP === 'early', count: 14, actions: 9, streams: 1, chromeSecs: 161, blocked: 0,
    held: CAP === 'paused' ? { why: 'you', secs: 12 } : CAP === 'bar' || CAP === 'off' ? { why: 'bar', secs: 40 } : undefined };
  if (CAP) window.SCENECAST_CAPTURE = { demo: 'innovation-act-1-demo-1', copilot: CAP === 'copilot' || CAP === 'ask' };
  // Review: a believable show (22 screens in 4 beats), each screen a drawn picture of its app; on 'review' one screen in
  // beat 3 differs (a date in a late font); 'review-ok' after Fix it for me.
  const COLORS = { teams: '#5B5FC7', copilot: '#0F6CBD', iq: '#0E7C66', admin: '#C4420F' };
  const pic = (app, n, wide) => {
    const c = COLORS[app], w = wide ? 640 : 320, h = 200, half = wide ? 2 : 1;
    const one = x => `<g transform="translate(${x} 0)"><rect width="320" height="200" fill="#fff"/><rect width="320" height="22" fill="${c}"/><rect x="0" y="22" width="56" height="178" fill="#F3F4F6"/>`
      + Array.from({ length: 5 }, (_, i) => `<rect x="72" y="${40 + i * 28}" width="${120 + ((n * 37 + i * 53) % 110)}" height="9" rx="4" fill="${i === n % 5 ? c : '#D7DCE1'}" opacity="${i === n % 5 ? .55 : 1}"/>`).join('')
      + `<rect x="72" y="176" width="200" height="14" rx="7" fill="none" stroke="#C5CDD5"/></g>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${one(0)}${half === 2 ? one(320) + '<rect x="319" width="2" height="200" fill="#0E1A26"/>' : ''}</svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  };
  const reviewOf = fixed => {
    const plan = [['The late shipment lands in Teams', 0, 75, 'teams', 5], ['Ask Copilot about PO-450101', 75, 210, 'copilot', 7], ['Who can approve the expedite', 210, 345, 'iq', 6], ['IT turns it on for everyone', 345, 450, 'admin', 4]];
    let k = 0;
    const beats = plan.map(([title, start, end, app, n], b) => ({ n: b + 1, title, start, end, app, key: `${OS === 'macos' ? '⌥' : 'Ctrl+Alt+'}${b + 1}`,
      screens: Array.from({ length: n }, (_, i) => { k++; const bad = !fixed && b === 2 && i === 0; return { id: `${app}-${String(i).padStart(2, '0')}`, app, shot: pic(app, k), sideBySide: pic(app, k, true), pass: !bad, pct: bad ? 2.8 : (k % 4 ? 0.01 : 0), why: bad ? ['Some text is in a different font: the replica doesn\u2019t have the font\u2019s file.', 'A picture or icon is missing in the replica.'] : [], detail: bad ? ['Segoe UI: the replica falls back; its file wasn\u2019t captured (record the screen again with the font loaded)', '/assets/avatar.png expired when captured, and no other capture has it: record the screen again'] : [] }; }) }));
    return { beats, others: [], screens: k, compared: true, matching: fixed ? k : k - 1, differ: fixed ? 0 : 1, fontsOk: fixed, report: null };
  };
  const H = {
    review_get: () => after('built') ? reviewOf(SC === 'review-ok' || SC === 'present' || SC === 'presenting' || SC === 'share') : null,
    build: async () => { await wait(2500); return { ok: true, liveScenes: 22, streams: 2, beats: 4, fallback: [], warnings: [], errors: [], scrub: null }; },
    run_checks: async () => { await wait(800); return { pass: true, passed: 41, failed: 0, quick: true, items: [] }; },
    fidelity_run: async () => { await wait(1500); return { pass: true, report: { items: [] }, dir: '', html: '' }; },
    record_status: () => CAP ? capStatus : { recording: false },
    // New demo: the browser's open tabs (new-typed: none, so addresses are typed in).
    open_tabs: () => SC === 'new' ? [
      { title: 'Procurement chat | Microsoft Teams', url: 'https://teams.cloud.microsoft/', active: false },
      { title: 'Inbox - Jessica Deen - Outlook', url: 'https://outlook.cloud.microsoft/mail/', active: false },
      { title: 'Microsoft 365 Copilot', url: 'https://m365.cloud.microsoft/chat', active: true },
      { title: 'Supply Chain Operations | Microsoft IQ', url: 'https://preview.iq.example.com/workspaces/supply', active: false },
      { title: 'Home | Microsoft 365 admin center', url: 'https://admin.cloud.microsoft/', active: false },
      { title: 'Scenecast keynote run of show - Google Docs', url: 'https://docs.google.com/document/d/1x', active: false },
      { title: 'jldeen/scenecast: Live demos, replicated', url: 'https://github.com/jldeen/scenecast', active: false },
      { title: 'Weather', url: 'https://www.bbc.co.uk/weather', active: false },
      { title: 'Expense report | Dynamics 365', url: 'https://myexpense.operations.dynamics.com/', active: false },
    ] : [],
    record_pause: () => ({ held: 'you' }),
    record_go_on: ({ anyway }) => CAP === 'off' && !anyway ? { held: 'bar', off: ['teams'] } : { recording: true, goOn: true },
    ai_answer: () => null, ai_stop: () => null,
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
    // Copilot records in a separate browser, already signed in (copilot-separate).
    capture_profiles: () => ({ profiles: ['default', 'demo-tenant'], separate: SC === 'copilot-separate', profile: SC === 'copilot-separate' ? 'demo-tenant' : 'default' }),
    ai_get: () => ({ plan: /^copilot-(plan|separate)$/.test(SC) ? PLAN : '', goal: 'A buyer finds out PO-450101 is late, asks Copilot what it holds up, finds who can approve the expedite in Microsoft IQ, and IT rolls the agent out.', source: '', sent: [], run: null,
      review: /^copilot-(plan|separate)$/.test(SC) ? { from: 'Act 1 talk track.docx', beats: 4, steps: 14, checked: 22, writes: [], flags: [{ kind: 'differs', beat: 2, line: '2.1', text: 'The product shows "Save: Save skill" here, not "Approve"' }] } : null }),
    pick_script_file: () => ({ name: 'Act 1 talk track.docx', path: '/x/Act 1 talk track.docx' }),
    ai_approve: () => ({ approved: true }),
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
    displays: () => ({ displays: [
      { name: OS === 'macos' ? 'Built-in Retina Display' : 'Laptop screen', x: 0, y: 0, width: 1512, height: 982, work: { x: 0, y: 38, width: 1512, height: 944 }, scale: 2, here: true, primary: true },
      ...(q.get('screens') === '1' ? [] : [{ name: 'LG HDR 4K', x: 1512, y: -300, width: 1920, height: 1080, work: { x: 1512, y: -300, width: 1920, height: 1080 }, scale: 2, here: false, primary: false }]) ] }),
    rundown: () => {
      const rehearsed = SC === 'present' || SC === 'presenting' || SC === 'share';
      const took = [80, 130, 140, 112];
      const beats = [['The late shipment lands in Teams', 0, 75, 'teams'], ['Ask Copilot about PO-450101', 75, 210, 'copilot'], ['Who can approve the expedite', 210, 345, 'iq'], ['IT turns it on for everyone', 345, 450, 'admin']]
        .map(([title, start, end, app], i) => ({ n: i + 1, title, start, end, app: after('recorded') ? app : null, key: `${OS === 'macos' ? '⌥' : 'Ctrl+Alt+'}${i + 1}`, took: rehearsed ? took[i] : null }));
      return { source: 'guide', slot: 480, planned: 450, beats, rehearsal: rehearsed ? { at: now - 3 * 3600e3, total: 462 } : null };
    },
    present_start: ({ rehearse }) => ({ url: 'http://127.0.0.1:47811/', opened: true, guide: 'http://127.0.0.1:47811/presenter.html', rehearse }),
    pending_opens: () => [], pick_share_file: () => null, share_import: () => demo,
    present_stop: () => null, present_guide: () => 'http://127.0.0.1:47811/presenter.html',
    preflight: async ({ id }) => {
      const items = SC === 'record-pick' ? preflightItems.map(i => i.id === 'app iq' ? { id: 'app iq', status: 'fail', detail: 'no tab for iq (preview.iq.example.com)', missing: true,
        tabs: [{ title: 'Supply Chain Operations | Microsoft IQ', url: 'https://iq.cloud.microsoft/workspaces/supply', host: 'iq.cloud.microsoft' }, { title: 'Procurement chat | Teams', url: 'https://teams.cloud.microsoft/', host: 'teams.cloud.microsoft' }, { title: 'Inbox | Outlook', url: 'https://outlook.cloud.microsoft/mail/', host: 'outlook.cloud.microsoft' }] } : i) : preflightItems;
      for (const item of items) { job(id, 'preflight', { type: 'preflight', item }); await wait(60); }
      return { ready: items.every(i => i.status !== 'fail'), secs: 0.8, items };
    },
    record_start: async ({ id }) => {
      if (SC === 'record-error') {
        for (const item of preflightItems.map(i => i.id === 'app admin' ? { id: 'app admin', status: 'fail', detail: 'no tab for admin (admin.cloud.microsoft)', missing: true, tabs: [{ title: 'Home | Microsoft 365 admin center', url: 'https://admin.microsoft.com/Adminportal/Home', host: 'admin.microsoft.com' }, { title: 'Procurement chat | Teams', url: 'https://teams.cloud.microsoft/', host: 'teams.cloud.microsoft' }] } : i)) { job(id, 'preflight', { type: 'preflight', item }); await wait(40); }
        throw 'not ready to record: no tab for admin (admin.cloud.microsoft)';
      }
      job(id, 'record', { type: 'record', status: { recording: true, busy: false, count: 14, actions: 9, streams: 1, timing: { recorderSecs: 41, productSecs: 120 }, ...(SC === 'paused' ? { held: { why: 'bar', secs: 40 } } : {}) } });
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
    event: { async listen(event, f) { (listeners[event] ||= []).push(f); return () => {}; }, async emitTo() {} },
  };
  window.__preview = { scenario: SC, os: OS, emit, demo };

  // Scenarios that need more than data: open the demo, run its check, start a recording.
  addEventListener('load', () => setTimeout(async () => {
    if (CAP) {
      const d = 'innovation-act-1-demo-1';
      if (CAP === 'early') job(d, 'record', { type: 'record', status: { ...capStatus, blocked: 1 } });
      if (CAP === 'copilot' || CAP === 'ask') {
        job(d, 'ai-record', { type: 'record', status: { ...capStatus, chromeSecs: 95 } });
        job(d, 'ai-record', { type: 'event', event: 'step', data: { n: 6, of: 11, text: 'Type "What does the delay on PO-450101 hold up?" in "Message"' } });
        if (CAP === 'ask') job(d, 'ai-record', { type: 'event', event: 'confirm', data: { id: 'q1', step: 'Press Enter', app: 'copilot', why: 'It sends the message' } });
      }
      if (CAP === 'off') { await wait(200); document.querySelector('[data-do="go-on"]')?.click(); }
      await wait(300);
      document.documentElement.dataset.previewReady = '1';
      return;
    }
    const S = window.__scenecast;
    const ready = () => { document.documentElement.dataset.previewReady = '1'; };
    if (!S || SC === 'empty' || SC === 'library') return ready();
    if (SC === 'new' || SC === 'new-typed') { document.querySelector('#new-demo')?.click(); await wait(300); return ready(); }
    document.querySelector(`[data-open="${demo.id}"]`)?.click();
    await wait(200);
    const gate = { review: 'review', 'review-ok': 'review', present: 'present', presenting: 'present', share: 'share' }[SC];
    if (gate) { document.querySelector(`[data-gate="${gate}"]`)?.click(); await wait(200); }
    if (q.get('details') === '1') document.querySelector('[data-action="details"]')?.click();
    if (SC === 'presenting') { await wait(300); document.querySelector('[data-action="present-start"]')?.click(); await wait(300); }
    await wait(500);
    // Making: recorded, Stop pressed, the replica being made (the build is under way).
    if (SC === 'making') { await wait(400); document.querySelector('[data-action="record-start"]')?.click(); await wait(900); document.querySelector('[data-action="record-stop"]')?.click(); await wait(1600); }
    if (SC === 'recording' || SC === 'paused' || SC === 'record-error') { await wait(500); document.querySelector('[data-action="record-start"]')?.click(); }
    document.documentElement.dataset.previewReady = '1';
  }, 300));
})();
