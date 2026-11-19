"use strict";
/*
 * AI DJ blocklist, favourites and presets — the pure logic (no database, no Discord), shared by
 * core/dj-manager.cjs (CommonJS) and handlers/music/dj-library.js (ESM imports this .cjs).
 *
 *   Blocklist (ai_dj_blacklist, migration 291): songs/artists the DJ must never queue. They are
 *     named to Gemini as exclusions AND every recommendation / resolved track is checked against
 *     them before it is queued — the prompt alone is a request, the filter is the guarantee.
 *   Favourites (ai_dj_favorites): when a DJ session has no seed, a few favourites — picked at random,
 *     weighted by `priority` — become the seed, re-picked for every batch.
 *   Presets (ai_dj_playlists.config): a named DJ setup {prompt, song, artist, genre, playlistLink}.
 *
 * Matching is deliberately conservative about ARTISTS: a blocked "Queen" must not block ABBA's
 * "Dancing Queen" or Queen Latifah, so an artist is compared as a whole credited name (the track's
 * uploader/artist credits, a YouTube "Artist - Title" prefix, or a "feat." credit), never as a
 * substring of the title.
 */

var MAX_PROMPT_EXCLUSION_CHARS = 1500;
var MAX_WEIGHT = 100;

/** lowercase, accents stripped, bracketed asides dropped, punctuation → spaces. */
function normalize(text) {
    return String(text == null ? '' : text)
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** An artist credit, without the channel decorations YouTube adds ("- Topic", "VEVO", "Official"). */
function normalizeArtist(text) {
    return normalize(String(text == null ? '' : text).replace(/\s*-\s*topic\s*$/i, ''))
        .replace(/\s*(vevo|official)$/g, '')
        .trim();
}

function squash(norm) {
    return String(norm || '').replace(/ /g, '').replace(/(vevo|official|topic)+$/, '');
}

var CREDIT_SPLIT = /\s*(?:,|;|\/|\s&\s|\s\+\s|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\bwith\b|\s[x×]\s)\s*/i;

/**
 * "Calvin Harris, Dua Lipa feat. Young Thug" → ["calvin harris dua lipa young thug", "calvin harris", "dua lipa", "young thug"]
 * The whole credit is kept too, so names that contain a separator ("Simon & Garfunkel",
 * "Dance With the Dead", "Tyler, The Creator") still match themselves.
 */
function artistCredits(text) {
    var raw = String(text == null ? '' : text);
    var parts = [normalizeArtist(raw)].concat(raw.split(CREDIT_SPLIT).map(normalizeArtist));
    return parts.filter(function (p, i) { return p && parts.indexOf(p) === i; });
}

/** "Rick Astley - Never Gonna Give You Up (Official Video)" → { artist, title } (null when no dash). */
function splitDashTitle(title) {
    var m = String(title == null ? '' : title).match(/^(.+?)\s+[-–—]\s+(.+)$/);
    return m ? { artist: m[1], title: m[2] } : null;
}

/** Featured credits inside a title: "Song (feat. A & B)" → "A & B". */
function featuredIn(title) {
    var m = String(title == null ? '' : title).match(/\b(?:feat\.?|ft\.?|featuring)\s+([^)\]\-–—]+)/i);
    return m ? m[1] : '';
}

function creditMatches(credit, blockedNorm) {
    if (!credit || !blockedNorm) return false;
    if (credit === blockedNorm) return true;
    var a = squash(credit), b = squash(blockedNorm);
    return a.length >= 2 && a === b;
}

/** Is `blockedArtistNorm` one of this track's credited artists? */
function artistMatches(blockedArtistNorm, item) {
    if (!blockedArtistNorm) return false;
    var credits = artistCredits(item && item.author);
    var dash = splitDashTitle(item && item.title);
    if (dash) credits = credits.concat(artistCredits(dash.artist));
    credits = credits.concat(artistCredits(featuredIn(item && item.title)));
    for (var i = 0; i < credits.length; i++) if (creditMatches(credits[i], blockedArtistNorm)) return true;
    return false;
}

function containsPhrase(hayNorm, needleNorm) {
    return !!needleNorm && (' ' + hayNorm + ' ').indexOf(' ' + needleNorm + ' ') !== -1;
}

/** The track's own title, without a YouTube "Artist - " prefix or bracketed asides. */
function titleCandidates(title) {
    var out = [normalize(title)];
    var dash = splitDashTitle(title);
    if (dash) out.push(normalize(dash.title));
    return out.filter(Boolean);
}

