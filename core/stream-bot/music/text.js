/*
 * Stream bot music: the command catalogue, reply texts and input parsing (pure, no I/O).
 * Design: docs/superpowers/specs/2026-11-19-stream-bot-design.md §7.
 *
 *   COMMANDS                every chat command the "Song requests" action runs: key, label, the names the owner's
 *                           Streamer.bot extension used (the first is the default name) and whether it is for mods
 *   DEFAULT_MESSAGES        reply texts with {placeholders}; each can be changed on the Music page
 *   fill(template, vars)    replace {name} placeholders; values are inserted as plain text and never read again
 *   parseRequestInput(s)    a Spotify / YouTube / YouTube Music / SoundCloud / other link, or search text
 *   trackKeyOf(url)         the stable key a song is known by (bans, likes, playlists, duplicates)
 *   parseVolume, parseIndex, topRange, formatWait, formatLength, normalise, namesList
 *
 * Tested in tests/stream-bot-music.test.js.
 */
import crypto from 'node:crypto';

const c = (key, label, names, extra = {}) => Object.freeze({ key, label, names: Object.freeze(names), mod: false, input: false, ...extra });

/** Every command, in the order the Music page lists them. `names` without the "!". */
export const COMMANDS = Object.freeze([
    c('request', 'Request a song', ['sr'], { input: true }),
    c('pending', 'List requests waiting for approval', ['pending'], { mod: true }),
    c('approve', 'Approve a waiting request', ['approve'], { mod: true, input: true }),
    c('deny', 'Deny a waiting request', ['deny'], { mod: true, input: true }),
    c('current', 'Current song', ['song', 'currentSong', 'songName']),
    c('current_link', 'Current song with its link', ['songLink', 'currentSongLink']),
    c('last', 'Previous song', ['lastSong', 'lastSongName', 'last']),
    c('queue', 'Next songs', ['queue', 'queuedSongs'], { input: true }),
    c('my_queue', "A viewer's own requests and wait", ['myQueue', 'myRequests', 'queuePos', 'queuePositions']),
    c('requests', 'Number and length of requests', ['requests', 'allRequests', 'getRequests', 'getAllRequests'], { mod: true }),
    c('skip', 'Skip the song', ['skip', 'next', 'skipSong', 'nextSong']),
    c('voteskip', 'Vote to skip', ['voteskip']),
    c('back', 'Play the previous song again', ['back', 'previous', 'previousSong'], { mod: true }),
    c('play', 'Start or resume the music', ['play', 'playSong', 'continue'], { mod: true }),
    c('pause', 'Pause the music', ['pause', 'stop', 'pauseSong', 'stopSong'], { mod: true }),
    c('restart', 'Restart the song', ['restart', 'restartSong', 'restartCurrentSong', 'replay', 'replaySong'], { mod: true }),
    c('volume', 'Show or set the volume', ['vol', 'volume', 'songVolume'], { mod: true, input: true }),
    c('remove', 'Remove a request by name', ['remove', 'removeFromQueue', 'removeSong', 'deleteSong', 'deleteSongFromQueue'], { mod: true, input: true }),
    c('wrong_song', "Remove the viewer's latest request", ['wrongsong']),
    c('ban', 'Ban the current song', ['banSong', 'excludeSong'], { mod: true }),
    c('banned', 'List banned songs', ['bannedSongs', 'bannedSongList', 'excludedSongs', 'excludedSondList'], { mod: true }),
    c('unban', 'Unban a song', ['unbanSong', 'includeSong'], { mod: true, input: true }),
    c('devices', 'Where the music plays (OBS)', ['devices', 'deviceList'], { mod: true }),
    c('change_device', 'How to change where the music plays', ['changeDevice', 'setDevice'], { mod: true }),
    c('playlists', "List the streamer's playlists", ['playlists', 'getPlaylists'], { mod: true }),
    c('play_playlist', 'Play a playlist', ['playPlaylist', 'setPlaylist', 'changePlaylist'], { mod: true, input: true }),
    c('current_playlist', 'Playlist the song is playing from', ['playlist', 'currentPlaylist']),
    c('add_to_playlist', 'Add the current song to a playlist', ['addSong', 'add', 'saveSong'], { mod: true, input: true }),
    c('add_input_to_playlist', 'Add a named song to a playlist', ['addSongToPlaylistFromInput'], { mod: true, input: true }),
    c('save_liked', "Add the song to the streamer's liked list", ['addToLikedSongs', 'addLike', 'likeAdd'], { mod: true }),
    c('like', 'A viewer likes the current song', ['like']),
    c('unlike', 'A viewer takes back a like', ['unlike'], { input: true }),
    c('likes', 'Who likes the current song', ['likes']),
    c('top_songs', 'Most requested songs', ['topSongs']),
    c('top_artists', 'Most requested artists', ['topArtists']),
    c('my_top_songs', "A viewer's most requested songs", ['myTopSongs', 'topSongsUser']),
    c('my_top_artists', "A viewer's most requested artists", ['myTopArtists', 'topArtistsUser']),
    c('streamer_top_tracks', 'Most played songs on stream', ['broadcasterTopTracks', 'broadcasterTopSongs'], { input: true }),
    c('streamer_top_artists', 'Most played artists on stream', ['broadcasterTopArtists'], { input: true }),
]);
const BY_KEY = new Map(COMMANDS.map((x) => [x.key, x]));
export const commandDef = (key) => BY_KEY.get(key) || null;
export const COMMAND_KEYS = Object.freeze(COMMANDS.map((x) => x.key));

