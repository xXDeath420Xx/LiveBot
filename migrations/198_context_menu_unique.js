/*
 * `context_menu_config` needs one row per (guild, menu).
 *
 * The table shipped with only `id` as a key, which was harmless while nothing wrote to it. Now
 * that the dashboard seeds a guild's rows on page load, an `ON DUPLICATE KEY UPDATE` with no
 * matching unique key inserts every time instead of updating — three page loads produced six
 * rows in testing.
 *
 * Existing duplicates are collapsed to the lowest id before the key is added, so the ALTER
 * cannot fail on data that predates it.
 */
export async function up(db) {
    // Collapse duplicates first — keep the earliest row for each (guild, menu).
    await db.execute(`
        DELETE c FROM context_menu_config c
        JOIN (
            SELECT guild_id, menu_name, MIN(id) AS keep_id
              FROM context_menu_config
             GROUP BY guild_id, menu_name
            HAVING COUNT(*) > 1
        ) d ON c.guild_id = d.guild_id AND c.menu_name = d.menu_name AND c.id <> d.keep_id
    `);

    const [idx] = await db.execute(
        `SHOW INDEX FROM context_menu_config WHERE Key_name = 'uniq_guild_menu'`
    );
    if (!idx.length) {
        await db.execute(
            `ALTER TABLE context_menu_config ADD UNIQUE KEY uniq_guild_menu (guild_id, menu_name)`
        );
    }
}

export async function down(db) {
    await db.execute(`ALTER TABLE context_menu_config DROP INDEX uniq_guild_menu`).catch(() => {});
}
