/*
 * Migration 307: loyalty points (/loyalty) — fills in the empty loyalty_points table and adds the
 * reward catalogue members redeem points against.
 *
 * core/loyalty-manager.js awards points once a day from activity the bot already records
 * (message_stats per user per day, voice_activity sessions): a daily-active award, points per
 * voice minutes, and a streak bonus for consecutive active days. Off until a server enables it.
 *
 *   loyalty_points (existing: guild_id, user_id, points, last_updated)
 *     + lifetime_points     everything ever earned (points is the spendable balance)
 *     + current_streak, best_streak
 *     + last_active_date    last day that counted as active
 *     + last_awarded_date   last day already paid — the guard that makes the daily job idempotent
 *     + UNIQUE (guild_id, user_id) so balance changes are single atomic upserts / conditional
 *       UPDATEs (`AND points >= cost` on redemption)
 *
 *   loyalty_rewards (new)      what a server offers: a role, coins, XP, or a custom reward staff
 *                              fulfil by hand. Optional stock.
 *   loyalty_redemptions (new)  every redemption: granted / requested (custom, awaiting staff) /
 *                              refunded (grant failed, points returned).
 *
 * loyalty_points was empty when this was written; duplicates stop the migration with a message.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */

const COLUMNS = [
    ['lifetime_points', 'INT NOT NULL DEFAULT 0'],
    ['current_streak', 'INT NOT NULL DEFAULT 0'],
    ['best_streak', 'INT NOT NULL DEFAULT 0'],
    ['last_active_date', 'DATE NULL DEFAULT NULL'],
    ['last_awarded_date', 'DATE NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

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

export async function up(db) {
    const [[row]] = await db.execute(
        `SELECT TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_points'`);
    if (!row) throw new Error('[307] table loyalty_points is missing');
    if (!String(row.c).startsWith('utf8mb4')) {
        await db.execute('ALTER TABLE loyalty_points CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    }

    for (const [column, type] of COLUMNS) {
        if (!(await hasColumn(db, 'loyalty_points', column))) {
            await db.execute(`ALTER TABLE loyalty_points ADD COLUMN \`${column}\` ${type}`);
        }
    }

    if (!(await hasUniqueOn(db, 'loyalty_points', ['guild_id', 'user_id']))) {
        const [[d]] = await db.execute(
            'SELECT COUNT(*) AS n FROM (SELECT 1 FROM loyalty_points GROUP BY guild_id, user_id HAVING COUNT(*) > 1) x');
        if (Number(d.n) > 0) {
            throw new Error(`[307] loyalty_points has ${d.n} duplicate (guild_id, user_id) groups — resolve them, then re-run`);
        }
        await db.execute('ALTER TABLE loyalty_points ADD UNIQUE KEY uq_guild_user (guild_id, user_id)');
    }

    await db.execute(`CREATE TABLE IF NOT EXISTS loyalty_rewards (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        guild_id     VARCHAR(20) NOT NULL,
        name         VARCHAR(100) NOT NULL,
        description  VARCHAR(300) NULL DEFAULT NULL,
        cost         INT NOT NULL,
        reward_type  VARCHAR(10) NOT NULL,
        role_id      VARCHAR(20) NULL DEFAULT NULL,
        amount       INT NOT NULL DEFAULT 0,
        stock        INT NULL DEFAULT NULL,
        enabled      TINYINT(1) NOT NULL DEFAULT 1,
        created_by   VARCHAR(20) NULL DEFAULT NULL,
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_guild_enabled (guild_id, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`CREATE TABLE IF NOT EXISTS loyalty_redemptions (
        id           BIGINT AUTO_INCREMENT PRIMARY KEY,
        guild_id     VARCHAR(20) NOT NULL,
        user_id      VARCHAR(20) NOT NULL,
        reward_id    INT NULL DEFAULT NULL,
        reward_name  VARCHAR(100) NOT NULL,
        cost         INT NOT NULL,
        status       VARCHAR(12) NOT NULL DEFAULT 'granted',
        note         VARCHAR(300) NULL DEFAULT NULL,
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_guild_user (guild_id, user_id),
        KEY idx_guild_status (guild_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS loyalty_redemptions');
    await db.execute('DROP TABLE IF EXISTS loyalty_rewards');
    await db.execute('ALTER TABLE loyalty_points DROP INDEX uq_guild_user').catch(() => {});
    for (const [column] of COLUMNS) {
        if (await hasColumn(db, 'loyalty_points', column)) {
            await db.execute(`ALTER TABLE loyalty_points DROP COLUMN \`${column}\``);
        }
    }
}
