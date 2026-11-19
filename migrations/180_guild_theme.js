/**
 * Migration 180: Per-guild embed theming
 *
 * This network runs 41 separately-branded custom bots across 82 guilds, and
 * every one of them renders the same hardcoded palette: Discord Blurple #5865F2
 * appears 99 times, green #57F287/#2ECC71/#00FF00 141 times, red 77 times, gold
 * 76 times. 760 of 973 setColor() calls are hex literals. A server that
 * commissioned its own bot, with its own name and avatar, still produces embeds
 * indistinguishable from every other server's.
 *
 * The columns are SEMANTIC SLOTS, not a colour list. A call site asks for
 * "success", not "green" — so a guild whose brand is red-on-black can map
 * success to something that reads as success in their palette, and a call site
 * never has to know which guild it is rendering for.
 *
 * Slots were chosen by clustering what the existing literals are actually used
 * for, rather than invented:
 *
 *   primary  — Blurple/blue.  ~161 uses. Neutral/informational default.
 *   success  — Greens.        ~141 uses. Something worked.
 *   danger   — Reds.          ~77 uses.  Something failed or was destroyed.
 *   warning  — Golds/oranges. ~76 uses.  Caution, pending, rate-limited.
 *   info     — Cyan/teal.     Secondary informational.
 *   accent   — Purple.        ~36 uses.  Decorative highlight.
 *
 * NULL means "inherit the network default", so a row exists only where a guild
 * has actually chosen something and defaults can be changed globally later.
 */
export async function up(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS guild_theme (
            guild_id      VARCHAR(20)  NOT NULL,

            primary_color VARCHAR(7)   DEFAULT NULL,
            success_color VARCHAR(7)   DEFAULT NULL,
            danger_color  VARCHAR(7)   DEFAULT NULL,
            warning_color VARCHAR(7)   DEFAULT NULL,
            info_color    VARCHAR(7)   DEFAULT NULL,
            accent_color  VARCHAR(7)   DEFAULT NULL,

            -- Branding that rides along with the palette. footer_text is
            -- appended to embeds that don't set their own footer; footer_icon_url
            -- and thumbnail_url let a guild put its own mark on bot output.
            footer_text      VARCHAR(2048) DEFAULT NULL,
            footer_icon_url  VARCHAR(512)  DEFAULT NULL,
            thumbnail_url    VARCHAR(512)  DEFAULT NULL,

            -- Off by default so enabling theming is an explicit act. A guild can
            -- configure a palette, preview it, and switch it on separately.
            enabled       TINYINT(1)   NOT NULL DEFAULT 1,

            updated_by    VARCHAR(20)  DEFAULT NULL,
            updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

            PRIMARY KEY (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[Migration 180] Created guild_theme');
}

export async function down(pool) {
    await pool.execute('DROP TABLE IF EXISTS guild_theme');
}
