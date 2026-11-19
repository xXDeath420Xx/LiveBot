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
import { requireTokesAuth, requireKickAuth, forgetTokesBanStatus } from './auth-tokes-bot.js';
import { isSuperAdmin } from '../../utils/constants.js';
import * as banlist from '../../services/certifried-bot/defender/banlist.js';
import * as managers from '../../services/certifried-bot/defender/managers.js';
import { channelStats, listEvents, listAllEvents, networkStats, dailyActivity } from '../../services/certifried-bot/defender/enforcement-log.js';
import { size as phishingSize, isDomainBlocked } from '../../services/certifried-bot/defender/phishing-domains.js';
import { resolveOwnedChannel } from '../../services/certifried-bot/defender/owned-channel.js';
import { listSubscriptions, ensureSubscribed, lastChatAt, KICK_EVENT_TYPES } from '../../services/certifried-bot/kick-event-subscriptions.js';

const router = express.Router();

// Error and "not allowed" pages for the /kick HTML routes: the site's styled message page
// (views/kick/message.ejs) instead of a bare line of text.
function kickPage(req, res, status, heading, message) {
    return res.status(status).render('kick/message', {
        heading, message,
        kickUser: req.session?.tokesUser || null,
        actionHref: '/kick', actionLabel: 'Back to your channels'
    });
}

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
        kickPage(req, res, 500, 'Could not load your channels', 'Something went wrong loading this page. Try again in a moment.');
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
        let chat = null;
        if (enabled) {
            const sub = await ensureSubscribed(channelId).catch(e => ({ ok: false, error: e.message }));
            chat = { ok: !!sub.ok, error: sub.ok ? null : (sub.error || null) };
        }
        res.json({ success: true, chat });
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
        return kickPage(req, res, 403, 'Owner only', 'Connected accounts is only open to the Kick Defender owner.');
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

        // Viewer submissions from `!elevated submit` waiting for the owner (oldest first).
        const [pendingThoughts] = await pool.execute(
            `SELECT id, thought, submitted_by, created_at FROM tokes_thoughts
              WHERE is_approved = 0 ORDER BY created_at, id LIMIT 100`);

        res.render('kick/admin', {
            user: req.session.tokesUser,
            accounts,
            pendingThoughts,
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
        kickPage(req, res, 500, 'Could not load connected accounts', 'Something went wrong loading this page. Try again in a moment.');
    }
});

// Owner-only review of `!elevated submit` thoughts: approve puts one in the rotation,
// reject deletes it. Only still-pending rows change, so a double click can't undo a review.
router.post('/kick/api/thoughts/review', requireTokesAuth, async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admins only' });
    const id = Number(req.body.id);
    const { action } = req.body;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id required' });
    try {
        let result;
        if (action === 'approve') {
            [result] = await pool.execute(
                `UPDATE tokes_thoughts SET is_approved = 1, reviewed_by = ?, reviewed_at = NOW()
                  WHERE id = ? AND is_approved = 0`, [req.session.tokesUser.id, id]);
        } else if (action === 'reject') {
            [result] = await pool.execute('DELETE FROM tokes_thoughts WHERE id = ? AND is_approved = 0', [id]);
        } else {
            return res.status(400).json({ error: 'action must be approve or reject' });
        }
        if (!result.affectedRows) return res.status(404).json({ error: 'That thought was already reviewed.' });
        logger.info('[KBD Dashboard] thought reviewed', { id, action, by: req.session.tokesUser.id });
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] thought review error', { id, action, error: error.message });
        res.status(500).json({ error: 'Failed to review thought' });
    }
});

// ── Manager console ───────────────────────────────────────────────────────
// ── Features / what-can-this-bot-do showcase (onboarding) ───────────────────
router.get('/kick/features', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        // Does this user have any Kick channels yet? Drives onboarding vs. showcase.
        const [[c]] = await pool.execute(
            "SELECT COUNT(*) AS n FROM tokes_channels WHERE platform = 'kick' AND owner_id = ?",
            [userId]
        );
        res.render('kick/features', {
            user: req.session.tokesUser,
            isManager: await isManagerUser(req),
            isAdmin: isAdminUser(req),
            hasChannels: Number(c.n) > 0,
            phishingCount: phishingSize(),
            reauthHref: '/tokes-bot/auth/kick',
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[KBD Dashboard] features page error', { error: error.message });
        kickPage(req, res, 500, 'Could not load this page', 'Something went wrong loading this page. Try again in a moment.');
    }
});

