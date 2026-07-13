/**
 * Migration 093: Self-promo announcement-channel gate
 *
 * Adds level + role gating to the self-promo announcement channel.
 * Previously the announcement channel was ungated — users could post
 * messages or create threads there without restriction. This migration
 * lets admins require a minimum level and/or specific roles (e.g. a
 * Twitch streamer role) to post or start threads in that channel.
 *
 * Columns added to self_promo_config:
 *   - announce_gate_enabled        BOOL, default 0 (off → no behavior change)
 *   - announce_min_level           INT UNSIGNED, default 1
 *   - announce_required_role_ids   LONGTEXT NULL (JSON array; NULL/[] = no role req)
 *   - announce_delete_unauthorized TINYINT, default 1 (delete offending threads/msgs)
 */

async function hasColumn(db, column) {
    // MariaDB's SHOW COLUMNS LIKE doesn't accept placeholders, and the
    // allow-list below is small and bot-controlled so plain interpolation
    // is safe here.
    const allowed = new Set([
        'announce_gate_enabled',
        'announce_min_level',
        'announce_required_role_ids',
        'announce_delete_unauthorized',
    ]);
    if (!allowed.has(column)) {
        throw new Error(`Refusing to inspect unknown column: ${column}`);
    }
    const [cols] = await db.execute(
        `SHOW COLUMNS FROM self_promo_config LIKE '${column}'`
    );
    return cols.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'announce_gate_enabled'))) {
        await db.execute(`
            ALTER TABLE self_promo_config
            ADD COLUMN announce_gate_enabled TINYINT(1) NOT NULL DEFAULT 0
            COMMENT 'If 1, enforce level + role gate on announcement_channel_id'
        `);
    }
    if (!(await hasColumn(db, 'announce_min_level'))) {
        await db.execute(`
            ALTER TABLE self_promo_config
            ADD COLUMN announce_min_level INT UNSIGNED NOT NULL DEFAULT 1
            COMMENT 'Minimum user level to post/create threads in announce channel (0 = no level gate)'
        `);
    }
    if (!(await hasColumn(db, 'announce_required_role_ids'))) {
        await db.execute(`
            ALTER TABLE self_promo_config
            ADD COLUMN announce_required_role_ids LONGTEXT NULL
            COMMENT 'JSON array of role snowflakes required to post in announce channel (NULL/[] = no role req)'
        `);
    }
    if (!(await hasColumn(db, 'announce_delete_unauthorized'))) {
        await db.execute(`
            ALTER TABLE self_promo_config
            ADD COLUMN announce_delete_unauthorized TINYINT(1) NOT NULL DEFAULT 1
            COMMENT 'If 1, bot deletes unauthorized messages/threads in announce channel'
        `);
    }
}

export async function down(db) {
    for (const col of ['announce_delete_unauthorized', 'announce_required_role_ids', 'announce_min_level', 'announce_gate_enabled']) {
        if (await hasColumn(db, col)) {
            await db.execute(`ALTER TABLE self_promo_config DROP COLUMN ${col}`);
        }
    }
}
