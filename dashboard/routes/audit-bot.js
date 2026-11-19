/**
 * Dashboard page for an auxiliary bot's server — today the audit bot (events/globalBanReportWatcher.js)
 * in Twitch Moderators Community. That bot runs exactly two features, so this page shows exactly two:
 *
 *   1. Ban report watcher: which channels it reads and whose reports it acts on
 *      (audit_watch_channels / audit_watch_roles, migration 414).
 *   2. Adaptive spam detection for that server (adaptive_spam_config).
 *
 * Super-admins only. The watcher feeds the GLOBAL ban list that every CertiFried server enforces,
 * so deciding who may file into it is a network-wide decision, not that server's.
 * server.js's checkGuildAdmin resolves the guild through the auxiliary bot and sets req.auxBot;
 * every other /manage page is closed for these servers there.
 */
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import configCache from '../../utils/configCache.js';

export const BAN_CATEGORIES = ['phishing', 'scam', 'spam', 'raid', 'harassment', 'selfbot', 'mass_dm', 'impersonation', 'other'];
const CATEGORY_LABELS = {
    auto: 'Work it out from the report', phishing: 'Phishing', scam: 'Scam', spam: 'Spam', raid: 'Raid',
    harassment: 'Harassment', selfbot: 'Self-bot', mass_dm: 'Mass DM', impersonation: 'Impersonation', other: 'Other',
};
// Adaptive spam actions, the same as the Raid lockdown page and /protection spam config (H-716).
const ACTIONS = ['alert', 'mute', 'kick', 'ban', 'delete+warn'];
const MAX_CHANNELS = 25;
const MAX_ROLES = 25;
const TEXTISH = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function textChannels(guild) {
    return [...guild.channels.cache.values()]
        .filter(c => TEXTISH.has(c.type))
        .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
        .map(c => ({ id: c.id, name: c.name, parent: c.parent?.name || null }));
}

function assignableRoles(guild) {
    return [...guild.roles.cache.values()]
        .filter(r => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.hexColor !== '#000000' ? r.hexColor : null }));
}

/** What the bot can actually do in a watched channel: reading it and marking processed reports. */
function channelAccess(guild, channelId) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) return { exists: false };
    const me = guild.members.me;
    const p = me ? ch.permissionsFor(me) : null;
    return {
        exists: true,
        name: ch.name,
        view: !!p?.has(PermissionFlagsBits.ViewChannel),
        history: !!p?.has(PermissionFlagsBits.ReadMessageHistory),
        react: !!p?.has(PermissionFlagsBits.AddReactions),
    };
}