router.get('/kick/managers', requireKickAuth, async (req, res) => {
    if (!await isManagerUser(req)) {
        return kickPage(req, res, 403, 'Managers only', 'The manager console is open to network managers and the owner.');
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
        kickPage(req, res, 500, 'Could not load the manager console', 'Something went wrong loading this page. Try again in a moment.');
    }
});

// Phishing-domain lookup: check whether a domain/URL is in the live blocklist
// (391K shared set + manual sites), matching enforcement's matching exactly.
router.get('/kick/api/check-domain', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q (domain) required' });
    try {
        res.json({ query: String(q).slice(0, 300), ...isDomainBlocked(String(q).slice(0, 300)) });
    } catch (error) {
        logger.error('[KBD Dashboard] check-domain error', { error: error.message });
        res.status(500).json({ error: 'Check failed' });
    }
});

// Manager banlist add/remove.
router.post('/kick/api/ban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username, reason, listType } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    try {
        await banlist.addBan({
            platform: 'kick', username: String(username).trim().slice(0, 60),
            reason: reason ? String(reason).slice(0, 200) : null,
            listType: listType === 'sublist' ? 'sublist' : 'ban',
            addedBy: req.session.tokesUser.id
        });
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] ban add error', { error: error.message });
        res.status(500).json({ error: 'Failed to add the ban' });
    }
});

router.delete('/kick/api/ban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    try {
        await banlist.removeBan('kick', null, String(username).trim());
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] ban remove error', { error: error.message });
        res.status(500).json({ error: 'Failed to remove the ban' });
    }
});

// Manager malicious-site add/remove.
router.post('/kick/api/site', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'uri required' });
    try {
        await banlist.addSite(String(uri).trim().slice(0, 300), req.session.tokesUser.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] site add error', { error: error.message });
        res.status(500).json({ error: 'Failed to add the site' });
    }
});

router.delete('/kick/api/site', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'uri required' });
    try {
        await banlist.removeSite(String(uri));
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] site remove error', { error: error.message });
        res.status(500).json({ error: 'Failed to remove the site' });
    }
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
    if (action !== 'add' && action !== 'remove') return res.status(400).json({ error: 'action must be add or remove' });
    try {
        const resolved = await resolveTokesUserId(String(identifier).slice(0, 100));
        if (!resolved) {
            return res.status(404).json({ error: `No user found matching "${String(identifier).slice(0, 100)}". They must have logged in to the bot at least once.` });
        }
        if (action === 'add') await managers.addManager(resolved.id, req.session.tokesUser.id);
        else await managers.removeManager(resolved.id);
        res.json({ success: true, user: resolved.name, id: resolved.id });
    } catch (error) {
        logger.error('[KBD Dashboard] manager change error', { error: error.message });
        res.status(500).json({ error: 'Failed to update managers' });
    }
});

// ── Admin: site bans (tokes_users.is_banned + tokes_moderation_actions) ─────
// A banned account cannot sign in to /kick (requireTokesAuth/requireKickAuth refuse it); a ban
// with an expiry is lifted by isTokesUserBanned() once it has passed. Only the owner: the owner's
// Kick/Twitch account (isAdminUser) or a dashboard super-admin signed in with Discord on the same
// session. This is the site login only; Kick chat bans are the banlist above.
const BAN_LENGTHS_H = new Set([1, 24, 72, 168, 720, 2160]);   // 1h, 1d, 3d, 7d, 30d, 90d; none = permanent

function isSiteBanAdmin(req) {
    return isAdminUser(req) || isSuperAdmin(req.user?.id);
}

async function isOwnerAccount(tokesUserId) {
    if (!OWNER_PLATFORM_IDS.size) return false;
    const [rows] = await pool.execute('SELECT platform_id FROM tokes_platform_connections WHERE user_id = ?', [tokesUserId]);
    return rows.some(r => OWNER_PLATFORM_IDS.has(String(r.platform_id)));
}

