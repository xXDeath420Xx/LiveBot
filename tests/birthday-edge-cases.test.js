import test, { after } from 'node:test';
import assert from 'node:assert/strict';

/*
 * H-664 birthday edge cases:
 *   - 29 February can be saved, so in years without one it is celebrated on the 28th;
 *   - the birthday role is held for 24 hours from when it was given, not until the UTC date changes;
 *   - /engage birthday setup without role: or message: keeps the ones already saved.
 */
const helpers = await import('../core/birthday-helpers.js');
const { EXPIRED_ROLE_SQL } = await import('../jobs/birthday-scheduler.js');
const { default: BirthdayManager } = await import('../core/birthday-manager.js');
const { default: pool } = await import('../utils/db.js');
after(() => pool.end().catch(() => {})); // close the pool so the file exits on its own

test('29 February is celebrated on the 28th in years without one', () => {
    const { birthdaysOn } = helpers;
    assert.deepEqual(birthdaysOn({ year: 2027, month: 2, day: 28 }), [{ month: 2, day: 28 }, { month: 2, day: 29 }]);
    assert.deepEqual(birthdaysOn({ year: 2028, month: 2, day: 28 }), [{ month: 2, day: 28 }]);
    assert.deepEqual(birthdaysOn({ year: 2028, month: 2, day: 29 }), [{ month: 2, day: 29 }]);
    assert.deepEqual(birthdaysOn({ year: 2027, month: 3, day: 1 }), [{ month: 3, day: 1 }]);
    assert.equal(helpers.isLeapYear(2100), false);
    assert.equal(helpers.isLeapYear(2000), true);
});

test('the next celebration of 29 February never rolls over to 1 March', () => {
    const { nextBirthdayDate } = helpers;
    const d2027 = nextBirthdayDate(2, 29, new Date(2027, 0, 10));
    assert.deepEqual([d2027.getFullYear(), d2027.getMonth() + 1, d2027.getDate()], [2027, 2, 28]);
    const d2028 = nextBirthdayDate(2, 29, new Date(2028, 0, 10));
    assert.deepEqual([d2028.getFullYear(), d2028.getMonth() + 1, d2028.getDate()], [2028, 2, 29]);
    // Passed this year: next year's.
    const next = nextBirthdayDate(1, 5, new Date(2027, 0, 10));
    assert.deepEqual([next.getFullYear(), next.getMonth() + 1, next.getDate()], [2028, 1, 5]);
    // Today counts as today.
    const today = nextBirthdayDate(1, 10, new Date(2027, 0, 10));
    assert.equal(today.getFullYear(), 2027);
});

test('the announcement date is New York\'s, not the server clock\'s', () => {
    // 03:00 UTC on the 20th is still the evening of the 19th in New York.
    assert.deepEqual(helpers.dateIn('America/New_York', new Date('2026-11-20T03:00:00Z')), { year: 2026, month: 11, day: 19 });
    assert.equal(helpers.isoDate({ year: 2027, month: 2, day: 8 }), '2027-02-08');
});

// ── Against the database ─────────────────────────────────────────────────────────────────────
const GUILD = '100000000000000664';

test('the role is due back 24 hours after it was given; older rows keep the date rule', async (t) => {
    t.after(() => pool.execute('DELETE FROM user_birthdays WHERE guild_id = ?', [GUILD]));
    const rows = [
        ['300000000000000001', 'NOW() - INTERVAL 23 HOUR', 'CURDATE()'],            // given 23 h ago: keep
        ['300000000000000002', 'NOW() - INTERVAL 25 HOUR', 'CURDATE()'],            // 25 h ago: due
        ['300000000000000003', 'NULL', 'CURDATE() - INTERVAL 1 DAY'],               // before the column: due
        ['300000000000000004', 'NULL', 'CURDATE()'],                                // before the column, today: keep
    ];
    for (const [user, given, announced] of rows) {
        await pool.query(
            `INSERT INTO user_birthdays (user_id, guild_id, month, day, last_announced, birthday_role_given_at)
             VALUES (?, ?, 1, 1, ${announced}, ${given})`, [user, GUILD]);
    }
    const [due] = await pool.execute(EXPIRED_ROLE_SQL, [GUILD]);
    assert.deepEqual(due.map(r => r.user_id).sort(), ['300000000000000002', '300000000000000003']);
});

test('setup without role or message keeps the saved ones; null clears them', async (t) => {
    t.after(() => pool.execute('DELETE FROM birthday_config WHERE guild_id = ?', [GUILD]));
    const manager = new BirthdayManager({});
    assert.equal(await manager.configureBirthdays(GUILD, '400000000000000001', true, '500000000000000001', 'Happy birthday {user}!'), true);

    await manager.configureBirthdays(GUILD, '400000000000000002', true, undefined, undefined);
    let cfg = await manager.getConfig(GUILD);
    assert.equal(cfg.announcement_channel_id, '400000000000000002');
    assert.equal(cfg.birthday_role_id, '500000000000000001');
    assert.equal(cfg.message_template, 'Happy birthday {user}!');

    await manager.configureBirthdays(GUILD, '400000000000000002', true, null, null);
    cfg = await manager.getConfig(GUILD);
    assert.equal(cfg.birthday_role_id, null);
    assert.equal(cfg.message_template, null);
});
