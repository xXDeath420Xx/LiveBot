/**
 * Migration 121: Voice channel guard — multi-role / multi-user / admin allowances
 *
 * Migration 103 gave each guarded channel a single `allowed_user_id`; migration
 * 118 added a single `allowed_role_id`. Some channels need to admit MORE than one
 * role (e.g. a "stream guest" channel that lets in BOTH a Stream-Guest role and a
 * Stream-Moderators role), a handful of named extra users, and/or anyone holding
 * Administrator. This migration extends `voice_channel_guards` with:
 *
 *   allowed_role_ids  VARCHAR(512) NULL  -- comma-separated additional role ids
 *   allowed_user_ids  VARCHAR(512) NULL  -- comma-separated additional user ids
 *   allow_admins      TINYINT(1) NOT NULL DEFAULT 0
 *
 * The voiceStateUpdate guard treats the joining member as allowed if their id is
 * `allowed_user_id` OR appears in `allowed_user_ids`, OR they hold `allowed_role_id`
 * OR any role in `allowed_role_ids`, OR (`allow_admins` AND they have Administrator).
 * All three columns default to NULL/0, so existing single-user / single-role guards
 * keep their exact prior behavior.
 *
 * Idempotent (per-column existence check).
 */

async function columnExists(db, table, column) {
    const allowedTables = new Set(['voice_channel_guards']);
    const allowedColumns = new Set(['allowed_role_ids', 'allowed_user_ids', 'allow_admins']);
    if (!allowedTables.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    if (!allowedColumns.has(column)) throw new Error(`Refusing to inspect unknown column: ${column}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'voice_channel_guards', 'allowed_role_ids'))) {
        await db.execute(
            'ALTER TABLE voice_channel_guards ADD COLUMN allowed_role_ids VARCHAR(512) NULL AFTER allowed_role_id'
        );
    }
    if (!(await columnExists(db, 'voice_channel_guards', 'allowed_user_ids'))) {
        await db.execute(
            'ALTER TABLE voice_channel_guards ADD COLUMN allowed_user_ids VARCHAR(512) NULL AFTER allowed_role_ids'
        );
    }
    if (!(await columnExists(db, 'voice_channel_guards', 'allow_admins'))) {
        await db.execute(
            'ALTER TABLE voice_channel_guards ADD COLUMN allow_admins TINYINT(1) NOT NULL DEFAULT 0 AFTER allowed_user_ids'
        );
    }
}

export async function down(db) {
    for (const col of ['allow_admins', 'allowed_user_ids', 'allowed_role_ids']) {
        if (await columnExists(db, 'voice_channel_guards', col)) {
            await db.execute(`ALTER TABLE voice_channel_guards DROP COLUMN ${col}`);
        }
    }
}
