/*
 * How a guild's Twitch schedule card should look.
 *
 * The month grid was the only option and most streamers ignored it in favour of
 * something they made in Canva. These columns let the card be a landscape overlay
 * or boxed rows instead, over a drawn gradient, an uploaded image, or artwork
 * generated from a prompt.
 *
 * `background_cache_url` exists because generation costs money per image: the
 * result is kept and reused until the prompt changes, rather than re-billed on
 * every six-hourly sync.
 */
export async function up(db) {
    const add = async (name, ddl) => {
        const [c] = await db.execute(`SHOW COLUMNS FROM twitch_schedule_sync_config LIKE '${name}'`);
        if (!c.length) await db.execute(`ALTER TABLE twitch_schedule_sync_config ADD COLUMN ${ddl}`);
    };
    await add('layout',              "layout VARCHAR(16) NOT NULL DEFAULT 'month'");
    await add('background_mode',     "background_mode VARCHAR(16) NOT NULL DEFAULT 'default'");
    await add('background_url',      'background_url TEXT NULL');
    await add('background_prompt',   'background_prompt TEXT NULL');
    await add('background_cache_url', 'background_cache_url TEXT NULL');
    await add('accent_color',        "accent_color VARCHAR(9) NULL");
    await add('card_title',          'card_title VARCHAR(80) NULL');
    await add('card_footer',         'card_footer VARCHAR(200) NULL');
}
export async function down(db) {
    for (const c of ['layout', 'background_mode', 'background_url', 'background_prompt',
        'background_cache_url', 'accent_color', 'card_title', 'card_footer']) {
        await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN ${c}`).catch(() => {});
    }
}
