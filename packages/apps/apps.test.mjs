// App packs: loading and merging (built-in under external), finding a pack by URL or by a talk track's name, the
// recording settings under a demo's own, flow defaults ({ use } rules, rules every demo gets), the build rules, and
// the checks every seeded pack passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPacks, mergePack, packFor, packForName, packsForDemo, activePacks, applyPacks, writeFor, safeFor, checkPack, themePack } from './index.mjs';
import { flowDefaults, htmlPasses } from './build.mjs';
import { packRules } from '../recorder/pack-rules.mjs';
import { elementEnd } from '../recorder/compose.mjs';
import { parseStep } from '../ai/plan.mjs';

const builtin = loadPacks({ dirs: [] });
const byId = id => builtin.find(p => p.id === id);

test('every seeded pack passes its checks, and its theme files load', () => {
  assert.deepEqual(builtin.map(p => p.id).sort(), ['github', 'github-copilot-app', 'm365-admin', 'm365-copilot', 'microsoft-iq', 'sentry', 'teams']);
  for (const p of builtin) assert.deepEqual(checkPack(p), [], p.id);
  for (const p of builtin) for (const t of Object.keys((p.theme || {}).themes || {})) assert.equal(themePack(p, t).kind, 'stuntdouble-theme-pack', `${p.id} ${t}`);
});

test('an external pack merges over the built-in one: writes by id, null removes, lists replace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-packs-'));
  mkdirSync(join(dir, 'm365-copilot'));
  writeFileSync(join(dir, 'm365-copilot', 'pack.json'), JSON.stringify({
    id: 'm365-copilot', record: { busy: [{ text: 'Thinking' }], groups: null },
    writes: [{ id: 'new-task', undo: { api: { use: 'rt', method: 'DELETE', path: '/t/{taskId}' } } }, { id: 'send', off: true }, { id: 'extra', what: 'x', on: { kind: 'click', target: 'X' }, undo: null, check: { expect: 'y' } }],
  }));
  const p = loadPacks({ dirs: [dir] }).find(x => x.id === 'm365-copilot');
  assert.equal(p._source, 'builtin+external');
  assert.deepEqual(p.record.busy, [{ text: 'Thinking' }]);
  assert.equal(p.record.groups, undefined);
  const task = p.writes.find(w => w.id === 'new-task');
  assert.ok(task.undo.steps.length && task.undo.api.path === '/t/{taskId}', 'the public steps stay, the private API undo is added');
  assert.ok(!p.writes.some(w => w.id === 'send') && p.writes.at(-1).id === 'extra');
  assert.deepEqual(mergePack({ a: { b: 1, c: 2 } }, { a: { c: null } }), { a: { b: 1 } });
});

test('packs are found by URL (a frame by its own host) and by the names a talk track uses', () => {
  assert.equal(packFor('https://teams.cloud.microsoft/v2/', builtin).id, 'teams');
  assert.equal(packFor('https://daily.iq.microsoft.com/home', builtin).id, 'microsoft-iq');
  assert.equal(packFor('https://app.powerbi.com/groups/me', builtin).id, 'microsoft-iq');
  assert.equal(packFor('https://example.com/', builtin), null);
  assert.equal(packForName('In the admin center, open Tools', builtin).id, 'm365-admin');
  assert.equal(packForName('Then Agent 365 shows it', builtin).id, 'm365-admin');
  assert.equal(packForName('Switch to the GitHub Copilot app', builtin).id, 'github-copilot-app');
  assert.equal(packForName('On GitHub, open the pull request', builtin).id, 'github');
  assert.equal(packForName('Fabric IQ is on', builtin), null);
});

