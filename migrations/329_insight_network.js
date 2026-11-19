/*
 * Migration 329: join risk insight + the global ban network that learns from every ban.
 *
 *   global_ban_config          mode (protect | alert | feed) and confidence_threshold (0-100). Existing
 *                              rows become 'protect' at 75, which acts on every curated entry exactly as
 *                              before (high 90 / critical 100 / medium 75 are at or above it).
 *   global_ban_entries         confidence (0-100) and signal_guilds (independent servers behind it).
 *                              NULL on existing rows: read as the confidence their severity stands for.
 *   global_ban_auto_aggregate  per-signal source_kind (protection | moderator | trusted_bot | bot |
 *                              unknown), context (which protection), guild_trust, burst, guild_owner_id
 *                              (independence is by owner), and an index for per-server queries.
 *   logging_config             join_insight (on) and join_new_account_days (7) for the join log's Risk field.
 *
 * Only new columns and an index: the running code reads none of them until it is replaced, and the
 * new code falls back when they are missing. No new tables.
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]);
    return rows.length > 0;
}

export const COLUMNS = [
    ['global_ban_config', 'mode', "ENUM('protect','alert','feed') NOT NULL DEFAULT 'protect'"],
    ['global_ban_config', 'confidence_threshold', 'TINYINT UNSIGNED NOT NULL DEFAULT 75'],
    ['global_ban_entries', 'confidence', 'TINYINT UNSIGNED DEFAULT NULL'],
    ['global_ban_entries', 'signal_guilds', 'SMALLINT UNSIGNED DEFAULT NULL'],
    ['global_ban_auto_aggregate', 'source_kind', "ENUM('protection','moderator','trusted_bot','bot','unknown') DEFAULT NULL"],
    ['global_ban_auto_aggregate', 'context', 'VARCHAR(32) DEFAULT NULL'],
    ['global_ban_auto_aggregate', 'guild_trust', 'DECIMAL(3,2) DEFAULT NULL'],
    ['global_ban_auto_aggregate', 'burst', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['global_ban_auto_aggregate', 'guild_owner_id', 'VARCHAR(20) DEFAULT NULL'],
    ['logging_config', 'join_insight', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['logging_config', 'join_new_account_days', 'SMALLINT UNSIGNED NOT NULL DEFAULT 7'],
];

export const INDEXES = [
    ['global_ban_auto_aggregate', 'idx_guild_occurred', '(guild_id, occurred_at)'],
];

export async function up(db) {
    for (const [table, name, def] of COLUMNS) {
        if (!(await hasColumn(db, table, name))) {
            await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        }
    }
    for (const [table, name, cols] of INDEXES) {
        if (!(await hasIndex(db, table, name))) {
            await db.execute(`ALTER TABLE ${table} ADD INDEX ${name} ${cols}`);
        }
    }
    // Signals recorded before this migration came from our own moderation commands.
    await db.execute("UPDATE global_ban_auto_aggregate SET source_kind = 'moderator' WHERE source_kind IS NULL");
}

export async function down(db) {
    for (const [table, name] of INDEXES) {
        if (await hasIndex(db, table, name)) await db.execute(`ALTER TABLE ${table} DROP INDEX ${name}`);
    }
    for (const [table, name] of [...COLUMNS].reverse()) {
        if (await hasColumn(db, table, name)) await db.execute(`ALTER TABLE ${table} DROP COLUMN ${name}`);
    }
}
