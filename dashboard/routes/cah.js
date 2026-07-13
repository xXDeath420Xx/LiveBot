/**
 * CAH dashboard routes. Auth-gated via Discord OAuth — web players use the
 * same Discord user id as in-server players so cross-platform games work
 * without a separate identity space.
 *
 * Routes:
 *   GET  /cah                — lobby browser (public games)
 *   POST /cah/create         — create a new web-only public game
 *   GET  /cah/:gameId        — game room (renders cah-game.ejs; live state via Socket.io)
 *   POST /cah/:gameId/join   — join via HTTP (fallback for non-JS or first-join)
 *   GET  /cah/decks          — list all imported decks
 *   POST /cah/decks/import   — import a CAST deck by code
 */
import express from 'express';
import pool from '../../utils/db.js';
import { checkAuth, checkGuildAdmin, optionalAuth, authOrGuest } from '../middleware/auth.js';
import { randomBytes } from 'crypto';
import {
    createGame, getGame, listPublicLobbies, listActiveGames, DEFAULT_SETTINGS,
    getGuildConfig, updateGuildConfig, adminForceEndGame, getGameAdminSnapshot
} from '../../core/cah-manager.js';
import {
    importCastDeck, bulkImportCastDecks, listDecks,
    startDiscoveryAndImport, getDiscoveryStatus,
    importManyDecksDeck, startManyDecksDiscovery
} from '../../core/cah-deck-importer.js';
import {
    createDeck, updateDeckMeta, deleteDeck, addWhiteCard, addBlackCard,
    deleteWhiteCard, deleteBlackCard, listMyDecks, getDeck, findByShareCode
} from '../../core/cah-deck-authoring.js';
import { buildCertiFriedMegaPack, seed420PackIfMissing } from '../../core/cah-certifried-builder.js';
import { isSuperAdmin } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const router = express.Router();

router.get('/cah', optionalAuth, async (req, res) => {
    const lobbies = await listPublicLobbies();
    // Anonymous users: pass null for forUserId — they see public packs only,
    // never anybody's private custom decks. The "Host a Game" UI itself
    // checks for user and shows a "Sign in to play" CTA instead.
    const decks = await listDecks({ limit: 10000, forUserId: req.user?.id || null, onlyWithCards: true });
    res.render('cah-lobby', { user: req.user, lobbies, decks });
});

// Guest identity setup — pick a username, get a session-scoped guest ID.
// No Discord required. Lives until cookie expiry (~30 days).
router.post('/cah/guest/identity', optionalAuth, (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
        return res.json({ ok: true, identity: { id: req.user.id, displayName: req.user.username, kind: 'discord' }, alreadyAuthed: true });
    }
    const raw = String(req.body.username || '').trim();
    if (raw.length < 2 || raw.length > 24) return res.status(400).json({ ok: false, reason: 'username_length', message: 'Pick a name between 2 and 24 characters.' });
    if (!/^[\w\-. ]+$/i.test(raw)) return res.status(400).json({ ok: false, reason: 'username_chars', message: 'Letters, numbers, spaces, dashes, dots, underscores only.' });
    // Reuse existing guest id if they already had one this session — name change just updates displayName
    let id = req.session?.cahGuest?.id;
    if (!id) id = 'guest:' + randomBytes(9).toString('base64url');
    req.session.cahGuest = { id, displayName: raw };
    req.session.save?.(err => {
        if (err) return res.status(500).json({ ok: false, reason: 'session_save_failed' });
        res.json({ ok: true, identity: { id, displayName: raw, kind: 'guest' } });
    });
});

router.get('/cah/guest/identity', optionalAuth, (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
        return res.json({ ok: true, identity: { id: req.user.id, displayName: req.user.username, kind: 'discord' } });
    }
    const guest = req.session?.cahGuest;
    if (guest?.id) return res.json({ ok: true, identity: { id: guest.id, displayName: guest.displayName, kind: 'guest' } });
    return res.json({ ok: true, identity: null });
});

