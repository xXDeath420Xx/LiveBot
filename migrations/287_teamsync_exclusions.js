/*
 * Migration 287: per-server team-sync exclusions.
 *
 * core/team-sync.js skips anyone in blacklisted_users when it reconciles a Twitch team every
 * hour, but the table had no guild_id, so an exclusion applied to every server — and nothing
 * wrote it, so a server that removed a team member saw them re-added at the next hourly sync.
 * /admin teamsync exclude|include|excluded now manage per-server rows.
 *
 *   blacklisted_users.guild_id   NULL = bot-wide (the table's original meaning; existing rows keep
 *                                it), otherwise only that server's team sync skips the streamer
 *   blacklisted_users.reason
 *
 * The unique key moves from (platform, platform_user_id) to (platform, platform_user_id,
 * guild_id): the old key would stop two servers excluding the same streamer. The new key is
 * added BEFORE the old one is dropped, so the table is never without a uniqueness guard. No row
 * is changed or removed (the table is empty on the live database today).
 *
 * Idempotent: guarded by information_schema. Apply directly: import { up } and call up(pool).
 */

const COLUMNS = [
    ['blacklisted_users', 'guild_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['blacklisted_users', 'reason', 'VARCHAR(255) NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
    if (!(await hasIndex(db, 'blacklisted_users', 'uniq_platform_user_guild'))) {
        await db.execute('ALTER TABLE blacklisted_users ADD UNIQUE KEY uniq_platform_user_guild (platform, platform_user_id, guild_id)');
    }
    // Only an index is dropped here, never data: the wider key above already covers it.
    if (await hasIndex(db, 'blacklisted_users', 'platform_user')) {
        await db.execute('ALTER TABLE blacklisted_users DROP INDEX platform_user');
    }
    if (!(await hasIndex(db, 'blacklisted_users', 'idx_guild'))) {
        await db.execute('ALTER TABLE blacklisted_users ADD INDEX idx_guild (guild_id)');
    }
}

export async function down(db) {
    // Restoring the old key fails if two servers excluded the same streamer; say so and leave the
    // wider key in place rather than delete anyone's exclusion.
    if (!(await hasIndex(db, 'blacklisted_users', 'platform_user'))) {
        try {
            await db.execute('ALTER TABLE blacklisted_users ADD UNIQUE KEY platform_user (platform, platform_user_id)');
        } catch (error) {
            console.warn(`[Migration 287 down] Could not restore unique (platform, platform_user_id): ${error.message}`);
            return;
        }
    }
    if (await hasIndex(db, 'blacklisted_users', 'uniq_platform_user_guild')) {
        await db.execute('ALTER TABLE blacklisted_users DROP INDEX uniq_platform_user_guild');
    }
    if (await hasIndex(db, 'blacklisted_users', 'idx_guild')) {
        await db.execute('ALTER TABLE blacklisted_users DROP INDEX idx_guild');
    }
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
