/*
 * Stream bot overlays in /privacy (migration 459), called from core/stream-bot/privacy.js.
 *
 *   overlaysExport(db, profileId, prefix, encryption?) → { overlays: rows[], overlay_media: rows[] }
 *       the streamer's overlays (type, name, settings, goal progress) and their media's names; never the key columns
 *   overlaysDelete(db, profileId, prefix, { mediaDir }) → { table: count }
 *       the rows (they would also go with the profile by FK cascade) and the uploaded image and video files
 *
 * No viewer data is kept by overlays (alerts, chat and lists are sent live and never stored), so there is nothing
 * to export or delete for a viewer.
 */
import { createOverlayStore } from './store.js';
import { removeProfileMedia } from './media.js';

export async function overlaysExport(db, profileId, prefix = 'stream_bot_') {
    if (!profileId) return {};
    try {
        const r = await createOverlayStore({ db, prefix }).exportProfile(profileId);
        const out = {};
        if (r.overlays.length) out.overlays = r.overlays;
        if (r.overlay_media.length) out.overlay_media = r.overlay_media;
        return out;
    } catch { return {}; }   // migration 459 not applied yet
}

export async function overlaysDelete(db, profileId, prefix = 'stream_bot_', { mediaDir = null } = {}) {
    if (!profileId) return {};
    let counts = {};
    try { counts = await createOverlayStore({ db, prefix }).deleteProfile(profileId); } catch { /* not migrated */ }
    // Throwaway test tables reuse small ids: only the real tables (or an explicit folder) touch files.
    if (mediaDir || prefix === 'stream_bot_') await removeProfileMedia(profileId, mediaDir);
    return counts;
}

export default { overlaysExport, overlaysDelete };
