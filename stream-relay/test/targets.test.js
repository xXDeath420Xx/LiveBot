const { test } = require('node:test');
const assert = require('node:assert');
const { createTargetTracker, redactError, uniqueNames } = require('../src/targets');
const { recordTarget, updateTarget, endTargets } = require('../src/sessions');

function recordingDb() {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    query: async (sql, params) => {
      // Let a later write overtake an earlier one if nothing orders them.
      await new Promise((r) => setTimeout(r, sql.startsWith('UPDATE') && params[0] === 'connecting' ? 15 : 1));
      calls.push({ sql, params });
      if (/^INSERT INTO stream_session_targets/i.test(sql)) return { insertId: nextId++ };
      return {};
    }
  };
}

test('recordTarget inserts one row and returns its id; updateTarget keeps the last error', async () => {
  const db = recordingDb();
  const id = await recordTarget(db, 7, 3, 'twitch', 'connecting');
  assert.strictEqual(id, 100);
  assert.deepStrictEqual(db.calls[0].params, [7, 3, 'twitch', 'connecting', null]);
  await updateTarget(db, id, 'live');
  assert.match(db.calls[1].sql, /COALESCE\(\?, last_error\)/);
  assert.deepStrictEqual(db.calls[1].params, ['live', null, 100]);
  await endTargets(db, 7);
  assert.match(db.calls[2].sql, /state = 'ended'.*state IN \('connecting', 'live'\)/s);
});

test('tracker writes one row per destination and applies state changes in order', async () => {
  const db = recordingDb();
  const t = createTargetTracker(db, 9, { error() {} });
  await t.add({ id: 1, name: 'Twitch', platform: 'twitch' });
  await t.add({ id: null, name: 'YT', platform: 'youtube' }, 'failed', 'Could not start: rtmp://a.rtmp.youtube.com/live2/SECRETKEY refused');
  t.update('Twitch', { state: 'connecting' });
  t.update('Twitch', { state: 'live' });
  t.update('Nope', { state: 'live' }); // unknown destination: ignored
  await t.endAll();
  const inserts = db.calls.filter((c) => c.sql.startsWith('INSERT'));
  assert.strictEqual(inserts.length, 2);
  assert.strictEqual(inserts[1].params[3], 'failed');
  assert.ok(!inserts[1].params[4].includes('SECRETKEY'), 'the stream key in the URL is removed');
  assert.ok(inserts[1].params[4].includes('rtmp://a.rtmp.youtube.com/'), 'the host is kept');
  const updates = db.calls.filter((c) => c.sql.startsWith('UPDATE stream_session_targets SET state = ?'));
  assert.deepStrictEqual(updates.map((u) => u.params[0]), ['connecting', 'live'], 'live lands after connecting');
  assert.ok(db.calls.at(-1).sql.includes("state = 'ended'"), 'endAll closes the rest after pending updates');
});

test('no session id: nothing is written', async () => {
  const db = recordingDb();
  const t = createTargetTracker(db, null);
  await t.add({ id: 1, name: 'A', platform: 'twitch' });
  await t.update('A', { state: 'live' });
  await t.endAll();
  assert.strictEqual(db.calls.length, 0);
});

test('redactError and uniqueNames', () => {
  assert.strictEqual(redactError(null), null);
  assert.strictEqual(redactError('rtmps://live.kick.com:443/app/sk_abc failed'), 'rtmps://live.kick.com:443/… failed');
  assert.strictEqual(redactError('x'.repeat(900)).length, 500);
  const names = uniqueNames([{ name: 'Twitch' }, { name: 'Twitch' }, { platform: 'kick' }]).map((d) => d.name);
  assert.deepStrictEqual(names, ['Twitch', 'Twitch (2)', 'kick']);
});
