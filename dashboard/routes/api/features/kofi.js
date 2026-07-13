/**
 * Ko-fi API — `/api/guilds/:guildId/kofi/*`
 *
 * Already gated by `apiCheckGuildAdmin` at the parent router.
 *
 * The webhook URL is a bearer secret: anyone holding it can post payments to this guild.
 * It is only ever returned to an authenticated guild admin, and never logged.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import {
    setup, getConfig, getTiers, addTier, removeTier, listSupporters, DEFAULT_DURATION_DAYS,
} from '../../../../core/kofi-manager.js';

const router = express.Router({ mergeParams: true });

const publicUrl = () =>
    (process.env.DASHBOARD_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const webhookUrl = token => `${publicUrl() || 'https://<your-dashboard>'}/webhooks/kofi/${token}`;

/** Never leak the encrypted verification token to the browser. */
function publicConfig(config) {
    if (!config) return null;
    return {
        enabled: !!config.enabled,
        announce_channel_id: config.announce_channel_id,
        role_duration_days: Number(config.role_duration_days),
        thank_you_message: config.thank_you_message,
        has_verification_token: !!config.verification_token,
        webhook_url: webhookUrl(config.webhook_token),
    };
}

router.get('/', async (req, res) => {
    try {
        const [config, tiers, supporters] = await Promise.all([
            getConfig(req.params.guildId),
            getTiers(req.params.guildId),
            listSupporters(req.params.guildId, 25),
        ]);
        res.json({
            configured: !!config,
            config: publicConfig(config),
            tiers,
            supporters,
            defaultDurationDays: DEFAULT_DURATION_DAYS,
        });
    } catch (err) {
        logger.error(`[API kofi] get failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load Ko-fi settings' });
    }
});

/** Create or update the connection. An empty `verification_token` keeps the stored one. */
router.put('/config', async (req, res) => {
    const { verification_token, announce_channel_id, role_duration_days, thank_you_message } = req.body || {};

    const days = Number(role_duration_days ?? DEFAULT_DURATION_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
        return res.status(400).json({ error: 'Perk length must be a whole number of days between 1 and 365.' });
    }
    if (thank_you_message && String(thank_you_message).length > 500) {
        return res.status(400).json({ error: 'Thank-you message must be 500 characters or fewer.' });
    }

    try {
        const existing = await getConfig(req.params.guildId);
        if (!existing && !verification_token) {
            return res.status(400).json({ error: "Paste the verification token from Ko-fi's webhook settings page." });
        }

        // setup() keeps the existing webhook_token, so re-saving never breaks a live Ko-fi config.
        await setup(req.params.guildId, {
            verificationToken: verification_token || null,
            announceChannelId: announce_channel_id || null,
            durationDays: days,
        });
        await pool.execute(
            'UPDATE kofi_config SET thank_you_message = ?, announce_channel_id = ? WHERE guild_id = ?',
            [thank_you_message || null, announce_channel_id || null, req.params.guildId]);

        const config = await getConfig(req.params.guildId);
        res.json({ success: true, config: publicConfig(config) });
    } catch (err) {
        logger.error(`[API kofi] save failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to save Ko-fi settings' });
    }
});

router.post('/toggle', async (req, res) => {
    try {
        const enabled = req.body?.enabled ? 1 : 0;
        const [r] = await pool.execute('UPDATE kofi_config SET enabled = ? WHERE guild_id = ?',
            [enabled, req.params.guildId]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Ko-fi is not set up here yet.' });
        res.json({ success: true, enabled: !!enabled });
    } catch (err) {
        logger.error(`[API kofi] toggle failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to toggle Ko-fi' });
    }
});

router.post('/tiers', async (req, res) => {
    const { role_id, tier_name, min_amount } = req.body || {};
    if (!/^\d{15,25}$/.test(String(role_id || ''))) return res.status(400).json({ error: 'Pick a role.' });

    const amount = Number(min_amount || 0);
    const name = tier_name ? String(tier_name).trim().slice(0, 100) : null;
    if (!name && !(amount > 0)) {
        return res.status(400).json({ error: 'Give a Ko-fi tier name, or a minimum amount above 0.' });
    }
    if (!Number.isFinite(amount) || amount < 0 || amount > 99999999) {
        return res.status(400).json({ error: 'Minimum amount is out of range.' });
    }

    try {
        // Refuse a role we could never actually grant, rather than failing silently at payment time.
        const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
        if (guild) {
            const role = guild.roles.cache.get(role_id);
            const me = guild.members.me;
            if (!role) return res.status(400).json({ error: 'That role no longer exists.' });
            if (role.managed) return res.status(400).json({ error: `**${role.name}** is managed by an integration and cannot be assigned.` });
            if (me && role.position >= me.roles.highest.position) {
                return res.status(400).json({ error: `**${role.name}** sits above the bot's highest role — move the bot's role up first.` });
            }
        }

        await addTier(req.params.guildId, { roleId: role_id, tierName: name, minAmount: amount });
        res.json({ success: true, tiers: await getTiers(req.params.guildId) });
    } catch (err) {
        logger.error(`[API kofi] add tier failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to save tier' });
    }
});

router.delete('/tiers/:roleId', async (req, res) => {
    try {
        const gone = await removeTier(req.params.guildId, req.params.roleId);
        if (!gone) return res.status(404).json({ error: 'That role was not mapped.' });
        res.json({ success: true, tiers: await getTiers(req.params.guildId) });
    } catch (err) {
        logger.error(`[API kofi] remove tier failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to remove tier' });
    }
});

export default router;
