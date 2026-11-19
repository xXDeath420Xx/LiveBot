/*
 * Migration 313: OwO friendly-battle challenges with bets in escrow (owo_user_battle).
 * (OwO module — CC-BY-NC-SA derivative of OwO Bot, see /LICENSE-OWO-NOTICE.md.)
 *
 * owo_user_battle (existing, EMPTY) is upstream's per-pair challenge + head-to-head record:
 * (guild_id, user1, user2) with user1 < user2, sender, bet, time, win1/win2/tie, flags, channel.
 * core/owo/battle-pvp.js now uses it for every PvP challenge, holding optional bets in escrow.
 *
 *   user1, user2, sender   INT(11) -> VARCHAR(20). Upstream stored its own small user ids; this bot
 *                          stores Discord snowflakes, which overflow INT. Same conversion migration
 *                          091 applied to the other owo_* uid columns — this table was missed. The
 *                          table has no rows, so nothing is converted.
 *   + status               'idle' | 'pending' (challenger's stake held) | 'fighting' (both held)
 *   + escrow_sender        cowoncy currently held from the challenger
 *   + escrow_receiver      cowoncy currently held from the opponent
 *   + expires_at           when held escrow counts as abandoned; jobs/owo-battle-escrow-sweeper.js
 *                          refunds anything past it (restart safety)
 *   + message_id           the challenge message, so an expired one can be edited
 *   + KEY (status, expires_at) for the sweeper
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['status', "VARCHAR(12) NOT NULL DEFAULT 'idle'"],
    ['escrow_sender', 'BIGINT UNSIGNED NOT NULL DEFAULT 0'],
    ['escrow_receiver', 'BIGINT UNSIGNED NOT NULL DEFAULT 0'],
    ['expires_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
];

async function columnType(db, column) {
    const [[row]] = await db.execute(
        `SELECT DATA_TYPE AS type FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'owo_user_battle' AND COLUMN_NAME = ?`,
        [column]
    );
    return row?.type ?? null;
}

async function hasIndex(db, index) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'owo_user_battle' AND INDEX_NAME = ?`,
        [index]
    );
    return rows.length > 0;
}

export async function up(db) {
    const [[{ n }]] = await db.execute('SELECT COUNT(*) AS n FROM owo_user_battle');
    for (const col of ['user1', 'user2', 'sender']) {
        if ((await columnType(db, col)) === 'int') {
            if (Number(n) > 0) {
                throw new Error(`owo_user_battle has ${n} rows with INT ${col}; convert them by hand before running 313`);
            }
            const def = col === 'sender' ? 'VARCHAR(20) NOT NULL' : "VARCHAR(20) NOT NULL DEFAULT '0'";
            await db.execute(`ALTER TABLE \`owo_user_battle\` MODIFY \`${col}\` ${def}`);
        }
    }
    for (const [column, type] of COLUMNS) {
        if (!(await columnType(db, column))) {
            await db.execute(`ALTER TABLE \`owo_user_battle\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
    if (!(await hasIndex(db, 'idx_owo_user_battle_expiry'))) {
        await db.execute('ALTER TABLE `owo_user_battle` ADD KEY `idx_owo_user_battle_expiry` (`status`, `expires_at`)');
    }
}

export async function down(db) {
    if (await hasIndex(db, 'idx_owo_user_battle_expiry')) {
        await db.execute('ALTER TABLE `owo_user_battle` DROP KEY `idx_owo_user_battle_expiry`');
    }
    for (const [column] of COLUMNS) {
        if (await columnType(db, column)) {
            await db.execute(`ALTER TABLE \`owo_user_battle\` DROP COLUMN \`${column}\``);
        }
    }
    // user1/user2/sender stay VARCHAR(20): narrowing back to INT would truncate snowflakes.
}
