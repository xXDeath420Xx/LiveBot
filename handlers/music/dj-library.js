/*
 * AI DJ library: presets, blocklist and favourites (/music settings djpreset | djblock | djfavorite,
 * and `/music dj preset:`). Managing them needs Manage Server; starting a preset needs only what
 * /music dj needs.
 *
 *   ai_dj_playlists  named presets: config JSON {prompt, song, artist, genre, playlistLink}
 *   ai_dj_blacklist  songs / artists the DJ must never queue (migration 291 adds entry_type/title/artist)
 *   ai_dj_favorites  favourite songs, weighted by `priority`, used as the seed when a session has none
 *
 * Matching and prompt wording live in core/dj-blocklist.cjs (shared with core/dj-manager.cjs).
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import djLibrary from '../../core/dj-blocklist.cjs';

const DJ_COLOR = '#9B59B6';
const MAX_PRESETS = 50;
const MAX_BLOCK_ENTRIES = 200;
const MAX_FAVORITES = 200;

const clip = (s, n) => String(s ?? '').slice(0, n);

function isManager(interaction) {
    return !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function denyUnlessManager(interaction) {
    if (isManager(interaction)) return false;
    await interaction.reply({ content: 'You need the **Manage Server** permission to manage the AI DJ library.', ephemeral: true });
    return true;
}

/** Tell the DJ manager to drop its cached blocklist/favourites for this guild. */
function invalidate(interaction) {
    try { (interaction.client.djManager || global.djManager)?.invalidateDJLibrary?.(interaction.guildId); }
    catch (e) { logger.debug(`[DJ Library] cache invalidate failed: ${e.message}`); }
}

