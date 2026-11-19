/**
 * Live announcement style API — `/api/guilds/:guildId/live-style/*`
 *
 * Already gated by `apiCheckGuildAdmin` at the parent router.
 *
 * Chooses between the platform's own live preview and our rendered card, per streamer,
 * per channel, or for the whole server. Logic lives in core/stream-render-style.js so this
 * and `/systems live-style` cannot drift.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import {
    STYLES,
    DEFAULT_STYLE,
    STYLE_LABELS,
    setStyle,
    clearStyle,
    listStyles,
} from '../../../../core/stream-render-style.js';

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{15,25}$/;

/** Current settings plus everything the UI needs to offer a choice. */
router.get('/', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const guild = req.botClient?.guilds?.cache?.get(guildId);

        const rows = await listStyles(guildId);
        const byScope = { guild: null, channels: {}, streamers: {} };
        for (const row of rows) {
            if (row.scope_type === 'guild') byScope.guild = row.style;
            else if (row.scope_type === 'channel') byScope.channels[row.scope_id] = row.style;
            else byScope.streamers[row.scope_id] = row.style;
        }

        // Channels that actually receive announcements — no point offering a choice for the rest.
        const [channelRows] = await pool.execute(
            `SELECT announcement_channel_id AS channel_id, COUNT(*) AS streamer_count
             FROM subscriptions
             WHERE guild_id = ? AND announcement_channel_id IS NOT NULL AND announcement_channel_id <> ''
             GROUP BY announcement_channel_id
             ORDER BY streamer_count DESC`,
            [guildId]
        );

        const [streamerRows] = await pool.execute(
            `SELECT s.streamer_id, s.username, s.platform, COUNT(*) AS subscription_count
             FROM subscriptions sub
             JOIN streamers s ON s.streamer_id = sub.streamer_id
             WHERE sub.guild_id = ?
             GROUP BY s.streamer_id, s.username, s.platform
             ORDER BY s.username ASC`,
            [guildId]
        );

        res.json({
            defaultStyle: DEFAULT_STYLE,
            styles: STYLES.map(value => ({ value, label: STYLE_LABELS[value] })),
            current: byScope,
            channels: channelRows.map(c => ({
                channel_id: c.channel_id,
                name: guild?.channels?.cache?.get(c.channel_id)?.name ?? null,
                streamer_count: Number(c.streamer_count),
                style: byScope.channels[c.channel_id] ?? null,
            })),
            streamers: streamerRows.map(s => ({
                streamer_id: String(s.streamer_id),
                username: s.username,
                platform: s.platform,
                subscription_count: Number(s.subscription_count),
                style: byScope.streamers[String(s.streamer_id)] ?? null,
            })),
        });
    } catch (err) {
        logger.error(`[API live-style] load failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load live announcement styles' });
    }
});

/**
 * Set or clear one scope. `style: 'inherit'` deletes the override so the next scope up applies.
 */
router.post('/', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const { scopeType, scopeId = '', style } = req.body || {};

        if (!['guild', 'channel', 'streamer'].includes(scopeType)) {
            return res.status(400).json({ error: 'scopeType must be guild, channel or streamer.' });
        }
        if (scopeType === 'channel' && !SNOWFLAKE.test(String(scopeId))) {
            return res.status(400).json({ error: 'A channel is required.' });
        }
        if (scopeType === 'streamer' && !/^\d+$/.test(String(scopeId))) {
            return res.status(400).json({ error: 'A streamer is required.' });
        }
        if (style !== 'inherit' && !STYLES.includes(style)) {
            return res.status(400).json({ error: `style must be one of ${STYLES.join(', ')} or inherit.` });
        }

        // A streamer override is only meaningful for a streamer this guild actually tracks.
        if (scopeType === 'streamer') {
            const [[owned]] = await pool.execute(
                'SELECT 1 AS ok FROM subscriptions WHERE guild_id = ? AND streamer_id = ? LIMIT 1',
                [guildId, scopeId]
            );
            if (!owned) return res.status(404).json({ error: 'That streamer is not tracked in this server.' });
        }

        if (style === 'inherit') {
            await clearStyle({ guildId, scopeType, scopeId });
        } else {
            await setStyle({ guildId, scopeType, scopeId, style, updatedBy: req.user?.id ?? null });
        }

        res.json({ success: true, cleared: style === 'inherit' });
    } catch (err) {
        logger.error(`[API live-style] save failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to save the style' });
    }
});

export default router;
