/*
 * Migration 295: suggestion tags go live.
 *
 * suggestion_tags (guild_id, tag_name UNIQUE per guild, tag_color, tag_emoji) and
 * suggestion_tag_assignments (suggestion_id, tag_id, both FK ON DELETE CASCADE) already exist and
 * are exactly the right shape, but nothing ever wrote them and the dashboard's tag filter was fed
 * a hard-coded empty list. core/suggestion-tags.js now manages them (/engage suggest tags,
 * /engage suggest tag, the dashboard Suggestions page).
 *
 * Added, for the audit trail staff asked for ("who tagged this as a bug?"):
 *   suggestion_tags.created_by / created_at
 *   suggestion_tag_assignments.assigned_by / assigned_at
 *
 * tag_emoji's column default is a mojibake '?️' left by whatever created the table; the code always
 * writes the emoji (or NULL) explicitly and treats '?️' as "none", so the default is left alone.
 *
 * Apply directly: import { up } and call up(pool).
 */
const COLUMNS = [
    ['suggestion_tags', 'created_by', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['suggestion_tags', 'created_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
    ['suggestion_tag_assignments', 'assigned_by', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['suggestion_tag_assignments', 'assigned_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
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
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
