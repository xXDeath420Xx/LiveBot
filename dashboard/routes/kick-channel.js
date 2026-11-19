/**
 * /kick/channel/* — per-channel settings + command management for Kick.
 * Re-homes the proven /tokes-bot channel/command operations under /kick,
 * resolving the Kick channel_id to the tokes_channels PK on every call.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireKickAuth } from './auth-tokes-bot.js';
import { mountChannelCommandRoutes, commandsPageData } from './channel-bot-commands.js';
import { resolveOwnedChannel } from '../../services/certifried-bot/defender/owned-channel.js';
import { invalidateChannelCache } from '../../services/certifried-bot/command-registry.js';
import { clearAutoResponderCache } from '../../services/certifried-bot/auto-responder.js';
import { clearKickAutomodCache } from '../../services/certifried-bot/kick-automod.js';
import { dailyActivity } from '../../services/certifried-bot/defender/enforcement-log.js';
import { clearGiveawayCache } from '../../services/certifried-bot/giveaway.js';
import { chatTrend } from '../../services/certifried-bot/chat-stats.js';
import { sendChannelMessage } from '../../jobs/kick-timer-scheduler.js';
import { resolveChannel } from '../../services/certifried-bot/defender/channel-tokens.js';
import { resolveKickUser } from '../../services/certifried-bot/defender/resolve-kick-user.js';
import { banUser, unbanUser } from '../../services/certifried-bot/defender/kick-moderation.js';
import { log as logEnforcement } from '../../services/certifried-bot/defender/enforcement-log.js';
import { ensureSubscribed } from '../../services/certifried-bot/kick-event-subscriptions.js';
import {
    validateCommandName, validateCommandResponse, validateCooldown,
    validateAliases, validateBoolean
} from '../../utils/input-validation.js';

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

// ── Page: per-channel settings ──────────────────────────────────────────────
router.get('/kick/channel/:channelId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return kickPage(req, res, 404, 'Channel not found', 'That channel is not one of yours, or it was removed.');
        const [[channel]] = await pool.execute(
            `SELECT c.id, c.channel_id, c.channel_name, c.platform, c.is_enabled,
                    c.command_prefix, c.cooldown_global, c.cooldown_user, c.features_enabled
             FROM tokes_channels c WHERE c.id = ?`, [owned.id]
        );
        res.render('kick/channel', {
            user: req.session.tokesUser,
            channel,
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[Kick Channel] settings page error', { error: error.message });
        kickPage(req, res, 500, 'Could not load this channel', 'Something went wrong loading this page. Try again in a moment.');
    }
});

// ── API: update channel settings ────────────────────────────────────────────
router.patch('/kick/api/channel/:channelId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const { command_prefix, cooldown_global, cooldown_user, features_enabled } = req.body;
        // Partial update: only fields present in the body are changed; COALESCE
        // leaves the existing column value when a field is omitted (null param).
        const prefix = command_prefix != null ? String(command_prefix).slice(0, 5) : null;
        const cg = cooldown_global != null ? Math.max(0, Math.min(60, parseInt(cooldown_global, 10) || 0)) : null;
        const cu = cooldown_user != null ? Math.max(0, Math.min(300, parseInt(cooldown_user, 10) || 0)) : null;
        const feats = features_enabled != null ? JSON.stringify(features_enabled) : null;
        await pool.execute(
            `UPDATE tokes_channels SET
                command_prefix = COALESCE(?, command_prefix),
                cooldown_global = COALESCE(?, cooldown_global),
                cooldown_user = COALESCE(?, cooldown_user),
                features_enabled = COALESCE(?, features_enabled)
             WHERE id = ?`,
            [prefix, cg, cu, feats, owned.id]
        );
        invalidateChannelCache(owned.id);
        // features_enabled holds the automod sub-config too — bust its cache so
        // the live bot picks up filter changes on the next message.
        if (features_enabled != null) clearKickAutomodCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] settings save error', { error: error.message });
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ── Page: command management ────────────────────────────────────────────────
router.get('/kick/channel/:channelId/commands', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return kickPage(req, res, 404, 'Channel not found', 'That channel is not one of yours, or it was removed.');
        const { channel, commands, channelCommands, customCommands } = await commandsPageData(pool, owned.id);
        res.render('kick/channel-commands', {
            user: req.session.tokesUser, channel, commands, channelCommands, customCommands,
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[Kick Channel] commands page error', { error: error.message });
        kickPage(req, res, 500, 'Could not load commands', 'Something went wrong loading this page. Try again in a moment.');
    }
});

// ── API: toggle a built-in command ──────────────────────────────────────────
// Built-in commands, your own commands and auto-responders: shared with the stream bot's Twitch commands page
// (dashboard/routes/channel-bot-commands.js). Same routes, same checks as before.
mountChannelCommandRoutes(router, {
    base: '/kick/api/channel', guard: requireKickAuth, label: '[Kick Channel]',
    resolve: (req) => resolveOwnedChannel(req.session.tokesUser.id, req.params.channelId),
    createdBy: (req) => req.session.tokesUser.name || 'owner',
});

// ── API: override a built-in command ────────────────────────────────────────

// ── API: custom commands CRUD ───────────────────────────────────────────────



// ── Live moderation: ban / unban / timeout a user by name ───────────────────
// The streamer types a username; we resolve it to a Kick user id, use the
// channel owner's token (resolveChannel) to call the Kick moderation API, and
// record the action in the enforcement log so it shows in the activity feed.
router.post('/kick/api/channel/:channelId/moderate', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });

        const action = String(req.body.action || '');
        const username = String(req.body.username || '').trim();
        if (!['ban', 'unban', 'timeout'].includes(action)) {
            return res.status(400).json({ error: 'action must be ban, unban or timeout' });
        }
        if (!username) return res.status(400).json({ error: 'username required' });

        // The channel's own Kick id is the URL param; get a valid owner token + scopes.
        const channelId = String(req.params.channelId);
        const ch = await resolveChannel(channelId);
        if (!ch || !ch.token) {
            return res.status(409).json({ error: 'Channel is not enrolled or its Kick token is unavailable. Enable the defender and re-authorize.' });
        }
        if (!ch.scopes.includes('moderation:ban')) {
            return res.status(403).json({ error: 'This channel has not granted ban permissions. Re-authorize with Kick.' });
        }

        // Username → Kick user id.
        const target = await resolveKickUser(username);
        if (!target) return res.status(404).json({ error: `No Kick user found for "${username}"` });

        // Attribute the action to the dashboard user who clicked it — once
        // managers exist, "who banned this person" matters for the audit trail.
        const actor = String(req.session.tokesUser.name || `user#${userId}`).slice(0, 40);

        let result, reasonText;
        if (action === 'unban') {
            result = await unbanUser(ch.broadcasterId, target.userId, ch.token);
            reasonText = `manual unban by ${actor}`;
        } else {
            // ban (permanent) or timeout (minutes from req.body.minutes, default 10)
            const opts = { reason: req.body.reason ? String(req.body.reason).slice(0, 100) : `Manual action by ${actor} via dashboard` };
            if (action === 'timeout') {
                const mins = Math.min(Math.max(parseInt(req.body.minutes, 10) || 10, 1), 10080); // 1 min … 1 week
                opts.durationMin = mins;
                reasonText = `manual timeout ${mins}m by ${actor}`;
            } else {
                reasonText = `manual ban by ${actor}`;
            }
            result = await banUser(ch.broadcasterId, target.userId, opts, ch.token);
        }

        // Audit it (best-effort) so the activity feed reflects manual actions.
        // NB: kbd_enforcement_log.action is ENUM('ban','delete','detected_no_scope')
        // — 'unban' is not valid, so we record manual actions as 'ban' and keep the
        // real action in the reason text. (The feed renders the reason.)
        try {
            await logEnforcement({
                channelId,
                targetUserId: target.userId,
                targetUsername: target.slug,
                action: 'ban',
                reason: reasonText,
                success: !!result?.ok
            });
        } catch (_) { /* logging must never fail the action */ }

        if (!result?.ok) {
            return res.status(502).json({ error: `Kick API rejected the ${action} (status ${result?.status || '?'}).` });
        }
        res.json({ success: true, action, user: target.slug });
    } catch (error) {
        logger.error('[Kick Channel] moderate error', { error: error.message });
        res.status(500).json({ error: 'Moderation action failed' });
    }
});

