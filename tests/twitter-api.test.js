import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Tweets come from FxTwitter's profile timeline (the Nitter RSS mirrors are mostly gone). The feed
 * relies on the converted shape: id/text/author/created_at/url, media typed 'photo'|'video',
 * is_retweet/is_reply for its filters, and metrics.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
process.env.LOG_DIR ||= tmp;
const { fxStatusToTweet } = await import('../utils/platforms/twitter-api.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('an own post converts to the feed shape', () => {
    const t = fxStatusToTweet({
        id: '2107216803294495034', url: 'https://x.com/wolfzgangz/status/2107216803294495034', text: 'Fortnitemares glitch?',
        author: { screen_name: 'wolfzgangz', name: 'Wolfzgangz', avatar_url: 'https://pbs.twimg.com/a.jpg' },
        created_timestamp: 1791234610, likes: 3, reposts: 1, replies: 2, replying_to: null, reposted_by: null,
        media: { photos: [{ url: 'https://pbs.twimg.com/media/x.jpg' }], videos: [{ url: 'https://video.twimg.com/v.mp4', thumbnail_url: 'https://pbs.twimg.com/t.jpg' }] },
    }, 'wolfzgangz');
    assert.equal(t.id, '2107216803294495034');
    assert.equal(t.author.username, 'wolfzgangz');
    assert.equal(t.created_at, new Date(1791234610 * 1000).toISOString());
    assert.deepEqual(t.media.map(m => m.type), ['photo', 'video']);
    assert.deepEqual([t.is_retweet, t.is_reply], [false, false]);
    assert.deepEqual(t.metrics, { likes: 3, retweets: 1, replies: 2 });
});

test('a repost keeps the original author and is marked as a retweet; replies are marked too', () => {
    const rt = fxStatusToTweet({ id: '1', text: 'leak', author: { screen_name: 'HYPEX', name: 'HYPEX' }, created_timestamp: 1,
        reposted_by: { screen_name: 'wolfzgangz' } }, 'wolfzgangz');
    assert.equal(rt.is_retweet, true);
    assert.equal(rt.author.username, 'HYPEX');
    assert.equal(rt.url, 'https://x.com/HYPEX/status/1');
    const reply = fxStatusToTweet({ id: '2', text: '@x hi', author: { screen_name: 'wolfzgangz' }, replying_to: { screen_name: 'x' } }, 'wolfzgangz');
    assert.equal(reply.is_reply, true);
    assert.deepEqual(reply.media, []);
});
