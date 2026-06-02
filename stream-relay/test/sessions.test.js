const { test } = require('node:test');
const assert = require('node:assert');
const { createSession, endSession } = require('../src/sessions');

function recordingDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^INSERT INTO stream_sessions/i.test(sql)) return { insertId: 42 };
      if (/^SELECT started_at/i.test(sql)) return [{ started_at: new Date(Date.now() - 5000) }];
      return {};
    }
  };
}

test('createSession inserts and returns the new id', async () => {
  const db = recordingDb();
  const id = await createSession(db, 3, 2);
  assert.strictEqual(id, 42);
  assert.match(db.calls[0].sql, /INSERT INTO stream_sessions/i);
  assert.deepStrictEqual(db.calls[0].params, [3, 2]);
});

test('endSession computes duration and updates the row', async () => {
  const db = recordingDb();
  await endSession(db, 42, 'ended');
  const update = db.calls.find(c => /UPDATE stream_sessions/i.test(c.sql));
  assert.ok(update, 'should issue an UPDATE');
  // params: [duration_seconds, status, error_message, id]
  assert.ok(update.params[0] >= 4 && update.params[0] <= 10);
  assert.strictEqual(update.params[1], 'ended');
  assert.strictEqual(update.params[3], 42);
});
