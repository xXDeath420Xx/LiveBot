/**
 * Migration 185: Per-user dashboard layout preferences
 *
 * `user_preferences` already exists — with `theme` and `compact_mode` columns —
 * and is referenced by **zero lines of code**. Another table built for a feature
 * that was never wired up, exactly like `guild_language_prefs` and
 * `translations` were before the i18n work.
 *
 * So this extends the existing table rather than adding a competing one. Two new
 * columns:
 *
 *   dashboard_layout  'grid' (today's card grid) | 'list' (dense rows)
 *   pinned_pages      JSON array of ?page= slugs the user wants surfaced first
 *
 * ## Why the default must be the current behaviour
 *
 * The manage overview has 74 module cards and people have built muscle memory
 * around where things sit. A layout change that arrives unasked is a worse
 * experience than the layout being imperfect. So `dashboard_layout` defaults to
 * 'grid' — identical to what ships today — and everything here is opt-in. A
 * user who never visits settings sees no change at all.
 *
 * ## Why pinned pages are the bigger win
 *
 * There are 89 manage pages and a given admin uses perhaps five. A density
 * toggle makes 89 cards slightly smaller; pinning makes the five they actually
 * use appear first. The layout choice is the cosmetic half of this migration and
 * the pinning is the useful half.
 */
export async function up(pool) {
    const columns = [
        ['dashboard_layout', "ENUM('grid','list') NOT NULL DEFAULT 'grid'"],
        ['pinned_pages', 'JSON DEFAULT NULL'],
        ['recent_pages', 'JSON DEFAULT NULL'],
    ];

    for (const [name, definition] of columns) {
        try {
            await pool.execute(`ALTER TABLE user_preferences ADD COLUMN ${name} ${definition}`);
            console.log(`[Migration 185] Added user_preferences.${name}`);
        } catch (error) {
            // Re-runnable: an already-present column is success, not failure.
            if (error.code === 'ER_DUP_FIELDNAME') continue;
            throw error;
        }
    }

    // The table predates any migration and has no primary key declared in a
    // migration file — confirm it can be upserted against before code relies on
    // ON DUPLICATE KEY UPDATE, which silently inserts duplicates without one.
    const [keys] = await pool.execute(
        `SELECT COUNT(*) AS n FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'user_preferences'
            AND index_name IN ('PRIMARY', 'discord_user_id')`
    );
    if (Number(keys[0].n) === 0) {
        await pool.query('ALTER TABLE user_preferences ADD PRIMARY KEY (discord_user_id)');
        console.log('[Migration 185] Added PRIMARY KEY (discord_user_id) — upserts would have duplicated rows without it');
    }
}

export async function down(pool) {
    for (const name of ['dashboard_layout', 'pinned_pages', 'recent_pages']) {
        await pool.execute(`ALTER TABLE user_preferences DROP COLUMN ${name}`).catch(() => {});
    }
}
