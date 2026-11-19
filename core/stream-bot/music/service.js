/*
 * Stream bot music: the service everything else calls (chat commands, the Music page, the overlay routes,
 * CertiFried Studio's status reports). Design: docs/superpowers/specs/2026-11-19-stream-bot-design.md §7.
 *
 *   createMusicService({ db, store, mstore, resolver, hub, ingest, encryption, signer, logger, now })
 *     settingsOf(profileId) / saveSettings(profileId, input)
 *     overlayKey(profileId, { rotate }) → key            the browser-source key (made on first use; rotate = new key)
 *     profileForKey(key) → { profileId, keyHash } | null
 *     onStudioRequest(conn, method, params)               'music.overlay' → { url } for Studio's "CertiFried Music" source
 *     gateOf(profileId) → { vodSafe, vodTrack, reason }    studioMusicStatus() (core/stream-bot/studio.js) + the VOD track
 *     prepare(profileId) → { ok, vodTrack, reason }        the music.prepare action, answered by Studio before each song
 *     submit(profile, { input, viewer, roles, via }) → { outcome: 'queued'|'pending'|'refused'|'added_many', key, vars, requests }
 *     approve / deny / denyAll / remove / removeById / bans / playlists / status / history / templateValues
 *     player                                              core/stream-bot/music/player.js
 *     spotifyStatus(profile) → { linked, enabled, suspended, note }  Spotify-direct (spotify-direct.js) for the Music page
 *
 * Viewer identity on a request is { platform, id, login, name }; mods are the broadcaster and moderators.
 */
import { createPlayer } from './player.js';
import { withDefaults, validateSettings, messageFor, OWNER_PRESET, SOURCE_LABEL } from './settings.js';
import { parseRequestInput, trackKeyOf, primaryArtist, normalise, fill, formatWait, namesList } from './text.js';
import { newOverlayKey, keyHash, isKeyShape } from './audio.js';
import { studioMusicStatus } from '../studio.js';

const PREPARE_WAIT_MS = 12_000;
const PREPARE_POLL_MS = 200;
const GATE_SWEEP_MS = 5_000;
const KEY_CACHE_MS = 60_000;
export const SOURCE_OF = (parsed) => (parsed.kind === 'spotify' ? 'spotify' : parsed.kind === 'search' ? 'search'
    : parsed.platform === 'youtube' ? 'youtube' : parsed.platform === 'soundcloud' ? 'soundcloud' : 'links');
