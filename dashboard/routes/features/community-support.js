import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import { invalidateConfig as invalidateCommunityConfig } from '../../../core/community-support-manager.js';

const router = express.Router();

// GET /api/guilds/:guildId/community-support/config
router.get('/:guildId/community-support/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM community_support_config WHERE guild_id = ?',
            [req.guildId]
        );

        const config = rows[0] || {
            guild_id: req.guildId,
            enabled: false,
            raid_channel_id: null,
            support_channel_id: null,
            shoutout_channel_id: null,
            affiliate_link_channel_id: null,
            non_affiliate_link_channel_id: null,
            raid_affiliate_points: 5,
            raid_non_affiliate_points: 10,
            support_points: 3
        };

        res.json({ success: true, config });
    } catch (error) {
        logger.error('[API Community Support Config GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch community support config' });
    }
});

// PUT /api/guilds/:guildId/community-support/config
router.put('/:guildId/community-support/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const {
            enabled, raid_channel_id, support_channel_id, shoutout_channel_id,
            affiliate_link_channel_id, non_affiliate_link_channel_id,
            raid_affiliate_points, raid_non_affiliate_points, support_points
        } = req.body;

        await pool.execute(`
            INSERT INTO community_support_config
                (guild_id, enabled, raid_channel_id, support_channel_id, shoutout_channel_id,
                 affiliate_link_channel_id, non_affiliate_link_channel_id,
                 raid_affiliate_points, raid_non_affiliate_points, support_points)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled), raid_channel_id = VALUES(raid_channel_id),
                support_channel_id = VALUES(support_channel_id), shoutout_channel_id = VALUES(shoutout_channel_id),
                affiliate_link_channel_id = VALUES(affiliate_link_channel_id),
                non_affiliate_link_channel_id = VALUES(non_affiliate_link_channel_id),
                raid_affiliate_points = VALUES(raid_affiliate_points),
                raid_non_affiliate_points = VALUES(raid_non_affiliate_points),
                support_points = VALUES(support_points)
        `, [
            req.guildId,
            enabled ? 1 : 0,
            raid_channel_id || null,
            support_channel_id || null,
            shoutout_channel_id || null,
            affiliate_link_channel_id || null,
            non_affiliate_link_channel_id || null,
            raid_affiliate_points ?? 5,
            raid_non_affiliate_points ?? 10,
            support_points ?? 3
        ]);

        invalidateCommunityConfig(req.guildId);

        res.json({ success: true, message: 'Community support config updated' });
    } catch (error) {
        logger.error('[API Community Support Config PUT] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update community support config' });
    }
});

// GET /api/guilds/:guildId/community-support/entries — list entries with filtering
router.get('/:guildId/community-support/entries', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { month, user_id, target_username, limit = 100, offset = 0 } = req.query;
        let query = 'SELECT * FROM community_support_entries WHERE guild_id = ?';
        const params = [req.guildId];

        if (month) { query += ' AND month_key = ?'; params.push(month); }
        if (user_id) { query += ' AND user_id = ?'; params.push(user_id); }
        if (target_username) { query += ' AND target_username LIKE ?'; params.push(`%${target_username}%`); }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [entries] = await pool.execute(query, params);
        const [[{ total }]] = await pool.execute(
            'SELECT COUNT(*) as total FROM community_support_entries WHERE guild_id = ?',
            [req.guildId]
        );

        res.json({ success: true, entries, total });
    } catch (error) {
        logger.error('[API Community Support Entries GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch entries' });
    }
});