const toInt = (v, min, max, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const toNum = (v, min, max, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : dflt; };

export async function renderAuditBotPage(req, res) {
    const guild = req.guildObject;
    const guildId = guild.id;
    try {
        await Promise.all([guild.roles.fetch(), guild.channels.fetch()]).catch(err =>
            logger.warn('[AuditBotPage] role/channel refresh failed, using cache', { guildId, error: err.message }));

        const [[watchChannels], [watchRoles], [spamRows], [recent], [[totals]]] = await Promise.all([
            pool.query('SELECT channel_id, category, label, enabled, updated_by, updated_at FROM audit_watch_channels WHERE guild_id = ? ORDER BY created_at', [guildId]),
            pool.query('SELECT role_id FROM audit_watch_roles WHERE guild_id = ?', [guildId]),
            pool.query('SELECT * FROM adaptive_spam_config WHERE guild_id = ?', [guildId]),
            pool.query(`SELECT id, user_id, username, category, source, reporter_name, active, created_at
                          FROM global_ban_entries WHERE source_guild_id = ? ORDER BY created_at DESC LIMIT 15`, [guildId]),
            pool.query(`SELECT COUNT(*) total, SUM(created_at > NOW() - INTERVAL 30 DAY) last30,
                               (SELECT COUNT(*) FROM global_ban_entries WHERE source_guild_id IS NULL) unattributed
                          FROM global_ban_entries WHERE source_guild_id = ?`, [guildId]),
        ]);

        let exempt = [];
        try { exempt = JSON.parse(spamRows[0]?.exempt_channels || '[]'); } catch { /* keep empty */ }

        const roles = assignableRoles(guild);
        res.render('audit-bot', {
            user: req.user || null,
            guild: { id: guildId, name: guild.name, icon: guild.iconURL({ size: 64 }), memberCount: guild.memberCount },
            bot: { label: req.auxBot.label, tag: req.auxBot.client.user?.tag, avatar: req.auxBot.client.user?.displayAvatarURL({ size: 64 }) },
            status: global.auditWatcherStatus || {},
            channels: textChannels(guild),
            roles,
            watchChannels: watchChannels.map(w => ({ ...w, access: channelAccess(guild, w.channel_id) })),
            watchRoles: watchRoles.map(r => r.role_id),
            missingRoles: watchRoles.map(r => r.role_id).filter(id => !guild.roles.cache.has(id)),
            spam: spamRows[0] || null,
            exempt,
            recent,
            totals: { total: Number(totals.total) || 0, last30: Number(totals.last30) || 0, unattributed: Number(totals.unattributed) || 0 },
            categoryLabels: CATEGORY_LABELS,
            categories: ['auto', ...BAN_CATEGORIES],
            csrfToken: res.locals.csrfToken,
            saved: req.query.saved || null,
        });
    } catch (error) {
        logger.error('[AuditBotPage] render failed', { guildId, error: error.message });
        res.status(500).render('error', { user: req.user || null, error: 'Could not load the audit bot page.' });
    }
}

function requireAuxSuperAdmin(req, res, next) {
    if (!req.auxBot || !req.isSuperAdmin) return res.status(403).json({ error: 'forbidden' });
    next();
}

export function registerAuditBotRoutes(app, { checkAuth, checkGuildAdmin }) {
    // Save the report watcher: the full list of watched channels and authorised roles.
    app.post('/manage/:guildId/audit-bot/watcher', checkAuth, checkGuildAdmin, requireAuxSuperAdmin, async (req, res) => {
        const guild = req.guildObject;
        const guildId = guild.id;
        const body = req.body || {};
        const inChannels = Array.isArray(body.channels) ? body.channels : [];
        const inRoles = Array.isArray(body.roles) ? body.roles : [];
        if (inChannels.length > MAX_CHANNELS) return res.status(400).json({ error: `At most ${MAX_CHANNELS} channels.` });
        if (inRoles.length > MAX_ROLES) return res.status(400).json({ error: `At most ${MAX_ROLES} roles.` });

        const seen = new Set();
        const channels = [];
        for (const c of inChannels) {
            const id = String(c?.channel_id || '');
            const ch = guild.channels.cache.get(id);
            if (!ch || !TEXTISH.has(ch.type)) return res.status(400).json({ error: `Channel ${id} is not a text channel in this server.` });
            if (seen.has(id)) continue;
            seen.add(id);
            const category = c.category === 'auto' || BAN_CATEGORIES.includes(c.category) ? c.category : null;
            if (!category) return res.status(400).json({ error: `Unknown category for #${ch.name}.` });
            const label = String(c.label || '').trim().slice(0, 100) || ch.name;
            channels.push([guildId, id, category, label, c.enabled === false ? 0 : 1, req.user.id]);
        }
        const roles = [];
        for (const r of new Set(inRoles.map(String))) {
            const role = guild.roles.cache.get(r);
            if (!role || role.id === guild.id || role.managed) return res.status(400).json({ error: `Role ${r} cannot be used.` });
            roles.push([guildId, r, req.user.id]);
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query('DELETE FROM audit_watch_channels WHERE guild_id = ?', [guildId]);
            await conn.query('DELETE FROM audit_watch_roles WHERE guild_id = ?', [guildId]);
            if (channels.length) await conn.query('INSERT INTO audit_watch_channels (guild_id, channel_id, category, label, enabled, updated_by) VALUES ?', [channels]);
            if (roles.length) await conn.query('INSERT INTO audit_watch_roles (guild_id, role_id, updated_by) VALUES ?', [roles]);
            await conn.commit();
        } catch (error) {
            await conn.rollback().catch(() => {});
            logger.error('[AuditBotPage] watcher save failed', { guildId, error: error.message });
            return res.status(500).json({ error: 'Could not save. Nothing was changed.' });
        } finally {
            conn.release();
        }

        try {
            const { invalidateWatcherConfig } = await import('../../events/globalBanReportWatcher.js');
            invalidateWatcherConfig();
        } catch { /* the 60-second refresh picks it up */ }
        logger.info('[AuditBotPage] watcher settings saved', {
            guildId, by: req.user.id, channels: channels.map(c => `${c[1]}:${c[2]}${c[4] ? '' : ':off'}`), roles: roles.map(r => r[1]),
        });
        res.json({ ok: true, channels: channels.length, roles: roles.length });
    });

    // Save adaptive spam detection for this server.
    app.post('/manage/:guildId/audit-bot/adaptive-spam', checkAuth, checkGuildAdmin, requireAuxSuperAdmin, async (req, res) => {
        const guild = req.guildObject;
        const guildId = guild.id;
        const b = req.body || {};
        const action = ACTIONS.includes(b.action) ? b.action : null;
        if (!action) return res.status(400).json({ error: 'Unknown action.' });
        let alertChannel = b.alert_channel_id ? String(b.alert_channel_id) : null;
        if (alertChannel && !TEXTISH.has(guild.channels.cache.get(alertChannel)?.type)) return res.status(400).json({ error: 'Alert channel is not a text channel in this server.' });
        const exempt = [...new Set((Array.isArray(b.exempt_channels) ? b.exempt_channels : []).map(String))];
        if (exempt.some(id => !guild.channels.cache.has(id))) return res.status(400).json({ error: 'An exempt channel is not in this server.' });

        const v = {
            enabled: b.enabled ? 1 : 0,
            cross_channel_threshold: toInt(b.cross_channel_threshold, 2, 10, 3),
            cross_channel_timeframe_minutes: toInt(b.cross_channel_timeframe_minutes, 1, 30, 5),
            deviation_multiplier: toNum(b.deviation_multiplier, 1.5, 5, 2),
            new_account_multiplier_7d: toNum(b.new_account_multiplier_7d, 1, 3, 1.5),
            new_account_multiplier_24h: toNum(b.new_account_multiplier_24h, 1, 5, 2),
            action,
            alert_channel_id: alertChannel,
            exempt_channels: JSON.stringify(exempt),
        };
        try {
            // decisive_channel_count / action_threshold / near_duplicate_matching are not on this page
            // (nor on Raid lockdown); an existing row keeps them, a new row gets the column defaults.
            await pool.query(
                `INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
                     deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id, exempt_channels)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), cross_channel_threshold = VALUES(cross_channel_threshold),
                     cross_channel_timeframe_minutes = VALUES(cross_channel_timeframe_minutes), deviation_multiplier = VALUES(deviation_multiplier),
                     new_account_multiplier_7d = VALUES(new_account_multiplier_7d), new_account_multiplier_24h = VALUES(new_account_multiplier_24h),
                     action = VALUES(action), alert_channel_id = VALUES(alert_channel_id), exempt_channels = VALUES(exempt_channels)`,
                [guildId, v.enabled, v.cross_channel_threshold, v.cross_channel_timeframe_minutes, v.deviation_multiplier,
                 v.new_account_multiplier_7d, v.new_account_multiplier_24h, v.action, v.alert_channel_id, v.exempt_channels]
            );
            configCache.invalidate('adaptive_spam_config', guildId);
            logger.info('[AuditBotPage] adaptive spam saved', { guildId, by: req.user.id, ...v });
            res.json({ ok: true, saved: v });
        } catch (error) {
            logger.error('[AuditBotPage] adaptive spam save failed', { guildId, error: error.message });
            res.status(500).json({ error: 'Could not save. Nothing was changed.' });
        }
    });
}

export default { renderAuditBotPage, registerAuditBotRoutes, BAN_CATEGORIES };
