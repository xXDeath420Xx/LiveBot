/**
 * Wave 419 — joining: welcome DM / embed style / ban announcement, and autorole options.
 *
 * welcome_settings (core/greeting-manager.js; Welcome page)
 *   message_type          VARCHAR(8)  NULL  'text' | 'embed' for the welcome post. NULL keeps the old
 *                                           behaviour: an embed when the banner is on, plain text when not.
 *   embed_color           VARCHAR(7)  NULL  '#rrggbb' for the welcome embed; NULL = the built-in colours.
 *   goodbye_message_type  VARCHAR(8)  NOT NULL DEFAULT 'text'
 *   ban_enabled           TINYINT(1)  NOT NULL DEFAULT 0   post a message when a member is banned
 *   ban_channel_id        VARCHAR(20) NULL
 *   ban_message           TEXT        NULL  variables {user} {server} {reason} {moderator} ...
 *   ban_message_type      VARCHAR(8)  NOT NULL DEFAULT 'text'
 *   (dm_welcome_enabled / dm_welcome_message already exist; the bot now reads them.)
 *
 * autoroles_config (core/autoroles.js; Utilities page)
 *   bot_roles             TEXT  NULL   JSON role ids given to bots instead of roles_to_assign
 *   require_roles         TEXT  NULL   JSON: a member must hold one of these to get the join roles
 *   ignore_roles          TEXT  NULL   JSON: members holding any of these are skipped
 *   delay_minutes         INT   NOT NULL DEFAULT 0   wait after joining (queued on the deadline queue)
 *   backfill_*                         progress of "give to existing members" (one run per server)
 *
 * temp_access_members.kind gains 'autorole' (the delayed join roles ride the shared deadline queue
 * that jobs/temp-access-reaper.js sweeps every minute).
 *
 * Idempotent. Apply directly: import { up } and call up(pool).
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

async function hasTable(pool, table) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

const WELCOME_COLUMNS = [
    ['message_type', "VARCHAR(8) NULL DEFAULT NULL"],
    ['embed_color', "VARCHAR(7) NULL DEFAULT NULL"],
    ['goodbye_message_type', "VARCHAR(8) NOT NULL DEFAULT 'text'"],
    ['ban_enabled', "TINYINT(1) NOT NULL DEFAULT 0"],
    ['ban_channel_id', "VARCHAR(20) NULL DEFAULT NULL"],
    ['ban_message', "TEXT NULL"],
    ['ban_message_type', "VARCHAR(8) NOT NULL DEFAULT 'text'"],
];

const AUTOROLE_COLUMNS = [
    ['bot_roles', "TEXT NULL"],
    ['require_roles', "TEXT NULL"],
    ['ignore_roles', "TEXT NULL"],
    ['delay_minutes', "INT NOT NULL DEFAULT 0"],
    ['backfill_status', "VARCHAR(12) NULL DEFAULT NULL"],
    ['backfill_total', "INT NOT NULL DEFAULT 0"],
    ['backfill_scanned', "INT NOT NULL DEFAULT 0"],
    ['backfill_given', "INT NOT NULL DEFAULT 0"],
    ['backfill_skipped', "INT NOT NULL DEFAULT 0"],
    ['backfill_failed', "INT NOT NULL DEFAULT 0"],
    ['backfill_cursor', "VARCHAR(20) NULL DEFAULT NULL"],
    ['backfill_started_by', "VARCHAR(20) NULL DEFAULT NULL"],
    ['backfill_started_at', "DATETIME NULL DEFAULT NULL"],
    ['backfill_finished_at', "DATETIME NULL DEFAULT NULL"],
    ['backfill_note', "VARCHAR(255) NULL DEFAULT NULL"],
];

/** The values of an ENUM column, or null when the column is missing / not an enum. */
async function enumValues(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    const t = rows[0]?.t;
    if (!t || !/^enum\(/i.test(t)) return null;
    return [...t.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

export async function up(pool) {
    for (const [name, def] of WELCOME_COLUMNS) {
        if (!(await hasColumn(pool, 'welcome_settings', name))) {
            await pool.query(`ALTER TABLE welcome_settings ADD COLUMN ${name} ${def}`);
        }
    }
    for (const [name, def] of AUTOROLE_COLUMNS) {
        if (!(await hasColumn(pool, 'autoroles_config', name))) {
            await pool.query(`ALTER TABLE autoroles_config ADD COLUMN ${name} ${def}`);
        }
    }
    if (await hasTable(pool, 'temp_access_members')) {
        const kinds = await enumValues(pool, 'temp_access_members', 'kind');
        if (kinds && !kinds.includes('autorole')) {
            // Keep whatever values are there now (other waves may have added some) and append ours.
            const list = [...kinds, 'autorole'].map((k) => `'${k.replace(/'/g, "''")}'`).join(',');
            await pool.query(`ALTER TABLE temp_access_members MODIFY COLUMN kind ENUM(${list}) NOT NULL DEFAULT 'trial'`);
        }
    }
}

export async function down(pool) {
    for (const [name] of WELCOME_COLUMNS) {
        if (await hasColumn(pool, 'welcome_settings', name)) await pool.query(`ALTER TABLE welcome_settings DROP COLUMN ${name}`);
    }
    for (const [name] of AUTOROLE_COLUMNS) {
        if (await hasColumn(pool, 'autoroles_config', name)) await pool.query(`ALTER TABLE autoroles_config DROP COLUMN ${name}`);
    }
    // temp_access_members.kind keeps 'autorole': narrowing an ENUM with live rows would fail or truncate them.
}
