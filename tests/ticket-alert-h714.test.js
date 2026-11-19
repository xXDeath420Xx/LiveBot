import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-714: the "New Ticket Opened" alert channel can be set (each panel on the Tickets page, the default panel's
 * form, and /support ticket setup alert-channel; the default panel's column is migration 452), and a ticket
 * opened from a panel with one set posts the alert (interactions/buttons/ticket_create.js sendTicketAlert).
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h714-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pool = (await import('../utils/db.js')).default;
const { sendTicketAlert } = await import('../interactions/buttons/ticket_create.js');
const { cleanPanel } = await import('../dashboard/routes/features/ticket-panels.js');
const { ticketConfigChanges } = await import('../dashboard/services/ticket-config-save.js');

test.after(async () => { await pool.end().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); });

const ALERT = '900000000000000714';

function fakeGuild(channel) {
    const fetched = [];
    return {
        id: '900000000000000001',
        fetched,
        channels: { fetch: async (id) => { fetched.push(id); return channel; } },
    };
}

test('a ticket from a panel with an alert channel posts New Ticket Opened with a Join Ticket link', async () => {
    const sent = [];
    const guild = fakeGuild({ send: async (payload) => { sent.push(payload); return { id: '1' }; } });
    const ok = await sendTicketAlert({
        guild, config: { alert_channel_id: ALERT, panel_name: 'Help desk' }, user: '<@42>',
        channelId: '900000000000000777', channelName: 'ticket-kestrel', ticketNumber: 7,
    });
    assert.equal(ok, true);
    assert.deepEqual(guild.fetched, [ALERT]);
    assert.equal(sent.length, 1);
    const embed = sent[0].embeds[0].toJSON();
    assert.match(embed.title, /New Ticket Opened/);
    assert.match(embed.description, /ticket-kestrel/);
    assert.ok(embed.fields.some((f) => f.value === 'Help desk'));
    const button = sent[0].components[0].toJSON().components[0];
    assert.equal(button.url, `https://discord.com/channels/${guild.id}/900000000000000777`);
});

test('no alert channel, or one that is gone, posts nothing and does not throw', async () => {
    const guild = fakeGuild(null);
    assert.equal(await sendTicketAlert({ guild, config: {}, user: 'x', channelId: '1', channelName: 'n', ticketNumber: 1 }), false);
    assert.deepEqual(guild.fetched, []);
    assert.equal(await sendTicketAlert({ guild, config: { alert_channel_id: ALERT }, user: 'x', channelId: '1', channelName: 'n', ticketNumber: 1 }), false);
    const broken = fakeGuild({ send: async () => { throw new Error('Missing Permissions'); } });
    assert.equal(await sendTicketAlert({ guild: broken, config: { alert_channel_id: ALERT }, user: 'x', channelId: '1', channelName: 'n', ticketNumber: 1 }), false);
});

test('createTicket sends the alert for both panel and default-panel tickets', () => {
    const src = read('interactions/buttons/ticket_create.js');
    const body = src.slice(src.indexOf('export async function createTicket'), src.indexOf('export async function sendTicketAlert'));
    assert.match(body, /await sendTicketAlert\(\{ guild: interaction\.guild, config,/);
    // config is the ticket_panels row, or the ticket_config row for the default panel: both have the column now.
    assert.match(body, /SELECT \* FROM ticket_panels WHERE panel_id/);
    assert.match(body, /SELECT \* FROM ticket_config WHERE guild_id/);
});

test('both config tables have alert_channel_id', async () => {
    for (const table of ['ticket_panels', 'ticket_config']) {
        const [cols] = await pool.query(
            "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'alert_channel_id'", [table]);
        assert.equal(cols.length, 1, table);
    }
});

test('the Tickets page saves it: panels, the default panel form, and the page itself', () => {
    assert.equal(cleanPanel('1', { alert_channel_id: ALERT }, true).data.alert_channel_id, ALERT);
    assert.equal(cleanPanel('1', { alert_channel_id: '' }, true).data.alert_channel_id, null);
    assert.equal(cleanPanel('1', { alert_channel_id: 'nope' }, true).error, 'Alert channel is not valid.');
    const panels = read('dashboard/routes/features/ticket-panels.js');
    assert.match(panels, /save_transcripts, log_channel_id, alert_channel_id, is_active/);
    assert.match(panels, /'log_channel_id', 'alert_channel_id', 'is_active'/);

    const { cols, values } = ticketConfigChanges({ alert_channel_id: ALERT });
    assert.deepEqual([cols, values], [['alert_channel_id'], [ALERT]]);

    const page = read('dashboard/views/partials/manage/tickets.ejs');
    assert.match(page, /name="alert_channel_id"/, 'default panel form');
    assert.match(page, /<select id="alert_channel_id" class="form-select">/, 'panel dialog');
    assert.match(page, /'log_channel_id', 'alert_channel_id'\];/, 'dialog FIELDS');
});

test('/support ticket setup takes an alert channel and keeps the saved one when left out', async () => {
    const support = (await import('../commands/admin/support.js')).default;
    const json = support.data.toJSON();
    const setup = json.options.find((o) => o.name === 'ticket').options.find((o) => o.name === 'setup');
    const opt = setup.options.find((o) => o.name === 'alert-channel');
    assert.ok(opt, 'alert-channel option');
    assert.equal(opt.required ?? false, false);
    const handler = read('commands/admin/support/ticket.js');
    assert.match(handler, /alert_channel_id = IF\(\? = 1, VALUES\(alert_channel_id\), alert_channel_id\)/);
});