router.get('/kick/api/site-bans', requireTokesAuth, async (req, res) => {
    if (!isSiteBanAdmin(req)) return res.status(403).json({ error: 'Admins only' });
    try {
        const [active] = await pool.execute(`
            SELECT u.id AS user_id, u.primary_name, u.ban_reason,
                   (SELECT GROUP_CONCAT(DISTINCT CONCAT(pc.platform, ':', pc.platform_name) SEPARATOR ', ')
                      FROM tokes_platform_connections pc WHERE pc.user_id = u.id) AS accounts,
                   a.id AS action_id, a.reason, a.issued_at, a.expires_at, ib.primary_name AS issued_by_name
              FROM tokes_users u
              LEFT JOIN tokes_moderation_actions a
                     ON a.id = (SELECT MAX(a2.id) FROM tokes_moderation_actions a2
                                 WHERE a2.user_id = u.id AND a2.action_type = 'ban' AND a2.is_active = 1)
              LEFT JOIN tokes_users ib ON ib.id = a.issued_by
             WHERE u.is_banned = 1
             ORDER BY a.issued_at DESC, u.id`);
        const [history] = await pool.execute(`
            SELECT a.id, a.user_id, u.primary_name, a.action_type, a.reason, a.issued_at, a.expires_at, a.is_active,
                   ib.primary_name AS issued_by_name
              FROM tokes_moderation_actions a
              JOIN tokes_users u ON u.id = a.user_id
              LEFT JOIN tokes_users ib ON ib.id = a.issued_by
             WHERE a.action_type IN ('ban', 'unban')
             ORDER BY a.id DESC LIMIT 20`);
        res.json({ success: true, active, history });
    } catch (error) {
        logger.error('[KBD Dashboard] site bans list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load bans' });
    }
});

router.post('/kick/api/site-bans', requireTokesAuth, async (req, res) => {
    if (!isSiteBanAdmin(req)) return res.status(403).json({ error: 'Admins only' });
    const identifier = typeof req.body.user === 'string' ? req.body.user.trim().slice(0, 100) : '';
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const hoursRaw = req.body.hours;
    const hours = hoursRaw === null || hoursRaw === undefined || hoursRaw === '' ? null : Number(hoursRaw);
    if (!identifier) return res.status(400).json({ error: 'Enter a Kick username or user id.' });
    if (!reason) return res.status(400).json({ error: 'Give a reason.' });
    if (reason.length > 500) return res.status(400).json({ error: 'The reason can be up to 500 characters.' });
    if (hours !== null && !BAN_LENGTHS_H.has(hours)) return res.status(400).json({ error: 'Choose a ban length from the list.' });

    let conn;
    try {
        const target = await resolveTokesUserId(identifier);
        if (!target) return res.status(404).json({ error: `No account found matching "${identifier}". They must have signed in at least once.` });
        const actorId = req.session.tokesUser?.id ?? null;
        if (actorId != null && String(target.id) === String(actorId)) return res.status(400).json({ error: 'You cannot ban your own account.' });
        if (await isOwnerAccount(target.id)) return res.status(400).json({ error: 'The owner account cannot be banned.' });

        conn = await pool.getConnection();
        await conn.beginTransaction();
        // A new ban replaces any earlier one, so its length is the one that counts.
        await conn.execute(
            "UPDATE tokes_moderation_actions SET is_active = 0 WHERE user_id = ? AND action_type = 'ban' AND is_active = 1",
            [target.id]);
        await conn.execute('UPDATE tokes_users SET is_banned = 1, ban_reason = ? WHERE id = ?', [reason, target.id]);
        const [ins] = await conn.execute(
            `INSERT INTO tokes_moderation_actions (user_id, action_type, reason, details, issued_by, expires_at, is_active)
             VALUES (?, 'ban', ?, ?, ?, ${hours === null ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? HOUR)'}, 1)`,
            [target.id, reason, JSON.stringify({ via: 'kick-admin', discord_id: req.user?.id || null }), actorId,
                ...(hours === null ? [] : [hours])]);
        await conn.commit();
        forgetTokesBanStatus(target.id);
        logger.warn('[KBD Dashboard] site ban issued', { target: target.id, hours, by: actorId, discordBy: req.user?.id || null });
        res.json({ success: true, id: target.id, name: target.name, action_id: ins.insertId });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error('[KBD Dashboard] site ban error', { error: error.message });
        res.status(500).json({ error: 'Failed to ban the account' });
    } finally {
        conn?.release();
    }
});

