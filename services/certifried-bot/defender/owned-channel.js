/**
 * Resolve a Kick channel_id (broadcaster id, VARCHAR) to the tokes_channels PK
 * (id, INT) for a channel the given user owns. Returns { id } or null.
 *
 * The /kick surface keys everything on channel_id, but the re-homed tokes-bot
 * command routes operate on the PK. This is the single bridge between the two.
 */
import realPool from '../../../utils/db.js';

export function makeResolveOwnedChannel({ pool }) {
    return async function resolveOwnedChannel(userId, channelId) {
        const [[row]] = await pool.execute(
            "SELECT id FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? AND owner_id = ?",
            [String(channelId || ''), userId]
        );
        return row || null;
    };
}

export const resolveOwnedChannel = makeResolveOwnedChannel({ pool: realPool });