// ── Auto-responders CRUD ────────────────────────────────────────────────────





// ── Per-channel activity trend (time-series) ────────────────────────────────
router.get('/kick/api/channel/:channelId/trend', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        // Scope by the Kick channel_id (the URL param), which is what the log stores.
        const series = await dailyActivity({ channelId: String(req.params.channelId), days: req.query.days || 14 });
        res.json({ series });
    } catch (error) {
        logger.error('[Kick Channel] trend error', { error: error.message });
        res.status(500).json({ error: 'Failed to load trend' });
    }
});

// ── Timers (scheduled messages) CRUD ────────────────────────────────────────
router.get('/kick/api/channel/:channelId/timers', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [rows] = await pool.execute(
            `SELECT id, message, interval_min, is_enabled, send_count, last_sent_at
             FROM tokes_timers WHERE channel_id = ? ORDER BY id DESC`,
            [owned.id]
        );
        res.json({ timers: rows });
    } catch (error) {
        logger.error('[Kick Channel] timers list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load timers' });
    }
});

router.post('/kick/api/channel/:channelId/timers', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const respV = validateCommandResponse(req.body.message);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        // Interval in minutes: clamp to [1, 1440] (1 min … 1 day).
        const interval = Math.min(Math.max(parseInt(req.body.interval_min, 10) || 30, 1), 1440);
        const [result] = await pool.execute(
            `INSERT INTO tokes_timers (channel_id, message, interval_min, created_by) VALUES (?, ?, ?, ?)`,
            [owned.id, respV.value, interval, req.session.tokesUser.name || 'owner']
        );
        res.json({ success: true, id: result.insertId });
    } catch (error) {
        logger.error('[Kick Channel] timer create error', { error: error.message });
        res.status(500).json({ error: 'Failed to create timer' });
    }
});

