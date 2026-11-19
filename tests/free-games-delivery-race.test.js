/* Does a claim-first ledger actually stop two concurrent passes double-posting? */
import assert from 'node:assert/strict';
import test from 'node:test';

// Stand-in for the table's UNIQUE(subscription_id, announcement_id).
class Ledger {
  constructor() { this.rows = new Set(); }
  async claim(sub, ann) {
    const k = `${sub}:${ann}`;
    await new Promise(r => setImmediate(r));      // force interleaving
    if (this.rows.has(k)) return false;
    this.rows.add(k);
    return true;
  }
  async has(sub, ann) { await new Promise(r => setImmediate(r)); return this.rows.has(`${sub}:${ann}`); }
  async record(sub, ann) { this.rows.add(`${sub}:${ann}`); }
  async release(sub, ann) { this.rows.delete(`${sub}:${ann}`); }
}

const SUBS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

async function passOld(ledger, posted, failOn = new Set()) {
  for (const s of SUBS) {
    if (await ledger.has(s, 99)) continue;
    posted.push(s);                                // the message lands here
    await new Promise(r => setTimeout(r, 1));      // ledger write happens later
    if (failOn.has(s)) continue;
    await ledger.record(s, 99);
  }
}

async function passNew(ledger, posted, failOn = new Set()) {
  for (const s of SUBS) {
    if (!await ledger.claim(s, 99)) continue;
    if (failOn.has(s)) { await ledger.release(s, 99); continue; }
    posted.push(s);
    await new Promise(r => setTimeout(r, 1));
  }
}

test('the old check-then-post loses the race', async () => {
  const l = new Ledger(), posted = [];
  await Promise.all([passOld(l, posted), passOld(l, posted)]);
  const dupes = SUBS.filter(s => posted.filter(x => x === s).length > 1);
  assert.ok(dupes.length > 0, 'expected the old shape to double-post');
  console.log(`   old: ${posted.length} posts for ${SUBS.length} subscriptions — ${dupes.length} doubled`);
});

test('claim-first posts exactly once per subscription under concurrency', async () => {
  const l = new Ledger(), posted = [];
  await Promise.all([passNew(l, posted), passNew(l, posted), passNew(l, posted)]);
  assert.equal(posted.length, SUBS.length);
  assert.deepEqual([...new Set(posted)].sort((a, b) => a - b), SUBS);
  console.log(`   new: ${posted.length} posts for ${SUBS.length} subscriptions — none doubled`);
});

test('a failed send releases the slot so a retry still delivers', async () => {
  const l = new Ledger(), posted = [];
  await passNew(l, posted, new Set([3, 7]));       // 3 and 7 fail
  assert.deepEqual(posted, [1, 2, 4, 5, 6, 8, 9, 10]);
  await passNew(l, posted);                        // the retry
  assert.deepEqual(posted.filter(x => x === 3 || x === 7), [3, 7]);
  assert.equal(posted.length, SUBS.length, 'retry must not re-post to anyone else');
  console.log('   failed sends retried once, everyone else untouched');
});
