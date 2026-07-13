/**
 * Migration 101: Optional per-button level gate on reaction-role mappings.
 *
 * Adds `min_level INT UNSIGNED NULL DEFAULT NULL` to `reaction_role_mappings`.
 * When set, `core/reaction-role-manager.js`'s grant path checks the user's
 * level via `levelingManager.getUserRank()` before assigning the role; the
 * remove path always bypasses the gate so users can opt out at any level.
 *
 * Primary use case: a self-serve "Auto-Live Opt-In" button in a signup
 * channel that should only grant the streamer role once a user reaches
 * level 2.
 *
 * Idempotent.
 */

async function hasColumn(db, table, column) {
    const allowedTables = new Set(['reaction_role_mappings']);
    const allowedColumns = new Set(['min_level']);
    if (!allowedTables.has(table) || !allowedColumns.has(column)) {
        throw new Error(`Refusing to inspect unknown table/column: ${table}/${column}`);
    }
    const [cols] = await db.execute(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    return cols.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'reaction_role_mappings', 'min_level'))) {
        await db.execute(`
            ALTER TABLE reaction_role_mappings
            ADD COLUMN min_level INT UNSIGNED NULL DEFAULT NULL
            COMMENT 'Optional minimum user level to obtain this role via button click; remove path bypasses'
        `);
        console.log('[Migration 101] Added reaction_role_mappings.min_level');
    }
    console.log('[Migration 101] reaction_role_mappings.min_level ready');
}

export async function down(db) {
    if (await hasColumn(db, 'reaction_role_mappings', 'min_level')) {
        await db.execute(`ALTER TABLE reaction_role_mappings DROP COLUMN min_level`);
    }
    console.log('[Migration 101] Rolled back - removed min_level');
}