router.put('/kick/api/channel/:channelId/timers/:id', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [[existing]] = await pool.execute(
            'SELECT id FROM tokes_timers WHERE id = ? AND channel_id = ?', [req.params.id, owned.id]
        );
        if (!existing) return res.status(404).json({ error: 'Timer not found' });
        const respV = validateCommandResponse(req.body.message);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const interval = Math.min(Math.max(parseInt(req.body.interval_min, 10) || 30, 1), 1440);
        const enV = validateBoolean(req.body.is_enabled, true);
        await pool.execute(
            'UPDATE tokes_timers SET message = ?, interval_min = ?, is_enabled = ? WHERE id = ?',
            [respV.value, interval, enV.value ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] timer update error', { error: error.message });
        res.status(500).json({ error: 'Failed to update timer' });
    }
});

router.delete('/kick/api/channel/:channelId/timers/:id', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [result] = await pool.execute(
            'DELETE FROM tokes_timers WHERE id = ? AND channel_id = ?', [req.params.id, owned.id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Timer not found' });
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] timer delete error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete timer' });
    }
});

// ── Chat-volume trend (messages/day) ────────────────────────────────────────
router.get('/kick/api/channel/:channelId/chat-trend', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        res.json({ series: await chatTrend(owned.id, req.query.days || 14) });
    } catch (error) {
        logger.error('[Kick Channel] chat-trend error', { error: error.message });
        res.status(500).json({ error: 'Failed to load chat trend' });
    }
});

// ── My channels (for copy-config pickers etc.) ──────────────────────────────
router.get('/kick/api/my-channels', requireKickAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            "SELECT channel_id, channel_name FROM tokes_channels WHERE platform = 'kick' AND owner_id = ? ORDER BY channel_name",
            [req.session.tokesUser.id]
        );
        res.json({ channels: rows });
    } catch (error) {
        logger.error('[Kick Channel] my-channels error', { error: error.message });
        res.status(500).json({ error: 'Failed to load channels' });
    }
});