/** Reply texts, kept close to what the owner's Streamer.bot extension said. Placeholders: MESSAGE_VARS. */
export const DEFAULT_MESSAGES = Object.freeze({
    added: "'{song}' by {artist} is in the queue (#{position}, plays in about {wait}).",
    added_liked: "'{song}' by {artist} is in the queue (#{position}, plays in about {wait}). Liked by {liked_by}.",
    added_many: 'Added {count} songs from {playlist} to the queue.',
    needs_approval: '"{song}" needs mod approval (#{count} waiting). Mods: !pending, !approve <number>',
    approved: "Approved #{number} for {requester}: '{song}' by {artist} is in the queue. {left} still waiting.",
    denied: 'Denied #{number} ({requester}). {left} still waiting.',
    denied_all: 'Denied all waiting requests.',
    pending_list: 'Waiting ({count}): {list}',
    pending_none: 'No song requests are waiting.',
    bad_number: "That number isn't on the list ({count} there).",
    request_usage: 'Usage: !sr <song name or link>',
    requests_closed: 'Song requests are closed right now.',
    requests_paused: 'Song requests are paused until OBS VOD protection is on.',
    source_not_allowed: "Requests from {source} aren't allowed here.",
    playlists_only: 'Only songs from the playlists here can be requested.',
    not_found: 'No song was found for that.',
    short_link: 'Use the full link, or the song name.',
    link_failed: "That link couldn't be read. Try the song name or another link.",
    banned_song: 'That song is banned from requests.',
    banned_artist: 'Songs by {artist} are banned from requests.',
    explicit: "'{song}' by {artist} is explicit. Please request a clean song.",
    too_long: 'Songs can be at most {max} long.',
    duplicate: 'That song is already in the queue.',
    user_limit: "You can't have more than {max} songs in the queue at once.",
    queue_full: 'The request queue is full ({max} songs). Try again later.',
    music_error: "Music couldn't be reached. Try again in a moment.",
    nothing_playing: 'No music is playing right now.',
    current: "'{song}' by {artist}{requested}",
    current_link: "'{song}' by {artist} | {link}{requested}",
    requested_by: '(requested by {requester})',
    last: "The previous song was '{song}' by {artist}{requested}",
    no_last: "There's no previous song yet.",
    queue: 'The next {count} songs: {list}',
    queue_empty: 'The queue is empty.',
    my_queue: '{list} || Your first song plays in about {wait}.',
    my_queue_none: "You don't have any songs in the queue.",
    requests: '{count} requests in the queue, {time} in total.',
    requests_none: 'There are no requests in the queue.',
    skipped: "'{song}' by {artist} was skipped.",
    skip_mods_only: 'Only moderators can skip songs.',
    skip_not_yours: "The current song wasn't requested by you. To take out a song that is still waiting, use !remove <song>.",
    vote_counted: 'Vote to skip counted ({votes}/{needed}).',
    vote_already: 'You already voted to skip this song.',
    vote_skipped: "Enough votes ({votes}/{needed}): skipping '{song}'.",
    back: "Playing '{song}' by {artist} again.",
    resumed: 'The music is playing.',
    paused: 'The music is paused.',
    restarted: "'{song}' by {artist} started again from the beginning.",
    volume_now: 'The volume is at {volume}%.',
    volume_set: 'The volume is now {volume}%.',
    volume_usage: 'Use a number from 0 to 100, or +10 / -10.',
    removed: "'{song}' by {artist} was removed from the queue.",
    remove_usage: 'Name the song, for example !remove Stairway To Heaven',
    remove_none: "No requested song matches '{input}'.",
    remove_not_yours: "That song wasn't requested by you. If your song is playing now, use !skip.",
    remove_mods_only: 'Only moderators can remove songs.',
    wrong_song_none: "You don't have any songs in the queue to remove.",
    banned_now: "'{song}' by {artist} is banned from requests.",
    ban_nothing: "There's no song playing to ban.",
    banned_list: 'Banned: {list}',
    banned_none: 'No songs are banned.',
    unbanned: "'{song}' by {artist} can be requested again.",
    unban_usage: 'Use !unbanSong <number> from !bannedSongs.',
    devices: "Music plays in the OBS source '{source}'. {vod}",
    change_device: "Music plays through OBS: change where you hear it in OBS's Advanced Audio Properties (Audio Monitoring).",
    playlists: 'Playlists: {list}',
    playlists_none: 'There are no playlists yet.',
    playlist_playing: "Playing the playlist '{playlist}'.",
    playlist_usage: 'Name a playlist or its number from !playlists.',
    playlist_not_found: "That playlist wasn't found. Use !playlists to see them.",
    current_playlist: "'{playlist}'{url}",
    no_playlist: "The current song isn't playing from a playlist.",
    added_to_playlist: "'{song}' by {artist} was added to '{playlist}'.",
    already_in_playlist: "'{song}' by {artist} is already in '{playlist}'.",
    playlist_full: "'{playlist}' is full.",
    playlist_input_usage: 'Usage: !addSongToPlaylistFromInput <song or link> | <playlist name or number>',
    no_default_playlist: 'Name a playlist, or choose a default playlist on the Music page.',
    saved_liked: "'{song}' by {artist} was added to {streamer}'s liked songs.",
    already_saved_liked: "'{song}' by {artist} is already in {streamer}'s liked songs.",
    liked: "{user} liked '{song}' by {artist}.",
    already_liked: "You already liked '{song}' by {artist}.",
    unliked: "{user} took back their like for '{song}' by {artist}.",
    unlike_none: "You haven't liked a song that matches that.",
    likes: "{count} people like '{song}' by {artist}: {list}",
    likes_none: "Nobody has liked '{song}' by {artist} yet.",
    top_songs: 'Most requested songs: {list}',
    top_artists: 'Most requested artists: {list}',
    my_top_songs: 'Your most requested songs: {list}',
    my_top_artists: 'Your most requested artists: {list}',
    top_none: 'There are no stats yet.',
    streamer_top_tracks: 'Most played on stream in {range}: {list}',
    streamer_top_artists: 'Most played artists on stream in {range}: {list}',
});
export const MESSAGE_KEYS = Object.freeze(Object.keys(DEFAULT_MESSAGES));

