import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normaliseForSimilarity, similarity, CrossChannelTracker, attachmentKey } from '../core/spam-similarity.js';

// What the old detector did, for comparison.
const exactHash = c => crypto.createHash('sha256')
  .update(String(c).toLowerCase().replace(/https?:\/\/\S+/g, '[URL]').replace(/\s+/g, ' ').trim())
  .digest('hex').slice(0, 16);

const AD = 'Free nitro giveaway!! Join now https://scam.example/a';
const VARIANTS = [
  'Free nitro giveaway!! Join now https://scam.example/b',      // different link
  'free nitro giveaway!!! join now 🎉 https://scam.example/c',   // emoji + punctuation
  'Free nitro giveaway! Join now guys https://scam.example/d',   // inserted word
  'FREE NITRO GIVEAWAY!! join now <@123> https://scam.example/e', // mention + caps
];

test('the old exact hash misses the variations that matter', () => {
  // It normalises URLs, so a bare link swap IS caught...
  assert.equal(exactHash(AD), exactHash(VARIANTS[0]), 'link-only swap should hash the same');
  // ...but an emoji, an inserted word or a mention puts each copy in its own bucket, where
  // nothing ever looks repeated. That is the gap.
  for (const v of VARIANTS.slice(1)) {
    assert.notEqual(exactHash(AD), exactHash(v), `unexpectedly identical: ${v}`);
  }
});

test('near-duplicate matching catches all of them', () => {
  for (const v of VARIANTS) {
    const s = similarity(AD, v);
    assert.ok(s >= 0.65, `similarity ${s.toFixed(2)} too low for: ${v}`);
  }
});

test('genuinely different messages stay apart', () => {
  const pairs = [
    ['anyone up for some rocket league tonight', 'what time does the stream start'],
    ['gm everyone', 'good luck on the raid tonight team'],
    ['Free nitro giveaway!! Join now', 'the nitro gift you sent me worked thanks'],
  ];
  for (const [a, b] of pairs) {
    const s = similarity(a, b);
    assert.ok(s < 0.65, `false match (${s.toFixed(2)}): "${a}" vs "${b}"`);
  }
});

test('normalisation strips what a spammer varies for free', () => {
  assert.equal(normaliseForSimilarity('Join HERE!! 🎉 https://x.com/a <@123>'), 'join here url mention');
});

test('identical short messages still match', () => {
  assert.equal(similarity('gm', 'gm'), 1);
  assert.ok(similarity('join now', 'join now!') >= 0.65);
});

// ── the tracker ─────────────────────────────────────────────────────────────
test('a varied ad across channels is recognised as one cluster', () => {
  const t = new CrossChannelTracker();
  let r;
  r = t.add('g', 'u', 'c1', AD);
  assert.equal(r.count, 1, 'first post is not yet a cluster');
  r = t.add('g', 'u', 'c2', VARIANTS[0]);
  assert.equal(r.count, 2);
  r = t.add('g', 'u', 'c3', VARIANTS[1]);
  assert.equal(r.count, 3, 'emoji variant should join the cluster');
  r = t.add('g', 'u', 'c4', VARIANTS[3]);
  assert.equal(r.count, 4);
  assert.ok(r.similarity >= 0.65);
});

test('reposting in the SAME channel is not multi-channel spam', () => {
  const t = new CrossChannelTracker();
  t.add('g', 'u', 'c1', AD);
  const r = t.add('g', 'u', 'c1', VARIANTS[0]);
  assert.equal(r.count, 1, 'same channel must not inflate the channel count');
  assert.ok(r.matches >= 1, 'but it is still recognised as a repeat');
});

test('unrelated chatter across channels is not a cluster', () => {
  const t = new CrossChannelTracker();
  t.add('g', 'u', 'c1', 'anyone want to play some valorant');
  t.add('g', 'u', 'c2', 'the patch notes are out today');
  const r = t.add('g', 'u', 'c3', 'happy birthday hope you have a great one');
  assert.equal(r.count, 1);
});

test('posts outside the window do not count', () => {
  const t = new CrossChannelTracker({ windowMs: 60_000 });
  const t0 = 1_000_000;
  t.add('g', 'u', 'c1', AD, { now: t0 });
  const r = t.add('g', 'u', 'c2', AD, { now: t0 + 120_000 });
  assert.equal(r.count, 1, 'a repeat two minutes later is outside a one-minute window');
});

test('users are tracked separately', () => {
  const t = new CrossChannelTracker();
  t.add('g', 'u1', 'c1', AD);
  const r = t.add('g', 'u2', 'c2', AD);
  assert.equal(r.count, 1, "another user's identical post is not this user's cluster");
});

test('guilds are tracked separately', () => {
  const t = new CrossChannelTracker();
  t.add('g1', 'u', 'c1', AD);
  const r = t.add('g2', 'u', 'c2', AD);
  assert.equal(r.count, 1);
});

test('per-user history is bounded and prunes', () => {
  const t = new CrossChannelTracker({ maxPostsPerUser: 3, windowMs: 60_000 });
  for (let i = 0; i < 10; i++) t.add('g', 'u', `c${i}`, `message number ${i} here`);
  assert.ok(t.users.get('g:u').length <= 3);
  t.prune(Date.now() + 120_000);
  assert.equal(t.users.size, 0, 'stale users are dropped');
});

