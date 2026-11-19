/**
 * Channel access API — `/api/guilds/:guildId/channel-access/*`
 *
 * Already gated by `apiCheckGuildAdmin` at the parent router, and `botContext` supplies
 * `req.botClient` (the custom bot for this guild, or the main bot).
 *
 * Turns a per-user channel whitelist into a role. All logic lives in
 * core/channel-access-manager.js so the slash command and this endpoint can't drift.
 */
import express from 'express';
import logger from '../../../../utils/logger.js';
import {
    MIN_WHITELIST,
    scanGuild,
    convertWhitelistToRole,
    listWatches,
    setWatch,
    removeWatch,
    explainRefusal,
    summarize,
} from '../../../../core/channel-access-manager.js';

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{15,25}$/;

const resolveGuild = (req, res) => {
    const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
    if (!guild) {
        res.status(404).json({ error: 'That server is not reachable by the bot right now.' });
        return null;
    }
    return guild;
};

/** Scan: every channel granting access user-by-user, plus the active watches. */
router.get('/', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;

        const channels = await scanGuild(guild);
        const watches = (await listWatches(guild.id)).map(w => ({
            ...w,
            channel_name: guild.channels.cache.get(w.channel_id)?.name ?? null,
            role_name: guild.roles.cache.get(w.role_id)?.name ?? null,
        }));

        res.json({
            minimum: MIN_WHITELIST,
            channels,
            watches,
            totals: {
                channels: channels.length,
                grants: channels.reduce((sum, c) => sum + c.userCount, 0),
                convertible: channels.filter(c => c.convertible && !c.isTicket).length,
            },
        });
    } catch (err) {
        logger.error(`[API channel-access] scan failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to scan channel permissions' });
    }
});

/** Convert one channel. `dryRun: true` returns the same plan without applying it. */
router.post('/convert', async (req, res) => {
    try {
        const { channelId, roleId, dryRun = false, watch = false } = req.body || {};
        if (!SNOWFLAKE.test(String(channelId || ''))) return res.status(400).json({ error: 'A channel is required.' });
        if (!SNOWFLAKE.test(String(roleId || ''))) return res.status(400).json({ error: 'A role is required.' });

        const guild = resolveGuild(req, res);
        if (!guild) return;

        const channel = guild.channels.cache.get(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found in this server.' });
        const role = guild.roles.cache.get(roleId);
        if (!role) return res.status(404).json({ error: 'Role not found in this server.' });

        const result = await convertWhitelistToRole({
            channel,
            role,
            actorTag: req.user?.username ? `${req.user.username} (dashboard)` : 'dashboard',
            dryRun: !!dryRun,
        });

        if (!result.ok) {
            return res.status(422).json({ error: explainRefusal(result), code: result.code, result });
        }

        if (!dryRun && watch) {
            await setWatch({ guildId: guild.id, channelId, roleId, createdBy: req.user?.id ?? null });
        }

        res.json({ result, summary: summarize(result), watching: !dryRun && !!watch });
    } catch (err) {
        logger.error(`[API channel-access] convert failed: ${err.message}`);
        res.status(500).json({ error: 'Conversion failed — check the bot logs.' });
    }
});

/** Turn the watcher on or off for one channel. */
router.post('/watch', async (req, res) => {
    try {
        const { channelId, roleId, enabled = true } = req.body || {};
        if (!SNOWFLAKE.test(String(channelId || ''))) return res.status(400).json({ error: 'A channel is required.' });

        const guild = resolveGuild(req, res);
        if (!guild) return;

        if (!enabled) {
            await removeWatch(guild.id, channelId);
            return res.json({ watching: false });
        }

        if (!SNOWFLAKE.test(String(roleId || ''))) return res.status(400).json({ error: 'Enabling a watch needs a role.' });
        const role = guild.roles.cache.get(roleId);
        if (!role) return res.status(404).json({ error: 'Role not found in this server.' });
        if (role.managed || role.id === guild.id) return res.status(400).json({ error: 'That role cannot be assigned by a bot.' });

        await setWatch({ guildId: guild.id, channelId, roleId, createdBy: req.user?.id ?? null });
        res.json({ watching: true });
    } catch (err) {
        logger.error(`[API channel-access] watch toggle failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to update the watch' });
    }
});

export default router;