// PATCH /api/guilds/:guildId/community-support/entries/:entryId — edit an entry
router.patch('/:guildId/community-support/entries/:entryId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { entryId } = req.params;
        const { target_username, target_twitch_id, target_is_affiliate, points_awarded, entry_type } = req.body;

        // Verify entry belongs to this guild
        const [existing] = await pool.execute(
            'SELECT * FROM community_support_entries WHERE id = ? AND guild_id = ?',
            [entryId, req.guildId]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Entry not found' });
        }

        const updates = [];
        const params = [];
        if (target_username !== undefined) { updates.push('target_username = ?'); params.push(target_username); }
        if (target_twitch_id !== undefined) { updates.push('target_twitch_id = ?'); params.push(target_twitch_id); }
        if (target_is_affiliate !== undefined) { updates.push('target_is_affiliate = ?'); params.push(target_is_affiliate ? 1 : 0); }
        if (points_awarded !== undefined) { updates.push('points_awarded = ?'); params.push(parseInt(points_awarded)); }
        if (entry_type !== undefined) { updates.push('entry_type = ?'); params.push(entry_type); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(entryId, req.guildId);
        await pool.execute(
            `UPDATE community_support_entries SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
            params
        );

        res.json({ success: true, message: 'Entry updated' });
    } catch (error) {
        logger.error('[API Community Support Entry PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update entry' });
    }
});

// DELETE /api/guilds/:guildId/community-support/entries/:entryId — delete an entry
router.delete('/:guildId/community-support/entries/:entryId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { entryId } = req.params;
        const [result] = await pool.execute(
            'DELETE FROM community_support_entries WHERE id = ? AND guild_id = ?',
            [entryId, req.guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Entry not found' });
        }

        res.json({ success: true, message: 'Entry deleted' });
    } catch (error) {
        logger.error('[API Community Support Entry DELETE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to delete entry' });
    }
});

// DELETE /api/guilds/:guildId/community-support/entries — bulk delete entries
router.delete('/:guildId/community-support/entries', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'ids array required' });
        }

        const placeholders = ids.map(() => '?').join(',');
        const [result] = await pool.execute(
            `DELETE FROM community_support_entries WHERE id IN (${placeholders}) AND guild_id = ?`,
            [...ids, req.guildId]
        );

        res.json({ success: true, deleted: result.affectedRows });
    } catch (error) {
        logger.error('[API Community Support Entries Bulk DELETE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to delete entries' });
    }
});

// POST /api/guilds/:guildId/community-support/entries/:entryId/repost — repost the bot's response for this entry's message
router.post('/:guildId/community-support/entries/:entryId/repost', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { entryId } = req.params;

        // Get the entry and all sibling entries from the same original message
        const [entry] = await pool.execute(
            'SELECT * FROM community_support_entries WHERE id = ? AND guild_id = ?',
            [entryId, req.guildId]
        );
        if (entry.length === 0) {
            return res.status(404).json({ error: 'Entry not found' });
        }

        const sourceEntry = entry[0];
        const messageId = sourceEntry.message_id;
        const channelId = sourceEntry.channel_id;

        // Get ALL entries tied to this original message (a single message can track multiple streamers)
        const [siblings] = await pool.execute(
            'SELECT * FROM community_support_entries WHERE guild_id = ? AND message_id = ? ORDER BY id',
            [req.guildId, messageId]
        );

        // Build the updated embed
        const totalPoints = siblings.reduce((sum, e) => sum + e.points_awarded, 0);
        const pointBreakdown = siblings.map(e => {
            const tag = e.target_is_affiliate ? 'Affiliate' : 'Non-Affiliate';
            return `**${e.target_username}** (${tag}) +${e.points_awarded}pts`;
        }).join('\n');

        const entryType = sourceEntry.entry_type;
        const leaderboardUrl = `https://certifriedmultitool.com/supporters/${req.guildId}`;
        const embedData = {
            color: entryType === 'raid' ? 0x9146FF : 0x00D166,
            description: `${entryType === 'raid' ? '🛡️ Raid' : '💚 Support'} tracked for <@${sourceEntry.user_id}>!\n\n${pointBreakdown}\n\n**Total: +${totalPoints} points**\n\n📊 [View your ranking here](${leaderboardUrl})`,
            footer: { text: 'Community Support Tracker • Updated by admin' },
            timestamp: new Date().toISOString()
        };

        // Get the correct bot client for this guild
        const botClient = global.botManager ? global.botManager.getClientForGuild(req.guildId) : null;
        if (!botClient) {
            return res.status(500).json({ error: 'Bot client not available for this guild' });
        }

        // Fetch the channel and find the bot's reply to the original message
        const channel = await botClient.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Find and delete the bot's old reply by fetching messages after the original
        const messages = await channel.messages.fetch({ after: messageId, limit: 10 }).catch(() => null);
        if (messages) {
            for (const [, msg] of messages) {
                if (msg.author.id === botClient.user.id && msg.reference?.messageId === messageId) {
                    await msg.delete().catch(() => {});
                    break;
                }
            }
        }

        // Fetch the original message and reply to it with the updated embed
        const originalMsg = await channel.messages.fetch(messageId).catch(() => null);
        if (originalMsg) {
            const { EmbedBuilder } = await import('discord.js');
            const embed = new EmbedBuilder()
                .setColor(embedData.color)
                .setDescription(embedData.description)
                .setFooter(embedData.footer)
                .setTimestamp();

            await originalMsg.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
            res.json({ success: true, message: 'Response reposted with updated data' });
        } else {
            // Original message gone — just post in the channel
            const { EmbedBuilder } = await import('discord.js');
            const embed = new EmbedBuilder()
                .setColor(embedData.color)
                .setDescription(embedData.description)
                .setFooter(embedData.footer)
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            res.json({ success: true, message: 'Response posted (original message not found)' });
        }
    } catch (error) {
        logger.error('[API Community Support Repost] Error:', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to repost: ' + error.message });
    }
});

export default router;
