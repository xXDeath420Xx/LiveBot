/**
 * Migration 187: Custom colour schemes and an arrangeable dashboard
 *
 * Builds on 185 (layout + pinning) and 186 (density) with the three things a
 * preset list can't cover:
 *
 *   custom_theme      JSON of colour-token overrides. Lets someone build their
 *                     own scheme instead of picking from ours. Stored as data
 *                     rather than generated CSS — see the security note below.
 *
 *   section_order     JSON array of the overview's section keys, in the order
 *                     this user wants them. The overview ships 8 sections in a
 *                     fixed order that suits nobody in particular; a streaming
 *                     server wants Streaming first, a support server wants
 *                     Moderation first.
 *
 *   hidden_sections   JSON array of sections to leave out entirely. A server
 *                     that runs no games should not scroll past a Games section
 *                     forever.
 *
 * ## Why custom_theme stores DATA, never CSS
 *
 * The obvious shortcut is to let the user save a CSS snippet and echo it into a
 * <style> block. That is a stored-XSS hole: `}</style><script>…` escapes the
 * block trivially. So this column holds a flat map of known token names to
 * strictly-validated colour values, and the CSS is *generated* server-side from
 * that map. A value that isn't a hex colour never reaches the page.
 *
 * NULL everywhere means "no customisation", which is the default and reproduces
 * current behaviour exactly.
 */
export async function up(pool) {
    const columns = [
        ['custom_theme', 'JSON DEFAULT NULL'],
        ['section_order', 'JSON DEFAULT NULL'],
        ['hidden_sections', 'JSON DEFAULT NULL'],
    ];

    for (const [name, definition] of columns) {
        try {
            await pool.execute(`ALTER TABLE user_preferences ADD COLUMN ${name} ${definition}`);
            console.log(`[Migration 187] Added user_preferences.${name}`);
        } catch (error) {
            if (error.code !== 'ER_DUP_FIELDNAME') throw error;
            console.log(`[Migration 187] ${name} already present`);
        }
    }

    // 'custom' becomes a selectable theme value. The column is an ENUM in some
    // installs and a VARCHAR in others depending on how the table was created,
    // so widen it to VARCHAR rather than trying to ALTER an ENUM's member list.
    const [[col]] = await pool.execute(
        `SELECT column_type AS t FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'user_preferences' AND column_name = 'theme'`
    );
    if (col && /^enum/i.test(col.t)) {
        await pool.query(`ALTER TABLE user_preferences MODIFY COLUMN theme VARCHAR(32) NOT NULL DEFAULT 'dark'`);
        console.log('[Migration 187] Widened theme from ENUM to VARCHAR(32) so new themes need no schema change');
    }
}

export async function down(pool) {
    for (const name of ['custom_theme', 'section_order', 'hidden_sections']) {
        await pool.execute(`ALTER TABLE user_preferences DROP COLUMN ${name}`).catch(() => {});
    }
}