function songMatches(entry, item) {
    if (!entry.titleNorm) return false;
    var words = entry.titleNorm.split(' ').length;
    var cands = titleCandidates(item && item.title);
    var hit = cands.some(function (c) { return c === entry.titleNorm || (words >= 3 && containsPhrase(c, entry.titleNorm)); });
    if (!hit) return false;
    return !entry.artistNorm || artistMatches(entry.artistNorm, item);
}

/** A database row (or plain object) → a matchable entry. Rows from before migration 291 are songs keyed by title. */
function entryFromRow(row) {
    if (!row) return null;
    var type = row.entry_type === 'artist' || row.type === 'artist' ? 'artist' : 'song';
    var title = row.title != null ? row.title : (type === 'song' ? row.song_identifier : null);
    var artist = row.artist != null ? row.artist : (type === 'artist' ? row.song_identifier : null);
    if (type === 'song' && typeof title === 'string' && title.indexOf('song:') === 0 && row.title == null) {
        title = title.slice(5).split('|')[0];
    }
    if (type === 'artist' && typeof artist === 'string' && artist.indexOf('artist:') === 0 && row.artist == null) {
        artist = artist.slice(7);
    }
    var entry = {
        id: row.id != null ? row.id : null,
        type: type,
        title: title ? String(title) : '',
        artist: artist ? String(artist) : '',
        reason: row.reason || null,
    };
    entry.titleNorm = type === 'song' ? normalize(entry.title) : '';
    entry.artistNorm = normalizeArtist(entry.artist);
    if (type === 'artist' && !entry.artistNorm) return null;
    if (type === 'song' && !entry.titleNorm) return null;
    return entry;
}

/** The unique key stored in ai_dj_blacklist.song_identifier (UNIQUE with guild_id), so near-duplicates collide. */
function entryKey(type, title, artist) {
    var key = type === 'artist'
        ? 'artist:' + normalizeArtist(artist)
        : 'song:' + normalize(title) + '|' + normalizeArtist(artist || '');
    return key.slice(0, 255);
}

/**
 * The blocklist entry that rules this item out, or null.
 * @param {{title?: string, author?: string, artist?: string}} item  a Track or a Gemini {title, artist}
 */
function blockedBy(item, entries) {
    if (!item || !entries || !entries.length) return null;
    var probe = { title: item.title || '', author: item.author != null ? item.author : (item.artist || '') };
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e) continue;
        if (e.type === 'artist' ? artistMatches(e.artistNorm, probe) : songMatches(e, probe)) return e;
    }
    return null;
}

/** { kept, blocked: [{ item, entry }] } */
function filterBlocked(items, entries) {
    var kept = [], blocked = [];
    (items || []).forEach(function (item) {
        var e = blockedBy(item, entries);
        if (e) blocked.push({ item: item, entry: e }); else kept.push(item);
    });
    return { kept: kept, blocked: blocked };
}

