/*
 * Stream bot data in /privacy export and delete (design §2.6), called from core/privacy-manager.js.
 *
 *   createStreamBotPrivacy({ store, db, rowLimit })
 *     .exportFor(discordUserId) → { tables: { name: { total, rows } }, note } | null
 *     .deleteFor(discordUserId) → { deleted: { table: n } }
 *     .exportForAccounts([{ platform, id }]) / .deleteForAccounts([...])   viewer data only, for a viewer who signed in
 *                                                with Twitch or Kick on /privacy/viewer (H-772; no CertiFried account)
 *
 * As a streamer: their profile and everything under it (no tokens, hashes or encrypted secrets). The profile's
 * settings carry the sound library's names (Phase 2); delete also removes the uploaded sound files.
 * As a viewer: events where they are the actor, and their per-viewer {db:} values, found through the Twitch
 * account linked in twitch_oauth_accounts and the Kick account in stream_platform_accounts. `db` is only used
 * to read those links (real tables; tests pass a stub).
 * Viewer records (H-747, migration 464, core/stream-bot/viewers/privacy.js): as a streamer, the profile's viewer records and
 * point history; as a viewer, their own records (watch time, messages, points) in every streamer's channel.
 * Also as a viewer (H-783): other people's events that NAME them (a chat reply to them or a mention, a Kick gift sub
 * they received, a raid into their channel; song requests they handled as a moderator) through store.named
 * (core/stream-bot/named.js, migration 465). Export lists them; delete removes their id and name from those events
 * and leaves the other person's event. Their logins are read before their own events are deleted.
 * Sign-ins (H-820, core/stream-bot/platform-accounts-privacy.js): the member's own Twitch and Kick rows in
 * stream_platform_accounts (the multicast "Connect" sign-ins) and the multicast destinations made from them are exported
 * without tokens or keys and deleted, tokens revoked at Twitch and Kick first; the YouTube row likewise (revoked at Google).
 * They are read last for the viewer lookups above, so they go at the very end of deleteFor. Real tables only, or the
 * throwaway tables a test names in `signInTables` ({ table, destinations }).
 */
import { removeProfileSounds } from './sounds.js';
import { importExport } from './import/privacy.js';
import { musicExport, musicDelete } from './music/privacy.js';
import { overlaysExport, overlaysDelete } from './overlays/privacy.js';
import { devicesExport, devicesDelete } from './devices/privacy.js';
import { viewersExport, viewersDelete } from './viewers/privacy.js';
import { communityExport, communityDelete } from './community/privacy.js';
import { youtubeExport, youtubeDelete, youtubeAccountExport, youtubeAccountDelete } from './youtube/privacy.js';
import { createTimerStore } from './timers.js';
import { platformAccountsExport, platformAccountsDelete } from './platform-accounts-privacy.js';

