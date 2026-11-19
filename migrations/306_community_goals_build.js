/*
 * Migration 306: community goals (/arcade goals) — fills in the empty community_goals table.
 *
 * core/community-goals-manager.js runs server-wide targets with a deadline and a reward. Progress
 * comes from data the bot already records (activity_stats for messages, voice_activity for voice
 * minutes, the guild's member/boost counts) or from a staff-moved custom counter.
 *
 *   community_goals (existing: goal_type, target_value, current_value, is_active, reward_json,
 *                    created_at, completed_at)
 *     + title, description            what the goal is called / says
 *     + channel_id, message_id        where it is announced and the live progress post to edit
 *     + created_by                    staff member who set it
 *     + start_value, start_date       baseline for cumulative goals: messages already counted
 *                                     today in activity_stats when the goal was created
 *     + ends_at                       deadline (NULL = no deadline)
 *     + status                        'active' | 'completed' | 'failed' | 'cancelled'
 *     + last_milestone                25/50/75 already announced
 *     + reward_status                 'none' | 'pending' | 'paid'
 *     + progress_updated_at           last time the scheduler refreshed current_value
 *
 *   community_goal_payouts (new)  one row per member paid for a completed goal. Inserted BEFORE
 *                                 the member is paid, so a restart mid-payout cannot pay anyone twice.
 *
 * reward_json = {"coins": n, "xp": n, "role_id": "…"} paid to every member who contributed
 * (sent messages or spent time in voice) while the goal ran.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */

const COLUMNS = [
    ['title', "VARCHAR(100) NOT NULL DEFAULT ''"],
    ['description', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['created_by', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['start_value', 'BIGINT NOT NULL DEFAULT 0'],
    ['start_date', 'DATE NULL DEFAULT NULL'],
    ['ends_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['status', "VARCHAR(20) NOT NULL DEFAULT 'active'"],
    ['last_milestone', 'INT NOT NULL DEFAULT 0'],
    ['reward_status', "VARCHAR(20) NOT NULL DEFAULT 'none'"],
    ['progress_updated_at', 'TIMESTAMP NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    const [[row]] = await db.execute(
        `SELECT TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'community_goals'`);
    if (!row) throw new Error('[306] table community_goals is missing');
    if (!String(row.c).startsWith('utf8mb4')) {
        await db.execute('ALTER TABLE community_goals CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    }

    for (const [column, type] of COLUMNS) {
        if (!(await hasColumn(db, 'community_goals', column))) {
            await db.execute(`ALTER TABLE community_goals ADD COLUMN \`${column}\` ${type}`);
        }
    }

    await db.execute(`CREATE TABLE IF NOT EXISTS community_goal_payouts (
        goal_id       BIGINT NOT NULL,
        guild_id      VARCHAR(20) NOT NULL,
        user_id       VARCHAR(20) NOT NULL,
        coins         INT NOT NULL DEFAULT 0,
        xp            INT NOT NULL DEFAULT 0,
        role_granted  TINYINT(1) NOT NULL DEFAULT 0,
        paid_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (goal_id, user_id),
        KEY idx_guild_user (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS community_goal_payouts');
    for (const [column] of COLUMNS) {
        if (await hasColumn(db, 'community_goals', column)) {
            await db.execute(`ALTER TABLE community_goals DROP COLUMN \`${column}\``);
        }
    }
}