router.post('/kick/api/site-bans/unban', requireTokesAuth, async (req, res) => {
    if (!isSiteBanAdmin(req)) return res.status(403).json({ error: 'Admins only' });
    const userId = Number(req.body.user_id);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user_id required' });
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [upd] = await conn.execute('UPDATE tokes_users SET is_banned = 0, ban_reason = NULL WHERE id = ? AND is_banned = 1', [userId]);
        if (!upd.affectedRows) {
            await conn.rollback();
            return res.status(404).json({ error: 'That account is not banned.' });
        }
        await conn.execute(
            "UPDATE tokes_moderation_actions SET is_active = 0 WHERE user_id = ? AND action_type = 'ban' AND is_active = 1", [userId]);
        await conn.execute(
            `INSERT INTO tokes_moderation_actions (user_id, action_type, reason, details, issued_by, is_active)
             VALUES (?, 'unban', ?, ?, ?, 0)`,
            [userId, reason || null, JSON.stringify({ via: 'kick-admin', discord_id: req.user?.id || null }), req.session.tokesUser?.id ?? null]);
        await conn.commit();
        forgetTokesBanStatus(userId);
        logger.warn('[KBD Dashboard] site ban lifted', { target: userId, by: req.session.tokesUser?.id ?? null });
        res.json({ success: true });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error('[KBD Dashboard] site unban error', { error: error.message });
        res.status(500).json({ error: 'Failed to lift the ban' });
    } finally {
        conn?.release();
    }
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

// "https://www.Example.com/path" -> "www.example.com"; "*.example.com" -> "example.com". Hostnames only.
function normalizeAllowedDomain(raw) {
    let d = String(raw || '').trim().toLowerCase();
    if (!d) return null;
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
    d = d.split(/[/?#]/)[0].split('@').pop().split(':')[0].replace(/\.+$/, '');
    if (d.length > 253 || !d.includes('.') || !/^[a-z0-9.-]+$/.test(d) || d.startsWith('.') || d.includes('..')) return null;
    return d;
}

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
        const list = Array.isArray(safeDomains) ? safeDomains
            : (typeof safeDomains === 'string' ? safeDomains.split(/[\s,]+/) : []);
        const cleaned = [...new Set(list.map(normalizeAllowedDomain).filter(Boolean))].slice(0, 50);
        const safe = cleaned.length ? cleaned.join(',') : null;
        await pool.execute(
            `INSERT INTO kbd_channel_settings (channel_id, ban_duration_min, phishing_threshold, warning_template, safe_domains)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE ban_duration_min = VALUES(ban_duration_min),
                phishing_threshold = VALUES(phishing_threshold),
                warning_template = VALUES(warning_template), safe_domains = VALUES(safe_domains)`,
            [String(channelId || ''), dur, thr, warn, safe]
        );
        res.json({ success: true, safeDomains: cleaned });
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

// ── Network activity time-series (any logged-in Kick user) ──────────────────
router.get('/kick/api/network-trend', requireKickAuth, async (req, res) => {
    try {
        const series = await dailyActivity({ days: req.query.days || 14 });
        res.json({ series });
    } catch (error) {
        logger.error('[KBD Dashboard] network-trend error', { error: error.message });
        res.status(500).json({ error: 'Failed to load trend' });
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
        const { map, error: listError } = await listSubscriptions();
        const userId = req.session.tokesUser.id;
        const [chans] = await pool.execute(
            "SELECT channel_id, channel_name, defender_enabled FROM tokes_channels WHERE platform = 'kick' AND owner_id = ?",
            [userId]
        );
        const channels = chans.map(c => {
            const have = map ? (map.get(String(c.channel_id)) || new Set()) : null;
            const chatSubscribed = have ? have.has('chat.message.sent') : null;
            return {
                channelId: c.channel_id,
                channelName: c.channel_name,
                enrolled: c.defender_enabled === 1,
                chatSubscribed,
                missingEvents: have ? KICK_EVENT_TYPES.filter(e => !have.has(e.name)).map(e => e.name) : null,
                lastChatAt: lastChatAt(c.channel_id),
                joined: chatSubscribed === true   // kept for older callers: "chat reaches the bot"
            };
        });
        let joinedChannels = 0;
        if (map) for (const set of map.values()) if (set.has('chat.message.sent')) joinedChannels++;
        res.json({ connected: !!map, feed: 'webhook', statusError: map ? null : (listError || 'unknown'), joinedChannels, channels });
    } catch (error) {
        logger.error('[KBD Dashboard] bot-health error', { error: error.message });
        res.status(500).json({ error: 'Failed to load bot health' });
    }
});

export default router;