export const SOURCE_NAME = { spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud', links: 'that site', search: 'search', playlists: 'playlists' };

export const isModRoles = (roles) => (roles || []).some((r) => r === 'broadcaster' || r === 'moderator');

export function createMusicService({ db, store, mstore, resolver, hub = null, ingest = null, encryption = null, signer, logger = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), musicStatus = studioMusicStatus, direct = null } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamMusic] ${msg}`, meta); } catch { /* ignore */ } };
    const keyCache = new Map();       // keyHash -> { at, profileId }
    const nowPlayingVars = new Map(); // profileId -> template values

    const profileOf = (id) => store.getProfile(id);
    async function rawMusic(profileId) { return (await store.getSettingsKey(profileId, 'music').catch(() => null)) || {}; }
    async function settingsOf(profileId) { return withDefaults(await rawMusic(profileId)); }

    /** VOD protection as Studio last reported it (state.music), with the track the VOD records. */
    function gateOf(profileId) {
        const st = musicStatus(hub, profileId);
        const dev = (hub?.connected?.(profileId) || []).find((d) => d.deviceId === st.deviceId);
        const m = dev?.state?.music || null;
        return { vodSafe: st.vodSafe === true, vodTrack: m?.vodTrack ?? null, liveTrack: m?.liveTrack ?? null, sourceReady: m?.sourceReady ?? null,
            reason: st.vodSafe ? null : (st.reason || 'Music is not VOD-safe yet.'), studio: !!st.deviceId };
    }

    /** Studio checks OBS once more right before a song: the music.prepare action, acked { vodSafe: true, vodTrack }. */
    async function prepare(profileId) {
        if (!hub?.dispatch) return { ok: false, reason: 'CertiFried Studio is not connected.' };
        const d = await hub.dispatch({ profileId, runId: null, target: 'studio', capability: 'obs', actionType: 'music.prepare', params: {}, queueSeconds: 0 });
        if (d.status === 'none' || !d.id) return { ok: false, reason: 'CertiFried Studio is not connected.' };
        const until = now() + PREPARE_WAIT_MS;
        while (now() < until) {
            const row = await store.getDispatch(d.id).catch(() => null);
            if (row?.status === 'acked') return row.result?.vodSafe === true ? { ok: true, vodTrack: row.result.vodTrack ?? null } : { ok: false, reason: 'Studio did not confirm VOD protection.' };
            if (row && ['failed', 'expired'].includes(row.status)) return { ok: false, reason: String(row.error || 'Studio could not confirm VOD protection.').replace(/^vod_unsafe:\s*/, '').slice(0, 200) };
            await sleep(PREPARE_POLL_MS);
        }
        return { ok: false, reason: 'Studio did not answer in time.' };
    }

    /** Spotify-direct applies when the streamer turned it on; the account is chosen by the Discord bot's session manager. */
    async function directFor(profileId) {
        if (!direct) return null;
        const [settings, profile] = await Promise.all([settingsOf(profileId), profileOf(profileId)]);
        return settings.spotifyDirect && profile?.ownerDiscordId ? { discordUserId: profile.ownerDiscordId } : null;
    }
    const DIRECT_NOTE = {
        busy: 'your Spotify was in use by the Discord music bot',
        suspended: 'Spotify-direct is resting after Spotify stopped early',
        no_audio: "Spotify didn't start playing it",
        not_linked: 'your Spotify is not linked any more',
        player_error: "the OBS player couldn't play the Spotify audio",
        error: 'Spotify-direct ran into an error',
    };
    async function spotifyStatus(profile) {
        const settings = await settingsOf(profile.id);
        const el = direct ? await direct.eligible(profile.ownerDiscordId) : { ok: false };
        const st = await player.status(profile.id);
        const n = st.directNote;
        return {
            linked: !!el.ok, enabled: !!settings.spotifyDirect, playingLive: !!st.live,
            suspended: st.directSuspended ? { why: st.directSuspended.why, until: new Date(st.directSuspended.until).toISOString() } : null,
            note: n ? `'${n.title}' played from YouTube Music: ${n.why || DIRECT_NOTE[n.reason] || n.reason}.` : null,
        };
    }

    const player = createPlayer({ mstore, resolver, signer, now, logger, settingsOf, profileOf, gateOf, prepare, direct, directFor, emit: songChanged });

    // Studio's state reports are not pushed to this module: look at the gate every few seconds where an overlay is
    // open, so a held song starts (or a playing one pauses) without waiting for a command.
    let sweeper = null;
    function startSweep() {
        if (sweeper) return;
        sweeper = setInterval(() => {
            for (const [profileId, s] of player._states) if (s.overlays.size && (s.running || s.current)) player.gateChanged(profileId).catch(() => {});
        }, GATE_SWEEP_MS);
        sweeper.unref?.();
    }

    /** The "song changed" event: event log, live feed and automations (trigger music.song_changed), and the variables. */
    function songChanged(profileId, item, { requester, requestId, playlist }) {
        nowPlayingVars.set(profileId, varsFor(item, requester));
        if (!ingest) return;
        const ev = {
            platform: 'studio', type: 'music.song_changed', channelId: null, user: null, amount: null, currency: null,
            message: `${item.title}${item.artist ? ` — ${item.artist}` : ''}`.slice(0, 1000),
            metadata: { title: String(item.title || '').slice(0, 200), artist: String(item.artist || '').slice(0, 200), url: item.url || null,
                requestedBy: requester || null, requested: !!requestId, playlist: playlist || null, source: item.source || null },
            raw: null, occurredAt: new Date(now()), dedupeKey: null,
        };
        ingest.studio(profileId, ev).catch?.(() => {});
    }
    const varsFor = (item, requester) => ({
        'music.track': item?.title || '', 'music.artist': item?.artist || '', 'music.url': item?.url || '', 'music.requester': requester || '',
        'spotify.track': item?.title || '', 'spotify.artist': item?.artist || '', 'spotify.url': item?.url || '',
    });
    const templateValues = (profileId) => nowPlayingVars.get(Number(profileId)) || varsFor(null, null);

    // ── settings and the overlay key ──
    async function saveSettings(profileId, input) {
        const v = validateSettings(input);
        if (!v.ok) return v;
        const raw = await rawMusic(profileId);
        const playlists = await mstore.listPlaylists(profileId);
        const ids = new Set(playlists.map((p) => p.id));
        if (v.value.fallbackPlaylistId && !ids.has(v.value.fallbackPlaylistId)) v.value.fallbackPlaylistId = null;
        if (v.value.defaultPlaylistId && !ids.has(v.value.defaultPlaylistId)) v.value.defaultPlaylistId = null;
        await store.setSettingsKey(profileId, 'music', { ...v.value, ...(raw.overlay ? { overlay: raw.overlay } : {}) });
        player.setVolume(profileId, v.value.volume);
        player.setCard(profileId, v.value.card);
        return v;
    }
    async function applyPreset(profileId, preset = OWNER_PRESET) {
        const raw = await rawMusic(profileId);
        await store.setSettingsKey(profileId, 'music', { ...withDefaults({ ...raw, ...preset }), ...(raw.overlay ? { overlay: raw.overlay } : {}) });
    }

    async function overlayKey(profileId, { rotate = false } = {}) {
        const raw = await rawMusic(profileId);
        if (!rotate && raw.overlay?.keyEnc && encryption) {
            try { const k = encryption.decrypt(JSON.parse(raw.overlay.keyEnc)); if (isKeyShape(k)) return k; } catch { /* make a new one */ }
        }
        const key = newOverlayKey();
        const overlay = { keyEnc: encryption ? JSON.stringify(encryption.encrypt(key)) : null, keyHash: keyHash(key), createdAt: new Date(now()).toISOString() };
        if (raw.overlay?.keyHash) keyCache.delete(raw.overlay.keyHash);
        await store.setSettingsKey(profileId, 'music', { ...withDefaults(raw), overlay });
        return key;
    }
    async function profileForKey(key) {
        if (!isKeyShape(key)) return null;
        const kh = keyHash(key);
        const hit = keyCache.get(kh);
        if (hit && now() - hit.at < KEY_CACHE_MS) return hit.profileId ? { profileId: hit.profileId, keyHash: kh } : null;
        const [rows] = await db.query(`SELECT id FROM \`${store.prefix}profiles\` WHERE enabled = 1 AND JSON_UNQUOTE(JSON_EXTRACT(settings, '$.music.overlay.keyHash')) = ? LIMIT 1`, [kh]);
        const profileId = rows[0] ? Number(rows[0].id) : null;
        if (keyCache.size > 5000) keyCache.clear();
        keyCache.set(kh, { at: now(), profileId });
        return profileId ? { profileId, keyHash: kh } : null;
    }

    // ── CertiFried Studio ──
    async function onStudioRequest(conn, method, params = {}) {
        const err = (code, message) => Object.assign(new Error(message), { code });
        if (method === 'music.overlay') {
            const key = await overlayKey(conn.profileId, { rotate: params.rotate === true });
            const base = String(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
            return { url: `${base}/stream/bot/overlay/music/${key}`, sourceName: 'CertiFried Music' };
        }
        throw err('unknown_method', 'Unknown method');
    }

    // ── requests ──
    const vars = (item, extra = {}) => ({ song: item?.title || '', artist: item?.artist || 'unknown artist', link: item?.url || '', ...extra });

    async function queueInfo(profileId, requestId) {
        const queued = await mstore.requestsWithStatus(profileId, 'queued');
        const i = queued.findIndex((r) => r.id === requestId);
        const before = i < 0 ? queued : queued.slice(0, i);
        return { position: (i < 0 ? queued.length : i) + 1, wait: formatWait(player.estimatedWaitMs(profileId, before)) };
    }

    function refusal(key, v = {}) { return { outcome: 'refused', key, vars: v, requests: [] }; }

    /**
     * A song request from chat (via the "Song requests" action), a reward, or the dashboard (via: 'dashboard' skips the
     * gate, limits and approval: the streamer is adding it).
     */
    async function submit(profile, { input, viewer = {}, roles = [], via = 'chat' } = {}) {
        const profileId = profile.id;
        const settings = await settingsOf(profileId);
        const streamer = via === 'dashboard';
        if (!settings.open && !streamer) return refusal('requests_closed');
        if (!streamer) {
            const g = await player.status(profileId).then((s) => s.gate).catch(() => ({ ok: false }));
            if (!g.ok) return refusal('requests_paused');
        }
        const parsed = parseRequestInput(input);
        if (parsed.kind === 'empty') return refusal('request_usage');
        if (parsed.kind === 'censored') return refusal('short_link');
        if (parsed.kind === 'unsupported') return refusal(parsed.what === 'short_link' ? 'short_link' : 'not_found');

        const source = SOURCE_OF(parsed);
        const fromPlaylists = settings.sources.includes('playlists');
        let items = null, playlistName = null, total = 0;
        if (!streamer && !settings.sources.includes(source)) {
            if (!fromPlaylists) return refusal('source_not_allowed', { source: SOURCE_NAME[source] || source });
            const hit = parsed.kind === 'search'
                ? await mstore.findInPlaylists(profileId, { words: normalise(parsed.query) })
                : (parsed.kind === 'spotify' && parsed.type === 'track') || parsed.kind === 'url' ? await mstore.findInPlaylists(profileId, { trackKey: trackKeyOf(parsed.url) }) : null;
            if (!hit) return refusal('playlists_only');
            items = [{ source: hit.source, title: hit.title, artist: hit.artist, url: hit.url, trackKey: hit.trackKey, durationMs: hit.durationMs, explicit: hit.explicit, thumbnail: hit.thumbnail }];
        }

        const bypassLimits = streamer || settings.limitBypass.some((r) => roles.includes(r));
        const active = await mstore.activeRequests(profileId);
        const waiting = active.filter((r) => r.status !== 'playing');
        const mine = viewer.id ? waiting.filter((r) => r.platform === viewer.platform && String(r.viewerId) === String(viewer.id)) : [];
        if (!bypassLimits && mine.length >= settings.maxPerUser) return refusal('user_limit', { max: settings.maxPerUser });
        if (!bypassLimits && waiting.length >= settings.maxQueue) return refusal('queue_full', { max: settings.maxQueue });
        const room = bypassLimits ? Math.min(200, settings.maxQueue * 2) : Math.min(settings.maxPerUser - mine.length, settings.maxQueue - waiting.length);

        if (!items) {
            const multi = (parsed.kind === 'spotify' && parsed.type !== 'track') || (parsed.kind === 'url' && parsed.playlist);
            const found = await resolver.lookup(parsed, { max: multi ? Math.max(1, room) : 1 });
            if (!found.ok) return refusal(found.error === 'link_failed' ? 'link_failed' : found.error === 'music_error' ? 'music_error' : 'not_found');
            items = found.items;
            playlistName = multi ? (found.playlist || 'that playlist') : null;
            total = found.total || items.length;
        }

        const bypassApproval = streamer || settings.approvalBypass.some((r) => roles.includes(r));
        const created = [];
        let firstRefusal = null;
        const activeKeys = new Set(active.map((r) => r.trackKey));
        for (const item of items) {
            const ban = await mstore.banFor(profileId, item.trackKey, primaryArtist(item.artist));
            let why = null;
            if (ban) why = ban.kind === 'artist' ? ['banned_artist', { artist: ban.artist || item.artist }] : ['banned_song', {}];
            else if (item.explicit === true && !settings.allowExplicit && !streamer) why = ['explicit', vars(item)];
            else if (item.durationMs && item.durationMs > settings.maxDurationSec * 1000 && !streamer) why = ['too_long', { max: formatWait(settings.maxDurationSec * 1000) }];
            else if (!settings.allowDuplicates && activeKeys.has(item.trackKey) && !streamer) why = ['duplicate', {}];
            if (why) { firstRefusal ||= why; continue; }
            const needs = !bypassApproval && (settings.approval === 'all' || (settings.approval === 'explicit' && item.explicit === true)
                || (settings.approval === 'explicit_or_unknown' && item.explicit !== false));
            const id = await mstore.insertRequest(profileId, {
                platform: viewer.platform || (streamer ? 'dashboard' : 'unknown'), viewerId: viewer.id || null, viewerLogin: viewer.login || null, viewerName: viewer.name || null,
                source: items.length > 1 ? 'playlist' : (item.source === 'search' ? 'search' : item.source), input: String(input || '').slice(0, 300),
                title: item.title, artist: item.artist, url: item.url, trackKey: item.trackKey, durationMs: item.durationMs, explicit: item.explicit, thumbnail: item.thumbnail,
                playlistName, status: needs ? 'pending' : 'queued',
            });
            activeKeys.add(item.trackKey);
            created.push({ id, item, status: needs ? 'pending' : 'queued' });
            if (created.length >= room) break;
        }
        if (!created.length) return firstRefusal ? refusal(firstRefusal[0], firstRefusal[1]) : refusal('not_found');
        if (created.some((c) => c.status === 'queued')) player.nudge(profileId).catch(() => {});
        if (created.length > 1) return { outcome: 'added_many', key: 'added_many', vars: { count: created.length, playlist: playlistName || 'that playlist', total }, requests: created };
        const c = created[0];
        if (c.status === 'pending') {
            const pending = await mstore.requestsWithStatus(profileId, 'pending');
            return { outcome: 'pending', key: 'needs_approval', vars: { ...vars(c.item), input: String(input || '').slice(0, 100), count: pending.length }, requests: created };
        }
        const info = await queueInfo(profileId, c.id);
        const likedBy = await mstore.likesFor(profileId, c.item.trackKey).catch(() => []);
        return { outcome: 'queued', key: likedBy.length ? 'added_liked' : 'added', vars: { ...vars(c.item), position: info.position, wait: info.wait, liked_by: namesList(likedBy) }, requests: created };
    }

    async function approve(profileId, index, by) {
        const pending = await mstore.requestsWithStatus(profileId, 'pending');
        if (!pending.length) return { key: 'pending_none', vars: {} };
        const r = pending[index];
        if (!r) return { key: 'bad_number', vars: { count: pending.length } };
        await mstore.setRequestStatus(profileId, r.id, 'queued', { decidedBy: by, decided: true });
        player.nudge(profileId).catch(() => {});
        return { key: 'approved', vars: { ...vars(r), number: index + 1, requester: r.viewerName || 'the dashboard', left: pending.length - 1 }, request: r };
    }
    async function deny(profileId, index, by) {
        const pending = await mstore.requestsWithStatus(profileId, 'pending');
        if (!pending.length) return { key: 'pending_none', vars: {} };
        const r = pending[index];
        if (!r) return { key: 'bad_number', vars: { count: pending.length } };
        await mstore.setRequestStatus(profileId, r.id, 'denied', { decidedBy: by, decided: true, finished: true });
        return { key: 'denied', vars: { ...vars(r), number: index + 1, requester: r.viewerName || 'the dashboard', left: pending.length - 1 }, request: r };
    }
    async function denyAll(profileId, by) {
        const pending = await mstore.requestsWithStatus(profileId, 'pending');
        for (const r of pending) await mstore.setRequestStatus(profileId, r.id, 'denied', { decidedBy: by, decided: true, finished: true });
        return { key: pending.length ? 'denied_all' : 'pending_none', vars: { count: pending.length } };
    }
    /** Take a request out (dashboard or chat). A song that is playing is skipped. */
    async function removeRequest(profileId, given, by) {
        // Read it again: a song taken from an older list may have started playing since.
        const r = (await mstore.getRequest(profileId, given.id)) || given;
        if (r.status === 'playing' || player.nowPlaying(profileId)?.requestId === r.id) {
            await player.removedRequest(profileId, r.id);
            await mstore.setRequestStatus(profileId, r.id, 'removed', { decidedBy: by, reason: 'removed' });
            return true;
        }
        if (!['pending', 'queued'].includes(r.status)) return false;
        await mstore.setRequestStatus(profileId, r.id, 'removed', { decidedBy: by, decided: true, finished: true });
        return true;
    }
    async function decideById(profileId, id, action, by) {
        const r = await mstore.getRequest(profileId, id);
        if (!r) return { ok: false, error: 'not_found' };
        if (action === 'remove') return { ok: await removeRequest(profileId, r, by) };
        if (r.status !== 'pending') return { ok: false, error: 'not_pending' };
        if (action === 'approve') { await mstore.setRequestStatus(profileId, id, 'queued', { decidedBy: by, decided: true }); player.nudge(profileId).catch(() => {}); return { ok: true }; }
        if (action === 'deny') { await mstore.setRequestStatus(profileId, id, 'denied', { decidedBy: by, decided: true, finished: true }); return { ok: true }; }
        return { ok: false, error: 'bad_action' };
    }

    // ── bans and playlists (dashboard) ──
    async function banLink(profileId, { input, kind = 'track', by }) {
        if (kind === 'artist') {
            const name = String(input || '').trim().slice(0, 200);
            if (!primaryArtist(name)) return { ok: false, error: 'Enter the artist name.' };
            await mstore.addBan(profileId, { kind: 'artist', ref: primaryArtist(name), artist: name, createdBy: by });
            return { ok: true };
        }
        const parsed = parseRequestInput(input);
        if (parsed.kind !== 'spotify' && parsed.kind !== 'url' && parsed.kind !== 'search') return { ok: false, error: 'Enter a song link or name.' };
        const found = await resolver.lookup(parsed, { max: 1 });
        if (!found.ok) return { ok: false, error: 'No song was found for that.' };
        const it = found.items[0];
        await mstore.addBan(profileId, { kind: 'track', ref: it.trackKey, title: it.title, artist: it.artist, url: it.url, createdBy: by });
        return { ok: true, item: it };
    }
    async function importPlaylist(profileId, { name, url, by }) {
        const parsed = parseRequestInput(url);
        const listy = (parsed.kind === 'spotify' && parsed.type !== 'track') || (parsed.kind === 'url' && (parsed.playlist || parsed.platform === 'soundcloud'));
        if (!listy) return { ok: false, error: 'Paste a Spotify playlist or album, a YouTube playlist or a SoundCloud set link.' };
        const found = await resolver.lookup(parsed, { max: 2000 });
        if (!found.ok) return { ok: false, error: "That playlist couldn't be read. Check that it is public." };
        const title = String(name || '').trim().slice(0, 100) || String(found.playlist && found.playlist !== 'that playlist' ? found.playlist : 'Imported playlist').slice(0, 100);
        const made = await mstore.createPlaylist(profileId, { name: title, kind: 'imported', sourceUrl: parsed.url });
        if (!made.ok) return { ok: false, error: made.error === 'exists' ? 'You already have a playlist with that name.' : 'You have the most playlists allowed (50).' };
        const r = await mstore.addPlaylistItems(profileId, made.id, found.items, by);
        return { ok: true, id: made.id, name: title, added: r.added, full: r.full };
    }

    async function status(profileId) {
        const st = await player.status(profileId);
        const gate = gateOf(profileId);
        const studios = (hub?.connected(profileId) || []).filter((d) => d.kind === 'studio');
        return { ...st, vod: gate, studioOnline: studios.length > 0 };
    }

    /** Text for a reply: the streamer's wording or the default, placeholders filled, "@viewer " in front when set. */
    async function replyText(profileId, key, v = {}, { viewerName = null, settings = null } = {}) {
        const s = settings || await settingsOf(profileId);
        const tpl = messageFor(s, key);
        let text = fill(tpl, { user: viewerName || '', ...v });
        if (s.mention && viewerName && !tpl.includes('{user}')) text = `@${viewerName} ${text}`;
        return text;
    }

    async function boot(before = new Date()) {
        await mstore.closePlaying().catch(() => {});
        await mstore.interruptPlays(before).catch(() => {});
        startSweep();
    }
    const close = () => { if (sweeper) clearInterval(sweeper); sweeper = null; };

    return {
        player, settingsOf, saveSettings, applyPreset, overlayKey, profileForKey, onStudioRequest, gateOf, submit, approve, deny, denyAll,
        removeRequest, decideById, banLink, importPlaylist, status, replyText, templateValues, boot, close, prepare, spotifyStatus, direct, mstore, resolver, signer, store,
        sourceLabels: SOURCE_LABEL,
    };
}

export default { createMusicService, isModRoles, SOURCE_OF, SOURCE_NAME };
