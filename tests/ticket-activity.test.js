import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replyColumn, createTicketActivity } from '../core/ticket-activity.js';

/*
 * "Waiting on staff" on the Tickets page: tickets.last_user_reply_at / last_staff_reply_at are moved
 * by messages in open ticket channels (core/ticket-activity.js, called from events/messageCreate.js).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const msg = (channelId, authorId, bot = false) => ({ guild: { id: 'g' }, channel: { id: channelId }, author: { id: authorId, bot } });

test('the opener moves last_user_reply_at, anyone else last_staff_reply_at, bots nothing', () => {
    assert.equal(replyColumn('111', '111', false), 'last_user_reply_at');
    assert.equal(replyColumn('111', '222', false), 'last_staff_reply_at');
    assert.equal(replyColumn('111', '111', true), null);
    assert.equal(replyColumn('111', null, false), null);
});

test('messages in open ticket channels are recorded; other channels are not', async () => {
    const touched = [];
    let loads = 0;
    const t = createTicketActivity({
        loadOpen: async () => { loads++; return [{ id: 7, channel_id: '900', user_id: '111' }]; },
        touch: async (id, col) => { touched.push([id, col]); },
        now: () => 1_000_000,
    });
    assert.equal(await t.note(msg('900', '111')), 'last_user_reply_at');
    assert.equal(await t.note(msg('900', '222')), 'last_staff_reply_at');
    assert.equal(await t.note(msg('901', '111')), null);
    assert.equal(await t.note({ channel: { id: '900' }, author: { id: '111' } }), null, 'DMs are ignored');
    assert.deepEqual(touched, [[7, 'last_user_reply_at'], [7, 'last_staff_reply_at']]);
    assert.equal(loads, 1, 'the open list is loaded once a minute, not per message');
});

test('a ticket opened since the last load counts at once (remember)', async () => {
    const touched = [];
    const t = createTicketActivity({ loadOpen: async () => [], touch: async (id, col) => { touched.push([id, col]); }, now: () => 5 });
    await t.note(msg('950', '333'));
    t.remember('950', 12, '333');
    assert.equal(await t.note(msg('950', '333')), 'last_user_reply_at');
    assert.deepEqual(touched, [[12, 'last_user_reply_at']]);
});

test('a failing database never throws into messageCreate', async () => {
    const t = createTicketActivity({
        loadOpen: async () => [{ id: 1, channel_id: '5', user_id: '6' }],
        touch: async () => { throw new Error('db down'); },
        now: () => 100_000,
    });
    assert.equal(await t.note(msg('5', '6')), null);
    const broken = createTicketActivity({ loadOpen: async () => { throw new Error("db down"); }, now: () => 100_000 });
    assert.equal(await broken.note(msg('5', '6')), null);
});

test('messageCreate and ticket_create are wired to it', () => {
    assert.match(read('events/messageCreate.js'), /noteTicketMessage\(message\)/);
    assert.match(read('interactions/buttons/ticket_create.js'), /rememberTicketChannel\(channel\.id, ticketId, userId\)/);
});
