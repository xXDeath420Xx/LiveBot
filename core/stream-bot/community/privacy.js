/*
 * Stream bot community data in /privacy (migration 475), called from core/stream-bot/privacy.js.
 *
 *   communityExport(db, { profileId, accounts, prefix, rowLimit }) → { tables: { name: rows[] } }
 *       as a streamer: their quotes, store items, store redemptions and media share requests;
 *       as a viewer: their own redemptions and media requests in any streamer's channel, and quotes they added
 *   communityDelete(db, { profileId, accounts, prefix }) → { table: count }
 *       as a streamer: all four tables of the profile (counted here; they also go with the profile by FK cascade);
 *       as a viewer: their redemptions and media requests; quotes they added stay with the streamer without their name
 *
 * The line-up (profile settings `viewerQueue`) holds names only while a stream runs; it is part of the profile's settings,
 * exported and deleted with the profile. Nothing here throws when migration 475 has not run yet.
 */
import { createCommunityStore } from './store.js';

export async function communityExport(db, { profileId = null, accounts = [], prefix = 'stream_bot_', rowLimit = 1000 } = {}) {
    const tables = {};
    try {
        const cs = createCommunityStore({ db, prefix });
        if (!(await cs.available())) return { tables };
        if (profileId) {
            for (const [k, rows] of Object.entries(await cs.exportProfile(profileId, { limit: rowLimit }))) if (rows.length) tables[`${prefix}${k}`] = rows;
        }
        const v = await cs.exportAccounts(accounts, { limit: rowLimit });
        if (v.store_redemptions.length) tables[`${prefix}store_redemptions_about_you`] = v.store_redemptions;
        if (v.media_requests.length) tables[`${prefix}media_requests_about_you`] = v.media_requests;
        if (v.quotes.length) tables[`${prefix}quotes_you_added`] = v.quotes;
    } catch { /* tables not created yet (migration 475) */ }
    return { tables };
}

export async function communityDelete(db, { profileId = null, accounts = [], prefix = 'stream_bot_' } = {}) {
    const counts = {};
    const add = (t, n) => { if (n) counts[t] = (counts[t] || 0) + n; };
    try {
        const cs = createCommunityStore({ db, prefix });
        if (!(await cs.available())) return counts;
        if (profileId) for (const [k, n] of Object.entries(await cs.deleteProfile(profileId))) add(`${prefix}${k}`, n);
        const v = await cs.deleteAccounts(accounts);
        add(`${prefix}store_redemptions`, v.store_redemptions);
        add(`${prefix}media_requests`, v.media_requests);
        add(`${prefix}quotes_added_by_cleared`, v.quotes);
    } catch { /* tables not created yet */ }
    return counts;
}

export default { communityExport, communityDelete };