function promptSafe(text, max) {
    return String(text == null ? '' : text).replace(/["\r\n\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 120);
}

/** The exclusion sentence for Gemini ('' when nothing is blocked). Bounded so a huge list can't swamp the prompt. */
function exclusionText(entries, maxChars) {
    var limit = maxChars || MAX_PROMPT_EXCLUSION_CHARS;
    var artists = [], songs = [];
    (entries || []).forEach(function (e) {
        if (!e) return;
        if (e.type === 'artist') artists.push(promptSafe(e.artist, 80));
        else songs.push('"' + promptSafe(e.title, 120) + '"' + (e.artist ? ' by ' + promptSafe(e.artist, 80) : ''));
    });
    var parts = [];
    var budget = limit;
    function take(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (!list[i]) continue;
            if (budget - (list[i].length + 2) < 0) break;
            budget -= list[i].length + 2;
            out.push(list[i]);
        }
        return out;
    }
    var a = take(artists);
    if (a.length) parts.push('Never recommend any song by these artists (including features): ' + a.join(', '));
    var s = take(songs);
    if (s.length) parts.push('Never recommend these songs, in any version: ' + s.join(', '));
    return parts.length ? 'STRICT EXCLUSIONS set by this server. ' + parts.join('. ') + '.' : '';
}

/** A free-text request equivalent to the song/artist/genre seed (used when exclusions force the prompt path). */
function seedPrompt(seeds) {
    seeds = seeds || {};
    var song = promptSafe(seeds.inputSong, 200), artist = promptSafe(seeds.inputArtist, 120), genre = promptSafe(seeds.inputGenre, 80);
    var base = song && artist ? 'songs similar to "' + song + '" by ' + artist
        : song ? 'songs similar to "' + song + '"'
        : artist ? 'songs by artists similar to ' + artist
        : '';
    if (genre) base = base ? base + ', in the genre ' + genre : 'songs in the genre ' + genre;
    return base || 'a diverse mix of popular songs';
}

function joinPrompt() {
    var parts = Array.prototype.slice.call(arguments).map(function (p) { return p == null ? '' : String(p).trim(); }).filter(Boolean);
    // "…on YouTube." + "STRICT…" must not become "YouTube.. STRICT…"
    return parts.length ? parts.map(function (p, i) { return i < parts.length - 1 ? p.replace(/[.\s]+$/, '') : p; }).join('. ') : null;
}

/**
 * The prompt to send given the session prompt (may be null), its seeds and the exclusion text.
 * With no exclusions the prompt is returned unchanged (null keeps Gemini's own seed wording).
 */
function withExclusions(prompt, seeds, exclusion) {
    if (!exclusion) return prompt == null ? null : prompt;
    return joinPrompt(prompt || seedPrompt(seeds), exclusion);
}

/**
 * Pick up to k items at random, weighted by `priority` (min 1), without replacement.
 * `rand` is injectable for tests.
 */
function pickWeighted(items, k, rand) {
    var r = typeof rand === 'function' ? rand : Math.random;
    var pool = (items || []).filter(Boolean).map(function (it) {
        var w = Math.floor(Number(it.priority));
        return { it: it, w: Number.isFinite(w) && w > 0 ? Math.min(w, MAX_WEIGHT) : 1 };
    });
    var out = [];
    var n = Math.max(0, Math.floor(Number(k) || 0));
    while (out.length < n && pool.length) {
        var total = pool.reduce(function (s, p) { return s + p.w; }, 0);
        var x = r() * total, idx = 0;
        for (; idx < pool.length - 1; idx++) { x -= pool[idx].w; if (x < 0) break; }
        out.push(pool[idx].it);
        pool.splice(idx, 1);
    }
    return out;
}

/** Favourites (rows with song_title/artist) → a seed sentence. */
function favoritesSeedText(picks) {
    var list = (picks || []).map(function (f) {
        var t = promptSafe(f.song_title || f.title, 120);
        var a = promptSafe(f.artist, 80);
        return t ? '"' + t + '"' + (a ? ' by ' + a : '') : '';
    }).filter(Boolean);
    return list.length ? 'Base the mix on this server\'s favourite songs: ' + list.join(', ') + ' (similar songs, not only these)' : '';
}

var PRESET_FIELDS = { prompt: 1000, song: 200, artist: 200, genre: 100, playlistLink: 500 };

/** Options → the JSON stored in ai_dj_playlists.config (only known fields, trimmed). */
function buildPresetConfig(opts) {
    var out = {};
    Object.keys(PRESET_FIELDS).forEach(function (k) {
        var v = opts && opts[k];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, PRESET_FIELDS[k]);
    });
    return out;
}

/** ai_dj_playlists.config → { prompt, song, artist, genre, playlistLink } (bad JSON → {}). */
function parsePresetConfig(text) {
    var obj = text;
    if (typeof text === 'string') { try { obj = JSON.parse(text); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object') return {};
    // Accept the snake_case spelling too (playlist_link), in case a preset was written by hand.
    if (!obj.playlistLink && typeof obj.playlist_link === 'string') obj = Object.assign({}, obj, { playlistLink: obj.playlist_link });
    return buildPresetConfig(obj);
}

/** A one-line description of a preset's config. */
function describePreset(cfg) {
    var bits = [];
    if (cfg.prompt) bits.push('prompt "' + promptSafe(cfg.prompt, 80) + (cfg.prompt.length > 80 ? '…' : '') + '"');
    if (cfg.song) bits.push('song "' + promptSafe(cfg.song, 60) + '"');
    if (cfg.artist) bits.push('artist ' + promptSafe(cfg.artist, 60));
    if (cfg.genre) bits.push('genre ' + promptSafe(cfg.genre, 40));
    if (cfg.playlistLink) bits.push('playlist link');
    return bits.join(' · ') || 'server defaults';
}

module.exports = {
    normalize: normalize,
    normalizeArtist: normalizeArtist,
    artistCredits: artistCredits,
    splitDashTitle: splitDashTitle,
    artistMatches: artistMatches,
    songMatches: songMatches,
    entryFromRow: entryFromRow,
    entryKey: entryKey,
    blockedBy: blockedBy,
    filterBlocked: filterBlocked,
    exclusionText: exclusionText,
    seedPrompt: seedPrompt,
    joinPrompt: joinPrompt,
    withExclusions: withExclusions,
    pickWeighted: pickWeighted,
    favoritesSeedText: favoritesSeedText,
    buildPresetConfig: buildPresetConfig,
    parsePresetConfig: parsePresetConfig,
    describePreset: describePreset,
    promptSafe: promptSafe,
};
