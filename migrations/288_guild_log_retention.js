/*
 * Migration 288: per-server log retention.
 *
 * jobs/retention-sweeper.js enforces bot-wide windows per table (data_retention_policy:
 * message_logs 90 days, audit_logs 365 days). Servers can now choose a SHORTER window for their
 * own message and moderation logs; the sweeper applies it in a second, guild-scoped pass and
 * ignores any value at or above the bot-wide cap (core/guild-log-retention.js).
 *
 * The setting lives in the existing, empty log_retention_policy table — migration 182 noted it was
 * planned for exactly this ("keep my mod logs 30 days"). It is edited from the dashboard through
 * the generic feature-config card, which stores one row per guild keyed on guild_id, so:
 *
 *   event_type          gains DEFAULT 'guild'. A server's settings row is (guild_id, 'guild');
 *                       the existing unique key (guild_id, event_type) makes the card's upsert
 *                       update that row. Same type and length — only a default is added.
 *   message_logs_days   NULL = bot-wide window; otherwise 1-365, applied only if shorter
 *   audit_logs_days     same, for audit_logs (moderation & server audit log)
 *   updated_at, last_swept_at, last_deleted   bookkeeping written by the sweeper
 *   retention_days      (existing) unused by this feature; left in place.
 *
 * Indexes (guild_id, timestamp) on message_logs and audit_logs so the guild-scoped deletes do not
 * scan the whole table. Added online (ALGORITHM=INPLACE, LOCK=NONE) where the server allows it.
 *
 * Idempotent: every change is guarded by information_schema. Apply directly: import { up } and
 * call up(pool).
 */

const COLUMNS = [
    ['log_retention_policy', 'message_logs_days', 'INT NULL DEFAULT NULL'],
    ['log_retention_policy', 'audit_logs_days', 'INT NULL DEFAULT NULL'],
    ['log_retention_policy', 'updated_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ['log_retention_policy', 'last_swept_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['log_retention_policy', 'last_deleted', 'INT NOT NULL DEFAULT 0'],
];

const INDEXES = [
    ['message_logs', 'idx_guild_timestamp', '(guild_id, `timestamp`)'],
    ['audit_logs', 'idx_guild_timestamp', '(guild_id, `timestamp`)'],
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

    const [[col]] = await db.execute(
        `SELECT COLUMN_DEFAULT AS def, CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_retention_policy' AND COLUMN_NAME = 'event_type'`
    );
    if (col && (col.def === null || col.def === 'NULL') && Number(col.len) >= 50) {
        await db.execute("ALTER TABLE log_retention_policy MODIFY event_type VARCHAR(50) NOT NULL DEFAULT 'guild'");
    }

    for (const [table, name, cols] of INDEXES) {
        if (await hasIndex(db, table, name)) continue;
        try {
            await db.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` ${cols}, ALGORITHM=INPLACE, LOCK=NONE`);
        } catch (error) {
            console.warn(`[Migration 288] Online index build refused on ${table} (${error.message}); building normally`);
            await db.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` ${cols}`);
        }
    }
}

export async function down(db) {
    for (const [table, name] of INDEXES) {
        if (await hasIndex(db, table, name)) await db.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``);
    }
    await db.execute('ALTER TABLE log_retention_policy MODIFY event_type VARCHAR(50) NOT NULL');
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
