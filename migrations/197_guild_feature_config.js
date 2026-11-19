/*
 * Per-guild settings for features that never had a config table.
 *
 * The 2026-08-05 coverage audit found 27 command families with no dashboard control. Roughly
 * half of those had nowhere to PUT a setting either — /grow, /fun, /cannabis, /selfcare,
 * /knowledge and friends stored plenty of user data but no per-guild configuration at all, so
 * "enable it in this channel only" or "require an 18+ role" were not expressible.
 *
 * One JSON blob per (guild, feature) rather than a table per feature: these are small, sparse,
 * read-once-per-command settings whose shape is declared in core/feature-config-spec.js. A
 * column per setting across ~20 features would be ~120 columns of migration churn for values
 * that are never queried across guilds.
 *
 * Features that ALREADY have a real config table (vc_sound_config, qotd_channels,
 * pokemon_settings, ai_config, …) keep it — the spec points at those directly and this table
 * is not involved.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS guild_feature_config (
            guild_id     VARCHAR(20)  NOT NULL,
            feature_key  VARCHAR(64)  NOT NULL,
            config       JSON         NOT NULL,
            updated_by   VARCHAR(20)  DEFAULT NULL,
            created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, feature_key),
            KEY idx_feature (feature_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS guild_feature_config');
}
