import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketConfigChanges } from '../dashboard/services/ticket-config-save.js';

/*
 * The Tickets page's "Default panel" save (POST /manage/:id/update-tickets) writes only the
 * ticket_config columns the form posted, so the log channel set with /support ticket setup and the
 * thread settings are not cleared by a save.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('only the columns in the body are written', () => {
    const { cols, values } = ticketConfigChanges({
        panel_channel_id: '123456789012345678', ticket_category_id: '223456789012345678', support_role_id: '',
    });
    assert.deepEqual(cols, ['panel_channel_id', 'ticket_category_id', 'support_role_id']);
    assert.deepEqual(values, ['123456789012345678', '223456789012345678', null]);
    assert.ok(!cols.includes('log_channel_id'), 'a body without the log channel leaves it alone');
});

test('values are checked: ids, the auto-close range and the threads switch', () => {
    const { cols, values } = ticketConfigChanges({
        log_channel_id: 'not-an-id', auto_close_hours: '900', use_threads: 'on', thread_parent_channel_id: '323456789012345678',
    });
    const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
    assert.deepEqual(row, { log_channel_id: null, thread_parent_channel_id: '323456789012345678', auto_close_hours: null, use_threads: 1 });
    assert.equal(ticketConfigChanges({ auto_close_hours: '24' }).values[0], 24);
    assert.deepEqual(ticketConfigChanges({}), { cols: [], values: [] });
});

test('the route uses it and the form posts the log channel it shows', () => {
    const server = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    const at = server.indexOf("app.post('/manage/:guildId/update-tickets'");
    const route = server.slice(at, server.indexOf('app.post(', at + 10));
    assert.match(route, /ticketConfigChanges\(req\.body/);
    assert.doesNotMatch(route, /auto_close_hours \|\| null/);
    const page = fs.readFileSync(path.join(root, 'dashboard/views/partials/manage/tickets.ejs'), 'utf8');
    assert.match(page, /id="ticketLogChannel" name="log_channel_id"/);
});
