/**
 * /kick — Kick Defender dashboard.
 *
 * A separate product surface from /tokes-bot but reusing the same Kick login
 * (req.session.tokesUser + requireTokesAuth). Streamers enroll their channel,
 * Managers curate the shared banlist, Admins manage Managers.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireTokesAuth, requireKickAuth } from './auth-tokes-bot.js';
import * as banlist from '../../services/certifried-bot/defender/banlist.js';
import * as managers from '../../services/certifried-bot/defender/managers.js';
import { channelStats, listEvents, listAllEvents, networkStats } from '../../services/certifried-bot/defender/enforcement-log.js';
import { size as phishingSize, isDomainBlocked } from '../../services/certifried-bot/defender/phishing-domains.js';
import { resolveOwnedChannel } from '../../services/certifried-bot/defender/owned-channel.js';

const router = express.Router();

// Bot-owner platform ids (same source as tokes-admin / defender commands).
const OWNER_PLATFORM_IDS = new Set(
    [process.env.TOKES_OWNER_ID, process.env.TOKES_KICK_OWNER_ID].filter(Boolean).map(String)
);

function isAdminUser(req) {
    const u = req.session?.tokesUser;
    return !!u && OWNER_PLATFORM_IDS.has(String(u.platformId));
}

async function isManagerUser(req) {
    const u = req.session?.tokesUser;
    if (!u) return false;
    return isAdminUser(req) || await managers.isManager(u.id);
}

// True if `userId` owns the given Kick channel. Centralizes the owner check
// used by the enforcement-log and channel-settings routes.
async function ownsChannel(userId, channelId) {
    return !!(await resolveOwnedChannel(userId, channelId));
}

// ── Streamer panel ────────────────────────────────────────────────────────
router.get('/kick', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const [channels] = await pool.execute(
            `SELECT c.channel_id, c.channel_name, c.defender_enabled, pc.scopes
             FROM tokes_channels c
             JOIN tokes_platform_connections pc ON c.connection_id = pc.id
             WHERE c.platform = 'kick' AND c.owner_id = ?`,
            [userId]
        );
        const enriched = [];
        for (const ch of channels) {
            const scopes = ch.scopes ? String(ch.scopes).split(/\s+/) : [];
            enriched.push({
                channelId: ch.channel_id,
                channelName: ch.channel_name,
                enabled: ch.defender_enabled === 1,
                hasBanScope: scopes.includes('moderation:ban'),
                hasManageScope: scopes.includes('moderation:chat_message:manage'),
                stats: await channelStats(ch.channel_id)
            });
        }
        res.render('kick/panel', {
            user: req.session.tokesUser,
            channels: enriched,
            isManager: await isManagerUser(req),
            isAdmin: isAdminUser(req),
            reauthHref: '/tokes-bot/auth/kick',
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[KBD Dashboard] panel error', { error: error.message });
        res.status(500).send('Failed to load defender panel.');
    }
});

// Toggle enrollment for a channel the user owns.
router.post('/kick/api/enroll', requireTokesAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const { channelId, enabled } = req.body;
        const [[owned]] = await pool.execute(
            "SELECT 1 AS ok FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? AND owner_id = ?",
            [channelId, userId]
        );
        if (!owned) return res.status(403).json({ error: 'Not your channel' });
        await pool.execute(
            "UPDATE tokes_channels SET defender_enabled = ? WHERE platform = 'kick' AND channel_id = ?",
            [enabled ? 1 : 0, channelId]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] enroll error', { error: error.message });
        res.status(500).json({ error: 'Failed to update enrollment' });
    }
});

// ── Admin: connected accounts overview ────────────────────────────────────
// Owner-only. One row per connected platform account (Kick/Twitch) with the
// channels they own, defender enrollment, granted moderation scopes, role
// flags and token freshness — the "who's connected and what can the bot do for
// them" control panel.
router.get('/kick/admin', requireKickAuth, async (req, res) => {
    if (!isAdminUser(req)) {
        return res.status(403).send('Admins only.');
    }
    try {
        // Kick connections only — this is the Kick Defender admin surface. A
        // user's Twitch link (and its token expiry) is irrelevant here: the
        // defender only ever uses the Kick token, so showing a stale Twitch
        // token as an "expired account" on this page is misleading. Filtering to
        // platform='kick' also collapses a user's linked accounts to the one
        // that actually matters here.
        const [conns] = await pool.execute(`
            SELECT pc.id AS conn_id, pc.platform, pc.platform_id, pc.platform_name,
                   pc.platform_avatar, pc.scopes, pc.expires_at, pc.token_updated_at,
                   pc.is_bot_account, pc.connected_at,
                   u.id AS user_id, u.primary_name, u.role, u.is_banned, u.last_seen
            FROM tokes_platform_connections pc
            JOIN tokes_users u ON u.id = pc.user_id
            WHERE pc.platform = 'kick'
            ORDER BY pc.platform_name
        `);

        // Channels per connection (one query, grouped in JS). Kick only — this
        // page lists Kick connections, so a Twitch channel here would be orphaned.
        const [channels] = await pool.execute(`
            SELECT connection_id, channel_id, channel_name, platform,
                   is_enabled, defender_enabled
            FROM tokes_channels
            WHERE platform = 'kick'
        `);
        const channelsByConn = new Map();
        for (const ch of channels) {
            if (!channelsByConn.has(ch.connection_id)) channelsByConn.set(ch.connection_id, []);
            channelsByConn.get(ch.connection_id).push(ch);
        }

        const nowMs = Date.now();
        const accounts = [];
        for (const c of conns) {
            const scopes = c.scopes ? String(c.scopes).split(/\s+/).filter(Boolean) : [];
            const chans = channelsByConn.get(c.conn_id) || [];
            const enriched = [];
            for (const ch of chans) {
                enriched.push({
                    channelName: ch.channel_name,
                    channelId: ch.channel_id,
                    enabled: ch.is_enabled === 1,
                    defenderEnabled: ch.defender_enabled === 1,
                    stats: ch.platform === 'kick' ? await channelStats(ch.channel_id) : null
                });
            }
            const expMs = c.expires_at ? new Date(c.expires_at).getTime() : null;
            accounts.push({
                userId: c.user_id,
                primaryName: c.primary_name,
                platform: c.platform,
                platformName: c.platform_name,
                avatar: c.platform_avatar,
                role: c.role,
                isBanned: c.is_banned === 1,
                isBotAccount: c.is_bot_account === 1,
                isManager: await managers.isManager(c.user_id),
                isAdmin: OWNER_PLATFORM_IDS.has(String(c.platform_id)),
                hasBanScope: scopes.includes('moderation:ban'),
                hasManageScope: scopes.includes('moderation:chat_message:manage'),
                scopes,
                channels: enriched,
                tokenExpired: expMs != null && expMs < nowMs,
                lastSeen: c.last_seen
            });
        }

        res.render('kick/admin', {
            user: req.session.tokesUser,
            accounts,
            totals: {
                accounts: accounts.length,
                kick: accounts.filter(a => a.platform === 'kick').length,
                channels: channels.length,
                enrolled: channels.filter(c => c.defender_enabled === 1).length
            },
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[KBD Dashboard] admin overview error', { error: error.message });
        res.status(500).send('Failed to load admin overview.');
    }
});

// ── Manager console ───────────────────────────────────────────────────────
router.get('/kick/managers', requireKickAuth, async (req, res) => {
    if (!await isManagerUser(req)) {
        return res.status(403).send('Managers only.');
    }
    try {
        res.render('kick/managers', {
            user: req.session.tokesUser,
            counts: await banlist.getCounts(),
            sites: await banlist.listSites(),
            bans: await banlist.listBans('kick', 'ban', 100, 0),
            sublist: await banlist.listBans('kick', 'sublist', 100, 0),
            unbans: await banlist.listUnbans('kick', 100, 0),
            phishingCount: phishingSize(),
            isAdmin: isAdminUser(req),
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[KBD Dashboard] managers console error', { error: error.message });
        res.status(500).send('Failed to load manager console.');
    }
});

// Phishing-domain lookup: check whether a domain/URL is in the live blocklist
// (391K shared set + manual sites), matching enforcement's matching exactly.
router.get('/kick/api/check-domain', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q (domain) required' });
    res.json({ query: String(q), ...isDomainBlocked(q) });
});

// Manager banlist add/remove.
router.post('/kick/api/ban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username, reason, listType } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    await banlist.addBan({
        platform: 'kick', username,
        reason: reason || null,
        listType: listType === 'sublist' ? 'sublist' : 'ban',
        addedBy: req.session.tokesUser.id
    });
    res.json({ success: true });
});

router.delete('/kick/api/ban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    await banlist.removeBan('kick', null, username);
    res.json({ success: true });
});

// Manager malicious-site add/remove.
router.post('/kick/api/site', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'uri required' });
    await banlist.addSite(uri, req.session.tokesUser.id);
    res.json({ success: true });
});

router.delete('/kick/api/site', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'uri required' });
    await banlist.removeSite(uri);
    res.json({ success: true });
});

// Resolve a manager identifier (numeric tokes_user_id, Kick/Twitch username, or
// display name) to a tokes_users.id. Returns { id, name } or null.
async function resolveTokesUserId(identifier) {
    if (!identifier) return null;
    const id = String(identifier).trim();

    if (/^\d+$/.test(id)) {
        const [[byId]] = await pool.execute(
            'SELECT id, primary_name FROM tokes_users WHERE id = ?', [id]
        );
        if (byId) return { id: byId.id, name: byId.primary_name };
    }
    // Platform username (e.g. their Kick login) — most natural to type.
    const [[byPlatform]] = await pool.execute(
        `SELECT u.id, u.primary_name
         FROM tokes_users u
         JOIN tokes_platform_connections pc ON pc.user_id = u.id
         WHERE LOWER(pc.platform_name) = LOWER(?)
         LIMIT 1`,
        [id]
    );
    if (byPlatform) return { id: byPlatform.id, name: byPlatform.primary_name };
    // Fallback: primary display name.
    const [[byName]] = await pool.execute(
        'SELECT id, primary_name FROM tokes_users WHERE LOWER(primary_name) = LOWER(?) LIMIT 1', [id]
    );
    if (byName) return { id: byName.id, name: byName.primary_name };

    return null;
}

// ── Admin: manage Managers ────────────────────────────────────────────────
router.post('/kick/api/managers', requireTokesAuth, async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admins only' });
    // Accept either `user` (id / username / display name) or legacy `tokesUserId`.
    const identifier = req.body.user ?? req.body.tokesUserId;
    const { action } = req.body;
    if (!identifier) return res.status(400).json({ error: 'user (id or username) required' });

    const resolved = await resolveTokesUserId(identifier);
    if (!resolved) {
        return res.status(404).json({ error: `No user found matching "${identifier}". They must have logged in to the bot at least once.` });
    }

    if (action === 'add') {
        await managers.addManager(resolved.id, req.session.tokesUser.id);
    } else if (action === 'remove') {
        await managers.removeManager(resolved.id);
    } else {
        return res.status(400).json({ error: 'action must be add or remove' });
    }
    res.json({ success: true, user: resolved.name, id: resolved.id });
});

// ── Sublist (manager) ──────────────────────────────────────────────────────
router.post('/kick/api/sublist', requireTokesAuth, async (req, res) => {
    try {
        if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
        const { username, reason } = req.body;
        if (!username) return res.status(400).json({ error: 'username required' });
        await banlist.addBan({ platform: 'kick', username, reason: reason || 'Bot', listType: 'sublist', addedBy: req.session.tokesUser.id });
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] sublist add error', { error: error.message });
        res.status(500).json({ error: 'Failed to add to sublist' });
    }
});

router.post('/kick/api/sublist/clear', requireTokesAuth, async (req, res) => {
    try {
        if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
        await banlist.clearSublist();
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] sublist clear error', { error: error.message });
        res.status(500).json({ error: 'Failed to clear sublist' });
    }
});

// ── Unbanlist / whitelist (manager) ────────────────────────────────────────
router.post('/kick/api/unban', requireTokesAuth, async (req, res) => {
    try {
        if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'username required' });
        await banlist.addUnban({ platform: 'kick', username, addedBy: req.session.tokesUser.id });
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] unban add error', { error: error.message });
        res.status(500).json({ error: 'Failed to add to unbanlist' });
    }
});

router.delete('/kick/api/unban', requireTokesAuth, async (req, res) => {
    try {
        if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'username required' });
        await banlist.removeUnban('kick', null, username);
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] unban remove error', { error: error.message });
        res.status(500).json({ error: 'Failed to remove from unbanlist' });
    }
});

// ── Enforcement log viewer (channel owner or manager) ──────────────────────
router.get('/kick/api/enforcement-log', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const channelId = String(req.query.channelId || '');
        if (!channelId) return res.status(400).json({ error: 'channelId required' });
        if (!await ownsChannel(userId, channelId) && !await isManagerUser(req)) return res.status(403).json({ error: 'Not your channel' });
        const rows = await listEvents({
            channelId,
            action: req.query.action || null,
            limit: req.query.limit || 50,
            offset: req.query.offset || 0
        });
        res.json({ events: rows });
    } catch (error) {
        logger.error('[KBD Dashboard] enforcement-log error', { error: error.message });
        res.status(500).json({ error: 'Failed to load enforcement log' });
    }
});

// ── Per-channel protection settings (channel owner) ────────────────────────
router.get('/kick/api/channel-settings', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const channelId = String(req.query.channelId || '');
        if (!channelId) return res.status(400).json({ error: 'channelId required' });
        if (!await ownsChannel(userId, channelId)) return res.status(403).json({ error: 'Not your channel' });
        const [[row]] = await pool.execute(
            'SELECT ban_duration_min, phishing_threshold, warning_template, safe_domains FROM kbd_channel_settings WHERE channel_id = ?',
            [channelId]
        );
        res.json({ settings: row || null });
    } catch (error) {
        logger.error('[KBD Dashboard] get channel-settings error', { error: error.message });
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.post('/kick/api/channel-settings', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const { channelId, banDurationMin, phishingThreshold, warningTemplate, safeDomains } = req.body;
        if (!await ownsChannel(userId, channelId)) return res.status(403).json({ error: 'Not your channel' });
        // null = permanent ban; otherwise clamp to [1, 525600] minutes (max 1 year).
        let dur = (banDurationMin === '' || banDurationMin == null) ? null : (parseInt(banDurationMin, 10) || 0);
        if (dur != null) dur = dur <= 0 ? null : Math.min(dur, 525600);
        const thr = Math.min(Math.max(parseInt(phishingThreshold, 10) || 2, 1), 10);
        const warn = (warningTemplate && String(warningTemplate).trim()) ? String(warningTemplate).slice(0, 400) : null;
        let safe = null;
        if (Array.isArray(safeDomains)) {
            const cleaned = safeDomains.map(d => String(d).trim()).filter(Boolean).filter(d => d.length <= 253).slice(0, 50);
            safe = cleaned.length ? cleaned.join(',') : null;
        } else if (safeDomains) {
            safe = String(safeDomains).slice(0, 2000);
        }
        await pool.execute(
            `INSERT INTO kbd_channel_settings (channel_id, ban_duration_min, phishing_threshold, warning_template, safe_domains)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE ban_duration_min = VALUES(ban_duration_min),
                phishing_threshold = VALUES(phishing_threshold),
                warning_template = VALUES(warning_template), safe_domains = VALUES(safe_domains)`,
            [String(channelId || ''), dur, thr, warn, safe]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] save channel-settings error', { error: error.message });
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ── Network stats (any logged-in Kick user) ────────────────────────────────
// Aggregate protection numbers across the whole defender network, for the main
// dashboard's overview. Read-only, cheap.
router.get('/kick/api/network-stats', requireKickAuth, async (req, res) => {
    try {
        const [stats, counts] = await Promise.all([networkStats(), banlist.getCounts()]);
        res.json({
            stats,
            banlist: counts.banlist,
            sublist: counts.sublist,
            unbanlist: counts.unbanlist,
            sites: counts.sites,
            phishing: phishingSize()
        });
    } catch (error) {
        logger.error('[KBD Dashboard] network-stats error', { error: error.message });
        res.status(500).json({ error: 'Failed to load network stats' });
    }
});

// ── Network activity feed (manager+) ───────────────────────────────────────
router.get('/kick/api/network-activity', requireKickAuth, async (req, res) => {
    try {
        if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
        const events = await listAllEvents({ limit: req.query.limit || 50 });
        res.json({ events });
    } catch (error) {
        logger.error('[KBD Dashboard] network-activity error', { error: error.message });
        res.status(500).json({ error: 'Failed to load activity' });
    }
});

// ── Manager roster (admin) ─────────────────────────────────────────────────
router.get('/kick/api/managers', requireKickAuth, async (req, res) => {
    try {
        if (!isAdminUser(req)) return res.status(403).json({ error: 'Admins only' });
        res.json({ managers: await managers.listManagers() });
    } catch (error) {
        logger.error('[KBD Dashboard] manager-list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load managers' });
    }
});

// ── Bot health (any logged-in Kick user) ───────────────────────────────────
// Is the live Kick bot connected, and to how many chatrooms? Plus this user's
// channel scope/token state, so the dashboard can show operational status.
router.get('/kick/api/bot-health', requireKickAuth, async (req, res) => {
    try {
        const bot = global.kickBot;
        const connected = !!(bot && bot.isConnected);
        const joinedChannels = bot && bot.channels && typeof bot.channels.size === 'number' ? bot.channels.size : 0;
        // This user's enrolled Kick channels + whether each has a live join.
        const userId = req.session.tokesUser.id;
        const [chans] = await pool.execute(
            "SELECT channel_id, channel_name, defender_enabled FROM tokes_channels WHERE platform = 'kick' AND owner_id = ?",
            [userId]
        );
        const channels = chans.map(c => ({
            channelId: c.channel_id,
            channelName: c.channel_name,
            enrolled: c.defender_enabled === 1,
            joined: !!(bot && bot.channels && bot.channels.has(String(c.channel_id)))
        }));
        res.json({ connected, joinedChannels, channels });
    } catch (error) {
        logger.error('[KBD Dashboard] bot-health error', { error: error.message });
        res.status(500).json({ error: 'Failed to load bot health' });
    }
});

export default router;