test('a demo finds its packs by its apps\' URLs, never by its own app ids, and can leave one out', () => {
  const cfg = { apps: [{ id: 'iq', url: 'https://iq.microsoft.com/' }, { id: 'chat', match: 'm365.cloud.microsoft' }, { id: 'gh', url: 'https://github.com/', pack: false }] };
  assert.deepEqual(Object.fromEntries(Object.entries(packsForDemo(cfg, builtin)).map(([k, p]) => [k, p.id])), { iq: 'microsoft-iq', chat: 'm365-copilot' });
  assert.ok(!activePacks(cfg, builtin).some(p => p.id === 'github'));
  assert.deepEqual(activePacks({ packs: false }, builtin), []);
});

test('recording settings: the demo always wins; busy and ignore lists join; each app keeps its own budget', () => {
  const groups = { button: 'button.mine' };
  const { record, used } = applyPacks({ apps: [{ id: 'c', url: 'https://m365.cloud.microsoft/' }, { id: 'q', url: 'https://iq.microsoft.com/' }], record: { busy: [{ text: 'Mine' }], groups, autoPerApp: { c: { maxS: 5 } } } }, builtin);
  assert.deepEqual(used, [{ app: 'c', pack: 'm365-copilot' }, { app: 'q', pack: 'microsoft-iq' }]);
  assert.deepEqual(record.busy[0], { text: 'Mine' });
  assert.ok(record.busy.some(b => b.text === 'Working on it'));
  assert.equal(record.groups, groups);
  assert.equal(record.autoPerApp.c.maxS, 5);
  assert.equal(record.autoPerApp.q.zoom, true);
  assert.deepEqual(record.skipFrames, byId('microsoft-iq').frames.skip);
  assert.equal(record.ignore, undefined);
});

test('flow defaults: named rules by { use } with the demo\'s fields over them, rules every demo gets once, groups and menus filled', () => {
  const flow = {
    apps: [{ id: 'c', layout: { chips: [{ use: 'workspace-chips', state: 's1', plus: { from: 'v200' } }], responsive: [{ use: 'nav', variant: { default: 'v' } }] }, on: [] }, { id: 'q', layout: {} }],
    drags: [{ use: 'side-pane', app: 'q', frame: 'f4' }],
    groups: [{ app: 'c', template: { closed: 'a', open: 'b' } }],
    clickPages: [{ page: 'p', app: 'c' }],
  };
  const appPacks = { c: byId('m365-copilot'), q: byId('microsoft-iq') };
  flowDefaults(flow, appPacks);
  const once = JSON.stringify(flow);
  flowDefaults(flow, appPacks);
  assert.equal(JSON.stringify(flow), once, 'running it twice changes nothing');
  const c = flow.apps[0];
  assert.deepEqual(c.layout.chips[0], { list: 'aside ul[role=list]', item: 'li[role=listitem]', rows: 2, gap: 4, plus: { marker: 'VNextWorkspacePanel.ChipOverflow', noun: 'plugins', from: 'v200' }, state: 's1' });
  assert.equal(c.layout.responsive[0].below, 1024);
  assert.equal(c.layout.pin.length, 1);
  assert.deepEqual(c.on, [{ click: { sel: 'button[data-testid="nav-toggle-button"]' }, flag: 'navCollapsed' }]);
  assert.equal(flow.drags[0].frame, 'f4');
  assert.equal(flow.drags[0].handle, '[data-testid="side-pane-resize-handle"]');
  assert.ok(flow.drags.some(d => d.app === 'c' && d.write === 'flexPercent'));
  assert.equal(flow.groups[0].label, '[data-finalized-label]');
  assert.equal(flow.clickPages[0].vendorCss[0], 'pack:m365-copilot/vendor/fluent-react-slider.css');
  assert.equal(flow.lateItems[0].text, 'Give feedback');
  assert.throws(() => flowDefaults({ apps: [{ id: 'c', layout: { set: [{ use: 'nope' }] } }] }, appPacks), /no pack rule "nope"/);
});

