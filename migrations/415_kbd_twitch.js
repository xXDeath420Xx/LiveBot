/**
 * Wave 415 — KumaBot Defender on Twitch.
 *
 * The defender (services/certifried-bot/defender) ran on Kick only. This adds the Twitch side
 * (core/twitch-kbd-defender.js) using the broadcaster's existing tier-B write grant.
 *
 *   twitch_analytics_alerts_config.kbd_mode   'off' (default) | 'detect' | 'enforce'
 *       Per broadcaster, opt-in. Owner request 2026-11-18: off everywhere, on only in the
 *       owner's own channel, never forced on anyone.
 *   kbd_banlist.source                          where an entry came from: NULL = added by hand,
 *       'kbd_2023' = Bear's KumaBot Defender export (Feb-Aug 2023), 'auto_spam' = matched a
 *       spam pattern in a channel running in enforce mode.
 *   kbd_enforcement_log.platform                'kick' (existing rows) | 'twitch'
 *   kbd_enforcement_log.action                  + 'detected' (detect mode: what would have happened)
 *
 * Apply directly: import { up } and call up(pool).
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(pool) {
    if (!(await hasColumn(pool, 'twitch_analytics_alerts_config', 'kbd_mode'))) {
        await pool.query(`ALTER TABLE twitch_analytics_alerts_config
            ADD COLUMN kbd_mode ENUM('off','detect','enforce') NOT NULL DEFAULT 'off'`);
    }
    if (!(await hasColumn(pool, 'kbd_banlist', 'source'))) {
        await pool.query(`ALTER TABLE kbd_banlist ADD COLUMN source VARCHAR(32) NULL DEFAULT NULL AFTER reason,
            ADD KEY idx_source (source)`);
    }
    if (!(await hasColumn(pool, 'kbd_enforcement_log', 'platform'))) {
        await pool.query(`ALTER TABLE kbd_enforcement_log
            ADD COLUMN platform VARCHAR(16) NOT NULL DEFAULT 'kick' AFTER id,
            ADD KEY idx_platform_channel (platform, channel_id, created_at)`);
    }
    await pool.query(`ALTER TABLE kbd_enforcement_log
        MODIFY action ENUM('ban','delete','detected_no_scope','detected') NOT NULL`);
}

export async function down(pool) {
    await pool.query("DELETE FROM kbd_enforcement_log WHERE action = 'detected'");
    await pool.query(`ALTER TABLE kbd_enforcement_log MODIFY action ENUM('ban','delete','detected_no_scope') NOT NULL`);
    if (await hasColumn(pool, 'kbd_enforcement_log', 'platform')) {
        await pool.query('ALTER TABLE kbd_enforcement_log DROP KEY idx_platform_channel, DROP COLUMN platform');
    }
    if (await hasColumn(pool, 'kbd_banlist', 'source')) {
        await pool.query('ALTER TABLE kbd_banlist DROP KEY idx_source, DROP COLUMN source');
    }
    if (await hasColumn(pool, 'twitch_analytics_alerts_config', 'kbd_mode')) {
        await pool.query('ALTER TABLE twitch_analytics_alerts_config DROP COLUMN kbd_mode');
    }
}
