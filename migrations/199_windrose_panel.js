/*
 * Identity and audit for the Windrose panel at /windrose and /wrmanager.
 *
 * Windrose+ ships a capable admin surface but has exactly ONE credential — a shared RCON
 * password — and no concept of who is behind a request. Every action in its own dashboard is
 * anonymous and equally privileged. That is fine for one operator on a LAN and useless for a
 * group of friends where some should be able to restart the server, some should only watch,
 * and nobody should be able to restore a backup by accident.
 *
 * These four tables are the entire reason a custom panel exists. Without them the panel would
 * be a reskin of a tool that already works.
 *
 * `windrose_users.steam_id` is the load-bearing oddity. Discord OAuth gives us a Discord ID;
 * Windrose+ identifies players by Steam ID. Without the link, "show me my playtime" is
 * unanswerable and every per-player feature degrades into a server-wide one. It is nullable
 * because the link can only be made after someone has actually joined the game once.
 *
 * `windrose_pending_config` exists because ServerDescription.json, WorldDescription.json and
 * windrose_plus*.ini are all rewritten by the server as it shuts down: an edit made while it
 * runs is silently reverted. Rather than trusting people to remember that, the panel stages
 * edits here and applies them during the next stop→start window.
 *
 * `windrose_backups` mirrors what is on disk rather than owning it. The filesystem is the
 * source of truth — a row whose file has been deleted is stale, not authoritative — but the
 * table records WHO took a snapshot and WHY, which the filename alone cannot.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS windrose_users (
            discord_id    VARCHAR(20)  NOT NULL,
            role          ENUM('viewer','player','admin','owner') NOT NULL DEFAULT 'viewer',
            steam_id      VARCHAR(20)  DEFAULT NULL,
            display_name  VARCHAR(64)  DEFAULT NULL,
            granted_by    VARCHAR(20)  DEFAULT NULL,
            created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (discord_id),
            UNIQUE KEY uniq_steam (steam_id),
            KEY idx_role (role)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS windrose_audit (
            id          BIGINT       NOT NULL AUTO_INCREMENT,
            discord_id  VARCHAR(20)  DEFAULT NULL,
            action      VARCHAR(64)  NOT NULL,
            detail      JSON         DEFAULT NULL,
            result      ENUM('ok','error','denied') NOT NULL DEFAULT 'ok',
            created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_actor_time (discord_id, created_at),
            KEY idx_action_time (action, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS windrose_pending_config (
            id           BIGINT       NOT NULL AUTO_INCREMENT,
            target_file  VARCHAR(64)  NOT NULL,
            patch        JSON         NOT NULL,
            staged_by    VARCHAR(20)  DEFAULT NULL,
            applied_at   TIMESTAMP    NULL DEFAULT NULL,
            created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            -- Partial-index equivalent: the panel almost always wants "what is
            -- still waiting to apply", never the full history.
            KEY idx_unapplied (applied_at, target_file)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS windrose_backups (
            id          BIGINT       NOT NULL AUTO_INCREMENT,
            filename    VARCHAR(255) NOT NULL,
            size_bytes  BIGINT       NOT NULL DEFAULT 0,
            kind        ENUM('manual','scheduled','pre-restore') NOT NULL DEFAULT 'manual',
            created_by  VARCHAR(20)  DEFAULT NULL,
            created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_filename (filename),
            KEY idx_kind_time (kind, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS windrose_backups');
    await db.execute('DROP TABLE IF EXISTS windrose_pending_config');
    await db.execute('DROP TABLE IF EXISTS windrose_audit');
    await db.execute('DROP TABLE IF EXISTS windrose_users');
}
