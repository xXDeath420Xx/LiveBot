/**
 * Moderation messages API: the DMs members get when a bot moderation command acts on them, protected
 * roles and default lengths (moderation_config, migration 420). The bot reads them through
 * core/moderation-manager.js (getModerationSettings, sendModerationDm, protectedRoleFor); the dashboard's
 * config-cache clear after a successful PUT makes a save apply at once.
 *
 * GET /api/guilds/:guildId/moderation/messages → the settings
 * PUT /api/guilds/:guildId/moderation/messages → validates, saves, returns the saved settings
 * POST /api/guilds/:guildId/moderation/messages/test → DMs the signed-in admin one message, built from
 *      the page's unsaved values ({ action, template, showModerator, appealLink }), marked as a test
 * GET / PUT /api/guilds/:guildId/moderation/ban-requests → /ban's request channel, approver and requester
 *      roles (ban_request_config, migration 236; read through core/ban-requests.js; H-657)
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import {
    MOD_DM_ACTIONS, MOD_DM_TEMPLATE_MAX, MOD_PROTECTED_ROLES_MAX, MOD_DEFAULT_MUTE_MAX, MOD_DEFAULT_BAN_MAX,
    normaliseModerationSettings, buildModerationDm,
} from '../../../../core/moderation-manager.js';
import { BAN_REQUEST_ROLES_MAX, parseBanRequestConfig, readBanRequestConfig } from '../../../../core/ban-requests.js';

const router = express.Router({ mergeParams: true });

function liveGuild(guildId) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || null;
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

function toClient(settings) {
    return {
        dmOn: settings.dmOn,
        templates: settings.templates,
        showModerator: settings.showModerator,
        appealLink: settings.appealLink || '',
        protectedRoleIds: settings.protectedRoleIds,
        defaultMuteMinutes: settings.defaultMuteMinutes,
        defaultBanMinutes: settings.defaultBanMinutes,
    };
}

/** '' / null → null; otherwise a whole number of minutes within 1..max, or an error. */
function minutesField(value, max, label) {
    if (value === undefined || value === null || value === '') return { value: null };
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) return { error: `${label} must be a whole number of minutes from 1 to ${max}.` };
    return { value: n };
}

router.get('/messages', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM moderation_config WHERE guild_id = ?', [req.params.guildId]);
        res.json(toClient(normaliseModerationSettings(rows[0])));
    } catch (error) {
        logger.error('[API Moderation messages GET] Error:', error);
        res.status(500).json({ error: 'Could not load the moderation messages.' });
    }
});

