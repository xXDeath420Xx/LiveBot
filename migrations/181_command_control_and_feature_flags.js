/**
 * Migration 181: Per-command control depth, and per-guild feature flags
 *
 * ## guild_command_restrictions
 *
 * The entire per-command control surface was three columns — `allowed`,
 * `admin_only`, `channel_id` — which forces every question into "on/off, mods
 * only, one channel". Real servers ask narrower questions than that: let this
 * role use it but not that one; allow it in these three channels; slow it down
 * without disabling it; say something specific when it's refused.
 *
 * Only 8 of 82 guilds use the table at all, which is what a control surface too
 * blunt to express what people want looks like.
 *
 * Columns added:
 *   allowed_roles     JSON array of role ids. Empty/NULL = everyone.
 *   denied_roles      JSON array of role ids. Checked after allowed_roles.
 *   allowed_channels  JSON array of channel ids, superseding the single channel_id.
 *   cooldown_seconds  Per-guild override of the command's own cooldown.
 *   cooldown_scope    Whether that cooldown is per user, per channel or per guild.
 *   denial_message    What to say when refused. NULL = the built-in localized text.
 *   ephemeral         Force replies hidden/visible regardless of the command's default.
 *
 * `channel_id` is deliberately kept. 95 rows already use it, and dropping it
 * would silently unlock every command those guilds had pinned to one channel.
 * The reader treats it as a single-entry allowed_channels.
 *
 * ## guild_feature_flags
 *
 * 211 of 443 guild-scoped tables have zero rows across all 82 guilds. Part of
 * that is discoverability, but part is that there has never been one place to
 * see what exists and turn it on. A single row per (guild, feature) gives the
 * catalog page something to read and write, without each subsystem needing its
 * own config table just to answer "is this on".
 */
export async function up(pool) {
    const columns = [
        ["allowed_roles", "JSON DEFAULT NULL"],
        ["denied_roles", "JSON DEFAULT NULL"],
        ["allowed_channels", "JSON DEFAULT NULL"],
        ["cooldown_seconds", "INT DEFAULT NULL"],
        ["cooldown_scope", "ENUM('user','channel','guild') NOT NULL DEFAULT 'user'"],
        ["denial_message", "VARCHAR(500) DEFAULT NULL"],
        ["ephemeral", "TINYINT(1) DEFAULT NULL"],
    ];

    for (const [name, definition] of columns) {
        try {
            await pool.execute(`ALTER TABLE guild_command_restrictions ADD COLUMN ${name} ${definition}`);
            console.log(`[Migration 181] Added guild_command_restrictions.${name}`);
        } catch (error) {
            // Re-runnable: an already-present column is success, not failure.
            if (error.code === 'ER_DUP_FIELDNAME') continue;
            throw error;
        }
    }

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS guild_feature_flags (
            guild_id     VARCHAR(20)  NOT NULL,
            feature_key  VARCHAR(64)  NOT NULL,
            enabled      TINYINT(1)   NOT NULL DEFAULT 0,
            configured_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            configured_by VARCHAR(20) DEFAULT NULL,
            PRIMARY KEY (guild_id, feature_key),
            KEY idx_feature (feature_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[Migration 181] Created guild_feature_flags');
}

export async function down(pool) {
    for (const name of ['allowed_roles', 'denied_roles', 'allowed_channels', 'cooldown_seconds', 'cooldown_scope', 'denial_message', 'ephemeral']) {
        await pool.execute(`ALTER TABLE guild_command_restrictions DROP COLUMN ${name}`).catch(() => {});
    }
    await pool.execute('DROP TABLE IF EXISTS guild_feature_flags');
}
