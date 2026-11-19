/**
 * Channel post rules API (core/channel-post-rules.js enforces them on every message).
 *   GET    /api/guilds/:guildId/channel-post-rules              all rules for the server
 *   PUT    /api/guilds/:guildId/channel-post-rules/:channelId   create or replace one channel's rules
 *   DELETE /api/guilds/:guildId/channel-post-rules/:channelId   remove them
 * Until 2026-11-18 these rows could only be written by one-off scripts (audit: dashboard-first gap).
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import configCache from '../../../../utils/configCache.js';

const router = express.Router({ mergeParams: true });
const ID = /^\d{17,20}$/;
const int = (v, min, max, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0);
const arr = (v) => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };

function shape(r) {
    return {
        channel_id: r.channel_id, enabled: !!r.enabled, require_image: !!r.require_image,
        blocked_link_domains: arr(r.blocked_link_domains), min_level: r.min_level, min_messages: r.min_messages,
        activity_window_days: r.activity_window_days, min_member_days: r.min_member_days, cooldown_hours: r.cooldown_hours,
        exempt_role_ids: arr(r.exempt_role_ids), delete_violations: !!r.delete_violations, notify_user: !!r.notify_user,
        log_channel_id: r.log_channel_id || null, updated_at: r.updated_at,
    };
}

router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM channel_post_rules WHERE guild_id = ? ORDER BY created_at', [req.params.guildId]);
        res.json({ rules: rows.map(shape) });
    } catch (error) {
        logger.error('[ChannelPostRules API] load failed', { error: error.message });
        res.status(500).json({ error: 'Could not load the rules.' });
    }
});

router.put('/:channelId', async (req, res) => {
    const { guildId, channelId } = req.params;
    if (!ID.test(channelId)) return res.status(400).json({ error: 'Bad channel.' });
    const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
    if (guild && !guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server.' });
    const b = req.body || {};
    const domains = [...new Set(arr(b.blocked_link_domains).map(d => String(d).trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 100);
    const roles = [...new Set(arr(b.exempt_role_ids).map(String).filter(id => ID.test(id) && (!guild || guild.roles.cache.has(id))))].slice(0, 50);
    const logChannel = b.log_channel_id && ID.test(String(b.log_channel_id)) ? String(b.log_channel_id) : null;
    const v = [
        bool(b.enabled ?? 1), bool(b.require_image), JSON.stringify(domains),
        int(b.min_level, 0, 500, 0), int(b.min_messages, 0, 100000, 0), int(b.activity_window_days, 1, 365, 30),
        int(b.min_member_days, 0, 3650, 0), int(b.cooldown_hours, 0, 720, 0), JSON.stringify(roles),
        bool(b.delete_violations ?? 1), bool(b.notify_user ?? 1), logChannel,
    ];
    try {
        await pool.execute(
            `INSERT INTO channel_post_rules (guild_id, channel_id, enabled, require_image, blocked_link_domains, min_level, min_messages,
                 activity_window_days, min_member_days, cooldown_hours, exempt_role_ids, delete_violations, notify_user, log_channel_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), require_image = VALUES(require_image),
                 blocked_link_domains = VALUES(blocked_link_domains), min_level = VALUES(min_level), min_messages = VALUES(min_messages),
                 activity_window_days = VALUES(activity_window_days), min_member_days = VALUES(min_member_days),
                 cooldown_hours = VALUES(cooldown_hours), exempt_role_ids = VALUES(exempt_role_ids),
                 delete_violations = VALUES(delete_violations), notify_user = VALUES(notify_user), log_channel_id = VALUES(log_channel_id)`,
            [guildId, channelId, ...v]);
        configCache.invalidate('channel_post_rules', `${guildId}:${channelId}`);
        const [[row]] = await pool.execute('SELECT * FROM channel_post_rules WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
        res.json({ ok: true, rule: shape(row) });
    } catch (error) {
        logger.error('[ChannelPostRules API] save failed', { error: error.message });
        res.status(500).json({ error: 'Could not save. Nothing was changed.' });
    }
});

router.delete('/:channelId', async (req, res) => {
    const { guildId, channelId } = req.params;
    try {
        await pool.execute('DELETE FROM channel_post_rules WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
        configCache.invalidate('channel_post_rules', `${guildId}:${channelId}`);
        res.json({ ok: true });
    } catch (error) {
        logger.error('[ChannelPostRules API] delete failed', { error: error.message });
        res.status(500).json({ error: 'Could not remove the rules.' });
    }
});

export default router;
