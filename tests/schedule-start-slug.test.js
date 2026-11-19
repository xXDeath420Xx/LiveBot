import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * H-671 event schedules: /schedule list create had no start time (so planned run times and
 * "starting soon" posts only worked once one was set on the dashboard), and event slugs, which the
 * public page looks up without a server, were only checked within one server.
 */
const { default: ScheduleManager, parseScheduleStart, isEventSlugTaken } = await import('../core/schedule-manager.js');
const { default: schedule } = await import('../commands/community/schedule.js');
const { default: pool } = await import('../utils/db.js');

test('a start typed in a time zone is stored as the UTC instant', () => {
    const ny = parseScheduleStart('2026-12-05 18:00', 'America/New_York');
    assert.equal(ny.ok, true);
    assert.equal(ny.date.toISOString(), '2026-12-05T23:00:00.000Z');
    assert.equal(parseScheduleStart('2026-07-01 09:30').date.toISOString(), '2026-07-01T09:30:00.000Z');
    assert.equal(parseScheduleStart('tomorrow at 6', 'UTC').ok, false);
    assert.match(parseScheduleStart('2026-12-05 18:00', 'Mars/Olympus').error, /Unknown time zone/);
});

test('the command has start and timezone on list create, and list set-start', () => {
    const json = schedule.data.toJSON();
    const list = json.options.find(o => o.name === 'list');
    const create = list.options.find(o => o.name === 'create');
    assert.ok(create.options.some(o => o.name === 'start' && !o.required));
    assert.ok(create.options.some(o => o.name === 'timezone' && o.autocomplete));
    const setStart = list.options.find(o => o.name === 'set-start');
    assert.ok(setStart, 'list set-start exists');
    assert.deepEqual(setStart.options.filter(o => o.required).map(o => o.name), ['schedule_id', 'start']);
});

// ── Against the database ─────────────────────────────────────────────────────────────────────
const GUILD_A = '100000000000000671';
const GUILD_B = '100000000000000672';
const SLUG = 'fwb-h671-test';

async function cleanup() {
    const [ev] = await pool.execute('SELECT id FROM schedule_events WHERE guild_id IN (?, ?)', [GUILD_A, GUILD_B]);
    for (const { id } of ev) await pool.execute('DELETE FROM schedule_schedules WHERE event_id = ?', [id]);
    await pool.execute('DELETE FROM schedule_events WHERE guild_id IN (?, ?)', [GUILD_A, GUILD_B]);
}

function interactionFor(guildId, values) {
    const out = {};
    return {
        out,
        interaction: {
            guild: { id: guildId }, guildId, user: { id: '200000000000000671' },
            options: {
                getString: (n) => values[n] ?? null,
                getInteger: (n) => values[n] ?? null,
            },
            deferReply: async () => {},
            editReply: async (r) => { out.reply = typeof r === 'string' ? r : r.content; },
        },
    };
}

test('a slug used by an event in another server is refused, and the database refuses it too', async (t) => {
    t.after(cleanup);
    await cleanup();
    const manager = new ScheduleManager({});
    await manager.createEvent(GUILD_A, { slug: SLUG, name: 'Marathon A' }, 'u');
    assert.equal(await isEventSlugTaken(SLUG), true);

    const { interaction, out } = interactionFor(GUILD_B, { name: 'Marathon B', slug: SLUG });
    await schedule.handleEventCreate(interaction, manager);
    assert.match(out.reply, /already used by another event/);

    await assert.rejects(
        pool.execute("INSERT INTO schedule_events (guild_id, slug, name, created_by) VALUES (?, ?, 'x', 'u')", [GUILD_B, SLUG]),
        (err) => err.code === 'ER_DUP_ENTRY');
});

test('list create with start stores it; list set-start changes it', async (t) => {
    t.after(cleanup);
    await cleanup();
    const manager = new ScheduleManager({});
    await manager.createEvent(GUILD_A, { slug: SLUG, name: 'Marathon A', timezone: 'Europe/London' }, 'u');

    const create = interactionFor(GUILD_A, { event: SLUG, name: 'Saturday', slug: 'saturday', start: '2026-12-05 15:00', timezone: 'America/New_York' });
    await schedule.handleScheduleCreate(create.interaction, manager);
    assert.match(create.out.reply, /Starts: <t:\d+:F>/);
    const [[row]] = await pool.execute(
        'SELECT s.id, s.start_time FROM schedule_schedules s JOIN schedule_events e ON e.id = s.event_id WHERE e.guild_id = ? AND s.slug = ?',
        [GUILD_A, 'saturday']);
    assert.equal(new Date(row.start_time).toISOString(), '2026-12-05T20:00:00.000Z');

    // No timezone: the event's own (Europe/London, GMT in December).
    const set = interactionFor(GUILD_A, { schedule_id: row.id, start: '2026-12-06 10:00' });
    await schedule.handleScheduleSetStart(set.interaction, manager);
    const [[after]] = await pool.execute('SELECT start_time FROM schedule_schedules WHERE id = ?', [row.id]);
    assert.equal(new Date(after.start_time).toISOString(), '2026-12-06T10:00:00.000Z');
    assert.match(set.out.reply, /Europe\/London/);

    // Another server cannot touch it.
    const other = interactionFor(GUILD_B, { schedule_id: row.id, start: '2026-12-06 10:00' });
    await schedule.handleScheduleSetStart(other.interaction, manager);
    assert.equal(other.out.reply, 'Schedule not found.');
});
