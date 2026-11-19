/*
 * Migration 300: trades — what a live negotiation needs.
 *
 * The dashboard's Trading page lists the `trades` table, but nothing ever created a trade.
 * /economy trade offer and /fun games trade (core/trade-manager.js) now do: the offer is posted with
 * Accept / Counter / Decline / Cancel buttons, either side can counter, and accepting settles coins,
 * shop items and cards in one transaction. This adds:
 *
 *   channel_id, message_id  the posted offer, so expiry and dashboard cancels can update it
 *   awaiting_id             whose answer the current terms wait for (the recipient at first; it
 *                           flips to the other side on every counter-offer). Only they can accept.
 *   expires_at              pending offers lapse 24h after the last change (jobs/economy-events-scheduler.js)
 *   counter_count           counter-offers so far (capped, so two people can't ping-pong forever)
 *   status 'expired'        appended to the status ENUM (by union with the live list; never narrows)
 *
 * Nothing is held in escrow while an offer is pending — balances, items and card ownership are
 * re-checked under row locks at the moment of acceptance — so expiring or cancelling a trade never
 * has to give anything back.
 *
 * Idempotent. Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['awaiting_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['expires_at', 'DATETIME NULL DEFAULT NULL'],
    ['counter_count', 'INT NOT NULL DEFAULT 0'],
];

async function hasColumn(db, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND COLUMN_NAME = ?`,
        [column]
    );
    return rows.length > 0;
}

async function hasIndex(db, index) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND INDEX_NAME = ?`,
        [index]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [column, type] of COLUMNS) {
        if (!(await hasColumn(db, column))) {
            await db.execute(`ALTER TABLE trades ADD COLUMN \`${column}\` ${type}`);
        }
    }

    const [[col]] = await db.execute(
        `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades' AND COLUMN_NAME = 'status'`
    );
    const values = [...String(col?.type || '').matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
    if (values.length && !values.includes('expired')) {
        const list = [...values, 'expired'].map(v => `'${v.replace(/'/g, "''")}'`).join(',');
        await db.execute(`ALTER TABLE trades MODIFY COLUMN status ENUM(${list}) NULL DEFAULT 'pending'`);
    }

    if (!(await hasIndex(db, 'idx_trades_expiry'))) {
        await db.execute('ALTER TABLE trades ADD INDEX idx_trades_expiry (status, expires_at)');
    }
}

export async function down(db) {
    if (await hasIndex(db, 'idx_trades_expiry')) {
        await db.execute('ALTER TABLE trades DROP INDEX idx_trades_expiry');
    }
    for (const [column] of COLUMNS) {
        if (await hasColumn(db, column)) {
            await db.execute(`ALTER TABLE trades DROP COLUMN \`${column}\``);
        }
    }
    // status keeps 'expired': narrowing would blank rows that use it.
}
