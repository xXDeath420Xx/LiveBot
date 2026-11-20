/*
 * Watch Together: saved sessions (table activity_watch_sessions, migration 467), so a dashboard restart does not end a
 * film people are watching. One row per session: the server, voice channel, Activity instance, the host (user_id, so
 * /privacy export lists it and /privacy delete removes it), the title and the player state. Rows are deleted 30 days
 * after their last change (data_retention_policy). No viewer list is saved: who is watching lives in memory only.
 */
const TABLE = 'activity_watch_sessions';

export function createWatchStore({ pool }) {
    async function save(snap) {
        await pool.execute(
            `INSERT INTO ${TABLE} (id, instance_id, guild_id, channel_id, user_id, item_id, item_name, state_json, ended_at, end_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), item_id = VALUES(item_id), item_name = VALUES(item_name),
                state_json = VALUES(state_json), ended_at = VALUES(ended_at), end_reason = VALUES(end_reason)`,
            [snap.id, snap.instanceId, snap.guildId || '', snap.channelId || '', snap.hostId, snap.itemId, snap.itemName ? String(snap.itemName).slice(0, 255) : null,
                JSON.stringify(snap.state), snap.ended ? new Date() : null, snap.endReason ? String(snap.endReason).slice(0, 32) : null],
        );
    }

    async function loadActive() {
        const [rows] = await pool.execute(
            `SELECT id, instance_id, guild_id, channel_id, user_id, state_json FROM ${TABLE}
              WHERE ended_at IS NULL AND updated_at > (NOW() - INTERVAL 6 HOUR) ORDER BY updated_at DESC LIMIT 200`);
        const out = [];
        for (const r of rows) {
            let state = null;
            try { state = JSON.parse(r.state_json); } catch { state = null; }
            out.push({ id: r.id, instanceId: r.instance_id, guildId: r.guild_id || null, channelId: r.channel_id || null, hostId: r.user_id, state });
        }
        // Anything older that never ended (a crash) is closed now, so it does not count as playing.
        await pool.execute(`UPDATE ${TABLE} SET ended_at = NOW(), end_reason = 'stale' WHERE ended_at IS NULL AND updated_at <= (NOW() - INTERVAL 6 HOUR)`);
        return out;
    }

    return { save, loadActive };
}
