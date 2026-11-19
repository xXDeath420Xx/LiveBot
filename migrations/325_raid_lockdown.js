/*
 * Migration 325: raid lockdown, auto-trigger, same-name join floods, Discord incident actions
 * (core/raid-lockdown.js, core/raid-lockdown-logic.js).
 *
 *   raid_detection_config  gains every setting. It is the raid system's config row already (the
 *                          join-rate + new-account rule in core/raid-detection-manager.js), so the
 *                          lockdown, the auto-trigger and the same-name check live beside it rather
 *                          than in a parallel table. Everything that removes people is OFF.
 *   raid_lockdowns         one row per lockdown. The active row IS the lockdown (it survives a
 *                          restart); ended rows are the history. `lockdowns` could not be reused: it
 *                          is the per-channel send-lock record of `/admin mod lock` (UNIQUE per
 *                          channel, restore state), which a lockdown uses but is not.
 *   anti_raid_config       the Security page's old "Anti-Raid Protection" form wrote here and nothing
 *                          ever read it. Its numbers (joins / seconds / kick-or-ban / alert channel)
 *                          are exactly the auto-trigger's, so they are copied onto the auto-trigger
 *                          (left switched OFF: nothing acted on them before, and switching a
 *                          kick-every-join mode on for 30 servers is not a migration's call). The
 *                          table stays as a mirror for the old readers (feature flags, takeover).
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

const COLUMNS = [
    // Manual lockdown defaults (what /lockdown start and the dashboard pre-fill).
    ['lockdown_action', "VARCHAR(12) NOT NULL DEFAULT 'kick'"],
    ['lockdown_duration_minutes', 'INT NOT NULL DEFAULT 60'],
    ['lockdown_pause_invites', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['lockdown_lock_channels', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['lockdown_channel_ids', 'TEXT DEFAULT NULL'],
    ['lockdown_dm', 'TINYINT(1) NOT NULL DEFAULT 1'],
    // Auto-trigger (Hashbot defaults: 20 joins in 10 s, kick, 1 hour).
    ['auto_lockdown_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['auto_lockdown_joins', 'INT NOT NULL DEFAULT 20'],
    ['auto_lockdown_window_seconds', 'INT NOT NULL DEFAULT 10'],
    ['auto_lockdown_duration_minutes', 'INT NOT NULL DEFAULT 60'],
    ['auto_lockdown_action', "VARCHAR(12) NOT NULL DEFAULT 'kick'"],
    ['auto_lockdown_pause_invites', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['auto_lockdown_lock_channels', 'TINYINT(1) NOT NULL DEFAULT 0'],
    // Same-name join flood.
    ['same_name_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['same_name_count', 'INT NOT NULL DEFAULT 5'],
    ['same_name_window_seconds', 'INT NOT NULL DEFAULT 300'],
    ['same_name_action', "VARCHAR(12) NOT NULL DEFAULT 'ban'"],
    // Discord incident actions: the switches, and the exact times we last wrote (ownership).
    ['keep_dms_disabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['keep_invites_disabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['incident_dms_owned_until', 'DATETIME DEFAULT NULL'],
    ['incident_invites_owned_until', 'DATETIME DEFAULT NULL'],
    ['incident_checked_at', 'DATETIME DEFAULT NULL'],
    ['incident_error', 'VARCHAR(255) DEFAULT NULL'],
];

const clamp = (v, min, max, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export async function up(db) {
    for (const [name, def] of COLUMNS) {
        if (!(await hasColumn(db, 'raid_detection_config', name))) {
            await db.execute(`ALTER TABLE raid_detection_config ADD COLUMN ${name} ${def}`);
        }
    }

    if (!(await hasTable(db, 'raid_lockdowns'))) {
        await db.execute(`
            CREATE TABLE raid_lockdowns (
                id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id        VARCHAR(20) NOT NULL,
                status          ENUM('active','ended') NOT NULL DEFAULT 'active',
                action          VARCHAR(12) NOT NULL,
                trigger_kind    VARCHAR(10) NOT NULL DEFAULT 'manual',
                trigger_detail  VARCHAR(255) DEFAULT NULL,
                reason          VARCHAR(255) DEFAULT NULL,
                started_by      VARCHAR(20) DEFAULT NULL,
                started_at      DATETIME NOT NULL,
                ends_at         DATETIME NOT NULL,
                ended_at        DATETIME DEFAULT NULL,
                ended_by        VARCHAR(20) DEFAULT NULL,
                end_reason      VARCHAR(12) DEFAULT NULL,
                pause_invites   TINYINT(1) NOT NULL DEFAULT 0,
                invites_paused  TINYINT(1) NOT NULL DEFAULT 0,
                channels_locked TEXT DEFAULT NULL,
                joins_blocked   INT NOT NULL DEFAULT 0,
                joins_held      INT NOT NULL DEFAULT 0,
                joins_failed    INT NOT NULL DEFAULT 0,
                joins_logged    INT NOT NULL DEFAULT 0,
                blocked_users   LONGTEXT DEFAULT NULL,
                PRIMARY KEY (id),
                KEY idx_guild_status (guild_id, status),
                KEY idx_status_ends (status, ends_at),
                KEY idx_guild_started (guild_id, started_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }

    // Carry the old Security-page numbers onto the auto-trigger (switched off). Only where the
    // auto-trigger still has its defaults, so a re-run never overwrites a setting chosen since.
    if (await hasTable(db, 'anti_raid_config')) {
        const [rows] = await db.execute('SELECT guild_id, join_limit, time_period_seconds, action, alert_channel_id FROM anti_raid_config');
        for (const r of rows) {
            const gid = String(r.guild_id || '');
            if (!/^\d{15,25}$/.test(gid)) continue;
            const joins = clamp(r.join_limit, 3, 100, 20);
            const windowS = clamp(r.time_period_seconds, 5, 300, 10);
            const action = r.action === 'ban' ? 'ban' : r.action === 'lockdown' ? 'timeout' : 'kick';
            await db.execute('INSERT IGNORE INTO raid_detection_config (guild_id) VALUES (?)', [gid]);
            await db.execute(
                `UPDATE raid_detection_config
                    SET auto_lockdown_joins = ?, auto_lockdown_window_seconds = ?, auto_lockdown_action = ?,
                        alert_channel_id = COALESCE(alert_channel_id, ?)
                  WHERE guild_id = ? AND auto_lockdown_enabled = 0
                    AND auto_lockdown_joins = 20 AND auto_lockdown_window_seconds = 10 AND auto_lockdown_action = 'kick'`,
                [joins, windowS, action, r.alert_channel_id || null, gid]);
        }
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS raid_lockdowns');
    for (const [name] of COLUMNS) {
        if (await hasColumn(db, 'raid_detection_config', name)) await db.execute(`ALTER TABLE raid_detection_config DROP COLUMN ${name}`);
    }
}
