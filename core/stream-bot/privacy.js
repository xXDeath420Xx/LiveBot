/*
 * Stream bot data in /privacy export and delete (design §2.6), called from core/privacy-manager.js.
 *
 *   createStreamBotPrivacy({ store, db, rowLimit })
 *     .exportFor(discordUserId) → { tables: { name: { total, rows } }, note } | null
 *     .deleteFor(discordUserId) → { deleted: { table: n } }
 *
 * As a streamer: their profile and everything under it (no tokens, hashes or encrypted secrets). The profile's
 * settings carry the sound library's names (Phase 2); delete also removes the uploaded sound files.
 * As a viewer: events where they are the actor, and their per-viewer {db:} values, found through the Twitch
 * account linked in twitch_oauth_accounts and the Kick account in stream_platform_accounts. `db` is only used
 * to read those links (real tables; tests pass a stub).
 */
import { removeProfileSounds } from './sounds.js';
import { importExport } from './import/privacy.js';
import { musicExport, musicDelete } from './music/privacy.js';
import { overlaysExport, overlaysDelete } from './overlays/privacy.js';
import { createTimerStore } from './timers.js';

export function createStreamBotPrivacy({ store, db, rowLimit = 1000, soundsDir = null, timersTable = null, mediaDir = null } = {}) {
    // Stream bot timers live in tokes_timers (migration 456, profile_id); tests pass their throwaway table.
    const timers = db ? createTimerStore({ db, table: timersTable || (store.prefix === 'stream_bot_' ? 'tokes_timers' : `${store.prefix}timers`) }) : null;
    async function viewerAccounts(userId) {
        const out = [];
        const add = (platform, id) => {
            if (id != null && id !== '' && !out.some((a) => a.platform === platform && a.id === String(id))) out.push({ platform, id: String(id) });
        };
        if (!db) return out;
        try {
            const [rows] = await db.query('SELECT twitch_user_id FROM twitch_oauth_accounts WHERE discord_user_id = ?', [String(userId)]);
            for (const r of rows) add('twitch', r.twitch_user_id);
        } catch { /* not in this database */ }
        try {
            const [rows] = await db.query("SELECT platform, platform_user_id FROM stream_platform_accounts WHERE owner_discord_id = ? AND platform IN ('kick', 'twitch')", [String(userId)]);
            for (const r of rows) add(r.platform, r.platform_user_id);
        } catch { /* not in this database */ }
        return out;
    }

    return {
        viewerAccounts,
        async exportFor(userId) {
            const own = await store.exportOwner(userId, { rowLimit });
            const viewer = await store.exportViewer(await viewerAccounts(userId), { rowLimit });
            if (!own && !viewer.events.length && !viewer.variables.length) return null;
            const tables = {};
            const add = (name, rows) => { if (rows && (Array.isArray(rows) ? rows.length : true)) tables[`${store.prefix}${name}`] = { total: Array.isArray(rows) ? rows.length : 1, rows: Array.isArray(rows) ? rows : [rows] }; };
            if (own) {
                add('profiles', own.profile);
                add('channels', own.channels);
                add('twitch_grants', own.twitch_grant);
                add('tip_sources', own.tip_sources);
                add('automations', own.automations);
                add('devices', own.devices);
                add('variables', own.variables);
                add('runs', own.runs);
                add('events', own.events);
                // Firebot / Streamer.bot import runs and items (migration 455); deleted with the profile by FK cascade.
                for (const [name, rows] of Object.entries(await importExport(db, own.profile.id, store.prefix, rowLimit))) add(name, rows);
                if (timers) { try { add('timers', await timers.exportProfile(own.profile.id)); } catch { /* table not migrated */ } }
                // Overlays (migration 459): settings, goal progress and media names; never the URL keys.
                for (const [name, rows] of Object.entries(await overlaysExport(db, own.profile.id, store.prefix))) add(name, rows);
            }
            // Song requests (migration 457): as the streamer, and as a viewer who requested or liked songs anywhere.
            {
                const music = await musicExport(db, { profileId: own?.profile?.id || null, accounts: await viewerAccounts(userId), prefix: store.prefix, rowLimit, ...(store.prefix === 'stream_bot_' ? {} : { playLogTable: `${store.prefix}play_log` }) });
                for (const [name, rows] of Object.entries(music.tables)) tables[name] = { total: rows.length, rows };
            }
            if (viewer.events.length) tables[`${store.prefix}events_about_you`] = { total: viewer.events.length, rows: viewer.events };
            if (viewer.variables.length) tables[`${store.prefix}values_for_you`] = { total: viewer.variables.length, rows: viewer.variables };
            return {
                tables,
                note: 'Stream bot: your streamer profile (tokens, device keys and tip-service tokens are never included), '
                    + `the newest ${rowLimit} runs and events, and events about you in other streamers' channels found through your linked Twitch and Kick accounts.`,
            };
        },
        async deleteFor(userId) {
            const own = await store.getProfileByOwner(userId).catch(() => null);
            let timerRows = 0;
            if (own?.id && timers) { try { timerRows = await timers.deleteProfile(own.id); } catch { /* table not migrated */ } }
            // Overlays (migration 459): counted before the profile goes (FK cascade), and the uploaded image and video files.
            const overlayRows = own?.id ? await overlaysDelete(db, own.id, store.prefix, { mediaDir }) : {};
            const deleted = { ...overlayRows, ...(await store.deleteOwner(userId)) };
            if (timerRows) deleted[store.prefix === 'stream_bot_' ? 'tokes_timers' : `${store.prefix}timers`] = timerRows;
            // Throwaway test tables reuse small ids: only the real tables (or an explicit folder) touch sound files.
            if (own?.id && (soundsDir || store.prefix === 'stream_bot_')) await removeProfileSounds(own.id, soundsDir);
            const accounts = await viewerAccounts(userId);
            const viewer = await store.deleteViewer(accounts);
            for (const [t, n] of Object.entries(viewer)) deleted[t] = (deleted[t] || 0) + n;
            // Song requests (migration 457): the streamer's stream plays in music_play_log; a viewer's likes and identity on requests.
            const music = await musicDelete(db, { profileId: own?.id || null, accounts, prefix: store.prefix, ...(store.prefix === 'stream_bot_' ? {} : { playLogTable: `${store.prefix}play_log` }) });
            for (const [t, n] of Object.entries(music)) deleted[t] = (deleted[t] || 0) + n;
            return { deleted };
        },
    };
}

export default { createStreamBotPrivacy };
