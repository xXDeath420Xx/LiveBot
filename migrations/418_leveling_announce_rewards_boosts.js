/**
 * Leveling options (gap analysis 2026-11-18, P1 item 2). All on level_config, set from the
 * dashboard (Leveling page) and read by core/leveling-manager.js:
 *
 *   level_up_mode          'channel' (level_up_channel_id, or the message's channel when NULL),
 *                          'dm' (sent to the member by DM) or 'off' (no announcement).
 *   announce_every_n       announce every Nth level only (1 = every level).
 *   announce_min_level     announce from this level up (0 = from the first).
 *   announce_rewards_only  1 = announce only levels that come with a role reward.
 *   reward_mode            'stack' keeps every reward role earned; 'replace' keeps only the
 *                          highest one and takes the lower ones away.
 *   remove_reward_on_loss  1 = take reward roles back when a member drops below their level
 *                          (dashboard XP edits).
 *   xp_boost_roles         JSON [{ "id": roleId, "multiplier": 1.5 }]: the highest boost a member
 *                          holds applies.
 *   xp_boost_channels      JSON [{ "id": channelId, "multiplier": 2 }]: messages (or voice time)
 *                          in these channels, or threads under them.
 *
 * Defaults keep today's behaviour exactly.
 */
const COLUMNS = [
    ['level_up_mode', "VARCHAR(10) NOT NULL DEFAULT 'channel' AFTER level_up_channel_id"],
    ['announce_every_n', 'SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER level_up_mode'],
    ['announce_min_level', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER announce_every_n'],
    ['announce_rewards_only', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER announce_min_level'],
    ['reward_mode', "VARCHAR(10) NOT NULL DEFAULT 'stack' AFTER announce_rewards_only"],
    ['remove_reward_on_loss', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER reward_mode'],
    ['xp_boost_roles', 'LONGTEXT NULL DEFAULT NULL CHECK (json_valid(xp_boost_roles)) AFTER ignored_roles'],
    ['xp_boost_channels', 'LONGTEXT NULL DEFAULT NULL CHECK (json_valid(xp_boost_channels)) AFTER xp_boost_roles'],
];

export async function up(pool) {
    for (const [name, def] of COLUMNS) {
        const [cols] = await pool.query('SHOW COLUMNS FROM level_config LIKE ?', [name]);
        if (!cols.length) await pool.query(`ALTER TABLE level_config ADD COLUMN ${name} ${def}`);
    }
}

export async function down(pool) {
    for (const [name] of [...COLUMNS].reverse()) {
        const [cols] = await pool.query('SHOW COLUMNS FROM level_config LIKE ?', [name]);
        if (cols.length) await pool.query(`ALTER TABLE level_config DROP COLUMN ${name}`);
    }
}
