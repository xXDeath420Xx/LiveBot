/*
 * Migration 280: what the modmail feature (core/modmail-manager.js) needs on top of the three
 * modmail tables that already existed but nothing wrote.
 *
 *   modmail_config.anonymous_replies   TINYINT(1) NOT NULL DEFAULT 0
 *       When 1, staff replies reach the member as "<server> Staff" instead of the staff member's
 *       name. Off by default — the existing behaviour of any modmail is to show who answered.
 *   modmail_config.category_id         NOT NULL → NULL
 *       The dashboard saves the form with or without a category; a NOT NULL column with no default
 *       made the first save of a guild with no category fail. Without one, threads are created at the
 *       top of the channel list (still private). Widening only.
 *   modmail_threads.close_reason       TEXT NULL     — why it was closed (shown in history/transcript)
 *   modmail_threads.last_activity_at   TIMESTAMP NULL — last relayed message either way (dashboard)
 *   modmail_messages.is_internal       TINYINT(1) NOT NULL DEFAULT 0 — staff-only `//` notes, never sent
 *   modmail_messages.is_anonymous      TINYINT(1) NOT NULL DEFAULT 0 — reply sent without the staff name
 *   modmail_messages.source_message_id VARCHAR(20) NULL — the Discord message relayed; makes relaying
 *                                       idempotent (a DM is never forwarded into a thread twice)
 *   modmail_blocked_users (new)        — members a server has blocked from opening modmail
 *                                       (dashboard Modmail page + the "Block & close" button)
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['modmail_config', 'anonymous_replies', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['modmail_threads', 'close_reason', 'TEXT NULL DEFAULT NULL'],
    ['modmail_threads', 'last_activity_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['modmail_messages', 'is_internal', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['modmail_messages', 'is_anonymous', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['modmail_messages', 'source_message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }

    // Widen category_id to nullable (no-op when it already is).
    const [[cat]] = await db.execute(
        `SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'modmail_config' AND COLUMN_NAME = 'category_id'`);
    if (cat && cat.nullable === 'NO') {
        await db.execute('ALTER TABLE modmail_config MODIFY category_id VARCHAR(20) NULL DEFAULT NULL');
    }

    await db.execute(`CREATE TABLE IF NOT EXISTS modmail_blocked_users (
        id          INT NOT NULL AUTO_INCREMENT,
        guild_id    VARCHAR(20) NOT NULL,
        user_id     VARCHAR(20) NOT NULL,
        reason      TEXT NULL,
        blocked_by  VARCHAR(20) NULL,
        blocked_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_guild_user (guild_id, user_id),
        KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
    // category_id stays nullable: narrowing it back would fail on any row saved without a category.
    const [tables] = await db.execute("SHOW TABLES LIKE 'modmail_blocked_users'");
    if (tables.length) {
        const [[{ n }]] = await db.execute('SELECT COUNT(*) AS n FROM modmail_blocked_users');
        if (Number(n) > 0) throw new Error(`modmail_blocked_users holds ${n} block(s) — export them before rolling back`);
        await db.execute('DROP TABLE modmail_blocked_users');
    }
}
