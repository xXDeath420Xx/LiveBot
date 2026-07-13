/**
 * Counting API — `/api/guilds/:guildId/counting/*`
 *
 * Already gated by `apiCheckGuildAdmin` at the parent router.
 *
 * Exposes the per-channel ruleset added in migration 150: a wrong number can either reset
 * the count (the classic game) or simply be deleted so the count never resets at all.
 */
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { getChannelConfig, setMode, setCount } from '../../../../core/counting-manager.js';

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{15,25}$/;
const BOOL_COLUMNS = {
    allow_same_user: 'allow-same-user',
    react_on_valid: 'react-on-valid',
    announce_milestones: 'announce-milestones',
    delete_chatter: 'delete-chatter',
};

router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM counting_channels WHERE guild_id = ? ORDER BY is_active DESC, id', [req.params.guildId]);

        const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
        const channels = rows.map(r => ({
            ...r,
            is_active: !!r.is_active,
            allow_same_user: !!r.allow_same_user,
            react_on_valid: !!r.react_on_valid,
            announce_milestones: !!r.announce_milestones,
            delete_chatter: !!r.delete_chatter,
            channel_name: guild?.channels?.cache?.get(r.channel_id)?.name ?? null,
            next_number: Number(r.current_count) + 1,
        }));
        res.json({ channels });
    } catch (err) {
        logger.error(`[API counting] get failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load counting channels' });
    }
});

/** Enable counting in a channel, starting at `start`. */
router.post('/', async (req, res) => {
    const { channel_id, start } = req.body || {};
    if (!SNOWFLAKE.test(String(channel_id || ''))) return res.status(400).json({ error: 'Pick a channel.' });

    const first = Number(start ?? 1);
    if (!Number.isInteger(first) || first < 0) return res.status(400).json({ error: 'Starting number must be 0 or more.' });

    try {
        const [[existing]] = await pool.execute(
            'SELECT is_active FROM counting_channels WHERE guild_id = ? AND channel_id = ?',
            [req.params.guildId, channel_id]);
        if (existing?.is_active) return res.status(409).json({ error: 'Counting is already active in that channel.' });

        // `current_count` holds the LAST number posted, so the next expected is `first`.
        await pool.execute(
            `INSERT INTO counting_channels (guild_id, channel_id, current_count, highest_count, is_active)
             VALUES (?, ?, ?, ?, TRUE)
             ON DUPLICATE KEY UPDATE current_count = VALUES(current_count),
                                     highest_count = GREATEST(highest_count, VALUES(highest_count)),
                                     last_user_id = NULL, is_active = TRUE`,
            [req.params.guildId, channel_id, first - 1, Math.max(first - 1, 0)]);
        res.json({ success: true });
    } catch (err) {
        logger.error(`[API counting] create failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to set up counting' });
    }
});

router.post('/:channelId/disable', async (req, res) => {
    try {
        const [r] = await pool.execute(
            'UPDATE counting_channels SET is_active = FALSE WHERE guild_id = ? AND channel_id = ?',
            [req.params.guildId, req.params.channelId]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Not a counting channel.' });
        res.json({ success: true });
    } catch (err) {
        logger.error(`[API counting] disable failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to disable counting' });
    }
});

/** Seed the count — used when taking a channel over from another bot mid-run. */
router.post('/:channelId/count', async (req, res) => {
    const last = Number(req.body?.last_number);
    if (!Number.isInteger(last) || last < 0) return res.status(400).json({ error: 'Last number must be 0 or more.' });

    try {
        const cfg = await getChannelConfig(req.params.guildId, req.params.channelId);
        if (!cfg) return res.status(404).json({ error: 'Not a counting channel.' });

        await setCount(req.params.guildId, req.params.channelId, last, null);
        res.json({ success: true, next_number: last + 1 });
    } catch (err) {
        logger.error(`[API counting] setcount failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to set the count' });
    }
});

router.put('/:channelId/mode', async (req, res) => {
    const body = req.body || {};
    const fields = {};

    if (body.fail_mode !== undefined) {
        if (!['reset', 'delete'].includes(body.fail_mode)) {
            return res.status(400).json({ error: 'Mode must be "reset" or "delete".' });
        }
        fields.fail_mode = body.fail_mode;
    }
    for (const col of Object.keys(BOOL_COLUMNS)) {
        if (body[col] !== undefined) fields[col] = body[col] ? 1 : 0;
    }
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to change.' });

    try {
        const cfg = await getChannelConfig(req.params.guildId, req.params.channelId);
        if (!cfg) return res.status(404).json({ error: 'Not a counting channel.' });

        // Delete mode is only feedback the bot gives; without Manage Messages it is silent failure.
        const willDelete = (fields.fail_mode ?? cfg.fail_mode) === 'delete';
        if (willDelete) {
            const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
            const channel = guild?.channels?.cache?.get(req.params.channelId);
            const me = guild?.members?.me;
            if (channel && me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
                return res.status(400).json({ error: `The bot needs Manage Messages in #${channel.name} to delete wrong numbers.` });
            }
        }

        await setMode(req.params.guildId, req.params.channelId, fields);
        const updated = await getChannelConfig(req.params.guildId, req.params.channelId);
        res.json({ success: true, channel: updated });
    } catch (err) {
        logger.error(`[API counting] mode failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to update the rules' });
    }
});

export default router;
