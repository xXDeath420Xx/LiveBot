const { test } = require('node:test');
const assert = require('node:assert');
const { validateStreamKey } = require('../src/keys');

function fakeDb(rows) {
  return { query: async () => rows };
}

test('rejects unknown key', async () => {
  const r = await validateStreamKey(fakeDb([]), 'nope');
  assert.deepStrictEqual(r, { ok: false, reason: 'not_found' });
});

test('rejects disabled key', async () => {
  const r = await validateStreamKey(fakeDb([{ id: 1, enabled: 0, expires_at: null }]), 'k');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'disabled');
});

test('rejects expired key', async () => {
  const past = new Date('2000-01-01T00:00:00Z');
  const r = await validateStreamKey(
    fakeDb([{ id: 1, enabled: 1, expires_at: past }]), 'k', Date.now());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'expired');
});

test('accepts enabled, non-expired key', async () => {
  const row = { id: 7, enabled: 1, expires_at: null };
  const r = await validateStreamKey(fakeDb([row]), 'k');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.key.id, 7);
});

test('accepts key whose expiry is in the future', async () => {
  const future = new Date(Date.now() + 3600_000);
  const r = await validateStreamKey(
    fakeDb([{ id: 2, enabled: 1, expires_at: future }]), 'k', Date.now());
  assert.strictEqual(r.ok, true);
});
