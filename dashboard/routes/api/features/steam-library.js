/**
 * Steam Library API — `/api/guilds/:guildId/steam-library/*`
 *
 * Admin view of the server's "who owns what" tally: settings, the live board, the optional
 * public page, and who has linked. SteamIDs never leave the server — admins see Discord names,
 * verification state and game counts, which is all they need to help someone who is stuck.
 *
 * Gated by `apiCheckGuildAdmin` on the parent router; every query is scoped to the URL's guild.
 */
import express from 'express';
import logger from '../../../../utils/logger.js';
import {
    SteamLibraryError, getConfig, saveConfig, guildStats, topGames, countGames, gameOwners,
    guildMembersForDashboard, postPanel, refreshPanel, unshareFromGuild, newPublicToken, publicUrl, linkUrl,
} from '../../../../core/steam-library-manager.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const PAGE_SIZE = 50;

const bool = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || lo));

async function namesFor(guild, ids) {
    const names = new Map();
    if (!guild) return names;
    for (let i = 0; i < ids.length; i += 100) {
        const found = await guild.members.fetch({ user: ids.slice(i, i + 100) }).catch(() => null);
        found?.forEach(m => names.set(m.id, { name: m.displayName, avatar: m.displayAvatarURL({ size: 32 }) }));
    }
    return names;
}

function shapeConfig(cfg, guild) {
    const channel = cfg.panel_channel_id ? guild?.channels.cache.get(cfg.panel_channel_id) : null;
    return {
        boardSize: cfg.board_size,
        minOwners: cfg.min_owners,
        allowUnverified: !!cfg.allow_unverified,
        publicShowNames: !!cfg.public_show_names,
        publicUrl: cfg.public_token ? publicUrl(cfg.public_token) : null,
        linkUrl: linkUrl(cfg.guild_id),
        panel: cfg.panel_channel_id ? {
            channelId: cfg.panel_channel_id,
            channelName: channel?.name || null,
            messageId: cfg.panel_message_id,
            url: cfg.panel_message_id ? `https://discord.com/channels/${cfg.guild_id}/${cfg.panel_channel_id}/${cfg.panel_message_id}` : null,
        } : null,
        steamKeyConfigured: !!process.env.STEAM_API_KEY,
    };
}

router.get('/', async (req, res) => {
    try {
        const guild = req.botClient?.guilds.cache.get(req.params.guildId);
        const [cfg, stats] = await Promise.all([getConfig(req.params.guildId), guildStats(req.params.guildId)]);
        res.json({ success: true, config: shapeConfig(cfg, guild), stats });
    } catch (err) {
        logger.error('[SteamLibraryAPI] overview', { error: err.message });
        res.status(500).json({ success: false, error: 'Could not load the Steam library settings.' });
    }
});

router.get('/games', async (req, res) => {
    try {
        const page = clampInt(req.query.page, 1, 10000);
        const minOwners = clampInt(req.query.min, 1, 1000);
        const q = String(req.query.q || '').slice(0, 100);
        const [games, total] = await Promise.all([
            topGames(req.params.guildId, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, minOwners, q }),
            countGames(req.params.guildId, { minOwners, q }),
        ]);
        res.json({ success: true, games, total, page, pageSize: PAGE_SIZE });
    } catch (err) {
        logger.error('[SteamLibraryAPI] games', { error: err.message });
        res.status(500).json({ success: false, error: 'Could not load games.' });
    }
});

router.get('/games/:appId/owners', async (req, res) => {
    const appId = Number.parseInt(req.params.appId, 10);
    if (!Number.isInteger(appId) || appId <= 0) return res.status(400).json({ success: false, error: 'Bad app id.' });
    try {
        const guild = req.botClient?.guilds.cache.get(req.params.guildId);
        const ids = await gameOwners(req.params.guildId, appId);
        const names = await namesFor(guild, ids);
        const owners = ids.map(id => ({ id, name: names.get(id)?.name || null, avatar: names.get(id)?.avatar || null }))
            .sort((a, b) => (a.name || '~').localeCompare(b.name || '~'));
        res.json({ success: true, owners });
    } catch (err) {
        logger.error('[SteamLibraryAPI] owners', { error: err.message });
        res.status(500).json({ success: false, error: 'Could not load owners.' });
    }
});