router.put('/messages', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = liveGuild(guildId);
        if (!guild) return res.status(503).json({ error: 'The bot cannot see this server right now. Try again in a minute.' });
        const body = req.body || {};

        const dmOn = {};
        for (const action of MOD_DM_ACTIONS) dmOn[action] = truthy(body.dmOn?.[action]);

        const templates = {};
        for (const action of MOD_DM_ACTIONS) {
            const raw = body.templates?.[action];
            if (raw === undefined || raw === null) continue;
            if (typeof raw !== 'string') return res.status(400).json({ error: 'Message text must be text.' });
            const text = raw.replace(/\r\n/g, '\n').trim();
            if (text.length > MOD_DM_TEMPLATE_MAX) {
                return res.status(400).json({ error: `Each message can be at most ${MOD_DM_TEMPLATE_MAX} characters.` });
            }
            if (text) templates[action] = text;
        }

        let appealLink = typeof body.appealLink === 'string' ? body.appealLink.trim() : '';
        if (appealLink) {
            if (appealLink.length > 500) return res.status(400).json({ error: 'The appeal link can be at most 500 characters.' });
            let url;
            try { url = new URL(appealLink); } catch { url = null; }
            if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
                return res.status(400).json({ error: 'The appeal link must be a web address starting with https://' });
            }
            appealLink = url.toString();
        }

        const roleList = Array.isArray(body.protectedRoleIds) ? body.protectedRoleIds : (body.protectedRoleIds ? [body.protectedRoleIds] : []);
        const protectedRoleIds = [...new Set(roleList.map(String))];
        if (protectedRoleIds.length > MOD_PROTECTED_ROLES_MAX) {
            return res.status(400).json({ error: `Choose at most ${MOD_PROTECTED_ROLES_MAX} protected roles.` });
        }
        const badRole = protectedRoleIds.find(id => !/^\d{17,20}$/.test(id) || id === guild.id || !guild.roles.cache.has(id));
        if (badRole) return res.status(400).json({ error: `Role ${badRole} is not in this server.` });

        const mute = minutesField(body.defaultMuteMinutes, MOD_DEFAULT_MUTE_MAX, 'The default timeout length');
        if (mute.error) return res.status(400).json({ error: mute.error });
        const ban = minutesField(body.defaultBanMinutes, MOD_DEFAULT_BAN_MAX, 'The default ban length');
        if (ban.error) return res.status(400).json({ error: ban.error });

        const showModerator = truthy(body.showModerator);

        await pool.execute(`
            INSERT INTO moderation_config
                (guild_id, dm_on_warn, dm_on_mute, dm_on_unmute, dm_on_kick, dm_on_ban, dm_on_unban,
                 dm_templates, dm_show_moderator, appeal_link, protected_role_ids, default_mute_minutes, default_ban_minutes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                dm_on_warn = VALUES(dm_on_warn), dm_on_mute = VALUES(dm_on_mute), dm_on_unmute = VALUES(dm_on_unmute),
                dm_on_kick = VALUES(dm_on_kick), dm_on_ban = VALUES(dm_on_ban), dm_on_unban = VALUES(dm_on_unban),
                dm_templates = VALUES(dm_templates), dm_show_moderator = VALUES(dm_show_moderator),
                appeal_link = VALUES(appeal_link), protected_role_ids = VALUES(protected_role_ids),
                default_mute_minutes = VALUES(default_mute_minutes), default_ban_minutes = VALUES(default_ban_minutes)
        `, [
            guildId,
            dmOn.warn ? 1 : 0, dmOn.mute ? 1 : 0, dmOn.unmute ? 1 : 0, dmOn.kick ? 1 : 0, dmOn.ban ? 1 : 0, dmOn.unban ? 1 : 0,
            Object.keys(templates).length ? JSON.stringify(templates) : null,
            showModerator ? 1 : 0,
            appealLink || null,
            protectedRoleIds.length ? JSON.stringify(protectedRoleIds) : null,
            mute.value, ban.value,
        ]);

        const [rows] = await pool.execute('SELECT * FROM moderation_config WHERE guild_id = ?', [guildId]);
        res.json(toClient(normaliseModerationSettings(rows[0])));
    } catch (error) {
        if (error?.code === 'ER_BAD_FIELD_ERROR') {
            return res.status(503).json({ error: 'This setting needs a database update that has not been applied yet.' });
        }
        logger.error('[API Moderation messages PUT] Error:', error);
        res.status(500).json({ error: 'Could not save the moderation messages.' });
    }
});

// One test DM per admin per server every 10 seconds.
const lastTest = new Map();

