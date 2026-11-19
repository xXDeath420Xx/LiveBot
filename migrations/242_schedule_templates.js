/*
 * Schedule artwork templates.
 *
 * One background got stale fast — the same card every week for a channel that
 * streams six days of it. Owners upload several examples instead and the bot
 * picks one per post: fixed, shuffled, or random.
 *
 * Shuffle deals like a deck rather than rolling a die: every template appears
 * before any repeats, and `bag` holds what is left of the current round. Random
 * picking looks broken to a human — the same image twice running reads as a bug
 * even when it is honest chance.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS schedule_templates (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            guild_id    VARCHAR(20)  NOT NULL,
            label       VARCHAR(80)  NULL,
            source_url  TEXT         NOT NULL,
            mode        VARCHAR(16)  NOT NULL DEFAULT 'style',
            cache_url   TEXT         NULL,
            prompt      VARCHAR(400) NULL,
            enabled     TINYINT(1)   NOT NULL DEFAULT 1,
            sort_order  INT          NOT NULL DEFAULT 0,
            added_by    VARCHAR(20)  NULL,
            created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_guild (guild_id, enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const add = async (name, ddl) => {
        const [c] = await db.execute(`SHOW COLUMNS FROM twitch_schedule_sync_config LIKE '${name}'`);
        if (!c.length) await db.execute(`ALTER TABLE twitch_schedule_sync_config ADD COLUMN ${ddl}`);
    };
    await add('background_rotation', "background_rotation VARCHAR(12) NOT NULL DEFAULT 'fixed'");
    await add('template_bag', 'template_bag TEXT NULL');
    await add('last_template_id', 'last_template_id INT NULL');
}
export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS schedule_templates');
    for (const c of ['background_rotation', 'template_bag', 'last_template_id']) {
        await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN ${c}`).catch(() => {});
    }
}
