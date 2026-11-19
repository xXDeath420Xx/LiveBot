/*
 * Migration 298: economy_transactions.transaction_type gains 'heist'.
 *
 * /economy heist (core/heist-manager.js) takes each crew member's stake out of their wallet into
 * escrow when they join, and pays the crew (or refunds a cancelled heist) when it resolves. Both
 * movements are ledger rows of type 'heist' so /economy social transactions and the dashboard can
 * tell them apart from gambling and fines.
 *
 * The ENUM is widened by UNION: the live value list is read from information_schema and only the
 * missing values are appended, so this cannot drop a value another migration added (in either
 * order). Never narrows.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const TABLE = 'economy_transactions';
const COLUMN = 'transaction_type';
const ADD = ['heist'];

async function currentEnum(db) {
    const [[col]] = await db.execute(
        `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, COLUMN]
    );
    if (!col) return null;
    const values = [...String(col.type).matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
    return { values, nullable: col.nullable === 'YES' };
}

function enumSql(values) {
    return `ENUM(${values.map(v => `'${v.replace(/'/g, "''")}'`).join(',')})`;
}

export async function up(db) {
    const col = await currentEnum(db);
    if (!col) throw new Error(`${TABLE}.${COLUMN} not found`);
    const missing = ADD.filter(v => !col.values.includes(v));
    if (!missing.length) return;
    await db.execute(
        `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`${COLUMN}\` ${enumSql([...col.values, ...missing])} ${col.nullable ? 'NULL' : 'NOT NULL'}`
    );
}

export async function down() {
    // Not narrowed: rows already written with 'heist' would be truncated to ''.
}
