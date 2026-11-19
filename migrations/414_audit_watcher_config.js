/**
 * Wave 414 — audit bot report watcher settings.
 *
 * events/globalBanReportWatcher.js had its watched channels and its authorised reporter roles
 * hard-coded. They move here so the owner can edit them from the dashboard (Twitch Moderators
 * Community → audit bot page). Seeded with the exact values that were in the code on
 * 2026-11-18, so behaviour is unchanged by the migration itself.
 *
 *   audit_watch_channels  one row per channel whose reports are read
 *     guild_id    VARCHAR(20)   server the channel belongs to
 *     channel_id  VARCHAR(20)   PK
 *     category    VARCHAR(24)   'auto' = work it out from the report text (inferCategory), or a fixed
 *                               global_ban_entries.category for every entry filed from this channel
 *     label       VARCHAR(100)  name shown in logs and on the dashboard
 *     enabled     TINYINT(1)    0 = kept but not read
 *   audit_watch_roles     roles whose members' reports are acted on
 *     guild_id, role_id (PK)
 *
 * An empty table means "nothing watched" / "nobody authorised" — the watcher falls back to the
 * old constants only when it cannot read these tables at all.
 * Owner request 2026-11-18 ("make it manageable from my dashboard").
 * Apply directly: import { up } and call up(pool).
 */
const GUILD = '889550752123613194';

export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_watch_channels (
            guild_id   VARCHAR(20)  NOT NULL,
            channel_id VARCHAR(20)  NOT NULL,
            category   VARCHAR(24)  NOT NULL DEFAULT 'auto',
            label      VARCHAR(100) NOT NULL DEFAULT '',
            enabled    TINYINT(1)   NOT NULL DEFAULT 1,
            updated_by VARCHAR(20)  DEFAULT NULL,
            created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (channel_id),
            KEY idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_watch_roles (
            guild_id   VARCHAR(20) NOT NULL,
            role_id    VARCHAR(20) NOT NULL,
            updated_by VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (role_id),
            KEY idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Seed only into empty tables, so re-running never resurrects something removed on the dashboard.
    const [[{ n: ch }]] = await pool.query('SELECT COUNT(*) n FROM audit_watch_channels');
    if (!ch) {
        await pool.query(
            'INSERT INTO audit_watch_channels (guild_id, channel_id, category, label) VALUES ?',
            [[
                [GUILD, '899865437267963924', 'auto', 'Various red flags'],
                [GUILD, '1142508311594410086', 'spam', 'GFX spammer'],
            ]]
        );
    }
    const [[{ n: ro }]] = await pool.query('SELECT COUNT(*) n FROM audit_watch_roles');
    if (!ro) {
        await pool.query(
            'INSERT INTO audit_watch_roles (guild_id, role_id) VALUES ?',
            [['889550893727494185', '1345811788020711626', '951075793109405696', '1345812273234579507', '995576900091138108']
                .map(r => [GUILD, r])]
        );
    }
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS audit_watch_roles');
    await pool.query('DROP TABLE IF EXISTS audit_watch_channels');
}
