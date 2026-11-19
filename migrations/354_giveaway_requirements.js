/**
 * Migration 354 — Giveaway requirements + weighted entries (P2.9 parity with Giveaway Boat).
 *
 * Adds eligibility gates (min_level, min_messages, required_role_id, bypass_role_ids),
 * weighted-entry map (bonus_entries_json), and the context-menu reroll audit column.
 *
 * Idempotent.
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    const additions = [
        ['min_level',           'INT UNSIGNED NULL'],
        ['min_messages',        'INT UNSIGNED NULL'],
        ['required_role_id',    'VARCHAR(20) NULL'],
        ['bypass_role_ids',     'TEXT NULL'],           // JSON array of role_ids that skip all gates
        ['bonus_entries_json',  'TEXT NULL'],           // JSON {roleId: weight}
        ['rerolled_count',      'INT UNSIGNED NOT NULL DEFAULT 0'],
        ['last_rerolled_at',    'TIMESTAMP NULL'],
        ['last_rerolled_by',    'VARCHAR(20) NULL'],
    ];
    for (const [name, def] of additions) {
        if (!(await hasColumn(db, 'giveaways', name))) {
            await db.execute(`ALTER TABLE giveaways ADD COLUMN ${name} ${def}`);
            console.log(`[migrate 354] giveaways.${name} added`);
        }
    }
}