test('build rules (the stand-in applier): conditions, kinds, attributes stripped and whole-line CSS repairs', () => {
  const R = packRules(htmlPasses(builtin, { off: ['github:heading-font'] }), { elementEnd });
  const gh = '<html><head><style>\n.x { a: ; }\n</style></head><body><li class="mx-2"><form class="js-stats-toggle">t</form></li><i class="taillight-module_qW5TYa_Bitmap Heading__toON9Z"></i></body></html>';
  const repairs = htmlPasses([byId('github')])[0].repairs;
  const line = Object.keys(repairs)[0];
  const blob = R.apply(gh.replace('.x { a: ; }', line), 'github', { url: 'https://github.com/o/r/blob/main/a.md' });
  assert.ok(!blob.includes('js-stats-toggle') && !blob.includes('mx-2'));
  assert.ok(blob.includes('#read-only-cursor-text-area') && !blob.includes('Heading__toON9Z{'), 'code text on /blob/, heading font turned off');
  assert.ok(blob.includes('\n' + repairs[line] + '\n'));
  assert.ok(!R.apply(gh, 'github', { url: 'https://github.com/o/r/issues/1' }).includes('#read-only-cursor-text-area'), 'url condition');
  const teams = R.apply('<div><div role="tooltip" class="t">Open office app launcher</div><input placeholder="Press ⌥ ⌘ G to go right to a chat or channel"></div>', 'teams', {});
  assert.equal(teams, '<div><input placeholder="Search or ask Copilot (⌥ ⌘ E)"></div>');
  assert.equal(R.apply('<div powerbi-access-token="abc.def">x</div>', 'microsoft-iq', {}), '<div powerbi-access-token="">x</div>');
});

test('a plan step maps to the write it makes, and checks only look', () => {
  const cop = byId('m365-copilot');
  assert.equal(writeFor(cop, parseStep('Press Enter'), { name: 'Message Copilot' }).id, 'new-task');
  assert.equal(writeFor(cop, parseStep('Press Enter'), { name: 'Chat input' }).id, 'new-task', 'the composer in an open task');
  assert.equal(writeFor(cop, parseStep('Press Enter'), { name: 'Search' }), null);
  assert.equal(writeFor(cop, parseStep('Click "Save"')).id, 'save-skill');
  assert.equal(writeFor(cop, parseStep('Click "Approve"')).id, 'approve');
  assert.equal(writeFor(cop, parseStep('Click "Enable Fabric IQ"')).id, 'plugin-switch');
  assert.equal(writeFor(cop, parseStep('Click "Plugins"')), null);
  const bad = { ...cop, writes: [{ id: 'w', what: 'x', on: { kind: 'click', target: 'X' }, undo: null, check: { steps: ['Click "Delete"'] } }], apis: { a: { open: 'https://x', host: 'h' } }, notes: ['Bear', 'er ', 'x'.repeat(24)].join('') };
  const problems = checkPack(bad);
  assert.ok(problems.some(p => /could change something/.test(p)) && problems.some(p => /credential or token/.test(p)));
});

test('safe steps only open a picker or a menu: never a write, never a sign-in', () => {
  const iq = byId('microsoft-iq');
  assert.equal(safeFor(iq, parseStep('Click "Add content to Our numbers"')).id, 'add-content');
  assert.equal(safeFor(iq, parseStep('Click "Add endorsement"')).id, 'endorse-menu');
  assert.equal(writeFor(iq, parseStep('Click "Add content to Our numbers"')), null);
  assert.equal(safeFor(iq, parseStep('Click "Certified"')), null);
  const bad = safe => checkPack({ ...iq, safe: [safe] });
  assert.match(bad({ id: 's', on: { kind: 'click', target: 'Sign in' }, what: 'Sign in only opens the account menu' }).join(), /sign-in or account/);
  assert.match(bad({ id: 's', on: { kind: 'click', target: 'Filter' }, what: 'Filter changes nothing' }).join(), /only opens a picker or a menu/);
  assert.match(bad({ id: 's', on: { kind: 'click', target: 'Certified' }, what: 'Certified only opens a menu' }).join(), /write endorse has the same step/);
  assert.match(bad({ id: 's', on: { kind: 'press', key: 'Enter' }, what: 'Enter only opens the menu' }).join(), /kind: 'click'/);
});
