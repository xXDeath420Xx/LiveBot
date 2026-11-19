/*
 * Steam library tally — who in a server owns which Steam game, so game nights can be planned
 * around what people actually have.
 *
 * Privacy model (the reason most of this file looks the way it does):
 *   - We store a SteamID64 and a list of app ids. No playtime, no profile, no friends list.
 *   - A library is only visible in servers its owner shared it with (steam_library_members).
 *     Linking in one server never exposes it in another.
 *   - The SteamID itself is never shown to anyone but its owner — not in Discord, not on the
 *     dashboard, not on the public page.
 *   - A library that goes private on Steam is DELETED here, not kept stale: the member told
 *     Steam to hide it, so we stop showing it too.
 *   - Unlinking deletes everything at once. Members who leave are hidden immediately and
 *     purged after 30 days (jobs/steam-library-sync.js).
 *
 * Linking is either verified (Steam's own OpenID sign-in, dashboard/routes/steam-link.js) or a
 * pasted profile link. A verified link always wins a SteamID away from an unverified claim, and
 * an unverified claim can never take one that someone has verified.
 */
import axios from 'axios';
import crypto from 'crypto';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

export const STEAM_COLOR = 0x1B2838;
export const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
export const DEPARTED_RETENTION_DAYS = 30;
const STEAM_API = 'https://api.steampowered.com';
const STEAM_ID_RE = /^7656119\d{10}$/;
const VANITY_RE = /^[A-Za-z0-9_-]{2,32}$/;