/** Placeholders the reply texts can use (shown on the Music page). */
export const MESSAGE_VARS = Object.freeze([
    ['{user}', 'The viewer who used the command'], ['{song}', 'Song name'], ['{artist}', 'Artist'],
    ['{link}', 'Link to the song'], ['{requested}', 'The "requested by" text when the song was requested, else nothing'],
    ['{requester}', 'Who requested the song'], ['{position}', 'Place in the request queue'], ['{wait}', 'Time until it plays'],
    ['{count}', 'How many'], ['{max}', 'The limit that applies'], ['{list}', 'A list (songs, playlists …)'],
    ['{number}', 'The list number used'], ['{left}', 'Requests still waiting'], ['{votes}', 'Skip votes so far'], ['{needed}', 'Votes needed'],
    ['{volume}', 'Volume in percent'], ['{playlist}', 'Playlist name'], ['{input}', 'What the viewer typed'], ['{time}', 'Total length'],
    ['{streamer}', 'Your name'], ['{range}', 'the last 4 weeks / 6 months / year'], ['{liked_by}', 'Viewers who liked the song'],
    ['{source}', 'Where a link is from'], ['{vod}', 'VOD protection status'],
]);

const PLACEHOLDER = /\{([a-z_]{1,20})\}/g;

/** Replace {name} placeholders. Unknown names stay as written; values are plain text (never parsed again). */
export function fill(template, vars = {}) {
    return String(template ?? '').replace(PLACEHOLDER, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null ? String(vars[k]) : m))
        .replace(/\s+/g, ' ').trim().slice(0, 480);
}

