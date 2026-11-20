// Errors in plain words. Every message the engine or the app can show is matched here to what a presenter reads: a
// title (what happened), one sentence (why, or what to do), and at most one action (a button that puts it right).
// The engine's own words are kept for Details. Anything unmatched still reads as a sentence, never as engine output.
// No DOM here: apps/desktop/tests/errors.test.mjs runs it in Node.

// An action is one of: { action: '<ACTIONS key in app.js>' }, { goto: '<step>' }, { copy: '<text>' }; plus a label.
const A = (label, x) => ({ label, ...x });
const firstApp = m => (m.match(/(?:not open|no tab for):?\s*([a-z0-9-]+)/i) || [])[1];

export const CATALOG = [
  // A newer run of the same step took over: nothing went wrong, nothing to show.
  { id: 'superseded', test: /replaced by a newer check|a newer run took its place/i, quiet: true },

  { id: 'tabs-not-open', test: /not open: .*a tab whose address has|no tab for /i,
    title: c => c.many ? 'Some app tabs aren\u2019t open' : `The ${c.app || 'app'} tab isn\u2019t open`,
    body: c => `Scenecast didn\u2019t find ${c.many ? 'them' : 'it'} in ${c.browser}. It can open ${c.many ? 'them' : 'it'} for you.`,
    action: () => A('Open them for me', { action: 'preflight-fix' }) },
  { id: 'two-recorders', test: /recorder is in more than one browser/i,
    title: () => 'The recorder is in two browsers',
    body: c => `Close the other ${c.browser} window that has Scenecast\u2019s recorder, or remove the recorder from it. Then check again.`,
    action: () => A('Check again', { action: 'preflight' }) },
  { id: 'recorder-old', test: /Reload the recorder extension|recorder in .+ is [\d.]+(\.\d+)*; this app.s is|can.t reload itself/i,
    title: () => 'Your recorder needs an update',
    body: c => `${c.browser} is still running the older Scenecast recorder. Scenecast can update it for you.`,
    action: () => A('Update the recorder', { action: 'preflight-fix' }) },
  { id: 'recorder-off', test: /Developer mode is off|recorder is switched off|turn Scenecast Recorder on/i,
    title: c => `The recorder is switched off in ${c.browser}`,
    body: c => `Turn Scenecast Recorder back on in ${c.browser}\u2019s extensions, then check again.`,
    action: () => A('Show me how', { action: 'install' }) },
  { id: 'recorder-missing', test: /recorder isn.t connected|recorder isn.t in|isn.t talking to Scenecast|no agent polling|recorder is in .+ but this demo (uses|records in)|old copy of the recorder/i,
    title: c => `${c.browser} isn\u2019t connected`,
    body: c => `Scenecast can\u2019t reach its recorder in ${c.browser}. ${c.browser} may have restarted, or the recorder isn\u2019t added yet.`,
    action: c => A(`Connect ${c.browser}`, { action: 'install' }) },
  { id: 'browser-closed', test: /^(google |microsoft )?(chrome|edge|the browser) isn.t (open|running)|wasn.t running|start .+ with profile .+ yourself/i,
    title: c => `${c.browser} isn\u2019t open`,
    body: c => `Open ${c.browser} with the profile you use for work, then check again.`,
    action: () => A('Check again', { action: 'preflight-fix' }) },
  { id: 'receiver-down', test: /receiver isn.t running|nothing on \d+|couldn.t start a receiver|isn.t answering as a receiver/i,
    title: () => 'Scenecast lost its link to the browser',
    body: () => 'The part of Scenecast that talks to your browser stopped. Starting it again takes a second.',
    action: () => A('Start it again', { action: 'receiver-fix' }) },
  { id: 'app-sign-in', test: /isn.t on its start screen \(https?:\/\/(login\.|[^)]*\/(login|signin|oauth))/i,
    title: c => `Sign in to ${c.app || 'the app'} first`,
    body: c => `${c.app || 'It'} is showing its sign-in page in ${c.browser}. Sign in there, then come back.`,
    action: () => A('I\u2019ve signed in', { action: 'preflight' }) },
  { id: 'app-off-start', test: /isn.t on its start screen/i,
    title: c => `${c.app || 'An app'} isn\u2019t on its start screen`,
    body: () => 'Recording starts from each app\u2019s start screen. Scenecast can take it back there.',
    action: () => A('Take it back', { action: 'preflight-fix' }) },

  { id: 'already-recording', test: /already recording/i,
    title: () => 'Already recording', body: () => 'A recording is still running. Stop it first.',
    action: () => A('Stop recording', { action: 'record-stop' }) },
  { id: 'not-recording', test: /\bnot recording\b/i,
    title: () => 'Nothing is recording', body: () => 'There\u2019s no recording to stop.', action: () => null },
  { id: 'nothing-to-resume', test: /nothing to resume/i,
    title: () => 'Nothing to pick up', body: () => 'There\u2019s no saved recording to continue. Start a new one.',
    action: () => A('Start recording', { action: 'record-start' }) },
  { id: 'nothing-recorded', test: /\b0 (states|screens)\b|nothing was recorded/i,
    title: () => 'Nothing was recorded', body: () => 'The recording stopped before the first screen was captured.',
    action: () => A('Record again', { action: 'record-start' }) },
  { id: 'no-apps', test: /no apps to record/i,
    title: () => 'This demo has no apps', body: () => 'Add the apps it shows, then record.', action: () => null },
  { id: 'no-recording', test: /no recording:|record the demo first/i,
    title: () => 'Record the demo first', body: () => 'There\u2019s nothing to build yet.',
    action: () => A('Go to Record', { goto: 'record' }) },
  { id: 'credential', test: /credential/i,
    title: () => 'A password or key was on screen',
    body: () => 'The recording shows something that looks like a password, key or token, so it\u2019s kept out of your replica. Record that part again without it.',
    action: () => A('Record again', { action: 'record-start' }) },

  { id: 'script-empty', test: /the script is empty|paste or open the script first|no script at/i,
    title: () => 'Add your talk track first', body: () => 'Paste it, or open a file.', action: () => null },
  { id: 'guide-before-stage', test: /start presenting first/i,
    title: () => 'Start presenting first', body: () => 'The presenter guide follows the stage, so it opens once the stage is up.',
    action: () => A('Start presenting', { action: 'present-start' }) },
  { id: 'profiles-unreadable', test: /couldn.t read the browser.s profiles/i,
    title: () => 'Couldn\u2019t read your browser\u2019s profiles', body: () => 'Scenecast records in the profile that\u2019s open.', action: () => null },
  { id: 'duplicate-app', test: /two apps have the id/i,
    title: () => 'Two apps have the same name', body: () => 'Give each app its own name, then try again.', action: () => null },
  { id: 'no-name', test: /give the demo a name|title must not be empty/i,
    title: () => 'Give the demo a name', body: () => 'Any name you\u2019ll recognise.', action: () => null },

  { id: 'sign-in-expired', test: /expired_token|code expired|device code.*expired/i,
    title: () => 'Copilot sign-in didn\u2019t finish', body: () => 'GitHub didn\u2019t get the code in time. Nothing changed on your account.',
    action: () => A('Try again', { action: 'ai-sign-in' }) },
  { id: 'sign-in-denied', test: /access_denied|authorization.*(denied|declined)/i,
    title: () => 'Copilot sign-in was cancelled', body: () => 'GitHub says the code was declined. You can sign in again any time.',
    action: () => A('Sign in again', { action: 'ai-sign-in' }) },
  { id: 'no-copilot', test: /(no|not|without) (an? )?(active )?copilot (plan|subscription|access|seat)|copilot.*(not enabled|isn.t enabled)/i,
    title: () => 'This GitHub account doesn\u2019t have Copilot', body: () => 'Sign in with the account that has a Copilot plan.',
    action: () => A('Sign in again', { action: 'ai-sign-in' }) },
  { id: 'offline', test: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo|fetch failed|network is unreachable/i,
    title: () => 'Can\u2019t reach the internet', body: () => 'Scenecast couldn\u2019t reach GitHub. Check your connection, then try again.',
    action: c => c.retry ? A('Try again', { action: c.retry }) : null },
  { id: 'cant-open-url', test: /not opening (https?:\/\/\S+)|can.t open (https?:\/\/\S+)/i,
    title: () => 'Couldn\u2019t open your browser',
    body: c => `Go to ${c.url} yourself.`,
    action: c => A('Copy the address', { copy: c.url }) },
  { id: 'cant-open-file', test: /can.t (open|show) |not opening \//i,
    title: () => 'Couldn\u2019t open that', body: () => 'It may have been moved or deleted.', action: () => null },
  { id: 'update-check', test: /^update:|couldn.t check for updates/i,
    title: () => 'Couldn\u2019t check for updates', body: () => 'Scenecast tries again on its own every 30 minutes.', action: () => null },
  { id: 'node-missing', test: /Node\.js \d+ or later is needed|failed to run `node/i,
    title: () => 'Scenecast is missing a part', body: () => 'Its engine didn\u2019t start. Install Scenecast again from the download page.',
    action: () => A('Show the logs', { action: 'show-logs' }) },
  { id: 'disk-full', test: /ENOSPC|no space left/i,
    title: () => 'Your disk is full', body: () => 'Free up some space, then try again.', action: () => null },
  { id: 'no-permission', test: /EACCES|EPERM|permission denied|operation not permitted/i,
    title: () => 'Scenecast can\u2019t write to its folder', body: () => 'Another app may be using it, or it\u2019s read-only. Try again in a moment.', action: () => null },
  { id: 'step-stopped', test: /the engine.s .+ (stopped|failed) .*exit|stopped with exit code|the build has errors|static export:|wrote no report|replica server stopped|worker stopped/i,
    title: c => `${c.step ? `${c.step}: ` : ''}something went wrong`, body: () => 'Scenecast stopped partway. The logs say what happened.',
    action: () => A('Show the logs', { action: 'show-logs' }) },
];

const STEP = { preflight: 'Check', record: 'Recording', 'record-stop': 'Recording', build: 'Building the replica', checks: 'Checks', fidelity: 'Comparing with the real product', script: 'Talk track', export: 'Sharing', install: 'Recorder', 'ai-plan': 'Copilot\u2019s plan', 'ai-record': 'Copilot recording', 'ai-script': 'Copilot\u2019s talk track' };

// What a message means: { id, title, body, action, detail } (detail: the engine's words), or null when it's nothing
// to show. ctx: { browser: 'Chrome' | 'Edge', job, retry, appName(id) }.
export function explain(message, ctx = {}) {
  const detail = String(message ?? '').trim();
  const entry = CATALOG.find(e => e.test.test(detail));
  if (entry?.quiet) return null;
  const appId = firstApp(detail) || (detail.match(/^([a-z0-9-]+) isn.t on its start screen/i) || [])[1];
  const c = {
    browser: ctx.browser || 'your browser', step: STEP[ctx.job], retry: ctx.retry,
    app: appId ? (ctx.appName ? ctx.appName(appId) : appId) : null,
    many: (detail.match(/a tab whose address has/g) || []).length > 1,
    url: (detail.match(/https?:\/\/\S+/) || [])[0]?.replace(/[).,]+$/, ''),
  };
  if (!entry) return { id: 'unknown', title: c.step ? `${c.step}: something went wrong` : 'Something went wrong', body: 'Scenecast couldn\u2019t finish this. The details say what happened.', action: { label: 'Show the logs', action: 'show-logs' }, detail };
  return { id: entry.id, title: entry.title(c), body: entry.body(c), action: entry.action(c) || null, detail };
}