// ── Copy config from another owned channel ──────────────────────────────────
// Copies command overrides, custom commands, auto-responders, timers,
// channel settings (prefix/cooldowns/features incl. automod+welcome) and
// kbd_channel_settings from `from` into :channelId. REPLACES the target's
// existing rows in those tables — the UI warns before calling.
router.post('/kick/api/channel/:channelId/copy-config', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const target = await resolveOwnedChannel(userId, req.params.channelId);
        if (!target) return res.status(404).json({ error: 'Channel not found' });
        const source = await resolveOwnedChannel(userId, req.body.from);
        if (!source) return res.status(404).json({ error: 'Source channel not found (must be yours)' });
        if (source.id === target.id) return res.status(400).json({ error: 'Source and target are the same channel' });

        // Channel-level settings.
        await pool.execute(
            `UPDATE tokes_channels t
             JOIN tokes_channels s ON s.id = ?
             SET t.command_prefix = s.command_prefix,
                 t.cooldown_global = s.cooldown_global,
                 t.cooldown_user = s.cooldown_user,
                 t.features_enabled = s.features_enabled
             WHERE t.id = ?`,
            [source.id, target.id]
        );
        // Replace per-channel rows table by table.
        await pool.execute('DELETE FROM tokes_channel_commands WHERE channel_id = ?', [target.id]);
        await pool.execute(
            `INSERT INTO tokes_channel_commands (channel_id, command_key, is_enabled, custom_aliases, custom_response, cooldown_override, mod_only)
             SELECT ?, command_key, is_enabled, custom_aliases, custom_response, cooldown_override, mod_only
             FROM tokes_channel_commands WHERE channel_id = ?`,
            [target.id, source.id]
        );
        await pool.execute('DELETE FROM tokes_custom_commands WHERE channel_id = ?', [target.id]);
        await pool.execute(
            `INSERT INTO tokes_custom_commands (channel_id, command_name, response, cooldown, mod_only, is_enabled, created_by)
             SELECT ?, command_name, response, cooldown, mod_only, is_enabled, created_by
             FROM tokes_custom_commands WHERE channel_id = ?`,
            [target.id, source.id]
        );
        await pool.execute('DELETE FROM tokes_auto_responders WHERE channel_id = ?', [target.id]);
        await pool.execute(
            `INSERT INTO tokes_auto_responders (channel_id, trigger_text, match_type, response, cooldown, is_enabled, created_by)
             SELECT ?, trigger_text, match_type, response, cooldown, is_enabled, created_by
             FROM tokes_auto_responders WHERE channel_id = ?`,
            [target.id, source.id]
        );
        await pool.execute('DELETE FROM tokes_timers WHERE channel_id = ?', [target.id]);
        await pool.execute(
            `INSERT INTO tokes_timers (channel_id, message, interval_min, is_enabled, created_by)
             SELECT ?, message, interval_min, is_enabled, created_by
             FROM tokes_timers WHERE channel_id = ?`,
            [target.id, source.id]
        );
        // Defender per-channel settings are keyed by the KICK channel_id, not the PK.
        await pool.execute(
            `INSERT INTO kbd_channel_settings (channel_id, ban_duration_min, phishing_threshold, warning_template, safe_domains)
             SELECT ?, ban_duration_min, phishing_threshold, warning_template, safe_domains
             FROM kbd_channel_settings WHERE channel_id = ?
             ON DUPLICATE KEY UPDATE ban_duration_min = VALUES(ban_duration_min),
                phishing_threshold = VALUES(phishing_threshold),
                warning_template = VALUES(warning_template), safe_domains = VALUES(safe_domains)`,
            [String(req.params.channelId), String(req.body.from)]
        );

        // Bust every relevant cache so the live bot picks the new config up.
        invalidateChannelCache(target.id);
        clearAutoResponderCache(target.id);
        clearKickAutomodCache(target.id);
        clearGiveawayCache(target.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] copy-config error', { error: error.message });
        res.status(500).json({ error: 'Failed to copy configuration' });
    }
});

// ── Giveaways ───────────────────────────────────────────────────────────────
router.get('/kick/api/channel/:channelId/giveaway', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [[g]] = await pool.execute(
            `SELECT id, title, keyword, status, winner_username, created_at
             FROM tokes_giveaways WHERE channel_id = ? ORDER BY id DESC LIMIT 1`,
            [owned.id]
        );
        if (!g) return res.json({ giveaway: null });
        const [[cnt]] = await pool.execute(
            'SELECT COUNT(*) AS n FROM tokes_giveaway_entries WHERE giveaway_id = ?', [g.id]
        );
        res.json({ giveaway: { ...g, entries: Number(cnt.n) } });
    } catch (error) {
        logger.error('[Kick Channel] giveaway get error', { error: error.message });
        res.status(500).json({ error: 'Failed to load giveaway' });
    }
});

