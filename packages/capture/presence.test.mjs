import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presenceBody } from './presence.mjs';

const ME = '00000000-0000-0000-0000-0000000000aa', OTHER = '00000000-0000-0000-0000-0000000000bb';

test("her own entry reads as her recording's status; everyone else's stays as it is", () => {
  const body = JSON.stringify([
    { mri: `8:orgid:${ME}`, presence: { availability: 'Away', activity: 'Away', deviceType: 'Desktop' } },
    { mri: `8:orgid:${OTHER}`, presence: { availability: 'Busy', activity: 'InAMeeting' } },
  ]);
  const r = presenceBody(body, [ME], 'Available');
  assert.equal(r.ok, true);
  assert.equal(r.changed, 2);
  const out = JSON.parse(r.body);
  assert.deepEqual(out[0].presence, { availability: 'Available', activity: 'Available', deviceType: 'Desktop' });
  assert.deepEqual(out[1].presence, { availability: 'Busy', activity: 'InAMeeting' });
});

test('flat entries, upper-case ids, and an answer that names her outside an entry', () => {
  const body = JSON.stringify({ requester: `8:orgid:${ME}`, presences: [{ id: ME.toUpperCase(), availability: 'Offline', activity: 'OffWork' }, { id: OTHER, availability: 'DoNotDisturb', activity: 'Presenting' }] });
  const out = JSON.parse(presenceBody(body, [ME], 'Available').body);
  assert.deepEqual(out.presences[0], { id: ME.toUpperCase(), availability: 'Available', activity: 'Available' });
  assert.deepEqual(out.presences[1], { id: OTHER, availability: 'DoNotDisturb', activity: 'Presenting' });
});

test('nothing of hers, or already as recorded: the body as it came; not JSON: not touched', () => {
  const other = JSON.stringify([{ mri: `8:orgid:${OTHER}`, presence: { availability: 'Away' } }]);
  assert.deepEqual(presenceBody(other, [ME], 'Available'), { ok: true, body: other, changed: 0 });
  const mine = JSON.stringify([{ mri: `8:orgid:${ME}`, presence: { availability: 'Available', activity: 'Available' } }]);
  assert.equal(presenceBody(mine, [ME], 'Available').body, mine);
  assert.equal(presenceBody('<html>', [ME], 'Available').ok, false);
  assert.equal(presenceBody(other, [], 'Available').changed, 0);
});