router.post('/cah/create', authOrGuest, async (req, res) => {
    const visibility = ['private', 'guild_only', 'public'].includes(req.body.visibility) ? req.body.visibility : 'public';
    // Guests can only host public/private games — guild_only requires a Discord identity
    if (req.identity.kind === 'guest' && visibility === 'guild_only') {
        return res.status(403).json({ ok: false, reason: 'guests_cant_host_guild_games' });
    }
    const settings = {
        ...DEFAULT_SETTINGS,
        pointsToWin: parseInt(req.body.points, 10) || DEFAULT_SETTINGS.pointsToWin,
        maxRounds: parseInt(req.body.maxRounds, 10) || DEFAULT_SETTINGS.maxRounds,
        czarRotation: req.body.czarRotation || DEFAULT_SETTINGS.czarRotation,
        timeoutEnabled: req.body.timeoutEnabled !== 'false',
        timeoutSeconds: parseInt(req.body.timeoutSeconds, 10) || DEFAULT_SETTINGS.timeoutSeconds,
        timeoutPolicy: req.body.timeoutPolicy || DEFAULT_SETTINGS.timeoutPolicy,
        blankCardCount: parseInt(req.body.blankCardCount, 10) || 0,
        visibility,
        nsfw: req.body.nsfw === 'true',
        randoCount: parseInt(req.body.randoCount, 10) || 0,
        joinPassword: req.body.joinPassword ? String(req.body.joinPassword).slice(0, 64) : null,
        deckIds: (req.body.deckIds || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0)
    };
    if (settings.deckIds.length === 0) {
        const builtin = await listDecks({ source: 'builtin', limit: 1 });
        if (builtin.length > 0) settings.deckIds = [builtin[0].id];
    }

    // Guild-tied games: validate guildId belongs to user + bot has access + optional channelId
    let guildId = null, channelId = null;
    if (visibility === 'guild_only') {
        guildId = String(req.body.guildId || '').trim();
        channelId = req.body.channelId ? String(req.body.channelId).trim() : null;
        if (!guildId) return res.status(400).json({ ok: false, reason: 'guild_required_for_guild_only' });
        const userInGuild = req.user.guilds?.some(g => g.id === guildId);
        if (!userInGuild) return res.status(403).json({ ok: false, reason: 'not_in_guild' });
        const client = global.botManager?.getClientForGuild(guildId);
        if (!client || !client.guilds.cache.has(guildId)) {
            return res.status(400).json({ ok: false, reason: 'bot_not_in_guild' });
        }
        if (channelId) {
            const ch = client.channels.cache.get(channelId);
            if (!ch || ch.guildId !== guildId || !ch.isTextBased()) {
                return res.status(400).json({ ok: false, reason: 'invalid_channel' });
            }
        }
    }

    const r = await createGame({ guildId, channelId, hostUserId: req.identity.id, settings });
    if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason, nsfwDeckNames: r.nsfwDeckNames });
    r.game.addPlayer({ userId: req.identity.id, platform: 'web', displayName: req.identity.displayName });

    // For guild-tied games, attach the Discord adapter and post the lobby embed
    // into the chosen channel. The web user effectively starts a game in
    // someone else's Discord server, just like /cah start would.
    if (guildId && channelId) {
        try {
            const client = global.botManager.getClientForGuild(guildId);
            const ch = await client.channels.fetch(channelId).catch(() => null);
            if (ch) {
                const { attachDiscordAdapter } = await import('../../core/cah-discord-adapter.js');
                const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
                const embed = new EmbedBuilder()
                    .setColor(0xa78bfa)
                    .setTitle('🃏 CAH Lobby — Started from Web')
                    .setDescription(`**Host:** <@${req.identity.id}>\n[Open on certifriedmultitool.com](https://certifriedmultitool.com/cah/${r.game.id})\n\nClick **Join** to play, host clicks **Start** when ready.`)
                    .addFields(
                        { name: 'Win at', value: `${settings.pointsToWin} pts / ${settings.maxRounds} rounds`, inline: true },
                        { name: 'Czar', value: settings.czarRotation, inline: true },
                        { name: 'Blanks', value: String(settings.blankCardCount), inline: true }
                    );
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`cah_join:${r.game.id}`).setLabel('Join').setStyle(ButtonStyle.Success).setEmoji('🎴'),
                    new ButtonBuilder().setCustomId(`cah_leave:${r.game.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`cah_startgame:${r.game.id}`).setLabel('Start').setStyle(ButtonStyle.Primary).setEmoji('▶️')
                );
                const msg = await ch.send({ embeds: [embed], components: [row] });
                r.game._mainMessageId = msg.id;
                attachDiscordAdapter(r.game, client);
            }
        } catch (err) {
            // Don't fail the game creation if the Discord post errors — game still works on web
            logger.warn(`[cah] dashboard→discord post failed: ${err.message}`);
        }
    }
    return res.json({ ok: true, gameId: r.game.id });
});

// Per-user, in-memory cache of the fresh Discord guild list. Discord rate-limits
// /users/@me/guilds aggressively; caching for 60s per user prevents spam while
// still being fresh enough that "I just joined a server" works after one refresh.
const freshGuildCache = new Map();   // userId -> { guilds: [], ts: number }
const FRESH_GUILD_TTL = 60 * 1000;

async function fetchFreshGuildList(req) {
    const token = req.user?.accessToken;
    if (!token) return null;
    const cached = freshGuildCache.get(req.user.id);
    if (cached && Date.now() - cached.ts < FRESH_GUILD_TTL) return cached.guilds;
    try {
        const res = await fetch('https://discord.com/api/v10/users/@me/guilds', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return null;
        const guilds = await res.json();
        freshGuildCache.set(req.user.id, { guilds, ts: Date.now() });
        // Also update the session so other routes benefit
        req.user.guilds = guilds;
        if (req.session?.passport?.user) req.session.passport.user.guilds = guilds;
        req.session?.save?.(() => {});
        return guilds;
    } catch (err) {
        logger.warn(`[cah/my-guilds] fresh fetch failed for ${req.user.id}: ${err.message}`);
        return null;
    }
}

// List the user's mutual guilds that one of our bots is in (so they can host a
// Discord-tied lobby). Pulls FRESH from Discord (with 60s per-user cache) so a
// server the user joined after their last dashboard login still shows up. Falls
// back to session-cached list if the Discord API is unreachable.
router.get('/cah/my-guilds', checkAuth, async (req, res) => {
    if (!global.botManager) return res.json({ ok: true, guilds: [], totalGuilds: 0 });
    const fresh = await fetchFreshGuildList(req);
    const sourceGuilds = fresh || req.user.guilds || [];
    const out = [];
    const skippedNoBot = [];
    for (const g of sourceGuilds) {
        const client = global.botManager.getClientForGuild(g.id);
        if (client && client.isReady() && client.guilds.cache.has(g.id)) {
            const guild = client.guilds.cache.get(g.id);
            out.push({ id: g.id, name: guild.name, iconHash: g.icon || null });
        } else {
            skippedNoBot.push(g.id);
        }
    }
    res.json({
        ok: true,
        guilds: out,
        totalGuilds: sourceGuilds.length,
        guildsWithoutBot: skippedNoBot.length,
        wasFresh: !!fresh
    });
});

// Diagnostic — shows every guild from the user's OAuth list with status info
// so we can pinpoint why a specific expected server is missing from the picker.
// Bot-perspective: lists every guild every bot client has cached + which client.
router.get('/cah/my-guilds/debug', checkAuth, async (req, res) => {
    const fresh = await fetchFreshGuildList(req);
    const sourceGuilds = fresh || req.user.guilds || [];
    const mgr = global.botManager;
    const clients = mgr ? Array.from(mgr.clients?.entries?.() || []) : [];

    // 1. Bot health: every client and its guild count
    const botHealth = clients.map(([botId, c]) => ({
        botId,
        ready: !!c.isReady?.(),
        username: c.user?.username || null,
        guildCount: c.isReady?.() ? c.guilds.cache.size : 0
    }));

    // 2. Reverse index: every guild any bot is in → which bot(s)
    const guildToBots = new Map();
    for (const [botId, c] of clients) {
        if (!c.isReady?.()) continue;
        for (const [gid, g] of c.guilds.cache) {
            if (!guildToBots.has(gid)) guildToBots.set(gid, { name: g.name, bots: [] });
            guildToBots.get(gid).bots.push(botId);
        }
    }

    // 3. Per-OAuth-guild: status + which bot sees it
    const perms = (raw) => {
        const p = BigInt(raw || 0);
        const ADMIN = 0x8n, MANAGE_GUILD = 0x20n;
        return { admin: (p & ADMIN) === ADMIN, manageGuild: (p & MANAGE_GUILD) === MANAGE_GUILD };
    };
    const userPerspective = sourceGuilds.map(g => {
        const match = guildToBots.get(g.id);
        const p = perms(g.permissions);
        return {
            id: g.id, name: g.name,
            owner: !!g.owner, admin: p.admin, manageGuild: p.manageGuild,
            hasBot: !!match,
            botIds: match?.bots || []
        };
    });

    // 4. Anomalies: guilds where our bot IS but you're NOT according to OAuth
    //    (means OAuth list is incomplete — usually the 200 cap or stale token)
    const oauthIds = new Set(sourceGuilds.map(g => g.id));
    const botGuildsYouDontSee = [];
    for (const [gid, info] of guildToBots) {
        if (!oauthIds.has(gid)) botGuildsYouDontSee.push({ id: gid, name: info.name, botIds: info.bots });
    }

    res.json({
        ok: true,
        wasFresh: !!fresh,
        oauthGuildCount: sourceGuilds.length,
        botClientCount: clients.length,
        botHealth,
        mutualCount: userPerspective.filter(g => g.hasBot).length,
        adminSurfacedButNoBot: userPerspective.filter(g => (g.admin || g.owner || g.manageGuild) && !g.hasBot).length,
        userPerspective,
        botGuildsYouDontSee   // bot sees them, your OAuth list doesn't
    });
});

router.get('/cah/guild-channels/:guildId', checkAuth, (req, res) => {
    const guildId = req.params.guildId;
    if (!req.user.guilds?.some(g => g.id === guildId)) return res.status(403).json({ ok: false, reason: 'not_in_guild' });
    const client = global.botManager?.getClientForGuild(guildId);
    if (!client || !client.guilds.cache.has(guildId)) return res.status(400).json({ ok: false, reason: 'bot_not_in_guild' });
    const guild = client.guilds.cache.get(guildId);
    const me = guild.members.me;
    const channels = guild.channels.cache
        .filter(ch => ch.isTextBased() && ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']))
        .map(ch => ({ id: ch.id, name: ch.name, type: ch.type, parentName: ch.parent?.name || null }))
        .sort((a, b) => (a.parentName || '').localeCompare(b.parentName || '') || a.name.localeCompare(b.name));
    res.json({ ok: true, channels });
});

// UUID-shaped param so /cah/leaderboard, /cah/my-decks, etc. don't get
// captured as a "game id" by this catch-all. UUIDs are 8-4-4-4-12 lowercase hex.
const GAME_ID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

router.get(`/cah/:gameId(${GAME_ID_RE})`, optionalAuth, async (req, res) => {
    const game = getGame(req.params.gameId);
    if (!game) return res.status(404).render('error', { error: 'Game not found or already ended.' });
    // Anonymous viewers get the page as a spectator snapshot. Socket.io will
    // accept their connection but they can't act (cah:joinPlayer rejects on
    // missing userId). Game view shows a "Sign in to play" banner.
    res.render('cah-game', { user: req.user, game: game.serialize() });
});

router.post(`/cah/:gameId(${GAME_ID_RE})/join`, authOrGuest, async (req, res) => {
    const game = getGame(req.params.gameId);
    if (!game) return res.status(404).json({ ok: false, reason: 'no_such_game' });
    const r = game.addPlayer({
        userId: req.identity.id,
        platform: 'web',
        displayName: req.identity.displayName.slice(0, 64),
        password: req.body.password
    });
    return res.json(r);
});

// Your last N games (private — only you see)
router.get('/cah/my-history', checkAuth, async (req, res) => {
    const [rows] = await pool.execute(
        `SELECT g.id, g.guild_id, g.ended_at, g.state, g.winner_user_ids,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('userId', user_id, 'displayName', display_name, 'points', points))
                 FROM cah_game_players WHERE game_id = g.id) AS players_json
         FROM cah_games g
         WHERE g.host_user_id = ?
            OR EXISTS(SELECT 1 FROM cah_game_players p WHERE p.game_id = g.id AND p.user_id = ?)
         ORDER BY COALESCE(g.ended_at, g.updated_at) DESC
         LIMIT 20`,
        [req.user.id, req.user.id]
    );
    const games = rows.map(r => {
        const winners = typeof r.winner_user_ids === 'string' ? JSON.parse(r.winner_user_ids) : r.winner_user_ids;
        const players = typeof r.players_json === 'string' ? JSON.parse(r.players_json) : (r.players_json || []);
        const me = (players || []).find(p => p.userId === req.user.id);
        return {
            id: r.id, guildId: r.guild_id, endedAt: r.ended_at, state: r.state,
            winnerUserIds: winners, players, myPoints: me?.points || 0,
            iWon: winners?.includes(req.user.id) || false
        };
    });
    res.render('cah-my-history', { user: req.user, games });
});

// Bug-report relay: POST { text, page, ua } → forwarded to Discord webhook from env.
// If no webhook is configured, log to file via the normal logger and return success.
router.post('/cah/feedback', checkAuth, async (req, res) => {
    const text = String(req.body.text || '').slice(0, 2000).trim();
    const page = String(req.body.page || '').slice(0, 200);
    const ua = String(req.body.ua || '').slice(0, 300);
    if (!text) return res.status(400).json({ ok: false, reason: 'empty' });
    logger.info(`[cah-feedback] from ${req.user.username} (${req.user.id}) on ${page}: ${text.slice(0, 200)}`);
    const webhook = process.env.CAH_FEEDBACK_WEBHOOK;
    if (webhook) {
        try {
            await fetch(webhook, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: '💬 CAH Feedback',
                        description: text,
                        color: 0xa78bfa,
                        fields: [
                            { name: 'From', value: `${req.user.username} (${req.user.id})`, inline: true },
                            { name: 'Page', value: page || '—', inline: true }
                        ],
                        footer: { text: ua.slice(0, 200) },
                        timestamp: new Date().toISOString()
                    }]
                }),
                signal: AbortSignal.timeout(5000)
            });
        } catch (err) {
            logger.warn(`[cah-feedback] webhook post failed: ${err.message}`);
        }
    }
    return res.json({ ok: true });
});

// Admin observability dashboard (super-admin only)
router.get('/admin/cah', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user.id)) return res.status(403).render('error', { error: 'Admin only.' });
    const [active] = await pool.execute(`SELECT id, state, host_user_id, guild_id, created_at, updated_at FROM cah_games WHERE state NOT IN ('GAME_END','ABANDONED') ORDER BY created_at DESC LIMIT 25`);
    const [recent] = await pool.execute(`SELECT id, state, ended_at, guild_id, winner_user_ids FROM cah_games WHERE state IN ('GAME_END','ABANDONED') ORDER BY ended_at DESC LIMIT 25`);
    const [deployState] = await pool.execute(`SELECT bot_id, guild_id, deployed_at, blocked_until, last_block_reason FROM command_deploy_hashes ORDER BY deployed_at DESC LIMIT 50`);
    const [[deckCount]] = await pool.execute(`SELECT COUNT(*) AS n FROM cah_decks WHERE language = 'en'`);
    const [[allDeckCount]] = await pool.execute(`SELECT COUNT(*) AS n FROM cah_decks`);
    res.render('cah-admin', { user: req.user, active, recent, deployState, deckCount, allDeckCount });
});

// JSON feed of live in-memory games for the admin panel's auto-refresh.
// Joins what's actually in the engine (with players/state/timers) against
// the DB so ghost rows (in DB but not in memory) are still visible — those
// are the "stuck" games an admin needs to nuke.
router.get('/admin/cah/active.json', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user.id)) return res.status(403).json({ ok: false, reason: 'admin_only' });
    const [rows] = await pool.execute(
        `SELECT id, state, host_user_id, guild_id, channel_id, created_at, updated_at
         FROM cah_games
         WHERE state NOT IN ('GAME_END','ABANDONED')
         ORDER BY updated_at DESC LIMIT 100`
    );
    const livenessById = new Map();
    for (const g of listActiveGames()) livenessById.set(g.id, getGameAdminSnapshot(g.id));
    const games = rows.map(r => {
        const snap = livenessById.get(r.id);
        return {
            id: r.id,
            dbState: r.state,
            hostUserId: r.host_user_id,
            guildId: r.guild_id,
            channelId: r.channel_id,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            inMemory: !!snap,
            live: snap || null,
            // A game is "stuck" if the DB says it's active but it's NOT in
            // memory (no listeners, no timer) — usually means a crash during
            // rehydrate or PM2 died mid-transition.
            stuck: !snap
        };
    });
    res.json({ ok: true, count: games.length, games });
});

// Admin action: force-end a game. Works on both live (in-memory) and ghost
// (DB-only) games. Used to clear out stuck lobbies / abandoned rounds.
router.post('/admin/cah/:gameId/force-end', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user.id)) return res.status(403).json({ ok: false, reason: 'admin_only' });
    const reason = String(req.body.reason || 'admin_force_end').slice(0, 64);
    try {
        const r = await adminForceEndGame(req.params.gameId, reason);
        logger.info(`[cah-admin] ${req.user.username} (${req.user.id}) force-ended ${req.params.gameId} via ${r.mode}`);
        res.json(r);
    } catch (err) {
        logger.error(`[cah-admin] force-end ${req.params.gameId} failed: ${err.message}`);
        res.status(500).json({ ok: false, reason: 'force_end_failed', error: err.message });
    }
});

// Build leaderboard "ranked" array + a "recent" array enriched with winner
// names. Shared by the global + guild-scoped leaderboard routes so the data
// shape stays in sync between them.
//
// Source of truth for player names is `state_json.players[]` (the engine
// persists every player's displayName there on each state transition and
// submission). The older subquery against `cah_game_players` is still kept as
// a secondary source for historical rows that pre-date state_json — but the
// table is unused in current code, so state_json is what actually has data.
function buildLeaderboardFromRows(rows) {
    const stats = new Map();
    const recent = [];
    for (const row of rows) {
        const winnerIds = typeof row.winner_user_ids === 'string' ? JSON.parse(row.winner_user_ids || 'null') : row.winner_user_ids;
        const tablePlayers = typeof row.players_json === 'string' ? JSON.parse(row.players_json || 'null') : row.players_json;
        const stateJson = typeof row.state_json === 'string' ? JSON.parse(row.state_json || 'null') : row.state_json;
        // Prefer state_json (current source of truth) over the cah_game_players
        // snapshot. Merge by userId so we don't lose entries either source has.
        const byId = new Map();
        for (const p of (tablePlayers || [])) byId.set(p.userId, { userId: p.userId, displayName: p.displayName, points: p.points || 0 });
        for (const p of (stateJson?.players || [])) {
            const existing = byId.get(p.userId);
            byId.set(p.userId, {
                userId: p.userId,
                displayName: p.displayName || existing?.displayName,
                points: typeof p.points === 'number' ? p.points : (existing?.points || 0)
            });
        }
        const playerList = Array.from(byId.values());

        const winnersResolved = (winnerIds || []).map(uid => {
            if (String(uid).startsWith('rando:')) return { userId: uid, displayName: 'Rando Cardrissian' };
            const match = playerList.find(p => p.userId === uid);
            return { userId: uid, displayName: match?.displayName || `Player ${String(uid).slice(-4)}` };
        });
        recent.push({
            id: row.id,
            endedAt: row.ended_at,
            guildId: row.guild_id,
            winners: winnersResolved
        });
        for (const p of playerList) {
            const s = stats.get(p.userId) || { userId: p.userId, displayName: p.displayName, wins: 0, games: 0, totalPoints: 0 };
            s.games += 1;
            s.totalPoints += p.points || 0;
            if (winnerIds?.includes(p.userId)) s.wins += 1;
            s.displayName = p.displayName || s.displayName;
            stats.set(p.userId, s);
        }
    }
    const ranked = Array.from(stats.values())
        .filter(s => !String(s.userId).startsWith('rando:'))
        .sort((a, b) => b.wins - a.wins || b.totalPoints - a.totalPoints)
        .slice(0, 100);
    return { ranked, recent: recent.slice(0, 20) };
}

router.get('/cah/leaderboard/:guildId([0-9]{17,20})', optionalAuth, async (req, res) => {
    const guildId = req.params.guildId;
    const [rows] = await pool.execute(
        `SELECT g.id, g.winner_user_ids, g.ended_at, g.guild_id, g.state_json,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('userId', user_id, 'displayName', display_name, 'points', points))
                 FROM cah_game_players WHERE game_id = g.id) AS players_json
         FROM cah_games g
         WHERE g.state = 'GAME_END' AND g.winner_user_ids IS NOT NULL AND g.guild_id = ?
         ORDER BY g.ended_at DESC LIMIT 500`,
        [guildId]
    );
    const { ranked, recent } = buildLeaderboardFromRows(rows);
    res.render('cah-leaderboard', { user: req.user, ranked, recent, guildScope: guildId });
});

router.get('/cah/leaderboard', optionalAuth, async (req, res) => {
    // Wins = appearances in winner_user_ids JSON across completed games.
    // We can't use JSON_TABLE on older MySQL, so we pull rows and aggregate in JS.
    const [rows] = await pool.execute(
        `SELECT g.id, g.winner_user_ids, g.ended_at, g.guild_id, g.state_json,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('userId', user_id, 'displayName', display_name, 'points', points))
                 FROM cah_game_players WHERE game_id = g.id) AS players_json
         FROM cah_games g
         WHERE g.state = 'GAME_END' AND g.winner_user_ids IS NOT NULL
         ORDER BY g.ended_at DESC
         LIMIT 500`
    );
    const { ranked, recent } = buildLeaderboardFromRows(rows);
    res.render('cah-leaderboard', { user: req.user, ranked, recent });
});

router.get('/cah/packs', optionalAuth, async (req, res) => {
    const search = String(req.query.q || '').trim().toLowerCase();
    const sort = ['name', 'size', 'recent'].includes(req.query.sort) ? req.query.sort : 'recent';
    const includeNsfw = req.query.nsfw === '1';
    const includeNonEn = req.query.lang === 'all';

    const all = await listDecks({
        limit: 10000, forUserId: req.user?.id || null, onlyWithCards: true,
        language: includeNonEn ? 'all' : 'en'
    });
    let packs = all.filter(d =>
        (!search || d.name?.toLowerCase().includes(search) || d.cast_id?.toLowerCase().includes(search))
        && (includeNsfw || !d.nsfw)
        // Hide the Mega Pack from browse — it's a meta-aggregate, not a discovery target
        && !/Mega Pack/i.test(d.name || '')
    );
    if (sort === 'name') packs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sort === 'size') packs.sort((a, b) => (b.white_count + b.black_count) - (a.white_count + a.black_count));
    // 'recent' is already the default order from listDecks
    res.render('cah-packs', {
        user: req.user, packs: packs.slice(0, 200), total: packs.length,
        search, sort, includeNsfw, includeNonEn
    });
});

router.get('/cah/packs/:deckId([0-9]+)/preview', optionalAuth, async (req, res) => {
    const deckId = parseInt(req.params.deckId, 10);
    const [whites] = await pool.execute(`SELECT text FROM cah_white_cards WHERE deck_id = ? LIMIT 5`, [deckId]);
    const [blacks] = await pool.execute(`SELECT text, pick FROM cah_black_cards WHERE deck_id = ? LIMIT 3`, [deckId]);
    res.json({ ok: true, sampleWhite: whites.map(r => r.text), sampleBlack: blacks });
});

router.get('/cah/decks', checkAuth, async (req, res) => {
    const decks = await listDecks({ limit: 200 });
    res.json({ ok: true, decks });
});

router.get('/manage/:guildId/cah-config', checkAuth, checkGuildAdmin, async (req, res) => {
    const cfg = await getGuildConfig(req.params.guildId);
    res.render('cah-guild-config', { user: req.user, guildId: req.params.guildId, cfg });
});

router.post('/manage/:guildId/cah-config', checkAuth, checkGuildAdmin, async (req, res) => {
    const patch = {};
    const map = {
        nsfw_allowed: v => v === 'true' || v === true ? 1 : 0,
        blank_cards_allowed: v => v === 'true' || v === true ? 1 : 0,
        allow_public_imports: v => v === 'true' || v === true ? 1 : 0,
        max_blank_cards: v => parseInt(v, 10),
        default_points: v => parseInt(v, 10),
        default_max_rounds: v => parseInt(v, 10),
        default_timeout_secs: v => parseInt(v, 10)
    };
    for (const [k, parse] of Object.entries(map)) {
        if (req.body[k] !== undefined) patch[k] = parse(req.body[k]);
    }
    const r = await updateGuildConfig(req.params.guildId, patch);
    return res.json(r);
});

router.post('/cah/decks/import', checkAuth, async (req, res) => {
    const code = String(req.body.code || '').trim();
    const nsfw = req.body.nsfw === true || req.body.nsfw === 'true';
    if (!code) return res.status(400).json({ ok: false, reason: 'missing_code' });
    const r = await importCastDeck(code, { importedBy: req.user.id, markNsfw: nsfw });
    return res.json(r);
});

router.post('/cah/decks/discover_all', checkAuth, async (req, res) => {
    const source = req.body.source === 'manydecks' ? 'manydecks' : 'cast';
    let r;
    if (source === 'manydecks') {
        r = startManyDecksDiscovery({
            importedBy: req.user.id,
            language: req.body.language || null
        });
    } else {
        r = startDiscoveryAndImport({
            importedBy: req.user.id,
            sort: req.body.sort || 'popular',
            sfw: req.body.sfw === true || req.body.sfw === 'true' ? false : (req.body.sfw === 'false' ? true : null)
        });
    }
    return res.json(r);
});

// ─── User-authored decks (Many Decks-style CRUD) ──────────────────────────

router.get('/cah/my-decks', checkAuth, async (req, res) => {
    const decks = await listMyDecks(req.user.id);
    res.render('cah-my-decks', { user: req.user, decks });
});

router.post('/cah/my-decks/create', checkAuth, async (req, res) => {
    const r = await createDeck({
        ownerUserId: req.user.id,
        name: req.body.name,
        description: req.body.description,
        isPublic: req.body.isPublic === true || req.body.isPublic === 'true',
        nsfw: req.body.nsfw === true || req.body.nsfw === 'true'
    });
    res.json(r);
});

router.get('/cah/my-decks/:deckId/edit', checkAuth, async (req, res) => {
    const id = parseInt(req.params.deckId, 10);
    const deck = await getDeck(id, req.user.id);
    if (!deck || deck.owner_user_id !== req.user.id) {
        return res.status(404).render('error', { error: 'Deck not found or you don\'t own it.' });
    }
    res.render('cah-deck-edit', { user: req.user, deck });
});

router.post('/cah/my-decks/:deckId/update', checkAuth, async (req, res) => {
    const r = await updateDeckMeta(parseInt(req.params.deckId, 10), req.user.id, {
        name: req.body.name,
        description: req.body.description,
        isPublic: req.body.isPublic,
        nsfw: req.body.nsfw
    });
    res.json(r);
});

router.delete('/cah/my-decks/:deckId', checkAuth, async (req, res) => {
    const r = await deleteDeck(parseInt(req.params.deckId, 10), req.user.id);
    res.json(r);
});

router.post('/cah/my-decks/:deckId/white', checkAuth, async (req, res) => {
    const r = await addWhiteCard(parseInt(req.params.deckId, 10), req.user.id, req.body.text);
    res.json(r);
});

router.delete('/cah/my-decks/:deckId/white/:cardId', checkAuth, async (req, res) => {
    const r = await deleteWhiteCard(parseInt(req.params.deckId, 10), req.user.id, parseInt(req.params.cardId, 10));
    res.json(r);
});

router.post('/cah/my-decks/:deckId/black', checkAuth, async (req, res) => {
    const r = await addBlackCard(parseInt(req.params.deckId, 10), req.user.id, req.body.text);
    res.json(r);
});

router.delete('/cah/my-decks/:deckId/black/:cardId', checkAuth, async (req, res) => {
    const r = await deleteBlackCard(parseInt(req.params.deckId, 10), req.user.id, parseInt(req.params.cardId, 10));
    res.json(r);
});

// Add a deck to your visible-decks list via its share code (for private decks
// the owner shared with you).
router.get('/cah/decks/by-code/:code', checkAuth, async (req, res) => {
    const deck = await findByShareCode(req.params.code);
    if (!deck) return res.status(404).json({ ok: false, reason: 'not_found' });
    res.json({ ok: true, deck });
});

// Admin: rebuild the CertiFried Mega Pack (also seeds the 420 pack if missing)
router.post('/cah/decks/rebuild_mega', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user.id)) return res.status(403).json({ ok: false, reason: 'admin_only' });
    const r = await buildCertiFriedMegaPack();
    res.json(r);
});

router.post('/cah/decks/seed_420', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user.id)) return res.status(403).json({ ok: false, reason: 'admin_only' });
    const force = req.body.force === true || req.body.force === 'true';
    const r = await seed420PackIfMissing({ force });
    res.json(r);
});

router.post('/cah/decks/import_manydecks', checkAuth, async (req, res) => {
    const code = String(req.body.code || '').trim();
    const nsfw = req.body.nsfw === true || req.body.nsfw === 'true';
    if (!code) return res.status(400).json({ ok: false, reason: 'missing_code' });
    const r = await importManyDecksDeck(code, { importedBy: req.user.id, markNsfw: nsfw });
    return res.json(r);
});

router.get('/cah/decks/discover_status', checkAuth, (req, res) => {
    return res.json({ ok: true, status: getDiscoveryStatus() });
});

router.post('/cah/decks/bulk_import', checkAuth, async (req, res) => {
    const raw = String(req.body.codes || '').trim();
    if (!raw) return res.status(400).json({ ok: false, reason: 'missing_codes' });
    const codes = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (codes.length === 0) return res.status(400).json({ ok: false, reason: 'no_valid_codes' });
    if (codes.length > 50) return res.status(400).json({ ok: false, reason: 'too_many_codes', limit: 50 });
    const r = await bulkImportCastDecks(codes, { importedBy: req.user.id });
    return res.json({ ok: true, ...r });
});

export default router;
