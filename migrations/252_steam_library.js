/*
 * Steam library tally: who in a server owns which Steam game, for planning game nights.
 *
 * steam_links            one Steam account per Discord user. `verified` = proven through Steam's
 *                        own sign-in (OpenID); 0 = a pasted profile link nobody proved they own.
 *                        The SteamID64 is never shown to anyone but its owner.
 * steam_owned_games      app ids only — no playtime, no names, no friends. Keyed by the Discord
 *                        user so unlinking deletes everything in one statement.
 * steam_app_names        app id → store name, shared by everyone.
 * steam_library_members  which servers a user shares their library with. Linking in one server
 *                        never shows the library in another. `left_at` hides a departed member
 *                        at once; the sync job deletes the row 30 days later.
 * steam_library_config   per-guild panel (board embed + buttons) and public-page settings.
 * steam_game_nights /
 * steam_game_night_rsvps /steam night cards and who answered In / Maybe / Out.
 */
export async function up(db) {
    const T = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await db.execute(`
        CREATE TABLE IF NOT EXISTS steam_links (
            discord_user_id VARCHAR(20) PRIMARY KEY,
            steam_id64 VARCHAR(20) NOT NULL,
            verified TINYINT(1) NOT NULL DEFAULT 0,
            linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            synced_at TIMESTAMP NULL DEFAULT NULL,
            sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
            game_count INT UNSIGNED NOT NULL DEFAULT 0,
            KEY idx_steam (steam_id64),
            KEY idx_synced (synced_at)
        ) ${T}`);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS steam_owned_games (
            discord_user_id VARCHAR(20) NOT NULL,
            app_id INT UNSIGNED NOT NULL,
            PRIMARY KEY (discord_user_id, app_id),
            KEY idx_app (app_id)
        ) ${T}`);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS steam_app_names (
            app_id INT UNSIGNED PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_name (name(64))
        ) ${T}`);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS steam_library_members (
            guild_id VARCHAR(20) NOT NULL,
            discord_user_id VARCHAR(20) NOT NULL,
            joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            left_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (guild_id, discord_user_id),
            KEY idx_user (discord_user_id)
        ) ${T}`);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS steam_library_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            panel_channel_id VARCHAR(20) NULL,
            panel_message_id VARCHAR(20) NULL,
            board_size TINYINT UNSIGNED NOT NULL DEFAULT 15,
            min_owners TINYINT UNSIGNED NOT NULL DEFAULT 2,
            allow_unverified TINYINT(1) NOT NULL DEFAULT 1,
            public_token VARCHAR(32) NULL,
            public_show_names TINYINT(1) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_public_token (public_token)
        ) ${T}`);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS steam_game_nights (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            message_id VARCHAR(20) NULL,
            host_id VARCHAR(20) NOT NULL,
            app_id INT UNSIGNED NOT NULL,
            when_text VARCHAR(100) NULL,
            starts_at DATETIME NULL,
            note VARCHAR(300) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_guild (guild_id, created_at)
        ) ${T}`);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS steam_game_night_rsvps (
            night_id INT UNSIGNED NOT NULL,
            discord_user_id VARCHAR(20) NOT NULL,
            status VARCHAR(8) NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (night_id, discord_user_id)
        ) ${T}`);
}