// ── input parsing ───────────────────────────────────────────────────────────────────────────

const SP_ID = '[A-Za-z0-9]{22}';

/**
 * What a viewer typed after !sr (or what a reward collected).
 *   { kind: 'empty' | 'censored' }
 *   { kind: 'spotify', type: 'track'|'album'|'playlist'|'artist', id, url }
 *   { kind: 'unsupported', what }                  podcasts, Spotify short links
 *   { kind: 'url', platform: 'youtube'|'soundcloud'|'other', url, playlist }
 *   { kind: 'search', query }
 */
export function parseRequestInput(text) {
    const s = String(text ?? '').trim().slice(0, 400);
    if (!s) return { kind: 'empty' };
    if (s === '***' || /^\*{3,}$/.test(s)) return { kind: 'censored' };
    let m = s.match(new RegExp(`(?:^|\\s)spotify:(track|album|playlist|artist|show|episode):(${SP_ID})(?=\\s|$)`, 'i'));
    if (!m) m = s.match(new RegExp(`https?://open\\.spotify\\.com/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(?:embed/)?(track|album|playlist|artist|show|episode)/(${SP_ID})`, 'i'));
    if (m) {
        const type = m[1].toLowerCase();
        if (type === 'show' || type === 'episode') return { kind: 'unsupported', what: 'podcast' };
        return { kind: 'spotify', type, id: m[2], url: `https://open.spotify.com/${type}/${m[2]}` };
    }
    if (/https?:\/\/(?:spotify\.link|spoti\.fi)\//i.test(s)) return { kind: 'unsupported', what: 'short_link' };
    m = s.match(/https?:\/\/[^\s<>"']+/i);
    if (m) {
        let url = m[0].replace(/[),.!?]+$/, '');
        let host = '';
        try { const u = new URL(url); host = u.hostname.toLowerCase(); url = u.href; } catch { return { kind: 'unsupported', what: 'link' }; }
        if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) {
            const playlist = /[?&]list=(PL|OL|UU|FL|LL)[A-Za-z0-9_-]+/.test(url) && !/[?&]v=/.test(url) || /\/playlist\?/.test(url);
            return { kind: 'url', platform: 'youtube', url, playlist };
        }
        if (/(^|\.)soundcloud\.com$/.test(host)) return { kind: 'url', platform: 'soundcloud', url, playlist: /\/sets\//.test(url) };
        return { kind: 'url', platform: 'other', url, playlist: false };
    }
    return { kind: 'search', query: s.replace(/\s+/g, ' ').slice(0, 200) };
}

/** youtu.be / music.youtube.com / shorts / watch?v= all → the 11-character video id, or null. */
export function youtubeId(url) {
    try {
        const u = new URL(url);
        const h = u.hostname.toLowerCase();
        let id = null;
        if (h.endsWith('youtu.be')) id = u.pathname.slice(1).split('/')[0];
        else if (/(^|\.)youtube\.com$/.test(h)) id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
        return /^[\w-]{11}$/.test(id || '') ? id : null;
    } catch { return null; }
}

/** The stable key a song is known by: sp:<id> / yt:<id> / sc:<path> / u:<hash>. */
export function trackKeyOf(url) {
    const s = String(url || '');
    let m = s.match(new RegExp(`open\\.spotify\\.com/(?:intl-[a-z-]+/)?track/(${SP_ID})`, 'i')) || s.match(new RegExp(`spotify:track:(${SP_ID})`, 'i'));
    if (m) return `sp:${m[1]}`;
    const yt = youtubeId(s);
    if (yt) return `yt:${yt}`;
    try {
        const u = new URL(s);
        if (/(^|\.)soundcloud\.com$/i.test(u.hostname)) return `sc:${u.pathname.toLowerCase().replace(/\/+$/, '').slice(0, 180)}`;
    } catch { /* not a URL */ }
    return s ? `u:${crypto.createHash('sha1').update(s).digest('hex').slice(0, 32)}` : null;
}

/** '' → show; '55' → set; '+10' / '-10' → delta. A trailing % is allowed. Anything else → null. */
export function parseVolume(text) {
    const s = String(text ?? '').trim().replace(/%$/, '');
    if (!s) return { kind: 'show' };
    if (/^[+-]\d{1,3}$/.test(s)) return { kind: 'delta', value: Number(s) };
    if (/^\d{1,3}$/.test(s)) return { kind: 'set', value: Math.min(100, Number(s)) };
    return null;
}

/** A 1-based number a viewer typed → 0-based index, or -1 when it is not on a list of n. Empty → `fallback`. */
export function parseIndex(text, n, fallback = -1) {
    const s = String(text ?? '').trim();
    if (!s) return fallback;
    if (!/^\d{1,4}$/.test(s)) return -1;
    const i = Number(s) - 1;
    return i >= 0 && i < n ? i : -1;
}

/** The window for the streamer's top lists, from a viewer's words (as the extension read them): a year by default. */
export function topRange(text) {
    const s = String(text ?? '').toLowerCase();
    if (/short|new|latest|week/.test(s)) return { days: 28, label: 'the last 4 weeks' };
    if (/medium|mid|month/.test(s)) return { days: 183, label: 'the last 6 months' };
    return { days: 365, label: 'the last year' };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "1 hour, 3 minutes, 20 seconds"; "0 seconds" for nothing. */
export function formatWait(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const parts = [];
    if (h) parts.push(plural(h, 'hour'));
    if (m) parts.push(plural(m, 'minute'));
    if (s) parts.push(plural(s, 'second'));
    return parts.length ? parts.join(', ') : '0 seconds';
}

/** "3:20", or "1:02:03" past an hour. */
export function formatLength(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Lower case, accents and punctuation removed, for "!remove stairway" style matching. */
export function normalise(s) {
    return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The first artist of "A, B & C" style credits, normalised (artist bans). */
export const primaryArtist = (artist) => normalise(String(artist || '').split(/,|&| feat\.? | ft\.? | x /i)[0]);

/** "a, b and 3 others" */
export function namesList(names, show = 3) {
    const list = [...new Set((names || []).filter(Boolean))];
    if (list.length <= show) return list.join(', ');
    return `${list.slice(0, show).join(', ')} and ${list.length - show} others`;
}

export default {
    COMMANDS, COMMAND_KEYS, commandDef, DEFAULT_MESSAGES, MESSAGE_KEYS, MESSAGE_VARS, fill, parseRequestInput, youtubeId, trackKeyOf,
    parseVolume, parseIndex, topRange, formatWait, formatLength, normalise, primaryArtist, namesList,
};
