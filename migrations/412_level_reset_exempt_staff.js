/**
 * Wave 412 — keep staff out of the periodic leveling reset.
 *
 * level_config.reset_exempt_staff = 1 makes jobs/leveling-monthly-reset.js leave the owner and
 * anyone with Administrator, Manage Server, Kick, Ban or Timeout permission alone: their XP row is
 * kept and their level reward roles are not removed. Off by default; set from the dashboard
 * (Leveling > Periodic reset).
 *
 * Owner request 2026-11-11: turned on for Mama Bear's Lair (1216126780767731722),
 * the Forsaken Warriors (1469931133981687873) and Welcome to The Pac! (1099732505243959407).
 */
const OWNER_REQUESTED = ['1216126780767731722', '1469931133981687873', '1099732505243959407'];

export async function up(pool) {
    const [cols] = await pool.query("SHOW COLUMNS FROM level_config LIKE 'reset_exempt_staff'");
    if (!cols.length) {
        await pool.query(
            `ALTER TABLE level_config
               ADD COLUMN reset_exempt_staff TINYINT(1) NOT NULL DEFAULT 0 AFTER reset_interval_days`);
    }
    await pool.query(
        'UPDATE level_config SET reset_exempt_staff = 1 WHERE guild_id IN (?)', [OWNER_REQUESTED]);
}

export async function down(pool) {
    await pool.query('ALTER TABLE level_config DROP COLUMN reset_exempt_staff');
}
