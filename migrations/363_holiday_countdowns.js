/**
 * Migration 363 — Holiday countdowns.
 *
 * `holiday_countdowns` is per-guild config for each holiday slug (christmas,
 * halloween, …). The holiday catalog itself lives in code (core/holiday-manager.js)
 * so the migration can run before the catalog expands; new catalog entries land
 * on every guild automatically with their defaults.
 *
 * `holiday_countdown_pins` is a persistent "live" message the daily updater
 * edits in place — a server can have one pinned "Days until Christmas" post
 * per holiday that refreshes once a day without re-posting.
 *
 * `holiday_lunar_dates` holds manual-override dates for holidays whose
 * calendar isn't algorithmic (lunar new year, Diwali, Hanukkah, Ramadan, Eid).
 * Seed data goes in via a separate seed step so the migration itself stays
 * strictly schema-only.
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'holiday_countdowns'))) {
        await db.execute(`
            CREATE TABLE holiday_countdowns (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id VARCHAR(32) NOT NULL,
                slug VARCHAR(48) NOT NULL,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                announce_channel_id VARCHAR(32) NULL,
                announce_on_day TINYINT(1) NOT NULL DEFAULT 1,
                mention_role_id VARCHAR(32) NULL,
                emoji_override VARCHAR(24) NULL,
                label_override VARCHAR(80) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uniq_guild_slug (guild_id, slug),
                KEY idx_guild (guild_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('[migrate 363] holiday_countdowns created');
    }

    if (!(await hasTable(db, 'holiday_countdown_pins'))) {
        await db.execute(`
            CREATE TABLE holiday_countdown_pins (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id VARCHAR(32) NOT NULL,
                slug VARCHAR(48) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                message_id VARCHAR(32) NULL,
                last_updated_at TIMESTAMP NULL,
                last_days_remaining INT NULL,
                failures_since_success INT UNSIGNED NOT NULL DEFAULT 0,
                disabled_reason VARCHAR(120) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uniq_guild_slug_pin (guild_id, slug),
                KEY idx_channel (channel_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('[migrate 363] holiday_countdown_pins created');
    }

    if (!(await hasTable(db, 'holiday_lunar_dates'))) {
        await db.execute(`
            CREATE TABLE holiday_lunar_dates (
                slug VARCHAR(48) NOT NULL,
                year SMALLINT UNSIGNED NOT NULL,
                occurs_on DATE NOT NULL,
                PRIMARY KEY (slug, year)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('[migrate 363] holiday_lunar_dates created');
    }

    // Seed lunar / variable-date holidays. INSERT IGNORE so we're idempotent
    // across re-runs. Dates are the authoritative first-day of the holiday
    // (lunar new year = day 1, Hanukkah = first night, Ramadan = first day
    // of fasting, Eid al-Fitr = celebration day). Years cover current +
    // next few seasons so the countdown never shows "last year" for long.
    const seed = [
        // Lunar New Year (Chinese / Vietnamese)
        ['lunar-new-year', 2026, '2026-02-17'],
        ['lunar-new-year', 2027, '2027-02-06'],
        ['lunar-new-year', 2028, '2028-01-26'],
        ['lunar-new-year', 2029, '2029-02-13'],
        ['lunar-new-year', 2030, '2030-02-03'],
        // Diwali
        ['diwali', 2026, '2026-11-08'],
        ['diwali', 2027, '2027-10-29'],
        ['diwali', 2028, '2028-11-15'],
        ['diwali', 2029, '2029-11-05'],
        ['diwali', 2030, '2030-10-26'],
        // Hanukkah (first night)
        ['hanukkah', 2026, '2026-12-04'],
        ['hanukkah', 2027, '2027-12-24'],
        ['hanukkah', 2028, '2028-12-12'],
        ['hanukkah', 2029, '2029-12-01'],
        ['hanukkah', 2030, '2030-12-20'],
        // Ramadan (first day)
        ['ramadan', 2026, '2026-02-17'],
        ['ramadan', 2027, '2027-02-07'],
        ['ramadan', 2028, '2028-01-27'],
        ['ramadan', 2029, '2029-01-16'],
        ['ramadan', 2030, '2030-01-05'],
        // Eid al-Fitr (approximate — moves with lunar sighting)
        ['eid-al-fitr', 2026, '2026-03-19'],
        ['eid-al-fitr', 2027, '2027-03-09'],
        ['eid-al-fitr', 2028, '2028-02-26'],
        ['eid-al-fitr', 2029, '2029-02-14'],
        ['eid-al-fitr', 2030, '2030-02-04'],
    ];
    for (const [slug, year, date] of seed) {
        await db.execute(
            'INSERT IGNORE INTO holiday_lunar_dates (slug, year, occurs_on) VALUES (?, ?, ?)',
            [slug, year, date]
        );
    }
    console.log(`[migrate 363] seeded ${seed.length} lunar dates`);
}
