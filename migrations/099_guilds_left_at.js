/**
 * Migration 099: Track when the bot was removed from a guild.
 *
 * Adds `left_at TIMESTAMP NULL DEFAULT NULL` to the `guilds` table so guild
 * loss can be distinguished from "last time we observed the bot in the guild."
 * Previously, the guildDelete event handler overwrote `last_seen = NOW()` at
 * the moment of removal, making losses indistinguishable from active guilds.
 *
 * NULL means: bot is currently in the guild.
 * Non-NULL: timestamp when the bot was kicked / left.
 *
 * Idempotent.
 */

async function hasColumn(db, table, column) {
    const allowedTables = new Set(['guilds']);
    const allowedColumns = new Set(['left_at']);
    if (!allowedTables.has(table) || !allowedColumns.has(column)) {
        throw new Error(`Refusing to inspect unknown table/column: ${table}/${column}`);
    }
    const [cols] = await db.execute(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    return cols.length > 0;
}

async function hasIndex(db, table, indexName) {
    const allowedTables = new Set(['guilds']);
    const allowedIndexes = new Set(['idx_left_at']);
    if (!allowedTables.has(table) || !allowedIndexes.has(indexName)) {
        throw new Error(`Refusing to inspect unknown table/index: ${table}/${indexName}`);
    }
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
         WHERE table_schema = DATABASE() AND table_name = '${table}' AND index_name = '${indexName}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'guilds', 'left_at'))) {
        await db.execute(`
            ALTER TABLE guilds
            ADD COLUMN left_at TIMESTAMP NULL DEFAULT NULL
            COMMENT 'Timestamp when bot was kicked/left guild; NULL means currently present'
        `);
        console.log('[Migration 099] Added guilds.left_at column');
    }

    if (!(await hasIndex(db, 'guilds', 'idx_left_at'))) {
        await db.execute(`ALTER TABLE guilds ADD INDEX idx_left_at (left_at)`);
        console.log('[Migration 099] Added idx_left_at index');
    }

    console.log('[Migration 099] guilds.left_at ready');
}

export async function down(db) {
    if (await hasIndex(db, 'guilds', 'idx_left_at')) {
        await db.execute(`ALTER TABLE guilds DROP INDEX idx_left_at`);
    }
    if (await hasColumn(db, 'guilds', 'left_at')) {
        await db.execute(`ALTER TABLE guilds DROP COLUMN left_at`);
    }
    console.log('[Migration 099] Rolled back - removed guilds.left_at');
}
