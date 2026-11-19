/*
 * `guild_config.modlog_components_v2` — opt-in flag for rendering modlog
 * messages as Discord Components V2 (containers / sections / separators /
 * media galleries) instead of legacy embeds.
 *
 * Default 0 preserves the current behaviour; the dashboard appearance page
 * is where guilds flip it on. core/log-manager.js reads the flag once per
 * minute per guild via its own in-process cache, so the hot modlog path
 * does not hit the DB on every event.
 */

async function tableExists(db, name) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
        [name]
    );
    return rows.length > 0;
}

async function columnExists(db, table, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'guild_config'))) {
        // guild_config is created very early in the schema; a missing table here
        // means we're running against a bare DB — skip rather than fail the migration chain.
        return;
    }
    if (!(await columnExists(db, 'guild_config', 'modlog_components_v2'))) {
        await db.execute(
            `ALTER TABLE guild_config
             ADD COLUMN modlog_components_v2 TINYINT(1) NOT NULL DEFAULT 0
             COMMENT 'Opt-in: render modlog as Discord Components V2 instead of legacy embeds'`
        );
    }
}

export async function down(db) {
    if (await columnExists(db, 'guild_config', 'modlog_components_v2')) {
        await db.execute(`ALTER TABLE guild_config DROP COLUMN modlog_components_v2`);
    }
}
