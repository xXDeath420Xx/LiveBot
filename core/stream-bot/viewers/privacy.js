/*
 * Stream bot viewer records in /privacy (migration 464), called from core/stream-bot/privacy.js.
 *
 *   viewersExport(db, { profileId, accounts, prefix, rowLimit }) → { tables: { name: rows[] } }
 *       as a streamer: every viewer record of their profile and the point history;
 *       as a viewer: their own records in any streamer's channel (their linked Twitch / Kick account, or the account they
 *       signed in with on /privacy/viewer) and the history of those records
 *   viewersDelete(db, { profileId, accounts, prefix })           → { table: count }
 *       as a streamer: the profile's records (counted here; the rows also go with the profile by FK cascade);
 *       as a viewer: their records and history in every streamer's channel
 *
 * Nothing here throws when migration 464 has not run yet.
 */
import { createViewerStore } from './store.js';

export async function viewersExport(db, { profileId = null, accounts = [], prefix = 'stream_bot_', rowLimit = 1000 } = {}) {
    const tables = {};
    try {
        const vs = createViewerStore({ db, prefix });
        if (!(await vs.available())) return { tables };
        if (profileId) {
            const own = await vs.exportProfile(profileId);
            if (own.viewers.length) tables[`${prefix}viewers`] = own.viewers;
            if (own.history.length) tables[`${prefix}viewer_history`] = own.history;
        }
        const v = await vs.exportAccounts(accounts, { limit: rowLimit });
        if (v.viewers.length) tables[`${prefix}viewers_about_you`] = v.viewers;
        if (v.history.length) tables[`${prefix}viewer_history_about_you`] = v.history;
    } catch { /* tables not created yet (migration 464) */ }
    return { tables };
}

export async function viewersDelete(db, { profileId = null, accounts = [], prefix = 'stream_bot_' } = {}) {
    const counts = {};
    const add = (t, n) => { if (n) counts[t] = (counts[t] || 0) + n; };
    try {
        const vs = createViewerStore({ db, prefix });
        if (!(await vs.available())) return counts;
        if (profileId) {
            const c = await vs.deleteProfile(profileId);
            add(`${prefix}viewers`, c.viewers);
            add(`${prefix}viewer_history`, c.history);
        }
        const v = await vs.deleteAccounts(accounts);
        add(`${prefix}viewers`, v.viewers);
        add(`${prefix}viewer_history`, v.history);
    } catch { /* tables not created yet */ }
    return counts;
}

export default { viewersExport, viewersDelete };
