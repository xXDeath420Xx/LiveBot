/*
 * Migration 286: custom automod patterns become manageable.
 *
 * automod_patterns existed (and core/advanced-automod-manager.js matched it on every message) but
 * nothing could add, list or remove a row. /protection spam pattern-add|remove|list|toggle|
 * false-positive now do, and record hits in spam_patterns_stats (already unique on
 * guild_id + pattern_id, FK to automod_patterns ON DELETE CASCADE).
 *
 *   automod_patterns.created_by       Discord id of the admin who added it
 *   automod_patterns.created_at
 *   automod_patterns.disabled_reason  why it is off — set when a regex is switched off
 *                                     automatically for being too slow, or by an admin
 *
 * Idempotent (information_schema-guarded ADD COLUMN). Apply directly: import { up } and call up(pool).
 */

const COLUMNS = [
    ['automod_patterns', 'created_by', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['automod_patterns', 'created_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
    ['automod_patterns', 'disabled_reason', 'VARCHAR(200) NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
}

export async function down(db) {
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
