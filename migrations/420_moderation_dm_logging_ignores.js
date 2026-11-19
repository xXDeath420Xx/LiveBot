/**
 * Wave 420 — moderation DMs and protected roles; logging ignore lists.
 *
 * moderation_config (Moderation page, core/moderation-manager.js sendModerationDm / protectedRoleFor):
 *   dm_on_warn / dm_on_mute / dm_on_unmute / dm_on_kick / dm_on_ban   TINYINT(1) NOT NULL DEFAULT 1
 *   dm_on_unban                     TINYINT(1) NOT NULL DEFAULT 0   (the member usually shares no server with the bot)
 *   dm_templates                    LONGTEXT NULL   JSON { warn|mute|unmute|kick|ban|unban: text }; empty = built-in embed
 *   dm_show_moderator               TINYINT(1) NOT NULL DEFAULT 0   name the moderator in DMs ({moderator})
 *   appeal_link                     VARCHAR(500) NULL               {appeal_link}
 *   protected_role_ids              TEXT NULL       JSON array; members with one cannot be warned, muted, kicked or banned by bot commands
 *   default_mute_minutes            INT UNSIGNED NULL   used when /admin mod mute is given no duration
 *   default_ban_minutes             INT UNSIGNED NULL   used when /admin mod ban is given no duration (NULL = permanent)
 *
 * logging_config (Logging page, core/log-manager.js sendLogEmbed):
 *   ignored_channels  TEXT NULL  JSON array of channel / category ids
 *   ignored_roles     TEXT NULL  JSON array of role ids
 *   ignore_bots       TINYINT(1) NOT NULL DEFAULT 0
 *
 * Every column defaults to today's behaviour except dm_show_moderator (the old DMs always named the
 * moderator). Apply directly: import { up } and call up(pool).
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

const COLUMNS = [
    ['moderation_config', 'dm_on_warn', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['moderation_config', 'dm_on_mute', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['moderation_config', 'dm_on_unmute', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['moderation_config', 'dm_on_kick', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['moderation_config', 'dm_on_ban', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['moderation_config', 'dm_on_unban', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['moderation_config', 'dm_templates', 'LONGTEXT NULL DEFAULT NULL'],
    ['moderation_config', 'dm_show_moderator', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['moderation_config', 'appeal_link', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['moderation_config', 'protected_role_ids', 'TEXT NULL DEFAULT NULL'],
    ['moderation_config', 'default_mute_minutes', 'INT UNSIGNED NULL DEFAULT NULL'],
    ['moderation_config', 'default_ban_minutes', 'INT UNSIGNED NULL DEFAULT NULL'],
    ['logging_config', 'ignored_channels', 'TEXT NULL DEFAULT NULL'],
    ['logging_config', 'ignored_roles', 'TEXT NULL DEFAULT NULL'],
    ['logging_config', 'ignore_bots', 'TINYINT(1) NOT NULL DEFAULT 0'],
];

export async function up(pool) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(pool, table, column))) {
            await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
    }
}

export async function down(pool) {
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (await hasColumn(pool, table, column)) {
            await pool.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        }
    }
}
