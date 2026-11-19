import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    extensionOf, isImageAttachment, sanitizeFilename, filenameFromUrl, isSignedUrlExpired, trimUrl,
    uploadLimitBytes, packBatches, resolveCachePath, clampMaxMb,
} from '../core/evidence-helpers.js';

const CDN = 'https://cdn.discordapp.com/attachments/1/2/20261005_081204.jpg?backend=b2&ex=6ac4f60c&is=6ac3a48c&hm=abc&';

test('image detection prefers the content type, falls back to the extension', () => {
    assert.equal(isImageAttachment({ contentType: 'image/png', name: 'x.bin' }), true);
    assert.equal(isImageAttachment({ contentType: 'video/mp4', name: 'x.png' }), false);
    assert.equal(isImageAttachment({ name: 'photo.JPG' }), true);
    assert.equal(isImageAttachment({ url: CDN }), true);
    assert.equal(isImageAttachment({ url: 'https://cdn.discordapp.com/attachments/1/2/save.hvd?ex=1' }), false);
    assert.equal(isImageAttachment(null), false);
    assert.equal(extensionOf(CDN), '.jpg');
});

test('filenames are made safe and never escape a directory', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('my photo (1).png'), 'my_photo_1_.png');
    assert.equal(sanitizeFilename('...hidden'), 'hidden');
    assert.equal(sanitizeFilename(''), 'attachment');
    assert.equal(filenameFromUrl(CDN), '20261005_081204.jpg');
    assert.equal(filenameFromUrl('not a url'), 'attachment');
});

test('signed CDN links expire on their ex= timestamp', () => {
    const ex = parseInt('6ac4f60c', 16) * 1000;
    assert.equal(isSignedUrlExpired(CDN, ex - 1000), false);
    assert.equal(isSignedUrlExpired(CDN, ex + 1000), true);
    assert.equal(isSignedUrlExpired('https://example.com/a.png', Date.now()), false);
});

test('URLs are kept whole when they fit, query stripped when they do not', () => {
    assert.equal(trimUrl(CDN), CDN);
    const long = `https://x.test/a.png?${'q'.repeat(600)}`;
    assert.equal(trimUrl(long), 'https://x.test/a.png');
    assert.equal(trimUrl(null), null);
});

test('upload batches respect the boost-tier limit and ten files per message', () => {
    assert.ok(uploadLimitBytes(0) < 10 * 1024 * 1024);
    assert.ok(uploadLimitBytes(3) > 90 * 1024 * 1024);
    const MB = 1024 * 1024;
    const files = [{ size: 4 * MB }, { size: 4 * MB }, { size: 4 * MB }, { size: 20 * MB }, ...Array.from({ length: 12 }, () => ({ size: 1000 }))];
    const { batches, tooLarge } = packBatches(files, 9 * MB, 10);
    assert.equal(tooLarge.length, 1);
    assert.ok(batches.every(b => b.length <= 10));
    assert.ok(batches.every(b => b.reduce((s, f) => s + f.size, 0) <= 9 * MB));
    assert.equal(batches.flat().length, 15);
});

test('cache paths from the database cannot escape the cache directory', () => {
    const base = path.resolve('/tmp/evidence-cache');
    assert.equal(resolveCachePath(base, '123/456-789.png'), path.join(base, '123', '456-789.png'));
    assert.equal(resolveCachePath(base, '../../etc/passwd'), null);
    assert.equal(resolveCachePath(base, ''), null);
});

test('per-file size limit is clamped to 1..25 MB', () => {
    assert.equal(clampMaxMb(null), 8);
    assert.equal(clampMaxMb(0), 8);
    assert.equal(clampMaxMb(3.7), 3);
    assert.equal(clampMaxMb(500), 25);
});
