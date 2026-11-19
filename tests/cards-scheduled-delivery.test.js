/**
 * Greeting cards with a delivery date (cards-create "Delivery date"). jobs/birthday-scheduler.js used
 * to deliver them only when the bot started, and marked a server-connected card delivered before
 * looking for an undelivered card to post, so those were never posted. deliverScheduledCards() now
 * runs every 15 minutes; these tests drive it with a fake database and Discord client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliverScheduledCards } from '../jobs/birthday-scheduler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {} };

function fakeDb(cards, { config = null, signatures = 3, claimed = new Set() } = {}) {
    const calls = [];
    return {
        calls,
        async execute(sql, params = []) {
            calls.push([sql, params]);
            if (/^SELECT \* FROM birthday_cards/.test(sql)) return [cards];
            if (/^UPDATE birthday_cards SET is_posted = 1/.test(sql)) {
                const id = params[0];
                if (claimed.has(id)) return [{ affectedRows: 0 }];
                claimed.add(id);
                return [{ affectedRows: 1 }];
            }
            if (/birthday_card_signatures/.test(sql)) return [[{ c: signatures }]];
            if (/FROM birthday_config/.test(sql)) return [[config].filter(Boolean)];
            throw new Error('unexpected SQL ' + sql);
        }
    };
}

function fakeBots() {
    const sentTo = [];
    const channel = (id) => ({ id, send: async (msg) => { sentTo.push({ channel: id, msg }); return {}; } });
    const user = (id) => ({ id, send: async (msg) => { sentTo.push({ user: id, msg }); return {}; } });
    const client = {
        channels: { fetch: async (id) => channel(id) },
        users: { fetch: async (id) => user(id) }
    };
    return { sentTo, botManager: { getClientForGuild: () => client, getDefaultClient: () => client } };
}

test('a connected card is posted in its signing channel, mentioning the recipient', async () => {
    const db = fakeDb([{ id: 7, guild_id: '1', user_id: '42', signing_channel_id: '900', slug: 'happy-b', card_name: 'Happy birthday, Sam', recipient_name: 'Sam' }]);
    const { sentTo, botManager } = fakeBots();
    const n = await deliverScheduledCards({ db, botManager, log: quiet, baseUrl: 'https://example.test/' });
    assert.equal(n, 1);
    assert.equal(sentTo.length, 1);
    assert.equal(sentTo[0].channel, '900');
    assert.equal(sentTo[0].msg.content, '<@42>');
    assert.deepEqual(sentTo[0].msg.allowedMentions, { users: ['42'] });
    const button = sentTo[0].msg.components[0].toJSON().components[0];
    assert.equal(button.url, 'https://example.test/card/happy-b');
    assert.equal(sentTo[0].msg.embeds[0].toJSON().description, '3 people signed it.');
});

test('without a signing channel the server announcement channel is used', async () => {
    const db = fakeDb([{ id: 8, guild_id: '1', user_id: null, signing_channel_id: null, share_token: 'tok' }], { config: { announcement_channel_id: '555', card_channel_id: '556' } });
    const { sentTo, botManager } = fakeBots();
    await deliverScheduledCards({ db, botManager, log: quiet });
    assert.equal(sentTo[0].channel, '555');
    assert.equal(sentTo[0].msg.content, undefined, 'no recipient, no mention');
});

test('a card that is not connected goes to its creator as a DM', async () => {
    const db = fakeDb([{ id: 9, guild_id: null, creator_user_id: '77', slug: 's', card_name: 'Congrats', recipient_name: 'Ana' }], { signatures: 1 });
    const { sentTo, botManager } = fakeBots();
    assert.equal(await deliverScheduledCards({ db, botManager, log: quiet }), 1);
    assert.equal(sentTo[0].user, '77');
    assert.match(sentTo[0].msg.embeds[0].toJSON().description, /1 person signed it\. Send the link to Ana\./);
});

test('every due card is claimed once, so a second run sends nothing again', async () => {
    const cards = [{ id: 10, guild_id: null, creator_user_id: '77', slug: 'x' }, { id: 11, guild_id: null, creator_user_id: null, slug: 'y' }];
    const claimed = new Set();
    const { sentTo, botManager } = fakeBots();
    await deliverScheduledCards({ db: fakeDb(cards, { claimed }), botManager, log: quiet });
    await deliverScheduledCards({ db: fakeDb(cards, { claimed }), botManager, log: quiet });
    assert.deepEqual([...claimed].sort(), [10, 11], 'the logged-out card is closed too');
    assert.equal(sentTo.length, 1);
});

test('the scheduler runs delivery every 15 minutes, not only at startup', () => {
    const src = fs.readFileSync(path.join(root, 'jobs/birthday-scheduler.js'), 'utf8');
    const cron15 = src.slice(src.indexOf("cron.schedule('*/15 * * * *'"), src.indexOf("birthdayCheckTask = cron.schedule("));
    assert.match(cron15, /deliverScheduledCards\(\)/);
    assert.doesNotMatch(src, /postBirthdayCard\(card\.user_id/, 'old path that never found the card is gone');
});