test('forget clears a cleared member', () => {
  const t = new CrossChannelTracker();
  t.add('g', 'u', 'c1', AD);
  t.forget('g', 'u');
  assert.equal(t.add('g', 'u', 'c2', AD).count, 1);
});

test('empty content is safe', () => {
  const t = new CrossChannelTracker();
  assert.doesNotThrow(() => t.add('g', 'u', 'c1', ''));
  assert.doesNotThrow(() => t.add('g', 'u', 'c1', null));
});

// ── absence of evidence is not evidence ─────────────────────────────────────
// Normalisation deliberately erases what a spammer varies for free. The failure mode is reading
// what is left over as a MATCH when nothing distinguishing survived — the same mistake the
// character-spam filter made when it counted spaces, where a property every ordinary message has
// was treated as a signal.
test('messages with nothing comparable left do not match each other', () => {
  const noEvidence = [
    ['🎉', '👍'],                                        // different emoji
    ['<@123>', '<@999>'],                                // different people
    ['<#111>', '<#222>'],                                // different channels
    ['https://one.example/a', 'https://other.example/b'], // different links entirely
    ['', ''],                                            // image-only posts
  ];
  for (const [a, b] of noEvidence) {
    assert.equal(similarity(a, b), 0, `"${a}" and "${b}" should carry no similarity evidence`);
  }
});

test('a distinguishing word still makes placeholders count', () => {
  // The placeholder collapse is the whole point when there IS content around it: the same ad with
  // a swapped link must still cluster.
  assert.ok(similarity('join now https://a.example', 'join now https://b.example') >= 0.65);
  assert.ok(similarity('welcome <@1>', 'welcome <@2>') >= 0.65);
  assert.equal(normaliseForSimilarity('Join HERE!! 🎉 https://x.com/a <@123>'), 'join here url mention');
});

test('a member dropping different emoji in several channels is not a cluster', () => {
  // The concrete regression: this scored 1.00 per pair and produced a 3-channel "near-identical"
  // cluster for someone reacting in three places.
  const t = new CrossChannelTracker();
  t.add('g', 'u', 'c1', '🎉');
  t.add('g', 'u', 'c2', '👍');
  const r = t.add('g', 'u', 'c3', '😂');
  assert.equal(r.count, 1, `expected no cluster, got ${r.count} channels`);
});

test('the same ad in several channels is still a cluster', () => {
  const t = new CrossChannelTracker();
  t.add('g', 'u', 'c1', 'free nitro giveaway join now https://a.example');
  t.add('g', 'u', 'c2', 'free nitro giveaway!! join now https://b.example');
  const r = t.add('g', 'u', 'c3', 'FREE nitro giveaway join now guys https://c.example');
  assert.equal(r.count, 3);
});

// ── image-only cross-posting ────────────────────────────────────────────────
test('the same attachments re-uploaded key identically', () => {
  // What the scam waves do: one file, uploaded again into each channel. Discord issues a new
  // attachment id and CDN URL every time, but the name, size and dimensions travel with the file.
  const file = { name: 'image_hz6nkq.png', size: 184213, width: 826, height: 1130 };
  assert.equal(attachmentKey([file]), attachmentKey([{ ...file }]));
});

test('different pictures do NOT key the same', () => {
  // The regression that made wordless posts get skipped: every image-only post shared one hash, so
  // a member posting four unrelated pictures in four channels read as a spammer. These must differ.
  const a = attachmentKey([{ name: 'holiday.png', size: 184213, width: 826, height: 1130 }]);
  const b = attachmentKey([{ name: 'dog.png', size: 184213, width: 826, height: 1130 }]);
  const c = attachmentKey([{ name: 'holiday.png', size: 99001, width: 826, height: 1130 }]);
  const d = attachmentKey([{ name: 'holiday.png', size: 184213, width: 640, height: 480 }]);
  assert.equal(new Set([a, b, c, d]).size, 4, 'distinct images collapsed to the same key');
});

test('attachment order does not change the key', () => {
  const one = { name: 'a.png', size: 10, width: 1, height: 2 };
  const two = { name: 'b.png', size: 20, width: 3, height: 4 };
  assert.equal(attachmentKey([one, two]), attachmentKey([two, one]));
});

test('a post with no attachments has no key', () => {
  assert.equal(attachmentKey([]), null);
  assert.equal(attachmentKey(null), null);
});

test('image-only spam clusters across channels, ordinary sharing does not', () => {
  // Ten channels, one file -> a cluster. Four channels, four different pictures -> nothing.
  const scam = { name: 'image_hz6nkq.png', size: 184213, width: 826, height: 1130 };
  const scamKey = attachmentKey([scam]);
  const spread = new Set();
  for (const ch of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) spread.add(`${scamKey}:${ch}`);
  assert.equal(spread.size, 6);

  const holiday = ['beach.png', 'sunset.png', 'dinner.png', 'dog.png']
    .map(name => attachmentKey([{ name, size: 500000 + name.length, width: 1200, height: 900 }]));
  assert.equal(new Set(holiday).size, 4, 'four different pictures must not share a cluster key');
});
