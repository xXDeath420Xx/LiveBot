/*
 * Migration 299: what /economy heist needs on the existing (empty) heist tables.
 *
 * heists, heist_participants, heist_results, heist_rewards and heist_stats were created long ago and
 * never written. core/heist-manager.js now runs heists on them; this adds the state a restart-safe
 * resolver needs:
 *
 *   heists.message_id          the recruiting message, edited as the crew fills and when it resolves
 *   heists.max_crew            crew size cap chosen at start (2-10)
 *   heists.payout_multiplier   stake multiplier paid on success (fixed per target, stored for history)
 *   heists.roll                the random roll that decided it — written once, so a resolver that
 *                              restarts mid-settlement re-uses the decision instead of re-rolling
 *   heists.cancel_reason       why a heist was called off (not enough crew / host / admin)
 *   heist_participants.settled 0 while the stake is in escrow; 1 once paid out, lost or refunded.
 *                              Settlement flips it with a guarded UPDATE in the same transaction as
 *                              the wallet credit, so a stake is never paid twice.
 *   heist_participants.payout  what the member got back (0 on failure, the stake on a refund)
 *   heist_results.heist_id     which heist a result row belongs to
 *
 * heists.starts_at is the end of the join window; status 'inprogress' marks a heist claimed for
 * resolution. Existing UNIQUE keys (heist_participants heist_id+user_id, heist_stats
 * guild_id+user_id) already cover double joins and the stats upsert.
 *
 * Idempotent (guarded ADD COLUMN / ADD INDEX). Apply directly: import { up } and call up(pool).
 */
const COLUMNS = [
    ['heists', 'message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['heists', 'max_crew', 'INT NOT NULL DEFAULT 6'],
    ['heists', 'payout_multiplier', 'DECIMAL(5,2) NULL DEFAULT NULL'],
    ['heists', 'roll', 'DECIMAL(6,5) NULL DEFAULT NULL'],
    ['heists', 'cancel_reason', 'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL'],
    ['heist_participants', 'settled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['heist_participants', 'payout', 'INT NULL DEFAULT NULL'],
    ['heist_results', 'heist_id', 'BIGINT NULL DEFAULT NULL'],
];

const INDEXES = [
    ['heists', 'idx_heist_guild_status', '(guild_id, status, ended_at)'],
    ['heist_participants', 'idx_heist_unsettled', '(heist_id, settled)'],
    ['heist_results', 'idx_heist_result', '(heist_id)'],
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
    for (const [table, index, cols] of INDEXES) {
        if (!(await hasIndex(db, table, index))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` ${cols}`);
        }
    }
}

export async function down(db) {
    for (const [table, index] of INDEXES) {
        if (await hasIndex(db, table, index)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
        }
    }
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
