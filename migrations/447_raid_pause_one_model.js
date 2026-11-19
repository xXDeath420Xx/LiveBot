/**
 * Migration 447 — raid detection's "lockdown" action and the DM pause settle on one meaning each
 * (register H-660).
 *
 * 1. raid_detection_config.action 'lockdown' ("Time out raiders (lockdown)" / "Lockdown server") never
 *    started a raid lockdown: it timed the raiders out for mute_duration_minutes, exactly like 'mute'. The
 *    choice is gone from /protection raid config and the dashboard; its rows become 'mute', which does the
 *    same thing. (A real join lockdown is /lockdown and its auto-trigger.)
 * 2. /lockdown dm-pause (guild_settings.dm_disable_enabled, with its own daily renewer) and
 *    /lockdown discord are retired: the keep switches on raid_detection_config (/lockdown dms|invites, the
 *    dashboard's Raid lockdown panel) are the one control. A server that had the DM pause on keeps it on,
 *    through keep_dms_disabled; dm_disable_enabled is cleared so nothing renews it twice.
 *
 * Idempotent: each step only touches rows still in the old state.
 */
export async function up(db) {
    const [a] = await db.query("UPDATE raid_detection_config SET action = 'mute' WHERE action = 'lockdown'");
    console.log(`[migrate 447] ${a.affectedRows} raid config(s) moved from 'lockdown' to 'mute' (same behaviour)`);

    const [cols] = await db.query(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guild_settings' AND COLUMN_NAME = 'dm_disable_enabled'");
    if (cols.length) {
        const [b] = await db.query(`
            INSERT INTO raid_detection_config (guild_id, keep_dms_disabled)
            SELECT guild_id, 1 FROM guild_settings WHERE dm_disable_enabled = 1
            ON DUPLICATE KEY UPDATE keep_dms_disabled = 1`);
        await db.query('UPDATE guild_settings SET dm_disable_enabled = 0 WHERE dm_disable_enabled = 1');
        console.log(`[migrate 447] DM pause moved to the keep switch (${b.affectedRows} row(s) written)`);
    }
}

export async function down() {
    // Not reversible: 'lockdown' and 'mute' behaved the same, and the DM pause is still on through keep_dms_disabled.
}
