/*
 * A shared QOTD question library with real anti-repetition.
 *
 * The old setup was per-guild decks seeded from the same 20-card starter list, posted
 * with ORDER BY RAND(). Two guilds got byte-identical questions, and a 20-card pool on
 * an unseeded random draw repeats inside a week — "What's your go-to comfort food?" ran
 * four times in a month in one guild and four times in the other.
 *
 * Three tables' worth of change:
 *
 * qotd_library — ONE global pool, not a copy per guild. Copying is what made every
 * server identical; a shared pool plus a per-guild selection seed is what makes them
 * diverge. `variant_group` is the anti-reword key: "If you could master any skill
 * instantly, what?" and "What skill would you learn if it took an afternoon?" are the
 * same question wearing a different hat, so they share a group and the window suppresses
 * the group, not the row. `slug` is the stable identity across re-seeds — the seeder
 * upserts on it, so editing a question's wording never resets its history.
 *
 * qotd_history gains library_id + variant_group + theme. The group and theme are COPIED
 * IN at post time rather than joined back to the library, because the window has to hold
 * even if the question is later reworded, re-themed, or retired. History is the record of
 * what a guild actually saw; it must not move when the library moves.
 *
 * qotd_channels gains the per-channel knobs. repeat_window_days defaults to 90 (the
 * rolling no-repeat guarantee), cross_guild_spacing_days to 14 (how long a question stays
 * "taken" for OTHER guilds after one guild posts it — soft, relaxed before the 90-day rule
 * is ever touched).
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS qotd_library (
            library_id     INT AUTO_INCREMENT PRIMARY KEY,
            slug           VARCHAR(120) NOT NULL,
            content        TEXT         NOT NULL,
            theme          VARCHAR(40)  NOT NULL,
            variant_group  VARCHAR(120) NOT NULL
                           COMMENT 'Near-duplicates share this; the no-repeat window suppresses the group',
            card_type      VARCHAR(16)  NOT NULL DEFAULT 'question',
            weight         INT          NOT NULL DEFAULT 100,
            active         TINYINT(1)   NOT NULL DEFAULT 1,
            times_used     INT          NOT NULL DEFAULT 0,
            last_used_at   TIMESTAMP    NULL DEFAULT NULL,
            created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_slug (slug),
            KEY idx_theme (theme),
            KEY idx_group (variant_group),
            KEY idx_active (active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const addColumn = async (table, column, ddl) => {
        const [[hit]] = await db.execute(
            `SELECT COUNT(*) AS n FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
            [table, column]
        );
        if (!hit.n) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };

    await addColumn('qotd_history', 'library_id', 'library_id INT NULL DEFAULT NULL AFTER card_id');
    await addColumn('qotd_history', 'variant_group', 'variant_group VARCHAR(120) NULL DEFAULT NULL AFTER library_id');
    await addColumn('qotd_history', 'theme', 'theme VARCHAR(40) NULL DEFAULT NULL AFTER variant_group');

    // card_id was NOT NULL and pointed at qotd_cards; library posts have no deck card.
    await db.execute('ALTER TABLE qotd_history MODIFY COLUMN card_id INT NULL DEFAULT NULL');

    const [idx] = await db.execute(
        `SELECT index_name FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'qotd_history'
           AND index_name = 'idx_guild_group_posted'`
    );
    if (!idx.length) {
        await db.execute(
            'CREATE INDEX idx_guild_group_posted ON qotd_history (guild_id, variant_group, posted_at)'
        );
    }

    await addColumn('qotd_channels', 'source_mode',
        `source_mode VARCHAR(16) NOT NULL DEFAULT 'library'
         COMMENT 'library | deck | mixed — mixed drains the guild deck first, then the library'`);
    await addColumn('qotd_channels', 'repeat_window_days',
        'repeat_window_days INT NOT NULL DEFAULT 90');
    await addColumn('qotd_channels', 'cross_guild_spacing_days',
        'cross_guild_spacing_days INT NOT NULL DEFAULT 14');
    await addColumn('qotd_channels', 'theme_blocklist',
        `theme_blocklist TEXT NULL DEFAULT NULL COMMENT 'JSON array of themes this channel never posts'`);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS qotd_library');
    for (const col of ['library_id', 'variant_group', 'theme']) {
        await db.execute(`ALTER TABLE qotd_history DROP COLUMN IF EXISTS ${col}`);
    }
    for (const col of ['source_mode', 'repeat_window_days', 'cross_guild_spacing_days', 'theme_blocklist']) {
        await db.execute(`ALTER TABLE qotd_channels DROP COLUMN IF EXISTS ${col}`);
    }
}
