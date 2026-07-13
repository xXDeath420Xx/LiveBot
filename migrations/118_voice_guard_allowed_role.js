/**
 * Migration 118: Voice channel guard — allowed role
 *
 * Extends `voice_channel_guards` (migration 103) from a strict single-user
 * allowlist to "owner OR anyone holding a role". Adds:
 *
 *   allowed_role_id  VARCHAR(20) NULL
 *
 * When set, the voiceStateUpdate guard permits a joining member if their id
 * matches `allowed_user_id` OR they hold `allowed_role_id`. NULL preserves the
 * original owner-only behavior, so existing guards are unaffected.
 *
 * Idempotent (column-existence check).
 */

async function columnExists(db, table, column) {
    const allowedTables = new Set(['voice_channel_guards']);
    const allowedColumns = new Set(['allowed_role_id']);
    if (!allowedTables.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    if (!allowedColumns.has(column)) throw new Error(`Refusing to inspect unknown column: ${column}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'voice_channel_guards', 'allowed_role_id'))) {
        await db.execute(
            'ALTER TABLE voice_channel_guards ADD COLUMN allowed_role_id VARCHAR(20) NULL AFTER allowed_user_id'
        );
    }
}

export async function down(db) {
    if (await columnExists(db, 'voice_channel_guards', 'allowed_role_id')) {
        await db.execute('ALTER TABLE voice_channel_guards DROP COLUMN allowed_role_id');
    }
}
