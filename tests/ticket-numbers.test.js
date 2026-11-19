import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Ticket numbers (core/ticket-number.js, migration 444; register H-661).
 *   - one sequence per server, taken atomically, never reused (two tickets opened at once get two numbers)
 *   - the number is stored on the ticket and shown by open, close, transcript, logs and the dashboard; it
 *     used to be the ticket count + 1 on open and the global database id everywhere else
 * The counter test writes one ticket_counters row for a made-up server and deletes it afterwards.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkn-'));
process.env.LOG_DIR ||= tmp;
const { nextTicketNumber, ticketNumber, ticketLabel } = await import('../core/ticket-number.js');
const { default: pool } = await import('../utils/db.js');

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const GUILD = `jr2test-${Date.now()}`;

test.after(async () => {
    await pool.execute('DELETE FROM ticket_counters WHERE guild_id = ?', [GUILD]).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('numbers count up per server and are never handed out twice', async () => {
    assert.equal(await nextTicketNumber(GUILD), 1);
    assert.equal(await nextTicketNumber(GUILD), 2);
    const together = await Promise.all(Array.from({ length: 6 }, () => nextTicketNumber(GUILD)));
    assert.deepEqual([...together].sort((a, b) => a - b), [3, 4, 5, 6, 7, 8]);
    const [[row]] = await pool.execute('SELECT last_number FROM ticket_counters WHERE guild_id = ?', [GUILD]);
    assert.equal(row.last_number, 8);
});

test('the number shown is the stored one; old unnumbered tickets show their id', () => {
    assert.equal(ticketNumber({ id: 87, ticket_number: 4 }), 4);
    assert.equal(ticketLabel({ id: 87, ticket_number: 4 }), '#4');
    assert.equal(ticketLabel({ id: 87, ticket_number: null }), '#87');
});

test('every place a ticket is opened stores the number, and the close shows the same one', () => {
    for (const rel of ['interactions/buttons/ticket_create.js', 'dashboard/routes/public/stream-team.js', 'dashboard/routes/api/me/stream-team.js']) {
        const src = read(rel);
        assert.match(src, /await nextTicketNumber\(guildId\)/, `${rel}: takes a number`);
        assert.match(src, /INSERT INTO tickets \(guild_id, ticket_number,/, `${rel}: stores it`);
        assert.doesNotMatch(src, /SELECT COUNT\(\*\) as count FROM tickets/, `${rel}: no count-based number`);
        assert.doesNotMatch(src, /\(#\$\{ticketId\}\)|with ID: \$\{ticketId\}|Ticket #\$\{ticketId\}/, `${rel}: shows the number, not the database id`);
    }
    const close = read('core/ticket-manager.js');
    assert.match(close, /Ticket \*\*\$\{ticketLabel\(ticket\)\}\*\* has been closed\./);
    assert.match(close, /title: `Ticket \$\{ticketLabel\(ticket\)\} — /);
    assert.doesNotMatch(close, /Ticket \*\*#\$\{ticket\.id\}\*\*|text: `Ticket #\$\{ticket\.id\}`/);
    assert.match(read('commands/admin/support/ticket.js'), /\(\$\{ticketLabel\(ticket\)\}\)`\]/);
    assert.match(read('dashboard/routes/api/features/tickets.js'), /number: ticketNumber\(ticket\)/);
    assert.match(read('dashboard/views/partials/manage/tickets.ejs'), /Ticket #\$\{t\.number \?\? t\.id\}/);
});