router.post('/kick/api/channel/:channelId/giveaway', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const title = String(req.body.title || '').trim().slice(0, 200);
        if (!title) return res.status(400).json({ error: 'title required' });
        const keyword = (String(req.body.keyword || 'enter').trim().toLowerCase().replace(/^!/, '') || 'enter').slice(0, 50);
        if (!/^[a-z0-9_-]+$/.test(keyword)) return res.status(400).json({ error: 'keyword must be alphanumeric' });
        const [[active]] = await pool.execute(
            "SELECT id FROM tokes_giveaways WHERE channel_id = ? AND status = 'active'", [owned.id]
        );
        if (active) return res.status(409).json({ error: 'A giveaway is already running — close it first.' });
        const [r] = await pool.execute(
            'INSERT INTO tokes_giveaways (channel_id, title, keyword, created_by) VALUES (?, ?, ?, ?)',
            [owned.id, title, keyword, req.session.tokesUser.name || 'owner']
        );
        clearGiveawayCache(owned.id);
        // Announce in chat (best-effort).
        sendChannelMessage(String(req.params.channelId), `🎉 GIVEAWAY: ${title} — type !${keyword} to enter!`).catch(() => {});
        res.json({ success: true, id: r.insertId, keyword });
    } catch (error) {
        logger.error('[Kick Channel] giveaway create error', { error: error.message });
        res.status(500).json({ error: 'Failed to start giveaway' });
    }
});

router.post('/kick/api/channel/:channelId/giveaway/:id/draw', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [[g]] = await pool.execute(
            "SELECT id, title, status FROM tokes_giveaways WHERE id = ? AND channel_id = ?",
            [req.params.id, owned.id]
        );
        if (!g) return res.status(404).json({ error: 'Giveaway not found' });
        const [[winner]] = await pool.execute(
            'SELECT username FROM tokes_giveaway_entries WHERE giveaway_id = ? ORDER BY RAND() LIMIT 1', [g.id]
        );
        if (!winner) return res.status(409).json({ error: 'No entries yet — nobody to draw.' });
        await pool.execute(
            "UPDATE tokes_giveaways SET status = 'drawn', winner_username = ?, closed_at = NOW() WHERE id = ?",
            [winner.username, g.id]
        );
        clearGiveawayCache(owned.id);
        sendChannelMessage(String(req.params.channelId), `🏆 GIVEAWAY WINNER: @${winner.username} — congrats! (${g.title})`).catch(() => {});
        res.json({ success: true, winner: winner.username });
    } catch (error) {
        logger.error('[Kick Channel] giveaway draw error', { error: error.message });
        res.status(500).json({ error: 'Failed to draw winner' });
    }
});

router.post('/kick/api/channel/:channelId/giveaway/:id/close', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [r] = await pool.execute(
            "UPDATE tokes_giveaways SET status = 'closed', closed_at = NOW() WHERE id = ? AND channel_id = ? AND status = 'active'",
            [req.params.id, owned.id]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'No active giveaway with that id' });
        clearGiveawayCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] giveaway close error', { error: error.message });
        res.status(500).json({ error: 'Failed to close giveaway' });
    }
});

// ── Kick event subscriptions (webhooks: chat, follows, subs, stream status) ──
// The event list and the subscribe call live in services/certifried-bot/kick-event-subscriptions.js.

router.post('/kick/api/channel/:channelId/events/subscribe', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        let fallbackToken = null;
        try {
            const ch = await resolveChannel(String(req.params.channelId));
            if (ch?.token && ch.scopes?.includes('events:subscribe')) fallbackToken = ch.token;
        } catch { /* the app token is the normal path */ }
        const sub = await ensureSubscribed(String(req.params.channelId), { fallbackToken });
        if (!sub.ok) return res.status(502).json({ error: sub.error || 'Kick did not accept the subscription.' });
        res.json({ success: true, already: !!sub.already, added: sub.added, results: sub.results || [] });
    } catch (error) {
        logger.error('[Kick Channel] event subscribe error', { error: error.message });
        res.status(500).json({ error: 'Failed to subscribe to events' });
    }
});

router.get('/kick/api/channel/:channelId/events/recent', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [rows] = await pool.execute(
            `SELECT event_type, actor_username, created_at FROM tokes_kick_events
             WHERE channel_id = ? ORDER BY created_at DESC LIMIT 30`,
            [String(req.params.channelId)]
        );
        res.json({ events: rows });
    } catch (error) {
        logger.error('[Kick Channel] events recent error', { error: error.message });
        res.status(500).json({ error: 'Failed to load events' });
    }
});

export default router;
