/*
 * Stream bot music: the chat commands (the "Song requests" action runs one of these). Behaviour follows the
 * owner's Streamer.bot Spotify extension and "SR Gate / Approve / Deny / List" actions, mapped onto CertiFried's
 * music pipeline (see text.js COMMANDS and the design doc §7 for every mapping).
 *
 *   createCommands(svc).run(profile, key, { ev, input }) → { reply: string | null, detail }
 *
 * Mods are the broadcaster and moderators (what Streamer.bot's "Moderators" group allowed); the automation's own
 * role condition decides who may run a command at all, these checks only cover "your own song" rules.
 * Tested in tests/stream-bot-music.test.js.
 */
import { isModRoles } from './service.js';
import { normalise, parseIndex, parseVolume, parseRequestInput, topRange, formatWait, fill, namesList } from './text.js';
import { messageFor } from './settings.js';

const TOP = 5;
const SEP = ' // ';
const clipTitle = (s, n = 35) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

export function createCommands(svc) {
    const { mstore, player } = svc;

    function counts(rows, keyOf, labelOf) {
        const m = new Map();
        for (const r of rows) for (const k of [].concat(keyOf(r)).filter(Boolean)) {
            const e = m.get(k.key) || { label: k.label, artist: k.artist || '', n: 0 };
            e.n++;
            m.set(k.key, e);
        }
        return [...m.values()].sort((a, b) => b.n - a.n).slice(0, TOP).map((e, i) => labelOf(e, i + 1));
    }
    const songKeys = (r) => ({ key: r.track_key || `${r.title}|${r.artist}`, label: r.title, artist: r.artist || r.author || '' });
    const artistKeys = (r) => String(r.artist ?? r.author ?? '').split(/,\s*/).map((a) => a.trim()).filter(Boolean).map((a) => ({ key: normalise(a), label: a }));
    const songLine = (e, rank, withCount = true) => `${rank}. ${e.label}${e.artist ? ` by ${e.artist}` : ''}${withCount ? ` (${e.n}x)` : ''}`;
    const artistLine = (e, rank, withCount = true) => `${rank}. ${e.label}${withCount ? ` (${e.n}x)` : ''}`;

    async function findPlaylist(profileId, input) {
        const lists = await mstore.listPlaylists(profileId);
        const i = parseIndex(input, lists.length);
        if (i >= 0) return lists[i];
        const n = normalise(input);
        return n ? lists.find((p) => normalise(p.name) === n) || lists.find((p) => normalise(p.name).startsWith(n)) || null : null;
    }

    async function run(profile, key, { ev = {}, input = '' } = {}) {
        const profileId = profile.id;
        const settings = await svc.settingsOf(profileId);
        const roles = ev.user?.roles || [];
        const mod = isModRoles(roles);
        const viewer = { platform: ev.platform, id: ev.user?.id || null, login: ev.user?.login || null, name: ev.user?.name || ev.user?.login || null };
        const by = viewer.name || 'chat';
        const streamer = profile.displayName || 'the streamer';
        const say = async (k, v = {}) => ({ reply: await svc.replyText(profileId, k, v, { viewerName: viewer.name, settings }), detail: k });
        const np = player.nowPlaying(profileId);
        const requested = (requester) => (requester ? ` ${fill(messageFor(settings, 'requested_by'), { requester })}` : '');
        const song = (it, extra = {}) => ({ song: it?.title || '', artist: it?.artist || 'unknown artist', link: it?.url || '', ...extra });
        const isMine = (r) => r && viewer.id && r.platform === viewer.platform && String(r.viewerId) === String(viewer.id);
        const text = String(input || '').trim();

        switch (key) {
            case 'request': {
                const r = await svc.submit(profile, { input: text, viewer, roles, via: ev.platform === 'test' ? 'test' : 'chat' });
                return say(r.key, r.vars);
            }
            case 'pending': {
                const p = await mstore.requestsWithStatus(profileId, 'pending');
                if (!p.length) return say('pending_none');
                return say('pending_list', { count: p.length, list: p.map((r, i) => `${i + 1}) ${r.viewerName || '?'}: ${clipTitle(r.title)}`).join(' | ').slice(0, 420) });
            }
            case 'approve': { const r = await svc.approve(profileId, parseIndex(text, 10_000, 0), by); return say(r.key, r.vars); }
            case 'deny': {
                if (/^all$/i.test(text)) { const r = await svc.denyAll(profileId, by); return say(r.key, r.vars); }
                const r = await svc.deny(profileId, parseIndex(text, 10_000, 0), by);
                return say(r.key, r.vars);
            }
            case 'current': return np ? say('current', song(np.item, { requested: requested(np.requester), requester: np.requester || '' })) : say('nothing_playing');
            case 'current_link': return np ? say('current_link', song(np.item, { requested: requested(np.requester), requester: np.requester || '' })) : say('nothing_playing');
            case 'last': {
                const h = player.history(profileId).find((x) => !np || x.trackKey !== np.item.trackKey);
                return h ? say('last', song(h, { requested: requested(h.requester), requester: h.requester || '' })) : say('no_last');
            }
            case 'queue': {
                const n = Math.max(1, Math.min(10, /^\d{1,2}$/.test(text) ? Number(text) : 3));
                const q = await mstore.requestsWithStatus(profileId, 'queued');
                if (!q.length) return say('queue_empty');
                const shown = q.slice(0, n);
                return say('queue', { count: shown.length, list: shown.map((r, i) => `[${i + 1}] '${r.title}' - ${r.artist || '?'}${r.viewerName ? ` (requested by ${r.viewerName})` : ''}`).join(', ').slice(0, 420) });
            }
            case 'my_queue': {
                const q = await mstore.requestsWithStatus(profileId, 'queued');
                const p = await mstore.requestsWithStatus(profileId, 'pending');
                const mineQ = q.map((r, i) => ({ r, pos: i + 1 })).filter((x) => isMine(x.r));
                const mineP = p.filter(isMine);
                if (!mineQ.length && !mineP.length) return say('my_queue_none');
                const list = [...mineQ.map((x) => `'${x.r.title}' - '${x.r.artist || '?'}' (#${x.pos})`), ...mineP.map((r) => `'${r.title}' (waiting for approval)`)].join(', ');
                const wait = mineQ.length ? player.estimatedWaitMs(profileId, q.slice(0, mineQ[0].pos - 1)) : 0;
                return say('my_queue', { list: list.slice(0, 380), wait: formatWait(wait) });
            }
            case 'requests': {
                const q = await mstore.requestsWithStatus(profileId, 'queued');
                if (!q.length) return say('requests_none');
                return say('requests', { count: q.length, time: formatWait(q.reduce((a, r) => a + (r.durationMs || 0), 0)) });
            }
            case 'skip': {
                if (!np) return say('nothing_playing');
                if (!mod) {
                    if (!settings.skipOwn) return say('skip_mods_only');
                    const r = np.requestId ? await mstore.getRequest(profileId, np.requestId) : null;
                    if (!isMine(r)) return say('skip_not_yours');
                }
                const was = await player.skip(profileId, mod ? 'mod' : 'own');
                return was ? say('skipped', song(was)) : say('nothing_playing');
            }
            case 'voteskip': {
                if (!np || np.paused) return say('nothing_playing');
                const votes = player.votes(profileId);
                const voter = `${viewer.platform}:${viewer.id || viewer.login || viewer.name}`;
                if (votes.has(voter)) return say('vote_already');
                votes.add(voter);
                if (votes.size >= settings.voteSkip) {
                    const n = votes.size;
                    const was = await player.skip(profileId, 'vote');
                    return say('vote_skipped', song(was || np.item, { votes: n, needed: settings.voteSkip }));
                }
                return say('vote_counted', { votes: votes.size, needed: settings.voteSkip });
            }
            case 'back': {
                const r = await player.back(profileId);
                if (!r) return say('no_last');
                if (r.held) return say('requests_paused');
                return say('back', song(r));
            }
            case 'play': { const r = await player.resume(profileId); return r === 'held' ? say('requests_paused') : say('resumed'); }
            case 'pause': { const r = await player.pause(profileId); return r ? say('paused') : say('nothing_playing'); }
            case 'restart': { const it = await player.restart(profileId); return it ? say('restarted', song(it)) : say('nothing_playing'); }
            case 'volume': {
                const v = parseVolume(text);
                if (!v) return say('volume_usage');
                if (v.kind === 'show') return say('volume_now', { volume: settings.volume });
                const next = Math.max(0, Math.min(100, v.kind === 'delta' ? settings.volume + v.value : v.value));
                await svc.saveSettings(profileId, { ...settings, volume: next });
                return say('volume_set', { volume: next });
            }
            case 'remove': {
                if (!mod && !settings.removeOwn) return say('remove_mods_only');
                if (!text) return say('remove_usage');
                const n = normalise(text);
                const active = (await mstore.activeRequests(profileId)).filter((r) => r.status !== 'playing');
                const match = active.find((r) => normalise(r.title).includes(n) || normalise(r.artist).includes(n));
                if (!match) return say('remove_none', { input: text.slice(0, 60) });
                if (!mod && !isMine(match)) return say('remove_not_yours');
                await svc.removeRequest(profileId, match, by);
                return say('removed', song(match));
            }
            case 'wrong_song': {
                if (!settings.removeOwn && !mod) return say('remove_mods_only');
                const mine = (await mstore.activeRequests(profileId)).filter((r) => r.status !== 'playing' && isMine(r));
                const last = mine[mine.length - 1];
                if (!last) return say('wrong_song_none');
                await svc.removeRequest(profileId, last, by);
                return say('removed', song(last));
            }
            case 'ban': {
                if (!np) return say('ban_nothing');
                await mstore.addBan(profileId, { kind: 'track', ref: np.item.trackKey, title: np.item.title, artist: np.item.artist, url: np.item.url, createdBy: by });
                await player.skip(profileId, 'banned');
                return say('banned_now', song(np.item));
            }
            case 'banned': {
                const bans = await mstore.listBans(profileId);
                if (!bans.length) return say('banned_none');
                return say('banned_list', { list: bans.map((b, i) => (b.kind === 'artist' ? `${b.artist} (artist) [${i + 1}]` : `'${b.title}' - '${b.artist || '?'}' [${i + 1}]`)).join(', ').slice(0, 420) });
            }
            case 'unban': {
                const bans = await mstore.listBans(profileId);
                if (!bans.length) return say('banned_none');
                const i = parseIndex(text, bans.length);
                if (i < 0) return say('unban_usage');
                await mstore.removeBan(profileId, bans[i].id);
                return say('unbanned', { song: bans[i].title || bans[i].artist, artist: bans[i].artist || '' });
            }
            case 'devices': {
                const g = svc.gateOf(profileId);
                const vod = g.vodSafe ? `VOD protection is on${g.vodTrack ? ` (kept off Twitch VOD track ${g.vodTrack})` : ''}.` : 'VOD protection is off, so song requests are paused.';
                return say('devices', { source: 'CertiFried Music', vod });
            }
            case 'change_device': return say('change_device');
            case 'playlists': {
                const lists = await mstore.listPlaylists(profileId);
                if (!lists.length) return say('playlists_none');
                return say('playlists', { list: lists.map((p, i) => `[${i + 1}] ${p.name} (${p.items} songs)`).join(', ').slice(0, 420) });
            }
            case 'play_playlist': {
                if (!text) return say('playlist_usage');
                const p = await findPlaylist(profileId, text);
                if (!p) return say('playlist_not_found');
                await player.playPlaylist(profileId, p.id);
                return say('playlist_playing', { playlist: p.name });
            }
            case 'current_playlist': {
                if (!np) return say('nothing_playing');
                if (!np.playlist) return say('no_playlist');
                const lists = await mstore.listPlaylists(profileId);
                const p = lists.find((x) => x.name === np.playlist);
                return say('current_playlist', { playlist: np.playlist, url: p?.sourceUrl ? ` (${p.sourceUrl})` : '' });
            }
            case 'add_to_playlist':
            case 'save_liked': {
                if (!np) return say('nothing_playing');
                let p;
                if (key === 'save_liked') p = await mstore.likedPlaylist(profileId);
                else if (text) { p = await findPlaylist(profileId, text); if (!p) return say('playlist_not_found'); }
                else { p = settings.defaultPlaylistId ? await mstore.getPlaylist(profileId, settings.defaultPlaylistId) : null; if (!p) return say('no_default_playlist'); }
                if (await mstore.playlistHas(profileId, p.id, np.item.trackKey)) return say(key === 'save_liked' ? 'already_saved_liked' : 'already_in_playlist', song(np.item, { playlist: p.name, streamer }));
                const r = await mstore.addPlaylistItems(profileId, p.id, [np.item], by);
                if (!r.added) return say('playlist_full', { playlist: p.name });
                return say(key === 'save_liked' ? 'saved_liked' : 'added_to_playlist', song(np.item, { playlist: p.name, streamer }));
            }
            case 'add_input_to_playlist': {
                const [songPart, listPart] = text.split('|').map((x) => (x || '').trim());
                if (!songPart || !listPart) return say('playlist_input_usage');
                const p = await findPlaylist(profileId, listPart);
                if (!p) return say('playlist_not_found');
                const parsed = parseRequestInput(songPart);
                if (!['spotify', 'url', 'search'].includes(parsed.kind)) return say('not_found');
                const found = await svc.resolver.lookup(parsed, { max: 1 });
                if (!found.ok) return say(found.error === 'link_failed' ? 'link_failed' : 'not_found');
                const it = found.items[0];
                if (await mstore.playlistHas(profileId, p.id, it.trackKey)) return say('already_in_playlist', song(it, { playlist: p.name }));
                const r = await mstore.addPlaylistItems(profileId, p.id, [it], by);
                return r.added ? say('added_to_playlist', song(it, { playlist: p.name })) : say('playlist_full', { playlist: p.name });
            }
            case 'like': {
                if (!np) return say('nothing_playing');
                if (!viewer.id) return { reply: null, detail: 'no viewer id' };
                const added = await mstore.addLike(profileId, { platform: viewer.platform, viewerId: viewer.id, viewerName: viewer.name, trackKey: np.item.trackKey, title: np.item.title, artist: np.item.artist, url: np.item.url });
                return say(added ? 'liked' : 'already_liked', song(np.item));
            }
            case 'unlike': {
                if (!viewer.id) return { reply: null, detail: 'no viewer id' };
                const likes = await mstore.viewerLikes(profileId, viewer.platform, viewer.id);
                const n = normalise(text);
                const hit = n ? likes.find((l) => normalise(l.title).includes(n) || normalise(`${l.artist} ${l.title}`).includes(n)) : (np ? likes.find((l) => l.track_key === np.item.trackKey) : null);
                if (!hit) return say('unlike_none');
                await mstore.removeLike(profileId, viewer.platform, viewer.id, hit.track_key);
                return say('unliked', { song: hit.title, artist: hit.artist || '' });
            }
            case 'likes': {
                if (!np) return say('nothing_playing');
                const names = await mstore.likesFor(profileId, np.item.trackKey);
                return names.length ? say('likes', song(np.item, { count: names.length, list: namesList(names, 10) })) : say('likes_none', song(np.item));
            }
            case 'top_songs': case 'top_artists': case 'my_top_songs': case 'my_top_artists': {
                const mine = key.startsWith('my_');
                if (mine && !viewer.id) return say('top_none');
                const rows = await mstore.countedRequests(profileId, mine ? { platform: viewer.platform, viewerId: viewer.id } : {});
                const list = key.endsWith('songs') ? counts(rows, songKeys, songLine) : counts(rows, artistKeys, artistLine);
                return list.length ? say(key, { list: list.join(SEP) }) : say('top_none');
            }
            case 'streamer_top_tracks': case 'streamer_top_artists': {
                const range = topRange(text);
                const rows = await mstore.topPlayed(profileId, range.days);
                let list;
                if (key === 'streamer_top_tracks') list = rows.slice(0, TOP).map((r, i) => songLine({ label: r.title, artist: r.author || '' }, i + 1, false));
                else {
                    const m = new Map();
                    for (const r of rows) for (const a of artistKeys(r)) { const e = m.get(a.key) || { label: a.label, n: 0 }; e.n += Number(r.n) || 1; m.set(a.key, e); }
                    list = [...m.values()].sort((a, b) => b.n - a.n).slice(0, TOP).map((e, i) => artistLine(e, i + 1, false));
                }
                return list.length ? say(key, { list: list.join(SEP), range: range.label, streamer }) : say('top_none');
            }
            default:
                return { reply: null, detail: `unknown command ${key}` };
        }
    }
    return { run };
}

export default { createCommands };
