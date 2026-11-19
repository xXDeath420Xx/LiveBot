/*
 * Migration 305: emoji hunts (/arcade emojihunt) — fills in the three empty emoji_hunt* tables.
 *
 * The tables existed with no code behind them. core/emoji-hunt-manager.js now runs hunts on them:
 * the bot reacts with a target emoji on random recent member messages during a window, and the
 * first members to add the same reaction claim each hidden spot.
 *
 *   emoji_hunts            one row per guild (guild_id is already UNIQUE): the guild's current or
 *                          most recent hunt, reused for the next one. emojis_json holds the spots.
 *     + announce_channel_id, announce_message_id   where the start/results posts went
 *     + hunt_channels       JSON array of channel ids this hunt may hide spots in
 *     + finders_per_emoji   how many members can claim each spot (first N)
 *     + points_per_find, coins_per_find, xp_per_find   snapshot of the rewards when it started
 *     + max_age_minutes     only messages newer than this are used ("recent")
 *     + trigger_type        'manual' | 'auto'
 *     + ended_at            when it finished (auto-hunt spacing is measured from here)
 *     + hunt_count          how many hunts the guild has run (hunt number for display)
 *     target_emoji widened 50 → 100: a custom emoji <a:name:id> can be 57 characters.
 *   emoji_hunt_participants   per-hunt finds (rows for the previous hunt are cleared when the
 *                             guild's next hunt starts; lifetime totals live in the leaderboard)
 *     + points, fastest_find_ms, UNIQUE (hunt_id, user_id)
 *   emoji_hunt_leaderboard    lifetime totals per member per guild
 *     + total_points, last_find_at, UNIQUE (guild_id, user_id)
 *
 * The UNIQUE keys make the per-find upserts atomic. The tables were empty when this was written;
 * if duplicates exist anyway the migration stops with a message instead of guessing which to keep.
 * Tables are converted to utf8mb4 first (the database default is utf8mb3, which cannot store emoji).
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */

const TABLES = ['emoji_hunts', 'emoji_hunt_participants', 'emoji_hunt_leaderboard'];

const COLUMNS = [
    ['emoji_hunts', 'announce_channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['emoji_hunts', 'announce_message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['emoji_hunts', 'hunt_channels', 'LONGTEXT NULL DEFAULT NULL'],
    ['emoji_hunts', 'finders_per_emoji', 'INT NOT NULL DEFAULT 1'],
    ['emoji_hunts', 'points_per_find', 'INT NOT NULL DEFAULT 10'],
    ['emoji_hunts', 'coins_per_find', 'INT NOT NULL DEFAULT 0'],
    ['emoji_hunts', 'xp_per_find', 'INT NOT NULL DEFAULT 0'],
    ['emoji_hunts', 'max_age_minutes', 'INT NOT NULL DEFAULT 1440'],
    ['emoji_hunts', 'trigger_type', "VARCHAR(10) NOT NULL DEFAULT 'manual'"],
    ['emoji_hunts', 'ended_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['emoji_hunts', 'hunt_count', 'INT NOT NULL DEFAULT 0'],
    ['emoji_hunt_participants', 'points', 'INT NOT NULL DEFAULT 0'],
    ['emoji_hunt_participants', 'fastest_find_ms', 'INT NULL DEFAULT NULL'],
    ['emoji_hunt_leaderboard', 'total_points', 'INT NOT NULL DEFAULT 0'],
    ['emoji_hunt_leaderboard', 'last_find_at', 'TIMESTAMP NULL DEFAULT NULL'],
];

const UNIQUES = [
    ['emoji_hunt_participants', 'uq_hunt_user', ['hunt_id', 'user_id']],
    ['emoji_hunt_leaderboard', 'uq_guild_user', ['guild_id', 'user_id']],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

async function toUtf8mb4(db, table) {
    const [[row]] = await db.execute(
        `SELECT TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    );
    if (!row) throw new Error(`[305] table ${table} is missing`);
    if (!String(row.c).startsWith('utf8mb4')) {
        await db.execute(`ALTER TABLE \`${table}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
}

/** True when some UNIQUE/PRIMARY index covers exactly these columns, in this order. */
async function hasUniqueOn(db, table, columns) {
    const [rows] = await db.execute(
        `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0
          GROUP BY INDEX_NAME`,
        [table]
    );
    return rows.some(r => r.cols === columns.join(','));
}

async function addUnique(db, table, name, columns) {
    if (await hasUniqueOn(db, table, columns)) return;
    const cols = columns.map(c => `\`${c}\``).join(', ');
    const [dupes] = await db.execute(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM \`${table}\` GROUP BY ${cols} HAVING COUNT(*) > 1) d`
    );
    if (Number(dupes[0].n) > 0) {
        throw new Error(`[305] ${table} has ${dupes[0].n} duplicate (${columns.join(', ')}) groups — resolve them, then re-run`);
    }
    await db.execute(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${name}\` (${cols})`);
}

export async function up(db) {
    for (const t of TABLES) await toUtf8mb4(db, t);

    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }

    // Widen only (never narrows).
    const [[col]] = await db.execute(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'emoji_hunts' AND COLUMN_NAME = 'target_emoji'`);
    if (col && Number(col.len) < 100) {
        await db.execute(
            'ALTER TABLE emoji_hunts MODIFY target_emoji VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL');
    }

    for (const [table, name, columns] of UNIQUES) await addUnique(db, table, name, columns);
}

export async function down(db) {
    for (const [table, name] of UNIQUES) {
        await db.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``).catch(() => {});
    }
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
    // target_emoji stays VARCHAR(100) and the tables stay utf8mb4: narrowing could truncate data.
}
