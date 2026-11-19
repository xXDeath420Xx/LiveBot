/*
 * Migration 312: OwO give caps + transfer audit log (owo_cowoncy_limit, owo_transaction).
 * (OwO module — CC-BY-NC-SA derivative of OwO Bot, see /LICENSE-OWO-NOTICE.md.)
 *
 * core/owo/cowoncy.js transferCowoncy() now writes one owo_transaction row per transfer (also battle
 * bets and cowoncy drops/pickups, with the channel floor as account 0) and books every transfer
 * against the daily caps in owo_cowoncy_limit. Both tables exist and are empty; this widens them:
 *
 *   owo_transaction.time    TIMESTAMP -> TIMESTAMP(6). It is part of the PRIMARY KEY
 *                           (guild_id, sender, reciever, time); at one-second precision two gifts
 *                           between the same pair in the same second collide and the second
 *                           transfer would fail.
 *   owo_transaction.amount  INT -> BIGINT (balances are BIGINT).
 *   owo_cowoncy_limit.send / receive   INT UNSIGNED -> BIGINT UNSIGNED (high-level caps run to the
 *                           hundreds of millions per day).
 *   owo_transaction         + KEY (guild_id, reciever, time) for "transfers to this member" lookups
 *                           (`/owo2 transactions user:`); the PK already covers the sender side.
 *
 * Every change only widens a column or adds an index. Guarded, so re-running is a no-op.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function column(db, table, name) {
    const [[row]] = await db.execute(
        `SELECT DATA_TYPE AS type, DATETIME_PRECISION AS prec FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, name]
    );
    return row || null;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    const time = await column(db, 'owo_transaction', 'time');
    if (time && Number(time.prec) < 6) {
        await db.execute('ALTER TABLE `owo_transaction` MODIFY `time` TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)');
    }
    const amount = await column(db, 'owo_transaction', 'amount');
    if (amount && amount.type === 'int') {
        await db.execute('ALTER TABLE `owo_transaction` MODIFY `amount` BIGINT NOT NULL');
    }
    for (const name of ['send', 'receive']) {
        const col = await column(db, 'owo_cowoncy_limit', name);
        if (col && col.type === 'int') {
            await db.execute(`ALTER TABLE \`owo_cowoncy_limit\` MODIFY \`${name}\` BIGINT UNSIGNED NOT NULL DEFAULT 0`);
        }
    }
    if (!(await hasIndex(db, 'owo_transaction', 'idx_owo_tx_receiver'))) {
        await db.execute('ALTER TABLE `owo_transaction` ADD KEY `idx_owo_tx_receiver` (`guild_id`, `reciever`, `time`)');
    }
}

export async function down(db) {
    if (await hasIndex(db, 'owo_transaction', 'idx_owo_tx_receiver')) {
        await db.execute('ALTER TABLE `owo_transaction` DROP KEY `idx_owo_tx_receiver`');
    }
    // Column widenings are left in place: narrowing could truncate data written since.
}
