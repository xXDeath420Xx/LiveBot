/*
 * These assertions are the 2026-09-13 post-mortem in executable form.
 *
 * Four screenshots of a fake crypto casino reached nine channels in twenty-one seconds while both
 * image scanners stood down. The classifier scores those pictures at seven signal groups — the
 * pixels were never in question. What decided the outcome was one line of metadata handling:
 * `a.contentType?.startsWith('image/')`, with a size cap behind it. An attachment whose declared
 * type was missing, or whose declared size was large, was not an image as far as the scanners were
 * concerned, and the resulting no-op was indistinguishable from a completed clean scan.
 *
 * So the cases below are not hypotheticals about odd clients. They are the shapes that turn every
 * downstream content check off, which is exactly why they belong in a test rather than in a comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageAttachment, imageAttachments, hasImageAttachment } from '../core/message-images.js';

test('a declared image content type is an image', () => {
  assert.equal(isImageAttachment({ contentType: 'image/png', name: 'a.png' }), true);
  assert.equal(isImageAttachment({ contentType: 'IMAGE/JPEG' }), true);
});

test('a missing or wrong content type does not hide an image', () => {
  // The whole incident in one assertion.
  assert.equal(isImageAttachment({ name: 'photo_2026-09-04_22-28-11.png' }), true);
  assert.equal(isImageAttachment({ contentType: null, name: '1787155813368.PNG' }), true);
  assert.equal(isImageAttachment({ contentType: 'application/octet-stream', name: 'x.jpg' }), true);
});

test('dimensions alone are enough — Discord fills them in only for images it decoded', () => {
  assert.equal(isImageAttachment({ width: 1080, height: 1920 }), true);
  assert.equal(isImageAttachment({ contentType: null, name: 'no-extension', width: 800, height: 600 }), true);
});

test('size is not part of the decision', () => {
  // A picture too big for one scanner's buffer is still a picture; each scanner caps its own
  // download. Skipping it here made "too large" mean "innocent".
  assert.equal(isImageAttachment({ contentType: 'image/png', size: 40 * 1024 * 1024 }), true);
});

test('non-images stay out', () => {
  for (const att of [
    { contentType: 'text/plain', name: 'notes.txt' },
    { contentType: 'video/mp4', name: 'clip.mp4' },
    { name: 'archive.zip' },
    { name: 'song.mp3', width: 0, height: 0 },
    {}, null, undefined,
  ]) {
    assert.equal(isImageAttachment(att), false, `expected non-image: ${JSON.stringify(att)}`);
  }
});

test('an extension inside the name does not count — only the ending does', () => {
  assert.equal(isImageAttachment({ name: 'png.exe' }), false);
  assert.equal(isImageAttachment({ name: 'my.jpg.zip' }), false);
});

test('imageAttachments keeps message order and drops the rest', () => {
  const message = {
    attachments: {
      values: () => [
        { name: 'one.png' },
        { name: 'readme.txt' },
        { contentType: 'image/webp', name: 'two' },
        { width: 10, height: 10, name: 'three' },
      ],
    },
  };
  assert.deepEqual(imageAttachments(message).map(a => a.name), ['one.png', 'two', 'three']);
  assert.equal(hasImageAttachment(message), true);
});

test('a message with no attachments is handled without throwing', () => {
  assert.deepEqual(imageAttachments({}), []);
  assert.deepEqual(imageAttachments(null), []);
  assert.equal(hasImageAttachment({ attachments: { values: () => [] } }), false);
});
