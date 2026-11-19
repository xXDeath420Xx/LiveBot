// H-311: live-post edit governor (utils/announcement-edit-governor.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditGovernor, parseUnexpected429 } from '../utils/announcement-edit-governor.js';

function setup(opts = {}) {
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms) => { t += ms; } };
    const g = createEditGovernor({ now: clock.now, ...opts });
    return { g, clock };
}
const ctx = (messageId, channelId = 'c1', botKey = 'b1') => ({ messageId, channelId, botKey });
const editOnce = (g, c, fp) => {
    const v = g.check({ ...c, ...fp });
    if (v.ok) { g.begin(c); g.recordApplied(c.messageId, fp); g.end(c); }
    return v;
};

test('an unchanged post is not edited', () => {
    const { g } = setup();
    assert.equal(editOnce(g, ctx('m1'), { major: 'A', minor: '1' }).ok, true);
    assert.deepEqual(g.check({ ...ctx('m1'), major: 'A', minor: '1' }), { ok: false, reason: 'unchanged' });
});

test('viewer-count / preview-only changes wait minRefreshMs; a title change goes straight out', () => {
    const { g, clock } = setup();
    editOnce(g, ctx('m1'), { major: 'A', minor: '1' });
    clock.advance(60_000);
    assert.equal(g.check({ ...ctx('m1'), major: 'A', minor: '2' }).reason, 'refreshed-recently');
    assert.equal(g.check({ ...ctx('m1'), major: 'B', minor: '2' }).ok, true);
    clock.advance(3 * 60_000);
    assert.equal(g.check({ ...ctx('m1'), major: 'A', minor: '2' }).ok, true);
});

test('one edit per channel at a time; a stale one stops blocking after 10 minutes', () => {
    const { g, clock } = setup();
    assert.equal(g.check({ ...ctx('m1'), major: 'A' }).ok, true);
    g.begin(ctx('m1'));
    assert.equal(g.check({ ...ctx('m1'), major: 'B' }).reason, 'message-in-flight');
    assert.equal(g.check({ ...ctx('m2'), major: 'A' }).reason, 'channel-busy');
    assert.equal(g.check({ ...ctx('m3', 'c2'), major: 'A' }).ok, true, 'other channels are not affected');
    assert.equal(g.check({ ...ctx('m3', 'c1', 'b2'), major: 'A' }).ok, true, 'other bots are not affected');
    clock.advance(10 * 60_000 + 1);
    assert.equal(g.check({ ...ctx('m2'), major: 'A' }).ok, true);
});

test('end() frees the channel', () => {
    const { g } = setup();
    g.begin(ctx('m1'));
    g.end(ctx('m1'));
    assert.equal(g.check({ ...ctx('m2'), major: 'A' }).ok, true);
});

test('Discord rate limits hold edits back until Retry-After has passed', () => {
    const { g, clock } = setup();
    g.noteRateLimit({ botKey: 'b1', channelId: 'c1', retryAfterMs: 30_000 });
    const v = g.check({ ...ctx('m1'), major: 'A' });
    assert.equal(v.reason, 'rate-limited');
    assert.ok(v.waitMs > 29_000);
    clock.advance(27_500); // within the 3 s slack: let it through
    assert.equal(g.check({ ...ctx('m1'), major: 'A' }).ok, true);
    g.noteRateLimit({ botKey: 'b1', global: true, retryAfterMs: 60_000 });
    assert.equal(g.check({ ...ctx('m9', 'c7'), major: 'A' }).reason, 'rate-limited');
    assert.equal(g.check({ ...ctx('m9', 'c7', 'b2'), major: 'A' }).ok, true, 'a global limit is per bot');
});

test('at most channelMaxEdits edits per channel per window', () => {
    const { g, clock } = setup();
    for (let i = 0; i < 6; i++) {
        assert.equal(editOnce(g, ctx(`m${i}`), { major: 'A' }).ok, true);
        clock.advance(1_000);
    }
    const v = g.check({ ...ctx('m6'), major: 'A' });
    assert.equal(v.reason, 'channel-budget');
    clock.advance(60_000);
    assert.equal(g.check({ ...ctx('m6'), major: 'A' }).ok, true);
});

test('parseUnexpected429 reads @discordjs/rest\'s debug text', () => {
    const msg = '[REST 7c7f...:1240282619820642324] ' + [
        'Encountered unexpected 429 rate limit',
        '  Global         : false',
        '  Method         : PATCH',
        '  URL            : https://discord.com/api/v10/channels/1240282619820642324/messages/1',
        '  Bucket         : /channels/:id/messages/:id',
        '  Major parameter: 1240282619820642324',
        '  Hash           : abc',
        '  Limit          : 5',
        '  Retry After    : 43210ms',
        '  Sublimit       : 43210ms',
        '  Scope          : shared',
    ].join('\n');
    assert.deepEqual(parseUnexpected429(msg), {
        global: false, method: 'PATCH', route: '/channels/:id/messages/:id', majorParameter: '1240282619820642324',
        retryAfterMs: 43210, sublimitMs: 43210, scope: 'shared',
    });
    assert.equal(parseUnexpected429('Waiting 200ms for rate limit to pass'), null);
});

test('describe() says why a post is stuck', () => {
    const { g, clock } = setup();
    g.begin(ctx('m1'));
    clock.advance(75_000);
    g.noteRateLimit({ botKey: 'b1', channelId: 'c1', retryAfterMs: 12_000 });
    const text = g.describe(ctx('m1'));
    assert.match(text, /edit of this message has been running 75s/);
    assert.match(text, /rate limit for 12s more/);
});
