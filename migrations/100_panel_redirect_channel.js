/**
 * Migration 100: Optional per-panel redirect channel.
 *
 * Adds `post_assign_redirect_channel_id VARCHAR(20) NULL` to
 * `reaction_role_panels`. When set, the reaction-role manager appends a
 * Discord Link button to its ephemeral confirmation reply whenever a user
 * is GRANTED (not removed from) a role via that panel. The button targets
 * `https://discord.com/channels/{guild_id}/{channel_id}` so one click jumps
 * the user to the configured channel.
 *
 * Primary use case: rules-verify panels that should funnel newly-verified
 * users to a #roles channel. Generic — any panel in any guild can opt in.
 *
 * Idempotent.
 */

async function hasColumn(db, table, column) {
    const allowedTables = new Set(['reaction_role_panels']);
    const allowedColumns = new Set(['post_assign_redirect_channel_id']);
    if (!allowedTables.has(table) || !allowedColumns.has(column)) {
        throw new Error(`Refusing to inspect unknown table/column: ${table}/${column}`);
    }
    const [cols] = await db.execute(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    return cols.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'reaction_role_panels', 'post_assign_redirect_channel_id'))) {
        await db.execute(`
            ALTER TABLE reaction_role_panels
            ADD COLUMN post_assign_redirect_channel_id VARCHAR(20) NULL DEFAULT NULL
            COMMENT 'If set, ephemeral reply after role-add includes a Link button to this channel'
        `);
        console.log('[Migration 100] Added reaction_role_panels.post_assign_redirect_channel_id');
    }
    console.log('[Migration 100] reaction_role_panels.post_assign_redirect_channel_id ready');
}

export async function down(db) {
    if (await hasColumn(db, 'reaction_role_panels', 'post_assign_redirect_channel_id')) {
        await db.execute(`ALTER TABLE reaction_role_panels DROP COLUMN post_assign_redirect_channel_id`);
    }
    console.log('[Migration 100] Rolled back - removed post_assign_redirect_channel_id');
}
