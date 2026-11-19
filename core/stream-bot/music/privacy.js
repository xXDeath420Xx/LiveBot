/*
 * Stream bot music data in /privacy (migration 457), called from core/stream-bot/privacy.js.
 *
 *   musicExport(db, { profileId, accounts, prefix, rowLimit })  → { tables: { name: rows[] } }
 *       as a streamer: requests, bans, likes, playlists and items, and their stream plays in music_play_log;
 *       as a viewer: requests they made and likes they gave in any streamer's channel (their linked Twitch / Kick)
 *   musicDelete(db, { profileId, accounts, prefix })           → { table: count }
 *       as a streamer: the stream rows of music_play_log (the music_* tables go with the profile by FK cascade);
 *       as a viewer: their likes are deleted, and their requests lose the viewer id, name and the words they typed
 *       (the streamer keeps a nameless line in the queue history)
 */
import { createMusicStore } from './store.js';

export async function musicExport(db, { profileId = null, accounts = [], prefix = 'stream_bot_', rowLimit = 1000, playLogTable = 'music_play_log' } = {}) {
    const tables = {};
    try {
        const m = createMusicStore({ db, prefix, playLogTable });
        if (profileId) for (const [name, rows] of Object.entries(await m.exportOwner(profileId, rowLimit))) if (rows?.length) tables[`${prefix}${name}`] = rows;
        const v = await m.exportViewer(accounts, rowLimit);
        if (v.music_requests.length) tables[`${prefix}music_requests_by_you`] = v.music_requests;
        if (v.music_likes.length) tables[`${prefix}music_likes_by_you`] = v.music_likes;
    } catch { /* tables not created yet (migration 457) */ }
    return { tables };
}

export async function musicDelete(db, { profileId = null, accounts = [], prefix = 'stream_bot_', playLogTable = 'music_play_log' } = {}) {
    const counts = {};
    try {
        const m = createMusicStore({ db, prefix, playLogTable });
        if (profileId) { const n = await m.deleteOwnerPlays(profileId); if (n) counts[playLogTable] = n; }
        Object.assign(counts, await m.deleteViewer(accounts));
    } catch { /* tables not created yet */ }
    return counts;
}

export default { musicExport, musicDelete };