/** "Artist - Title (Official Video)" by "ArtistVEVO" → { title: 'Title (Official Video)', artist: 'Artist' } */
function describeTrack(track) {
    if (!track) return null;
    const dash = djLibrary.splitDashTitle(track.title);
    const author = String(track.author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
    return dash ? { title: dash.title.trim(), artist: dash.artist.trim() } : { title: String(track.title || '').trim(), artist: author };
}

function currentTrackOf(interaction) {
    const queue = interaction.client.player?.nodes?.get(interaction.guildId);
    return queue?.currentTrack || null;
}

// ── presets ─────────────────────────────────────────────────────────────────

/** A guild's preset by name (case-insensitive via the column collation), or null. */
export async function loadPreset(guildId, name) {
    const [rows] = await pool.execute(
        'SELECT id, name, description, config, times_used FROM ai_dj_playlists WHERE guild_id = ? AND name = ? LIMIT 1',
        [guildId, clip(name, 100).trim()]);
    if (!rows[0]) return null;
    return { ...rows[0], cfg: djLibrary.parsePresetConfig(rows[0].config) };
}

export async function markPresetUsed(id) {
    await pool.execute('UPDATE ai_dj_playlists SET times_used = COALESCE(times_used, 0) + 1, last_used = NOW() WHERE id = ?', [id])
        .catch(e => logger.warn(`[DJ Library] could not count preset use ${id}: ${e.message}`));
}

export async function handleDJPreset(interaction) {
    if (await denyUnlessManager(interaction)) return;
    const action = interaction.options.getString('action');
    const name = interaction.options.getString('name')?.trim();
    const guildId = interaction.guildId;

    if (action === 'list') {
        const [rows] = await pool.execute(
            `SELECT name, description, config, times_used FROM ai_dj_playlists WHERE guild_id = ? ORDER BY name LIMIT ${MAX_PRESETS}`,
            [guildId]);
        if (!rows.length) {
            return interaction.reply({ content: 'No AI DJ presets yet. Save one with `/music settings djpreset action:Save name:<name> prompt:<…>` — or with no seed options while a DJ session is running to save that session.', ephemeral: true });
        }
        const lines = rows.map(r => `**${r.name}** — ${djLibrary.describePreset(djLibrary.parsePresetConfig(r.config))}`
            + `${r.description ? `\n  _${clip(r.description, 120)}_` : ''} · used ${Number(r.times_used) || 0}×`);
        const embed = new EmbedBuilder().setColor(DJ_COLOR).setTitle(`AI DJ presets (${rows.length})`)
            .setDescription(clip(lines.join('\n'), 4000))
            .setFooter({ text: 'Start one with /music dj preset:<name>' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (!name) return interaction.reply({ content: 'Give the preset a `name`.', ephemeral: true });

    if (action === 'show') {
        const preset = await loadPreset(guildId, name);
        if (!preset) return interaction.reply({ content: `No preset called **${clip(name, 100)}**.`, ephemeral: true });
        const c = preset.cfg;
        const embed = new EmbedBuilder().setColor(DJ_COLOR).setTitle(`AI DJ preset: ${preset.name}`)
            .setDescription(preset.description ? clip(preset.description, 1000) : 'No description.')
            .addFields(
                { name: 'Prompt', value: clip(c.prompt || '—', 1024) },
                { name: 'Song', value: clip(c.song || '—', 1024), inline: true },
                { name: 'Artist', value: clip(c.artist || '—', 1024), inline: true },
                { name: 'Genre', value: clip(c.genre || '—', 1024), inline: true },
                { name: 'Playlist link', value: clip(c.playlistLink || '—', 1024) },
            )
            .setFooter({ text: `Used ${Number(preset.times_used) || 0} times` });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (action === 'delete') {
        const [res] = await pool.execute('DELETE FROM ai_dj_playlists WHERE guild_id = ? AND name = ?', [guildId, clip(name, 100)]);
        return interaction.reply({
            content: res.affectedRows ? `🗑️ Deleted the AI DJ preset **${clip(name, 100)}**.` : `No preset called **${clip(name, 100)}**.`,
            ephemeral: true,
        });
    }

    // save
    let cfg = djLibrary.buildPresetConfig({
        prompt: interaction.options.getString('prompt'),
        song: interaction.options.getString('song'),
        artist: interaction.options.getString('artist'),
        genre: interaction.options.getString('genre'),
        playlistLink: interaction.options.getString('playlist_link'),
    });
    let fromSession = false;
    if (!Object.keys(cfg).length) {
        const queue = interaction.client.player?.nodes?.get(guildId);
        const inputs = queue?.metadata?.djMode ? queue.metadata.presetInputs : null;
        cfg = djLibrary.buildPresetConfig(inputs || {});
        fromSession = Object.keys(cfg).length > 0;
        if (!fromSession) {
            return interaction.reply({ content: 'Give at least one of `prompt`, `song`, `artist`, `genre` or `playlist_link` — or run this while a DJ session started with those options is playing to save it.', ephemeral: true });
        }
    }
    const description = interaction.options.getString('description');
    const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM ai_dj_playlists WHERE guild_id = ?', [guildId]);
    const existing = await loadPreset(guildId, name);
    if (!existing && Number(n) >= MAX_PRESETS) {
        return interaction.reply({ content: `This server already has ${MAX_PRESETS} presets — delete one first.`, ephemeral: true });
    }
    await pool.execute(
        `INSERT INTO ai_dj_playlists (guild_id, name, description, config, created_by) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE description = COALESCE(VALUES(description), description), config = VALUES(config)`,
        [guildId, clip(name, 100), description ? clip(description, 1000) : null, JSON.stringify(cfg), interaction.user.id]);
    logger.info(`[DJ Library] preset "${name}" ${existing ? 'updated' : 'saved'} in ${guildId} by ${interaction.user.id}`);
    return interaction.reply({
        content: `💾 ${existing ? 'Updated' : 'Saved'} the AI DJ preset **${clip(name, 100)}**${fromSession ? ' from the running DJ session' : ''}: ${djLibrary.describePreset(cfg)}.\nAnyone who can use \`/music dj\` can start it with \`/music dj preset:${clip(name, 100)}\`.`,
        ephemeral: true,
    });
}

// ── blocklist ───────────────────────────────────────────────────────────────

/** The guild's blocklist as matchable entries (for features.js; dj-manager.cjs keeps its own cache). */
export async function loadBlocklist(guildId) {
    const [rows] = await pool.execute(
        'SELECT id, entry_type, song_identifier, title, artist, reason FROM ai_dj_blacklist WHERE guild_id = ?', [guildId]);
    return rows.map(djLibrary.entryFromRow).filter(Boolean);
}

function entryLabel(e) {
    return e.type === 'artist' ? `🎤 **${clip(e.artist, 80)}** (artist)` : `🎵 **${clip(e.title, 80)}**${e.artist ? ` by ${clip(e.artist, 60)}` : ''}`;
}

/** Remove queued (not playing) tracks the new entry blocks, in a running DJ session. */
function purgeQueued(interaction, entry) {
    const queue = interaction.client.player?.nodes?.get(interaction.guildId);
    if (!queue?.metadata?.djMode || !queue.tracks?.size) return 0;
    let removed = 0;
    for (const t of queue.tracks.toArray()) {
        if (djLibrary.blockedBy(t, [entry])) {
            try { queue.removeTrack(t); removed++; } catch { /* already gone */ }
        }
    }
    return removed;
}

export async function handleDJBlock(interaction) {
    if (await denyUnlessManager(interaction)) return;
    const action = interaction.options.getString('action');
    const guildId = interaction.guildId;

    if (action === 'list') {
        const entries = await loadBlocklist(guildId);
        if (!entries.length) return interaction.reply({ content: 'The AI DJ blocklist is empty.', ephemeral: true });
        const lines = entries.map(e => `${entryLabel(e)}${e.reason ? ` — _${clip(e.reason, 80)}_` : ''}`);
        const embed = new EmbedBuilder().setColor(DJ_COLOR).setTitle(`AI DJ blocklist (${entries.length})`)
            .setDescription(clip(lines.join('\n'), 4000))
            .setFooter({ text: 'The DJ never queues these. Remove one with /music settings djblock action:Remove' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const value = interaction.options.getString('value')?.trim() || '';

    if (action === 'remove') {
        if (!value) return interaction.reply({ content: 'Pick the entry to remove in `value`.', ephemeral: true });
        let res;
        const id = value.match(/^id:(\d+)$/)?.[1];
        if (id) {
            [res] = await pool.execute('DELETE FROM ai_dj_blacklist WHERE guild_id = ? AND id = ?', [guildId, id]);
        } else {
            [res] = await pool.execute(
                'DELETE FROM ai_dj_blacklist WHERE guild_id = ? AND song_identifier IN (?, ?, ?)',
                [guildId, djLibrary.entryKey('artist', null, value), djLibrary.entryKey('song', value, ''), value]);
        }
        invalidate(interaction);
        return interaction.reply({
            content: res.affectedRows ? `✅ Removed ${res.affectedRows === 1 ? 'that entry' : `${res.affectedRows} entries`} from the AI DJ blocklist.` : 'Nothing on the blocklist matched that.',
            ephemeral: true,
        });
    }

    // add
    const type = interaction.options.getString('type') || 'song';
    let title = null, artist = interaction.options.getString('artist')?.trim() || null;
    if (value) {
        if (type === 'artist') artist = value; else title = value;
    } else {
        const t = describeTrack(currentTrackOf(interaction));
        if (!t) return interaction.reply({ content: `Name the ${type} to block in \`value\` (or run this while the ${type === 'artist' ? 'artist' : 'song'} is playing).`, ephemeral: true });
        if (type === 'artist') artist = t.artist; else { title = t.title; artist = artist || t.artist || null; }
    }
    if (type === 'artist' && !artist) return interaction.reply({ content: 'The playing track has no artist I can block — name one in `value`.', ephemeral: true });
    const entry = djLibrary.entryFromRow({ entry_type: type, title, artist });
    if (!entry) return interaction.reply({ content: 'That is not something I can match — use letters or numbers.', ephemeral: true });

    const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM ai_dj_blacklist WHERE guild_id = ?', [guildId]);
    if (Number(n) >= MAX_BLOCK_ENTRIES) {
        return interaction.reply({ content: `The blocklist is full (${MAX_BLOCK_ENTRIES} entries) — remove some first.`, ephemeral: true });
    }
    const reason = interaction.options.getString('reason');
    const [res] = await pool.execute(
        `INSERT INTO ai_dj_blacklist (guild_id, song_identifier, entry_type, title, artist, reason, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = COALESCE(VALUES(reason), reason), title = VALUES(title), artist = VALUES(artist)`,
        [guildId, djLibrary.entryKey(type, title, artist), type, title ? clip(title, 255) : null, artist ? clip(artist, 255) : null,
            reason ? clip(reason, 255) : null, interaction.user.id]);
    invalidate(interaction);
    const removed = purgeQueued(interaction, entry);
    logger.info(`[DJ Library] blocked ${type} "${title || artist}" in ${guildId} by ${interaction.user.id}`);
    return interaction.reply({
        content: `${res.affectedRows === 1 ? '🚫 Added to' : '🚫 Already on'} the AI DJ blocklist: ${entryLabel(entry)}. The DJ will never queue it.`
            + (removed ? `\nRemoved ${removed} queued track${removed === 1 ? '' : 's'} it matched.` : ''),
        ephemeral: true,
    });
}

// ── favourites ──────────────────────────────────────────────────────────────

export async function loadFavorites(guildId) {
    const [rows] = await pool.execute(
        'SELECT id, song_title, artist, url, priority FROM ai_dj_favorites WHERE guild_id = ? ORDER BY priority DESC, id ASC LIMIT 200', [guildId]);
    return rows;
}

export async function handleDJFavorite(interaction) {
    if (await denyUnlessManager(interaction)) return;
    const action = interaction.options.getString('action');
    const guildId = interaction.guildId;

    if (action === 'list') {
        const rows = await loadFavorites(guildId);
        if (!rows.length) return interaction.reply({ content: 'No AI DJ favourites yet. When a DJ session starts with no seed, a few favourites (picked by weight) become its seed.', ephemeral: true });
        const lines = rows.map(r => `**${clip(r.song_title, 80)}** by ${clip(r.artist, 60)} · weight ${Number(r.priority) || 1}`);
        const embed = new EmbedBuilder().setColor(DJ_COLOR).setTitle(`AI DJ favourites (${rows.length})`)
            .setDescription(clip(lines.join('\n'), 4000))
            .setFooter({ text: 'Used as the seed when /music dj is started without a prompt, song, artist, genre or preset' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const song = interaction.options.getString('song')?.trim() || '';

    if (action === 'remove') {
        if (!song) return interaction.reply({ content: 'Pick the favourite to remove in `song`.', ephemeral: true });
        const id = song.match(/^id:(\d+)$/)?.[1];
        const [res] = id
            ? await pool.execute('DELETE FROM ai_dj_favorites WHERE guild_id = ? AND id = ?', [guildId, id])
            : await pool.execute('DELETE FROM ai_dj_favorites WHERE guild_id = ? AND song_title = ?', [guildId, clip(song, 255)]);
        invalidate(interaction);
        return interaction.reply({ content: res.affectedRows ? '✅ Removed from the AI DJ favourites.' : 'No favourite matched that.', ephemeral: true });
    }

    // add
    let title = song, artist = interaction.options.getString('artist')?.trim() || '', url = null;
    if (!title) {
        const track = currentTrackOf(interaction);
        const t = describeTrack(track);
        if (!t) return interaction.reply({ content: 'Name the `song` (and `artist`) to add, or run this while it is playing.', ephemeral: true });
        title = t.title;
        artist = artist || t.artist;
        url = /^https?:\/\//.test(track?.url || '') ? track.url : null;
    }
    if (!artist) return interaction.reply({ content: 'Give the `artist` too — the DJ needs it to find similar music.', ephemeral: true });
    const weight = interaction.options.getInteger('weight') ?? 1;
    const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM ai_dj_favorites WHERE guild_id = ?', [guildId]);
    if (Number(n) >= MAX_FAVORITES) return interaction.reply({ content: `This server already has ${MAX_FAVORITES} favourites — remove some first.`, ephemeral: true });
    const [res] = await pool.execute(
        `INSERT INTO ai_dj_favorites (guild_id, song_title, artist, url, priority, added_by) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE priority = VALUES(priority), url = COALESCE(VALUES(url), url)`,
        [guildId, clip(title, 255), clip(artist, 255), url, weight, interaction.user.id]);
    invalidate(interaction);
    return interaction.reply({
        content: `${res.affectedRows === 1 ? '⭐ Added' : '⭐ Updated'} **${clip(title, 100)}** by ${clip(artist, 80)} (weight ${weight}) in the AI DJ favourites.`,
        ephemeral: true,
    });
}

// ── /music dj helpers ───────────────────────────────────────────────────────

/** Drop blocked tracks from a search result in place (the DJ's playlist-link path). Returns how many went. */
export function stripBlockedFromResult(searchResult, entries) {
    if (!entries?.length || !searchResult?.tracks?.length) return 0;
    const { kept, blocked } = djLibrary.filterBlocked([...searchResult.tracks], entries);
    if (!blocked.length) return 0;
    const playlistTracks = searchResult.playlist?.tracks;
    searchResult.tracks.length = 0;
    searchResult.tracks.push(...kept);
    if (playlistTracks && playlistTracks !== searchResult.tracks) {
        playlistTracks.length = 0;
        playlistTracks.push(...kept);
    }
    return blocked.length;
}

// ── autocomplete ────────────────────────────────────────────────────────────

/**
 * Autocomplete for the DJ library options. Returns true when it answered the interaction.
 *   /music dj preset, /music settings djpreset name  → preset names
 *   /music settings djblock value (Remove)           → blocklist entries
 *   /music settings djfavorite song (Remove)         → favourites
 */
export async function autocomplete(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value || '').toLowerCase();
    const guildId = interaction.guildId;
    const respond = (choices) => interaction.respond(choices.slice(0, 25).map(c => ({ name: clip(c.name, 100), value: clip(c.value, 100) })));

    if ((!group && sub === 'dj' && focused.name === 'preset') || (group === 'settings' && sub === 'djpreset' && focused.name === 'name')) {
        const [rows] = await pool.execute('SELECT name, config FROM ai_dj_playlists WHERE guild_id = ? ORDER BY times_used DESC, name LIMIT 100', [guildId]);
        await respond(rows.filter(r => r.name.toLowerCase().includes(typed))
            .map(r => ({ name: `${r.name} — ${djLibrary.describePreset(djLibrary.parsePresetConfig(r.config))}`, value: r.name })));
        return true;
    }
    if (group === 'settings' && sub === 'djblock' && focused.name === 'value') {
        if (interaction.options.getString('action') !== 'remove') {
            const t = describeTrack(currentTrackOf(interaction));
            const type = interaction.options.getString('type') || 'song';
            const suggestion = t ? (type === 'artist' ? t.artist : t.title) : '';
            await respond(suggestion && suggestion.toLowerCase().includes(typed) ? [{ name: `Now playing: ${suggestion}`, value: suggestion }] : []);
            return true;
        }
        const entries = await loadBlocklist(guildId);
        await respond(entries.filter(e => `${e.title} ${e.artist}`.toLowerCase().includes(typed))
            .map(e => ({ name: e.type === 'artist' ? `Artist: ${e.artist}` : `Song: ${e.title}${e.artist ? ` — ${e.artist}` : ''}`, value: `id:${e.id}` })));
        return true;
    }
    if (group === 'settings' && sub === 'djfavorite' && focused.name === 'song') {
        if (interaction.options.getString('action') !== 'remove') {
            const t = describeTrack(currentTrackOf(interaction));
            await respond(t?.title && t.title.toLowerCase().includes(typed) ? [{ name: `Now playing: ${t.title}`, value: t.title }] : []);
            return true;
        }
        const rows = await loadFavorites(guildId);
        await respond(rows.filter(r => `${r.song_title} ${r.artist}`.toLowerCase().includes(typed))
            .map(r => ({ name: `${r.song_title} — ${r.artist}`, value: `id:${r.id}` })));
        return true;
    }
    return false;
}
