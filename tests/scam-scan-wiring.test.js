/*
 * Both of these got a real scam post through on 2026-11-02 (guild 961514092848382043), and neither shows
 * up in any single file. The images scored seven signal groups when replayed; nothing read them.
 *
 * 1. checkBlockedImage runs first on every image post and cached { enabled } under the configCache key
 *    getConfig reads, so the scanner got a row with no scan_images and skipped OCR without a log line.
 * 2. A plain number for GuildMemberManager drops keepOverLimit. In a server larger than the limit the bot's
 *    own member is evicted, and Partials.GuildMember replaces it with a blank one that has no roles, so an
 *    Administrator bot reports "I am missing the Moderate Members permission".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LimitedCollection } from 'discord.js';
import { imageAttachments, hasImageAttachment } from '../core/message-images.js';

test('every loader of the shared phishing_config cache key stores the whole row', () => {
  for (const file of ['core/phishing-detection-manager.js', 'core/image-blocklist.js']) {
    const source = fs.readFileSync(file, 'utf8');
    const loaders = source.split("configCache.get('phishing_config'").slice(1);
    assert.ok(loaders.length, `${file} no longer reads the key`);
    for (const loader of loaders) {
      assert.match(loader.slice(0, 300), /SELECT \* FROM phishing_config/, `${file} caches a partial row`);
    }
  }
});

test('the bot keeps its own member when a guild outgrows the member cache', () => {
  const source = fs.readFileSync('core/bot-manager.js', 'utf8');
  const setting = source.match(/GuildMemberManager:\s*\{([^}]*)\}/);
  assert.ok(setting, 'GuildMemberManager needs the object form: a number drops keepOverLimit');
  assert.match(setting[1], /keepOverLimit:\s*\(?\w+\)?\s*=>\s*\w+\.id === \w+\.client\.user\.id/);

  const selfId = '1';
  const members = new LimitedCollection({ maxSize: 2, keepOverLimit: member => member.id === selfId });
  for (const id of [selfId, '2', '3', '4', '5']) members.set(id, { id });
  assert.ok(members.has(selfId));
});

test('forwarded images reach the image scanners', () => {
  const image = { name: 'scam.jpg', contentType: 'image/jpeg', url: 'https://cdn.test/scam.jpg' };
  const forward = {
    attachments: new Map(),
    messageSnapshots: new Map([['1', { attachments: new Map([['2', image]]) }]]),
  };
  assert.deepEqual(imageAttachments(forward), [image]);
  assert.equal(hasImageAttachment(forward), true);

  for (const file of ['core/phishing-detection-manager.js', 'core/image-blocklist.js']) {
    const source = fs.readFileSync(file, 'utf8');
    const checkOnly = source.slice(0, source.includes('export async function learnScamImages') ? source.indexOf('export async function learnScamImages') : source.length);
    assert.doesNotMatch(checkOnly, /message\.attachments\.values\(\)/, `${file} reads attachments without the forwards`);
  }
});

test('checkSpam defines the content it reads', () => {
  const source = fs.readFileSync('core/advanced-automod-manager.js', 'utf8');
  const body = source.slice(source.indexOf('async checkSpam(message)'), source.indexOf('async executeSpamAction'));
  assert.match(body, /const content = effectiveContent\(message\)/);
});