router.post('/messages/test', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = liveGuild(guildId);
        if (!guild) return res.status(503).json({ error: 'The bot cannot see this server right now. Try again in a minute.' });
        const userId = String(req.user?.id || '');
        if (!/^\d{17,20}$/.test(userId)) return res.status(401).json({ error: 'Sign in again to send a test.' });
        const body = req.body || {};
        const action = MOD_DM_ACTIONS.includes(body.action) ? body.action : null;
        if (!action) return res.status(400).json({ error: 'Pick which message to test.' });
        if (body.template !== undefined && body.template !== null && typeof body.template !== 'string') {
            return res.status(400).json({ error: 'Message text must be text.' });
        }
        const template = String(body.template || '').replace(/\r\n/g, '\n').trim();
        if (template.length > MOD_DM_TEMPLATE_MAX) return res.status(400).json({ error: `Each message can be at most ${MOD_DM_TEMPLATE_MAX} characters.` });
        let appealLink = typeof body.appealLink === 'string' ? body.appealLink.trim().slice(0, 500) : '';
        if (appealLink) {
            let url;
            try { url = new URL(appealLink); } catch { url = null; }
            appealLink = url && (url.protocol === 'https:' || url.protocol === 'http:') ? url.toString() : '';
        }
        const key = guildId + ':' + userId;
        const now = Date.now();
        if (now - (lastTest.get(key) || 0) < 10000) return res.status(429).json({ error: 'Wait a few seconds before sending another test.' });
        lastTest.set(key, now);
        if (lastTest.size > 5000) lastTest.clear();

        const me = await guild.client.users.fetch(userId).catch(() => null);
        if (!me) return res.status(404).json({ error: 'The bot could not find your Discord account.' });
        const payload = buildModerationDm(action, { templates: template ? { [action]: template } : {}, showModerator: truthy(body.showModerator), appealLink }, {
            guildName: guild.name,
            guildId: guild.id,
            userName: me.globalName || me.username,
            reason: 'Test from the dashboard. Nothing has happened to your account.',
            durationMinutes: action === 'mute' ? 60 : null,
            permanent: action === 'ban',
            moderatorName: me.username,
        });
        const note = 'Test of a moderation message from ' + guild.name + ' (sent from the dashboard):';
        payload.content = payload.content ? (note + '\n\n' + payload.content).slice(0, 2000) : note;
        try {
            await me.send(payload);
        } catch {
            return res.status(400).json({ error: 'Discord would not deliver the DM. Allow direct messages from server members, then try again.' });
        }
        res.json({ sent: true });
    } catch (error) {
        logger.error('[API Moderation messages test] Error:', error);
        res.status(500).json({ error: 'Could not send the test message.' });
    }
});

// ── /ban requests ───────────────────────────────────────────────────────────────────────────────

router.get('/ban-requests', async (req, res) => {
    try {
        res.json(await readBanRequestConfig(req.params.guildId));
    } catch (error) {
        logger.error('[API Ban requests GET] Error:', error);
        res.status(500).json({ error: 'Could not load the ban request settings.' });
    }
});

router.put('/ban-requests', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = liveGuild(guildId);
        if (!guild) return res.status(503).json({ error: 'The bot cannot see this server right now. Try again in a minute.' });
        const body = req.body || {};

        const channelId = body.channelId ? String(body.channelId) : null;
        if (channelId) {
            const ch = guild.channels.cache.get(channelId);
            if (!ch || !ch.isTextBased?.() || ch.isVoiceBased?.()) return res.status(400).json({ error: 'Pick a text channel in this server for ban requests.' });
        }
        const roleField = (value, label) => {
            const list = [...new Set((Array.isArray(value) ? value : (value ? [value] : [])).map(String))];
            if (list.length > BAN_REQUEST_ROLES_MAX) return { error: `Choose at most ${BAN_REQUEST_ROLES_MAX} ${label}.` };
            const bad = list.find(id => !/^\d{17,20}$/.test(id) || id === guild.id || !guild.roles.cache.has(id));
            if (bad) return { error: `Role ${bad} is not in this server.` };
            return { list };
        };
        const approvers = roleField(body.approverRoleIds, 'approver roles');
        if (approvers.error) return res.status(400).json({ error: approvers.error });
        const requesters = roleField(body.requesterRoleIds, 'requester roles');
        if (requesters.error) return res.status(400).json({ error: requesters.error });

        await pool.execute(`
            INSERT INTO ban_request_config (guild_id, request_channel_id, approver_role_ids, requester_role_ids)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE request_channel_id = VALUES(request_channel_id),
                approver_role_ids = VALUES(approver_role_ids), requester_role_ids = VALUES(requester_role_ids)
        `, [guildId, channelId, JSON.stringify(approvers.list), JSON.stringify(requesters.list)]);
        const [rows] = await pool.execute('SELECT * FROM ban_request_config WHERE guild_id = ?', [guildId]);
        res.json(parseBanRequestConfig(rows[0]));
    } catch (error) {
        logger.error('[API Ban requests PUT] Error:', error);
        res.status(500).json({ error: 'Could not save the ban request settings.' });
    }
});

export default router;
