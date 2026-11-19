/**
 * Migration 430 — Self-Care habit reminder DMs start OFF for servers that already exist (owner
 * decision 2026-11-18, register H-101).
 *
 * The Self-Care page's "Send habit reminders by DM" defaults to on (core/feature-config-spec.js),
 * and that default stays for servers the bot joins later. Servers already using the bot must not
 * start getting habit DMs just because the reminder job was wired, so each of them gets an
 * explicit reminder_dm: 0 in guild_feature_config (feature_key 'selfcare'):
 *
 *   - an existing selfcare row with no reminder_dm key gets one (a value someone saved is kept);
 *   - every other known server (guilds, guild_settings, guild_bot_mapping, guild_feature_config,
 *     and anyone with habits) gets a new row holding only reminder_dm: 0. Every other setting
 *     keeps reading its page default, and the dashboard shows the stored off value.
 *
 * Idempotent: rows that already have the key are never touched, so running it again (or after a
 * server has switched reminders back on) changes nothing.
 */

async function hasTable(db, table) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'guild_feature_config'))) return;

    await db.query(
        `UPDATE guild_feature_config
            SET config = JSON_SET(COALESCE(NULLIF(config, ''), '{}'), '$.reminder_dm', 0)
          WHERE feature_key = 'selfcare'
            AND JSON_EXTRACT(COALESCE(NULLIF(config, ''), '{}'), '$.reminder_dm') IS NULL`
    );

    const sources = [
        ['guilds', 'guild_id'],
        ['guild_settings', 'guild_id'],
        ['guild_bot_mapping', 'guild_id'],
        ['guild_feature_config', 'guild_id'],
        ['habits', 'guild_id'],
    ];
    const selects = [];
    for (const [table, column] of sources) {
        if (await hasTable(db, table)) selects.push(`SELECT \`${column}\` AS guild_id FROM \`${table}\``);
    }
    if (!selects.length) return;

    await db.query(
        `INSERT INTO guild_feature_config (guild_id, feature_key, config, updated_by)
         SELECT known.guild_id, 'selfcare', '{"reminder_dm":0}', 'migration-430'
           FROM (${selects.join(' UNION ')}) AS known
          WHERE known.guild_id REGEXP '^[0-9]{17,20}$'
            AND NOT EXISTS (SELECT 1 FROM guild_feature_config g
                             WHERE g.guild_id = known.guild_id AND g.feature_key = 'selfcare')`
    );
}

export async function down(db) {
    // Remove only the rows this migration created and never edited since.
    await db.query(
        `DELETE FROM guild_feature_config
          WHERE feature_key = 'selfcare' AND updated_by = 'migration-430' AND config = '{"reminder_dm":0}'`
    );
}
