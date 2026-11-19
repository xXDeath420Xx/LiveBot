/*
 * Temporary voice channels (join-to-create): turned on by a temp_channel_config row per creator channel,
 * read by events/voiceStateUpdate.js. Turning them off deletes the rows. Shared by /admin temp-channel disable
 * (commands/admin/admin.js) and the switch on the dashboard's Utilities page (POST /manage/:guildId/update-tempchannels),
 * so both change the same state (H-681).
 */
import pool from '../utils/db.js';

/**
 * Turn temporary voice channels off: every creator channel of the server, or only `creatorChannelId`.
 * Channels already made are left alone; they are still deleted when they empty.
 * @returns {Promise<number>} how many creator channels were turned off
 */
export async function disableTempChannels(guildId, { creatorChannelId = null, db = pool } = {}) {
    const [res] = creatorChannelId
        ? await db.execute('DELETE FROM temp_channel_config WHERE guild_id = ? AND creator_channel_id = ?', [String(guildId), String(creatorChannelId)])
        : await db.execute('DELETE FROM temp_channel_config WHERE guild_id = ?', [String(guildId)]);
    return res?.affectedRows ?? 0;
}

const ON = new Set(['on', '1', 'true', 'yes']);

/**
 * Did the Utilities page form ask to turn them off? The page sends `enabled_sent` with the switch; an unticked
 * switch sends no `enabled`. A form without the marker (an older page) never turns them off.
 */
export function wantsTempChannelsOff(body) {
    if (!body || body.enabled_sent === undefined) return false;
    const v = Array.isArray(body.enabled) ? body.enabled[body.enabled.length - 1] : body.enabled;
    return !(v === true || ON.has(String(v ?? '').toLowerCase()));
}