router.get('/members', async (req, res) => {
    try {
        const guild = req.botClient?.guilds.cache.get(req.params.guildId);
        const rows = await guildMembersForDashboard(req.params.guildId);
        const names = await namesFor(guild, rows.map(r => r.discord_user_id));
        res.json({
            success: true,
            members: rows.map(r => ({
                id: r.discord_user_id,
                name: names.get(r.discord_user_id)?.name || null,
                avatar: names.get(r.discord_user_id)?.avatar || null,
                verified: !!r.verified,
                status: r.sync_status,
                games: r.game_count,
                syncedAt: r.synced_at,
                joinedAt: r.joined_at,
            })),
        });
    } catch (err) {
        logger.error('[SteamLibraryAPI] members', { error: err.message });
        res.status(500).json({ success: false, error: 'Could not load members.' });
    }
});

router.post('/config', async (req, res) => {
    try {
        const b = req.body || {};
        const patch = {};
        if (b.boardSize !== undefined) patch.board_size = clampInt(b.boardSize, 5, 30);
        if (b.minOwners !== undefined) patch.min_owners = clampInt(b.minOwners, 1, 50);
        if (b.allowUnverified !== undefined) patch.allow_unverified = bool(b.allowUnverified) ? 1 : 0;
        if (b.publicShowNames !== undefined) patch.public_show_names = bool(b.publicShowNames) ? 1 : 0;
        const cfg = await saveConfig(req.params.guildId, patch);
        refreshPanel(req.params.guildId, 1000);
        res.json({ success: true, config: shapeConfig(cfg, req.botClient?.guilds.cache.get(req.params.guildId)) });
    } catch (err) {
        logger.error('[SteamLibraryAPI] config', { error: err.message });
        res.status(500).json({ success: false, error: 'Could not save settings.' });
    }
});

router.post('/panel', async (req, res) => {
    const channelId = String(req.body?.channelId || req.body?.channel_id || '');
    if (!SNOWFLAKE.test(channelId)) return res.status(400).json({ success: false, error: 'Pick a channel first.' });
    try {
        const msg = await postPanel(req.params.guildId, channelId);
        const cfg = await getConfig(req.params.guildId);
        res.json({ success: true, url: msg.url, config: shapeConfig(cfg, req.botClient?.guilds.cache.get(req.params.guildId)) });
    } catch (err) {
        const known = err instanceof SteamLibraryError;
        if (!known) logger.error('[SteamLibraryAPI] panel', { error: err.message });
        const denied = err.code === 50013 || err.code === 50001;
        res.status(known || denied ? 400 : 500).json({
            success: false,
            error: known ? err.message : denied ? "The bot can't post in that channel (needs View Channel, Send Messages and Embed Links)." : 'Could not post the board.',
        });
    }
});

router.post('/panel/refresh', async (req, res) => {
    refreshPanel(req.params.guildId, 0);
    res.json({ success: true });
});

/** body.action: 'enable' (keep token if any), 'rotate' (new URL, old one dies), 'disable'. */
router.post('/public', async (req, res) => {
    try {
        const action = String(req.body?.action || '');
        const current = await getConfig(req.params.guildId);
        let token = current.public_token;
        if (action === 'enable') token = token || newPublicToken();
        else if (action === 'rotate') token = newPublicToken();
        else if (action === 'disable') token = null;
        else return res.status(400).json({ success: false, error: 'Unknown action.' });
        const cfg = await saveConfig(req.params.guildId, { public_token: token });
        refreshPanel(req.params.guildId, 1000); // the board's "Full list" button follows the token
        res.json({ success: true, config: shapeConfig(cfg, req.botClient?.guilds.cache.get(req.params.guildId)) });
    } catch (err) {
        logger.error('[SteamLibraryAPI] public', { error: err.message });
        res.status(500).json({ success: false, error: 'Could not change the public page.' });
    }
});

/** Take someone out of this server's tally (e.g. an alt, or someone who asked a mod). */
router.delete('/members/:userId', async (req, res) => {
    if (!SNOWFLAKE.test(req.params.userId)) return res.status(400).json({ success: false, error: 'Bad user id.' });
    try {
        await unshareFromGuild(req.params.guildId, req.params.userId);
        refreshPanel(req.params.guildId, 1000);
        logger.info(`[SteamLibraryAPI] ${req.user?.id} removed ${req.params.userId} from the tally in ${req.params.guildId}`);
        res.json({ success: true });
    } catch (err) {
        logger.error('[SteamLibraryAPI] remove member', { error: err.message });
        res.status(500).json({ success: false, error: 'Could not remove that member.' });
    }
});

export default router;