export function createStreamBotPrivacy({ store, db, rowLimit = 1000, soundsDir = null, timersTable = null, mediaDir = null, encryption = null, fetchImpl = undefined, signInTables = null } = {}) {
    // H-820: platform sign-ins live in shared real tables; throwaway test tables only when a test names them.
    const signIns = store.prefix === 'stream_bot_' ? {} : signInTables;
    async function tokenCipher() {
        if (encryption) return encryption;
        try { return (await import('../../utils/encryption.js')).default; } catch { return null; }   // no key configured: delete without revoking
    }
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
            const [rows] = await db.query(`SELECT platform, platform_user_id FROM \`${signIns?.table || 'stream_platform_accounts'}\` WHERE owner_discord_id = ? AND platform IN ('kick', 'twitch', 'youtube')`, [String(userId)]);
            for (const r of rows) add(r.platform, r.platform_user_id);
        } catch { /* not in this database */ }
        return out;
    }

    /**
     * H-772: a viewer signed in on /privacy/viewer with Twitch or Kick (no CertiFried account): only what is keyed to
     * those platform accounts, in every streamer's channel. Events where they are the actor (chat too, where a streamer
     * keeps chat), their {db:} values, their song requests and likes. Never a streamer profile.
     */
    /** H-783: other people's events and song requests that name these accounts. */
    async function namedTables(accounts, tables) {
        if (!store.named || !accounts?.length) return 0;
        const named = await store.named.exportFor(await store.named.identify(accounts), { rowLimit });
        if (named.events_naming_you.length) tables[`${store.prefix}events_naming_you`] = { total: named.events_naming_you.length, rows: named.events_naming_you };
        if (named.music_named_you.length) tables[`${store.prefix}music_named_you`] = { total: named.music_named_you.length, rows: named.music_named_you };
        return named.events_naming_you.length + named.music_named_you.length;
    }
    /** Run `remove` (which deletes their own rows) between reading who they are and redacting where others name them. */
    async function withRedaction(accounts, deleted, remove) {
        const who = store.named && accounts?.length ? await store.named.identify(accounts) : [];
        await remove();
        if (!who.length) return;
        for (const [t, n] of Object.entries(await store.named.redactFor(who))) deleted[t] = (deleted[t] || 0) + n;
    }

    async function exportForAccounts(accounts) {
        const viewer = await store.exportViewer(accounts, { rowLimit });
        const tables = {};
        if (viewer.events.length) tables[`${store.prefix}events_about_you`] = { total: viewer.events.length, rows: viewer.events };
        await namedTables(accounts, tables);
        if (viewer.variables.length) tables[`${store.prefix}values_for_you`] = { total: viewer.variables.length, rows: viewer.variables };
        const music = await musicExport(db, { profileId: null, accounts, prefix: store.prefix, rowLimit, ...(store.prefix === 'stream_bot_' ? {} : { playLogTable: `${store.prefix}play_log` }) });
        for (const [name, rows] of Object.entries(music.tables)) tables[name] = { total: rows.length, rows };
        // Viewer records (migration 464): their watch time, messages and points in every streamer's channel.
        for (const [name, rows] of Object.entries((await viewersExport(db, { accounts, prefix: store.prefix, rowLimit })).tables)) tables[name] = { total: rows.length, rows };
        // Community (migration 475): their store redemptions and media share requests, and quotes they added.
        for (const [name, rows] of Object.entries((await communityExport(db, { accounts, prefix: store.prefix, rowLimit })).tables)) tables[name] = { total: rows.length, rows };
        return { tables, note: `Stream bot data keyed to your Twitch or Kick account in every streamer's channel, and other people's events that name you (without who wrote them) (the newest ${rowLimit} rows per table).` };
    }
    async function deleteForAccounts(accounts) {
        const deleted = {};
        await withRedaction(accounts, deleted, async () => {
            Object.assign(deleted, await store.deleteViewer(accounts));
            for (const [t, n] of Object.entries(await viewersDelete(db, { accounts, prefix: store.prefix }))) deleted[t] = (deleted[t] || 0) + n;   // viewer records (migration 464)
            for (const [t, n] of Object.entries(await communityDelete(db, { accounts, prefix: store.prefix }))) deleted[t] = (deleted[t] || 0) + n;   // community (migration 475)
            const music = await musicDelete(db, { profileId: null, accounts, prefix: store.prefix, ...(store.prefix === 'stream_bot_' ? {} : { playLogTable: `${store.prefix}play_log` }) });
            for (const [t, n] of Object.entries(music)) deleted[t] = (deleted[t] || 0) + n;
        });
        return { deleted };
    }

    return {
        viewerAccounts,
        exportForAccounts,
        deleteForAccounts,
        async exportFor(userId) {
            const own = await store.exportOwner(userId, { rowLimit });
            const viewer = await store.exportViewer(await viewerAccounts(userId), { rowLimit });
            const namedOut = {};
            const namedCount = await namedTables(await viewerAccounts(userId), namedOut);
            // Viewer records (migration 464): the profile's viewers as the streamer; their own records as a viewer anywhere.
            const viewerRecords = (await viewersExport(db, { profileId: own?.profile?.id || null, accounts: await viewerAccounts(userId), prefix: store.prefix, rowLimit })).tables;
            // Community (migration 475): quotes, store, media share; as the streamer and as a viewer.
            Object.assign(viewerRecords, (await communityExport(db, { profileId: own?.profile?.id || null, accounts: await viewerAccounts(userId), prefix: store.prefix, rowLimit })).tables);
            // H-820: Twitch and Kick sign-ins (multicast "Connect") and the destinations made from them, with or without a profile.
            const signInRows = signIns && db ? await platformAccountsExport(db, userId, signIns).catch(() => ({})) : {};
            const youtubeSignIn = store.prefix === 'stream_bot_' ? await youtubeAccountExport(db, userId).catch(() => []) : [];
            if (!own && !viewer.events.length && !viewer.variables.length && !namedCount && !Object.keys(viewerRecords).length
                && !Object.keys(signInRows).length && !youtubeSignIn.length) return null;
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
                // Cloud light accounts (migration 461): provider, key hint, status, device names; never the key.
                for (const [name, rows] of Object.entries(await devicesExport(db, own.profile.id, store.prefix))) add(name, rows);
                // YouTube Live (migration 470): live state and quota use. Real tables only: the YouTube sign-in without its tokens.
                for (const [name, rows] of Object.entries(await youtubeExport(db, own.profile.id, store.prefix))) add(name, rows);
            }
            if (youtubeSignIn.length) tables.stream_platform_accounts_youtube = { total: youtubeSignIn.length, rows: youtubeSignIn };
            if (signInRows.accounts) tables.stream_platform_accounts = { total: signInRows.accounts.length, rows: signInRows.accounts };
            if (signInRows.destinations) tables.stream_destinations_from_sign_ins = { total: signInRows.destinations.length, rows: signInRows.destinations };
            // Song requests (migration 457): as the streamer, and as a viewer who requested or liked songs anywhere.
            {
                const music = await musicExport(db, { profileId: own?.profile?.id || null, accounts: await viewerAccounts(userId), prefix: store.prefix, rowLimit, ...(store.prefix === 'stream_bot_' ? {} : { playLogTable: `${store.prefix}play_log` }) });
                for (const [name, rows] of Object.entries(music.tables)) tables[name] = { total: rows.length, rows };
            }
            if (viewer.events.length) tables[`${store.prefix}events_about_you`] = { total: viewer.events.length, rows: viewer.events };
            Object.assign(tables, namedOut);
            for (const [name, rows] of Object.entries(viewerRecords)) tables[name] = { total: rows.length, rows };
            if (viewer.variables.length) tables[`${store.prefix}values_for_you`] = { total: viewer.variables.length, rows: viewer.variables };
            return {
                tables,
                note: 'Stream bot: your streamer profile (tokens, device keys and tip-service tokens are never included), '
                    + `the newest ${rowLimit} runs and events, and events about you in other streamers' channels found through your linked Twitch and Kick accounts, `
                    + 'including other people\'s events that name you (a reply to you, a mention, a gift sub you received, a raid into your channel; without who wrote them).',
            };
        },
        async deleteFor(userId) {
            const own = await store.getProfileByOwner(userId).catch(() => null);
            let timerRows = 0;
            if (own?.id && timers) { try { timerRows = await timers.deleteProfile(own.id); } catch { /* table not migrated */ } }
            // Overlays (migration 459): counted before the profile goes (FK cascade), and the uploaded image and video files.
            const overlayRows = own?.id ? await overlaysDelete(db, own.id, store.prefix, { mediaDir }) : {};
            const deviceRows = own?.id ? await devicesDelete(db, own.id, store.prefix) : {};   // cloud light keys (migration 461)
            const viewerRows = own?.id ? await viewersDelete(db, { profileId: own.id, prefix: store.prefix }) : {};   // the profile's viewer records (migration 464)
            Object.assign(viewerRows, own?.id ? await communityDelete(db, { profileId: own.id, prefix: store.prefix }) : {});   // quotes, store, media share (migration 475)
            const youtubeRows = own?.id ? await youtubeDelete(db, own.id, store.prefix) : {};   // YouTube live state and quota use (migration 470)
            const deleted = { ...overlayRows, ...deviceRows, ...viewerRows, ...youtubeRows, ...(await store.deleteOwner(userId)) };
            if (timerRows) deleted[store.prefix === 'stream_bot_' ? 'tokes_timers' : `${store.prefix}timers`] = timerRows;
            // Throwaway test tables reuse small ids: only the real tables (or an explicit folder) touch sound files.
            if (own?.id && (soundsDir || store.prefix === 'stream_bot_')) await removeProfileSounds(own.id, soundsDir);
            const accounts = await viewerAccounts(userId);
            await withRedaction(accounts, deleted, async () => {
                const viewer = await store.deleteViewer(accounts);
                for (const [t, n] of Object.entries(await viewersDelete(db, { accounts, prefix: store.prefix }))) deleted[t] = (deleted[t] || 0) + n;   // their viewer records
                for (const [t, n] of Object.entries(await communityDelete(db, { accounts, prefix: store.prefix }))) deleted[t] = (deleted[t] || 0) + n;   // their redemptions and media requests
                for (const [t, n] of Object.entries(viewer)) deleted[t] = (deleted[t] || 0) + n;
                // Song requests (migration 457): the streamer's stream plays in music_play_log; a viewer's likes and identity on requests.
                const music = await musicDelete(db, { profileId: own?.id || null, accounts, prefix: store.prefix, ...(store.prefix === 'stream_bot_' ? {} : { playLogTable: `${store.prefix}play_log` }) });
                for (const [t, n] of Object.entries(music)) deleted[t] = (deleted[t] || 0) + n;
            });
            // The sign-ins (stream_platform_accounts), after their accounts were used above to find their viewer data.
            // YouTube (H-741): revoked at Google; a YouTube multicast destination that used it goes with it (FK).
            // Twitch and Kick (H-820): revoked at Twitch and Kick, with the multicast destinations made from them.
            const cipher = signIns && db ? await tokenCipher() : null;
            if (store.prefix === 'stream_bot_') {
                for (const [t, n] of Object.entries(await youtubeAccountDelete(db, userId, { revoke: !!cipher, encryption: cipher, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => ({})))) deleted[t] = (deleted[t] || 0) + n;
            }
            if (signIns && db) {
                for (const [t, n] of Object.entries(await platformAccountsDelete(db, userId, { ...signIns, revoke: !!cipher, encryption: cipher, fetchImpl }))) deleted[t] = (deleted[t] || 0) + n;
            }
            return { deleted };
        },
    };
}

export default { createStreamBotPrivacy };
