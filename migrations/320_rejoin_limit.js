/*
 * Migration 320: the join gate's rejoin limit.
 *
 *   member_join_history  one row per arrival in a server, kept for good. The existing places a join is
 *                        noted (audit_logs 365 days, invite_tracker_logs 180) are pruned, which would
 *                        quietly reset a lifetime count. A safety record (core/privacy-tables.js).
 *   join_rejoin_resets   "count from here": written by staff (/protection joingate reset) and by any
 *                        unban, so someone staff let back in is not removed again by their old joins.
 *   join_gate_config     rejoin_* settings. Off by default; ban, all-time, 3 joins when switched on.
 *   join_gate_events     action enum gains the rejoin outcomes.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

const EVENT_ACTIONS = ['kicked_new', 'kicked_apply', 'allowed_approved', 'allowed_pending', 'failed',
    'rejoin_banned', 'rejoin_kicked', 'rejoin_apply', 'rejoin_observed'];
const OLD_EVENT_ACTIONS = EVENT_ACTIONS.slice(0, 5);
const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;

export async function up(db) {
    if (!(await hasTable(db, 'member_join_history'))) {
        await db.execute(`
            CREATE TABLE member_join_history (
                id         BIGINT AUTO_INCREMENT PRIMARY KEY,
                guild_id   VARCHAR(20) NOT NULL,
                user_id    VARCHAR(20) NOT NULL,
                joined_at  DATETIME(3) NOT NULL,
                source     ENUM('live','system_message','audit_log','invite_log') NOT NULL DEFAULT 'live',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_join (guild_id, user_id, joined_at),
                KEY idx_guild_time (guild_id, joined_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }
    if (!(await hasTable(db, 'join_rejoin_resets'))) {
        await db.execute(`
            CREATE TABLE join_rejoin_resets (
                id        BIGINT AUTO_INCREMENT PRIMARY KEY,
                guild_id  VARCHAR(20) NOT NULL,
                user_id   VARCHAR(20) NOT NULL,
                reason    ENUM('staff','unban') NOT NULL,
                reset_by  VARCHAR(20) DEFAULT NULL,
                reset_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                KEY idx_guild_user (guild_id, user_id, reset_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }

    const cols = [
        ['rejoin_limit_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['rejoin_max_joins', 'INT NOT NULL DEFAULT 3'],
        ['rejoin_window_days', 'INT NOT NULL DEFAULT 0'],
        ['rejoin_action', "VARCHAR(10) NOT NULL DEFAULT 'ban'"],
        ['rejoin_backfilled_at', 'DATETIME DEFAULT NULL'],
    ];
    for (const [name, def] of cols) {
        if (!(await hasColumn(db, 'join_gate_config', name))) {
            await db.execute(`ALTER TABLE join_gate_config ADD COLUMN ${name} ${def}`);
        }
    }

    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(EVENT_ACTIONS)} NOT NULL`);
}

export async function down(db) {
    await db.execute("DELETE FROM join_gate_events WHERE action LIKE 'rejoin\\_%'");
    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(OLD_EVENT_ACTIONS)} NOT NULL`);
    for (const name of ['rejoin_limit_enabled', 'rejoin_max_joins', 'rejoin_window_days', 'rejoin_action', 'rejoin_backfilled_at']) {
        if (await hasColumn(db, 'join_gate_config', name)) await db.execute(`ALTER TABLE join_gate_config DROP COLUMN ${name}`);
    }
    await db.execute('DROP TABLE IF EXISTS join_rejoin_resets');
    await db.execute('DROP TABLE IF EXISTS member_join_history');
}
