import test from 'node:test';
import assert from 'node:assert/strict';
import { launchCommand, profileRoot, defaultBrowser, registryAppPath } from './launch.mjs';

const url = 'http://127.0.0.1:4620/';

test('macOS: an app window in Chrome on the profile', () => {
  assert.deepEqual(launchCommand(url, { profile: 'Profile 10', platform: 'darwin' }),
    ['open', ['-na', 'Google Chrome', '--args', '--profile-directory=Profile 10', `--app=${url}`]]);
  assert.equal(launchCommand(url, { browser: 'edge', platform: 'darwin' })[1][1], 'Microsoft Edge');
});

test('Windows: launch Edge directly, without shell interpolation', () => {
  assert.equal(defaultBrowser('win32'), 'edge');
  assert.deepEqual(launchCommand(url, { profile: 'Profile 10 & test', platform: 'win32', executable: 'C:\\Browser\\msedge.exe' }),
    ['C:\\Browser\\msedge.exe', ['--profile-directory=Profile 10 & test', `--app=${url}`]]);
  assert.equal(launchCommand(url, { browser: 'chrome', platform: 'win32' }), null);
  assert.equal(registryAppPath('    (Default)    REG_SZ    C:\\Program Files\\Edge\\msedge.exe\r\n'), 'C:\\Program Files\\Edge\\msedge.exe');
});

test('profile folders on both', () => {
  assert.match(profileRoot('chrome', 'darwin', {}, '/Users/x'), /Library.Application Support.Google.Chrome$/);
  assert.match(profileRoot('edge', 'win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x'), /Microsoft.Edge.User Data$/);
});

test('Linux: no launcher, print the URL', () => {
  assert.equal(launchCommand(url, { platform: 'linux' }), null);
});
