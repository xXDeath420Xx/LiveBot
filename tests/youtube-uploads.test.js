/*
 * YouTube upload alerts fall back to the channel's Videos and Shorts tabs when the Data API and the RSS feed
 * (404 for every channel since 2026-11-05) cannot answer. These pin the page parsing on both layouts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialData, uploadsFromTab } from '../utils/platforms/youtube-uploads.js';

const lockup = (id, title) => ({ richItemRenderer: { content: { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: title } } } } } } });
const short = (id, title) => ({ richItemRenderer: { content: { shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } }, overlayMetadata: { primaryText: { content: title } } } } } });

test('reads ytInitialData out of a channel page', () => {
    const html = `<html><script>var ytInitialData = {"contents":{"a":1}};</script></html>`;
    assert.deepEqual(initialData(html), { contents: { a: 1 } });
    assert.equal(initialData('<html>nothing</html>'), null);
});

test('videos tab: current lockup layout, in page order, playlists skipped', () => {
    const data = { contents: { tabs: [{ items: [
        lockup('AAAAAAAAAAA', 'Newest'),
        { richItemRenderer: { content: { lockupViewModel: { contentId: 'PLxyz', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } } } },
        lockup('BBBBBBBBBBB', 'Older'),
        lockup('AAAAAAAAAAA', 'Newest again'),
    ] }] } };
    const out = uploadsFromTab(data);
    assert.deepEqual(out.map(u => u.id), ['AAAAAAAAAAA', 'BBBBBBBBBBB']);
    assert.equal(out[0].title, 'Newest');
    assert.equal(out[0].url, 'https://www.youtube.com/watch?v=AAAAAAAAAAA');
    assert.equal(out[0].thumbnail, 'https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg');
    assert.equal(out[0].short, false);
});

test('shorts tab and the older renderers', () => {
    const shorts = uploadsFromTab({ contents: [short('SSSSSSSSSSS', 'A short')] }, { short: true });
    assert.deepEqual(shorts, [{ id: 'SSSSSSSSSSS', title: 'A short', url: 'https://www.youtube.com/shorts/SSSSSSSSSSS', thumbnail: 'https://i.ytimg.com/vi/SSSSSSSSSSS/hqdefault.jpg', description: null, published: null, short: true }]);
    const old = uploadsFromTab({ contents: [{ videoRenderer: { videoId: 'OOOOOOOOOOO', title: { runs: [{ text: 'Old layout' }] } } }] });
    assert.equal(old[0].title, 'Old layout');
});

test('stops at the limit', () => {
    const data = { contents: Array.from({ length: 20 }, (_, i) => lockup(`V${String(i).padStart(10, '0')}`, `t${i}`)) };
    assert.equal(uploadsFromTab(data, { limit: 5 }).length, 5);
});