export class SteamLibraryError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function dashboardBase() {
    return (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
}
export const linkUrl = guildId => `${dashboardBase()}/steam/link?guild=${guildId}`;
export const publicUrl = token => `${dashboardBase()}/steam-library/${token}`;
export const storeUrl = appId => `https://store.steampowered.com/app/${appId}`;
export const headerImage = appId => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

// ── Steam Web API ───────────────────────────────────────────────────────────────────────────

// Every call goes through one queue, ~1 request/second, so a burst of links or the nightly
// refresh can never trip Steam's rate limit for the other Steam features sharing this key.
let queue = Promise.resolve();
let lastCall = 0;
function throttled(fn) {
    const run = queue.then(async () => {
        const wait = lastCall + 1100 - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastCall = Date.now();
        return fn();
    });
    queue = run.catch(() => {});
    return run;
}

async function steamGet(path, params) {
    const key = process.env.STEAM_API_KEY;
    if (!key) throw new SteamLibraryError('no_key', 'STEAM_API_KEY is not set');
    return throttled(async () => {
        try {
            const res = await axios.get(`${STEAM_API}${path}`, {
                params: { key, format: 'json', ...params },
                timeout: 15000,
                headers: { 'User-Agent': 'CertiFried Utility Bot/2.0' },
            });
            return res.data;
        } catch (err) {
            // axios puts the full URL — key included — on err.config; never let it reach a log.
            throw new SteamLibraryError('steam_http', `Steam API ${path} failed: ${err.response?.status || err.code || err.message}`);
        }
    });
}

/** Profile URL, /id/<vanity> URL, bare SteamID64 or bare vanity name → what to resolve. */
export function parseSteamInput(input) {
    const s = String(input || '').trim().replace(/[<>]/g, '').replace(/\/+$/, '');
    if (!s) return null;
    let m;
    if ((m = s.match(/steamcommunity\.com\/profiles\/(\d{17})(?:[/?#]|$)/i))) return { steamId: m[1] };
    if ((m = s.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})(?:[/?#]|$)/i))) return { vanity: m[1] };
    if (/^\d{17}$/.test(s)) return { steamId: s };
    if (VANITY_RE.test(s)) return { vanity: s };
    return null;
}

export async function resolveSteamInput(input) {
    const parsed = parseSteamInput(input);
    if (!parsed) throw new SteamLibraryError('bad_input', "That doesn't look like a Steam profile link.");
    if (parsed.steamId) {
        if (!STEAM_ID_RE.test(parsed.steamId)) throw new SteamLibraryError('bad_input', "That isn't a valid SteamID64.");
        return parsed.steamId;
    }
    const data = await steamGet('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: parsed.vanity });
    const id = data?.response?.success === 1 ? data.response.steamid : null;
    if (!id || !STEAM_ID_RE.test(id)) throw new SteamLibraryError('not_found', `No Steam profile found for "${parsed.vanity}".`);
    return id;
}

/** { private: true } when Game details are hidden; otherwise { games: [{ appid, name }] }. */
export async function fetchOwnedGames(steamId) {
    const data = await steamGet('/IPlayerService/GetOwnedGames/v1/', {
        steamid: steamId, include_appinfo: 1, include_played_free_games: 1,
    });
    const r = data?.response;
    // A private library answers 200 with an empty `response` — no game_count at all.
    if (!r || typeof r.game_count !== 'number') return { private: true };
    return { games: (r.games || []).filter(g => Number.isInteger(g.appid)) };
}

// ── Links and membership ────────────────────────────────────────────────────────────────────

export async function getLink(userId) {
    const [[row]] = await pool.execute('SELECT * FROM steam_links WHERE discord_user_id = ?', [userId]);
    return row || null;
}

async function deleteUserData(userIds) {
    if (!userIds.length) return;
    const ph = userIds.map(() => '?').join(',');
    await pool.execute(`DELETE FROM steam_library_members WHERE discord_user_id IN (${ph})`, userIds);
    await pool.execute(`DELETE FROM steam_owned_games WHERE discord_user_id IN (${ph})`, userIds);
    await pool.execute(`DELETE FROM steam_links WHERE discord_user_id IN (${ph})`, userIds);
}

/**
 * Bind a SteamID to a Discord user. Returns the guilds whose boards changed because another
 * user lost an unverified claim to this link.
 */
export async function linkAccount(userId, steamId, { verified }) {
    if (!STEAM_ID_RE.test(steamId)) throw new SteamLibraryError('bad_input', 'Invalid SteamID64.');
    const [holders] = await pool.execute(
        'SELECT discord_user_id, verified FROM steam_links WHERE steam_id64 = ? AND discord_user_id <> ?',
        [steamId, userId]);

    let displaced = [];
    if (verified) {
        // Proven ownership beats every other claim on this account, verified or not
        // (a verified claim elsewhere is the same person on another Discord account).
        displaced = holders.map(h => h.discord_user_id);
    } else if (holders.some(h => h.verified)) {
        throw new SteamLibraryError('claimed',
            'Someone has already verified that Steam account with Steam sign-in. If it is yours, use **Sign in through Steam** instead.');
    } else {
        // Two unverified claims on one account: last one in wins, same as a verified link would.
        displaced = holders.map(h => h.discord_user_id);
    }

    const touched = new Set();
    if (displaced.length) {
        const ph = displaced.map(() => '?').join(',');
        const [rows] = await pool.execute(
            `SELECT DISTINCT guild_id FROM steam_library_members WHERE discord_user_id IN (${ph})`, displaced);
        rows.forEach(r => touched.add(r.guild_id));
        await deleteUserData(displaced);
        logger.info(`[SteamLibrary] ${userId} took SteamID over from ${displaced.length} earlier claim(s)`);
    }

    const existing = await getLink(userId);
    if (existing && existing.steam_id64 !== steamId) {
        await pool.execute('DELETE FROM steam_owned_games WHERE discord_user_id = ?', [userId]);
    }
    await pool.execute(
        `INSERT INTO steam_links (discord_user_id, steam_id64, verified, sync_status, game_count, synced_at)
         VALUES (?, ?, ?, 'pending', 0, NULL)
         ON DUPLICATE KEY UPDATE
            verified = IF(steam_id64 = VALUES(steam_id64), GREATEST(verified, VALUES(verified)), VALUES(verified)),
            sync_status = IF(steam_id64 = VALUES(steam_id64), sync_status, 'pending'),
            game_count = IF(steam_id64 = VALUES(steam_id64), game_count, 0),
            synced_at = IF(steam_id64 = VALUES(steam_id64), synced_at, NULL),
            linked_at = IF(steam_id64 = VALUES(steam_id64), linked_at, CURRENT_TIMESTAMP),
            steam_id64 = VALUES(steam_id64)`,
        [userId, steamId, verified ? 1 : 0]);
    return [...touched];
}

export async function shareWithGuild(guildId, userId) {
    await pool.execute(
        `INSERT INTO steam_library_members (guild_id, discord_user_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE left_at = NULL`, [guildId, userId]);
}

export async function isSharedWith(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT 1 FROM steam_library_members WHERE guild_id = ? AND discord_user_id = ? AND left_at IS NULL',
        [guildId, userId]);
    return !!row;
}

/** Stop sharing with one server. The link itself stays so other servers keep working. */
export async function unshareFromGuild(guildId, userId) {
    await pool.execute('DELETE FROM steam_library_members WHERE guild_id = ? AND discord_user_id = ?', [guildId, userId]);
    const [[left]] = await pool.execute('SELECT COUNT(*) AS n FROM steam_library_members WHERE discord_user_id = ?', [userId]);
    // Shared nowhere any more → nothing justifies keeping the data.
    if (!left.n) await deleteUserData([userId]);
    return { deletedAll: !left.n };
}

/** Delete every trace of a user. Returns the guilds whose boards need a refresh. */
export async function unlinkEverywhere(userId) {
    const [rows] = await pool.execute('SELECT guild_id FROM steam_library_members WHERE discord_user_id = ?', [userId]);
    await pool.execute('DELETE FROM steam_library_members WHERE discord_user_id = ?', [userId]);
    await pool.execute('DELETE FROM steam_game_night_rsvps WHERE discord_user_id = ?', [userId]);
    await deleteUserData([userId]);
    return rows.map(r => r.guild_id);
}

export async function guildsSharedBy(userId) {
    const [rows] = await pool.execute(
        'SELECT guild_id FROM steam_library_members WHERE discord_user_id = ? AND left_at IS NULL', [userId]);
    return rows.map(r => r.guild_id);
}

// ── Library sync ────────────────────────────────────────────────────────────────────────────

/** Pull a user's library from Steam and replace what we hold. Returns { status, count }. */
export async function syncLibrary(userId) {
    const link = await getLink(userId);
    if (!link) throw new SteamLibraryError('not_linked', 'No Steam account linked.');

    let result;
    try {
        result = await fetchOwnedGames(link.steam_id64);
    } catch (err) {
        await pool.execute(
            "UPDATE steam_links SET sync_status = 'error', synced_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?", [userId]);
        logger.warn(`[SteamLibrary] sync failed for ${userId}: ${err.message}`);
        return { status: 'error', count: link.game_count };
    }

    if (result.private) {
        await pool.execute('DELETE FROM steam_owned_games WHERE discord_user_id = ?', [userId]);
        await pool.execute(
            "UPDATE steam_links SET sync_status = 'private', game_count = 0, synced_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?",
            [userId]);
        return { status: 'private', count: 0 };
    }

    const games = result.games;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM steam_owned_games WHERE discord_user_id = ?', [userId]);
        for (let i = 0; i < games.length; i += 500) {
            const chunk = games.slice(i, i + 500);
            await conn.query('INSERT IGNORE INTO steam_owned_games (discord_user_id, app_id) VALUES ?',
                [chunk.map(g => [userId, g.appid])]);
            const named = chunk.filter(g => g.name);
            if (named.length) {
                await conn.query(
                    'INSERT INTO steam_app_names (app_id, name) VALUES ? ON DUPLICATE KEY UPDATE name = VALUES(name)',
                    [named.map(g => [g.appid, String(g.name).slice(0, 255)])]);
            }
        }
        await conn.execute(
            "UPDATE steam_links SET sync_status = 'ok', game_count = ?, synced_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?",
            [games.length, userId]);
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
    return { status: 'ok', count: games.length };
}

export function refreshWaitMs(link) {
    if (!link?.synced_at) return 0;
    return Math.max(0, new Date(link.synced_at).getTime() + REFRESH_COOLDOWN_MS - Date.now());
}

// ── Queries (always scoped to one guild's active sharers) ───────────────────────────────────

const ACTIVE = 'm.guild_id = ? AND m.left_at IS NULL';
const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));
const escLike = s => s.replace(/[\\%_]/g, c => '\\' + c);

export async function guildStats(guildId) {
    const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS members,
                SUM(l.sync_status = 'ok') AS synced,
                SUM(l.sync_status = 'private') AS private_count,
                SUM(l.verified = 1) AS verified
           FROM steam_library_members m JOIN steam_links l ON l.discord_user_id = m.discord_user_id
          WHERE ${ACTIVE}`, [guildId]);
    const [[games]] = await pool.execute(
        `SELECT COUNT(DISTINCT o.app_id) AS n FROM steam_library_members m
           JOIN steam_owned_games o ON o.discord_user_id = m.discord_user_id WHERE ${ACTIVE}`, [guildId]);
    return {
        members: Number(row.members || 0), synced: Number(row.synced || 0),
        private: Number(row.private_count || 0), verified: Number(row.verified || 0),
        games: Number(games.n || 0),
    };
}

/** Most-owned games. `q` filters by name; paging is for the dashboard. */
export async function topGames(guildId, { limit = 25, offset = 0, minOwners = 1, q = '' } = {}) {
    const params = [guildId];
    let where = '';
    const search = String(q || '').trim().slice(0, 100);
    if (search) {
        where = ' AND n.name LIKE ?';
        params.push(`%${escLike(search)}%`);
    }
    params.push(int(minOwners, 1, 1000, 1));
    const [rows] = await pool.query(
        `SELECT o.app_id, n.name, COUNT(*) AS owners
           FROM steam_library_members m
           JOIN steam_owned_games o ON o.discord_user_id = m.discord_user_id
           LEFT JOIN steam_app_names n ON n.app_id = o.app_id
          WHERE ${ACTIVE}${where}
          GROUP BY o.app_id, n.name
         HAVING owners >= ?
          ORDER BY owners DESC, n.name ASC
          LIMIT ${int(limit, 1, 500, 25)} OFFSET ${int(offset, 0, 1e6, 0)}`, params);
    return rows.map(r => ({ appId: r.app_id, name: r.name || `App ${r.app_id}`, owners: Number(r.owners) }));
}

export async function countGames(guildId, { minOwners = 1, q = '' } = {}) {
    const params = [guildId];
    let where = '';
    const search = String(q || '').trim().slice(0, 100);
    if (search) {
        where = ' AND n.name LIKE ?';
        params.push(`%${escLike(search)}%`);
    }
    params.push(int(minOwners, 1, 1000, 1));
    const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM (
            SELECT o.app_id, COUNT(*) AS owners FROM steam_library_members m
              JOIN steam_owned_games o ON o.discord_user_id = m.discord_user_id
              LEFT JOIN steam_app_names n ON n.app_id = o.app_id
             WHERE ${ACTIVE}${where} GROUP BY o.app_id HAVING owners >= ?) t`, params);
    return Number(row.n || 0);
}

export async function gameOwners(guildId, appId) {
    const [rows] = await pool.execute(
        `SELECT m.discord_user_id FROM steam_library_members m
           JOIN steam_owned_games o ON o.discord_user_id = m.discord_user_id AND o.app_id = ?
          WHERE ${ACTIVE}`, [appId, guildId]);
    return rows.map(r => r.discord_user_id);
}

export async function appName(appId) {
    const [[row]] = await pool.execute('SELECT name FROM steam_app_names WHERE app_id = ?', [appId]);
    return row?.name || `App ${appId}`;
}

/** Autocomplete + name lookup: games someone in this server owns, best-owned first. */
export async function searchGuildGames(guildId, q, limit = 25) {
    const s = String(q || '').trim();
    if (/^\d{1,10}$/.test(s)) {
        const owners = await gameOwners(guildId, Number(s));
        if (owners.length) return [{ appId: Number(s), name: await appName(Number(s)), owners: owners.length }];
    }
    return topGames(guildId, { limit, q: s });
}

/**
 * Games owned across a group. Members who haven't shared here are reported, not counted.
 * Returns { counted, notShared, all: [...], almost: [{ ..., missing: [userId] }] }.
 */
export async function commonGames(guildId, userIds) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return { counted: [], notShared: [], all: [], almost: [] };
    const ph = ids.map(() => '?').join(',');
    const [shared] = await pool.execute(
        `SELECT m.discord_user_id FROM steam_library_members m
           JOIN steam_links l ON l.discord_user_id = m.discord_user_id AND l.sync_status = 'ok'
          WHERE ${ACTIVE} AND m.discord_user_id IN (${ph})`, [guildId, ...ids]);
    const counted = shared.map(r => r.discord_user_id);
    const notShared = ids.filter(id => !counted.includes(id));
    if (!counted.length) return { counted, notShared, all: [], almost: [] };

    const cph = counted.map(() => '?').join(',');
    const need = counted.length;
    const [rows] = await pool.query(
        `SELECT o.app_id, n.name, COUNT(*) AS c, GROUP_CONCAT(o.discord_user_id) AS who
           FROM steam_owned_games o LEFT JOIN steam_app_names n ON n.app_id = o.app_id
          WHERE o.discord_user_id IN (${cph})
          GROUP BY o.app_id, n.name
         HAVING c >= ?
          ORDER BY c DESC, n.name ASC
          LIMIT 400`, [...counted, Math.max(1, need - 1)]);
    const all = [];
    const almost = [];
    for (const r of rows) {
        const game = { appId: r.app_id, name: r.name || `App ${r.app_id}` };
        if (Number(r.c) === need) all.push(game);
        else if (need > 2) {
            const who = String(r.who || '').split(',');
            almost.push({ ...game, missing: counted.filter(id => !who.includes(id)) });
        }
    }
    return { counted, notShared, all, almost };
}

// ── Config ──────────────────────────────────────────────────────────────────────────────────

const CONFIG_DEFAULTS = {
    panel_channel_id: null, panel_message_id: null, board_size: 15, min_owners: 2,
    allow_unverified: 1, public_token: null, public_show_names: 0,
};

export async function getConfig(guildId) {
    const [[row]] = await pool.execute('SELECT * FROM steam_library_config WHERE guild_id = ?', [guildId]);
    return { guild_id: guildId, ...CONFIG_DEFAULTS, ...(row || {}) };
}

export async function getConfigByToken(token) {
    if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
    const [[row]] = await pool.execute('SELECT * FROM steam_library_config WHERE public_token = ?', [token]);
    return row || null;
}

const CONFIG_FIELDS = ['panel_channel_id', 'panel_message_id', 'board_size', 'min_owners', 'allow_unverified', 'public_token', 'public_show_names'];

export async function saveConfig(guildId, patch) {
    const cols = Object.keys(patch).filter(k => CONFIG_FIELDS.includes(k));
    if (!cols.length) return getConfig(guildId);
    await pool.execute(
        `INSERT INTO steam_library_config (guild_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`,
        [guildId, ...cols.map(c => patch[c])]);
    return getConfig(guildId);
}

export const newPublicToken = () => crypto.randomBytes(16).toString('hex');

// ── Discord messages ────────────────────────────────────────────────────────────────────────

function clientFor(guildId) {
    return global.botManager?.getClientForGuild?.(guildId) || null;
}

export async function buildPanelMessage(guildId) {
    const cfg = await getConfig(guildId);
    const stats = await guildStats(guildId);
    const games = await topGames(guildId, { limit: cfg.board_size, minOwners: cfg.min_owners });

    const lines = games.map((g, i) =>
        `\`${String(i + 1).padStart(2)}\` **${g.name.replace(/[*_`~|]/g, '')}** — ${g.owners} own${g.owners === 1 ? 's' : ''}`);
    let list = lines.join('\n');
    if (!games.length) {
        list = stats.members
            ? `*No game is owned by ${cfg.min_owners}+ linked members yet.*`
            : '*Nobody has linked yet. Be the first!*';
    }
    while (list.length > 3500) list = list.split('\n').slice(0, -1).join('\n');

    const embed = new EmbedBuilder()
        .setColor(STEAM_COLOR)
        .setTitle('🎮 Who Owns What')
        .setDescription(
            'Link your Steam so game nights can be planned around what people actually own.\n' +
            '-# Only the list of games you own is shared with this server. Never your Steam profile, playtime, or friends.\n\n' +
            list)
        .setFooter({ text: `${stats.members} linked · ${stats.games} different games · /steam who · /steam common` })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('stlib_link').setLabel('Link Steam').setEmoji('🔗').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stlib_refresh').setLabel('Refresh my games').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('stlib_leave').setLabel('Remove me').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
    );
    if (cfg.public_token) {
        row.addComponents(new ButtonBuilder().setLabel('Full list').setStyle(ButtonStyle.Link).setURL(publicUrl(cfg.public_token)));
    }
    return { embeds: [embed], components: [row] };
}

/** Post (or move) the panel. Deletes the old one so there's only ever one per server. */
export async function postPanel(guildId, channelId) {
    const client = clientFor(guildId);
    const guild = client?.guilds.cache.get(guildId);
    if (!guild) throw new SteamLibraryError('no_guild', 'The bot is not in that server.');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw new SteamLibraryError('bad_channel', 'That channel is not a text channel the bot can see.');

    const cfg = await getConfig(guildId);
    const msg = await channel.send(await buildPanelMessage(guildId));
    if (cfg.panel_channel_id && cfg.panel_message_id) {
        const old = await guild.channels.fetch(cfg.panel_channel_id).catch(() => null);
        await old?.messages?.delete(cfg.panel_message_id).catch(() => {});
    }
    await saveConfig(guildId, { panel_channel_id: channel.id, panel_message_id: msg.id });
    return msg;
}

async function editPanelNow(guildId) {
    const cfg = await getConfig(guildId);
    if (!cfg.panel_channel_id || !cfg.panel_message_id) return;
    const guild = clientFor(guildId)?.guilds.cache.get(guildId);
    if (!guild) return;
    const channel = await guild.channels.fetch(cfg.panel_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    try {
        await channel.messages.edit(cfg.panel_message_id, await buildPanelMessage(guildId));
    } catch (err) {
        if (err.code === 10008) {
            // Someone deleted the panel. Forget it rather than editing a ghost forever.
            await saveConfig(guildId, { panel_message_id: null });
            logger.info(`[SteamLibrary] panel in ${guildId} was deleted; cleared`);
        } else {
            logger.warn(`[SteamLibrary] panel edit failed in ${guildId}: ${err.message}`);
        }
    }
}

// A burst of links (everyone piling in after the panel goes up) becomes one edit per server.
const pendingPanels = new Map();
export function refreshPanel(guildId, delayMs = 15_000) {
    if (pendingPanels.has(guildId)) return;
    pendingPanels.set(guildId, setTimeout(() => {
        pendingPanels.delete(guildId);
        editPanelNow(guildId).catch(err => logger.warn(`[SteamLibrary] panel refresh ${guildId}: ${err.message}`));
    }, delayMs));
}
export const refreshPanels = (guildIds, delayMs) => guildIds.forEach(g => refreshPanel(g, delayMs));

/** What "Link Steam" shows a member: their current state and the ways to link. */
export async function buildLinkPrompt(guildId, userId) {
    const cfg = await getConfig(guildId);
    const link = await getLink(userId);
    const sharedHere = link ? await isSharedWith(guildId, userId) : false;

    const lines = [];
    const buttons = [];
    if (link) {
        const state = {
            ok: `✅ **${link.game_count}** games`,
            private: '🔒 **Your game list is private on Steam**, so nothing is counted',
            pending: '⏳ Fetching your games…',
            error: '⚠️ Steam did not answer last time. Try **Refresh my games** in a bit',
        }[link.sync_status] || link.sync_status;
        lines.push(`**Linked** ${link.verified ? '(verified with Steam sign-in)' : '(pasted link, not verified)'} · ${state}`);
        lines.push(sharedHere ? 'Your games **are** counted in this server.' : 'Your games are **not** counted in this server yet.');
        if (!sharedHere) {
            buttons.push(new ButtonBuilder().setCustomId('stlib_share').setLabel('Count my games here').setEmoji('✅').setStyle(ButtonStyle.Success));
        }
    } else {
        lines.push('**Sign in through Steam** proves the account is yours. Steam only tells us your SteamID. We never see your password.');
    }
    if (!link || link.sync_status === 'private') {
        lines.push('', '**Your game list must be public:** Steam → your profile → *Edit Profile* → *Privacy Settings* → **Game details: Public**.');
    }
    lines.push('', '-# Stored: your SteamID (never shown to anyone) and the IDs of games you own. Nothing else. `/steam unlink` deletes it all.');

    buttons.push(new ButtonBuilder().setLabel(link ? 'Re-link with Steam sign-in' : 'Sign in through Steam').setStyle(ButtonStyle.Link).setURL(linkUrl(guildId)));
    if (cfg.allow_unverified) {
        buttons.push(new ButtonBuilder().setCustomId('stlib_paste').setLabel('Paste profile link instead').setStyle(ButtonStyle.Secondary));
    }
    return { content: lines.join('\n'), components: [new ActionRowBuilder().addComponents(...buttons.slice(0, 5))] };
}

// ── Game nights ─────────────────────────────────────────────────────────────────────────────

/** `<t:…>`, a unix time, or "in 2h 30m" → Date. Anything else stays as free text. */
export function parseWhen(text) {
    const s = String(text || '').trim();
    let m;
    if ((m = s.match(/^<t:(\d{9,11})(?::[a-zA-Z])?>$/)) || (m = s.match(/^(\d{10})$/))) return new Date(Number(m[1]) * 1000);
    if ((m = s.match(/^in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:(?:ou)?rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/i))
        && (m[1] || m[2] || m[3])) {
        const ms = ((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 60_000;
        return new Date(Date.now() + ms);
    }
    return null;
}

export async function getNight(id) {
    const [[row]] = await pool.execute('SELECT * FROM steam_game_nights WHERE id = ?', [id]);
    return row || null;
}

export async function setRsvp(nightId, userId, status) {
    await pool.execute(
        `INSERT INTO steam_game_night_rsvps (night_id, discord_user_id, status) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status)`, [nightId, userId, status]);
}

export async function buildNightMessage(night) {
    const name = await appName(night.app_id);
    const owners = await gameOwners(night.guild_id, night.app_id);
    const [rsvps] = await pool.execute(
        'SELECT discord_user_id, status FROM steam_game_night_rsvps WHERE night_id = ? ORDER BY updated_at', [night.id]);
    const by = s => rsvps.filter(r => r.status === s).map(r => `<@${r.discord_user_id}>`);
    const list = (arr, empty = '—') => {
        if (!arr.length) return empty;
        let out = arr.join(' ');
        while (out.length > 1000) { arr = arr.slice(0, -1); out = `${arr.join(' ')} …`; }
        return out;
    };
    const answered = new Set(rsvps.map(r => r.discord_user_id));
    const undecided = owners.filter(id => !answered.has(id)).map(id => `<@${id}>`);

    let when = night.when_text ? night.when_text.replace(/[*_`~|]/g, '') : 'TBD';
    if (night.starts_at) {
        const t = Math.floor(new Date(night.starts_at).getTime() / 1000);
        when = `<t:${t}:F> (<t:${t}:R>)`;
    }

    const embed = new EmbedBuilder()
        .setColor(STEAM_COLOR)
        .setTitle(`🎮 Game night: ${name}`.slice(0, 256))
        .setURL(storeUrl(night.app_id))
        .setImage(headerImage(night.app_id))
        .setDescription([`**When:** ${when}`, `**Host:** <@${night.host_id}>`, night.note ? `\n${night.note}` : ''].join('\n'))
        .addFields(
            { name: `✅ In (${by('in').length})`, value: list(by('in')), inline: true },
            { name: `🤔 Maybe (${by('maybe').length})`, value: list(by('maybe')), inline: true },
            { name: `❌ Out (${by('out').length})`, value: list(by('out')), inline: true },
            { name: `Own it here, haven't answered (${undecided.length})`, value: list(undecided, owners.length ? 'Everyone who owns it has answered.' : 'Nobody here has it linked yet.') },
        )
        .setFooter({ text: `${owners.length} linked member${owners.length === 1 ? '' : 's'} own this · /steam link to be counted` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stlib_rsvp:${night.id}:in`).setLabel("I'm in").setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`stlib_rsvp:${night.id}:maybe`).setLabel('Maybe').setEmoji('🤔').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`stlib_rsvp:${night.id}:out`).setLabel("Can't").setEmoji('❌').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setLabel('Store page').setStyle(ButtonStyle.Link).setURL(storeUrl(night.app_id)),
    );
    return { embeds: [embed], components: [row] };
}

export async function createNight({ guildId, channel, hostId, appId, whenText, note, pingOwners }) {
    const startsAt = parseWhen(whenText);
    const [res] = await pool.execute(
        `INSERT INTO steam_game_nights (guild_id, channel_id, host_id, app_id, when_text, starts_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [guildId, channel.id, hostId, appId, whenText ? String(whenText).slice(0, 100) : null, startsAt, note ? String(note).slice(0, 300) : null]);
    await setRsvp(res.insertId, hostId, 'in');
    const night = await getNight(res.insertId);
    const payload = await buildNightMessage(night);
    if (pingOwners) {
        const owners = (await gameOwners(guildId, appId)).filter(id => id !== hostId).slice(0, 50);
        if (owners.length) {
            payload.content = owners.map(id => `<@${id}>`).join(' ');
            payload.allowedMentions = { users: owners };
        }
    }
    const msg = await channel.send(payload);
    await pool.execute('UPDATE steam_game_nights SET message_id = ? WHERE id = ?', [msg.id, night.id]);
    return { night, message: msg };
}

// ── Maintenance (jobs/steam-library-sync.js) ────────────────────────────────────────────────

/** Links due for a refresh: never synced, errored, or older than a day. Oldest first. */
export async function dueForSync(limit = 40) {
    const [rows] = await pool.query(
        `SELECT discord_user_id FROM steam_links
          WHERE synced_at IS NULL OR synced_at < NOW() - INTERVAL 20 HOUR
             OR (sync_status = 'error' AND synced_at < NOW() - INTERVAL 1 HOUR)
          ORDER BY synced_at IS NOT NULL, synced_at ASC
          LIMIT ${int(limit, 1, 500, 40)}`);
    return rows.map(r => r.discord_user_id);
}

/**
 * Hide members who left each server and purge the ones gone past the retention window.
 * Servers the bot can't currently see are skipped: a custom bot being offline for an hour
 * must not look like everyone left.
 */
export async function sweepDepartedMembers() {
    const [guildRows] = await pool.execute('SELECT DISTINCT guild_id FROM steam_library_members');
    const touched = [];
    for (const { guild_id: guildId } of guildRows) {
        const guild = clientFor(guildId)?.guilds.cache.get(guildId);
        if (!guild) continue;
        const [rows] = await pool.execute(
            'SELECT discord_user_id, left_at FROM steam_library_members WHERE guild_id = ?', [guildId]);
        const present = new Set();
        let complete = true;
        for (let i = 0; i < rows.length; i += 100) {
            const ids = rows.slice(i, i + 100).map(r => r.discord_user_id);
            try {
                const found = await guild.members.fetch({ user: ids, time: 20_000 });
                found.forEach((_, id) => present.add(id));
            } catch (err) {
                complete = false;
                logger.warn(`[SteamLibrary] member fetch failed in ${guildId}: ${err.message}`);
                break;
            }
        }
        if (!complete) continue;
        let changed = false;
        for (const r of rows) {
            const here = present.has(r.discord_user_id);
            if (!here && !r.left_at) {
                await pool.execute('UPDATE steam_library_members SET left_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND discord_user_id = ?', [guildId, r.discord_user_id]);
                changed = true;
            } else if (here && r.left_at) {
                await pool.execute('UPDATE steam_library_members SET left_at = NULL WHERE guild_id = ? AND discord_user_id = ?', [guildId, r.discord_user_id]);
                changed = true;
            }
        }
        if (changed) touched.push(guildId);
    }

    await pool.execute(
        `DELETE FROM steam_library_members WHERE left_at IS NOT NULL AND left_at < NOW() - INTERVAL ${DEPARTED_RETENTION_DAYS} DAY`);
    // A link shared with no server at all has no reason to exist.
    const [orphans] = await pool.execute(
        `SELECT l.discord_user_id FROM steam_links l
          WHERE NOT EXISTS (SELECT 1 FROM steam_library_members m WHERE m.discord_user_id = l.discord_user_id)`);
    await deleteUserData(orphans.map(o => o.discord_user_id));
    return { touched, purgedLinks: orphans.length };
}

/** One member's view, for the dashboard. Names come from the guild; never the SteamID. */
export async function guildMembersForDashboard(guildId) {
    const [rows] = await pool.execute(
        `SELECT m.discord_user_id, m.joined_at, l.verified, l.sync_status, l.game_count, l.synced_at
           FROM steam_library_members m JOIN steam_links l ON l.discord_user_id = m.discord_user_id
          WHERE ${ACTIVE} ORDER BY l.game_count DESC`, [guildId]);
    return rows;
}

/** appId → [userId] for the given games, active sharers only. For "who owns it" expanders. */
export async function ownersForGames(guildId, appIds) {
    const out = new Map();
    const ids = appIds.filter(Number.isInteger);
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const [rows] = await pool.query(
            `SELECT o.app_id, o.discord_user_id FROM steam_library_members m
               JOIN steam_owned_games o ON o.discord_user_id = m.discord_user_id
              WHERE ${ACTIVE} AND o.app_id IN (?)`, [guildId, chunk]);
        for (const r of rows) {
            if (!out.has(r.app_id)) out.set(r.app_id, []);
            out.get(r.app_id).push(r.discord_user_id);
        }
    }
    return out;
}
