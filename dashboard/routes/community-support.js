import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getLeaderboard } from '../../core/community-support-manager.js';

const router = express.Router();

/**
 * GET /supporters/:guildId
 * Public community support leaderboard — no auth required
 */
router.get('/supporters/:guildId', async (req, res) => {
    try {
        const { guildId } = req.params;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 25;
        const offset = (page - 1) * limit;

        // Default to current month
        let monthKey = req.query.month;
        if (monthKey && !/^\d{4}-\d{2}$/.test(monthKey)) {
            monthKey = null;
        }
        if (!monthKey) {
            const now = new Date();
            monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        }

        // Resolve guild from bot manager
        let guild = null;
        if (global.botManager) {
            const botClient = global.botManager.getClientForGuild(guildId);
            if (botClient) {
                guild = botClient.guilds.cache.get(guildId);
            }
        }

        if (!guild) {
            return res.status(404).render('community-support-leaderboard', {
                title: 'Supporters Not Found',
                guild: null,
                user: req.user || null,
                isAdmin: false,
                users: [],
                pagination: null,
                monthKey,
                availableMonths: [],
                entriesByUser: {},
                error: 'Server not found or bot is not in this server.'
            });
        }

        // Check if community support is enabled
        const [configRows] = await pool.execute(
            'SELECT enabled FROM community_support_config WHERE guild_id = ?',
            [guildId]
        );

        if (configRows.length === 0 || !configRows[0].enabled) {
            return res.render('community-support-leaderboard', {
                title: `${guild.name} - Community Supporters`,
                guild: {
                    id: guild.id,
                    name: guild.name,
                    icon: guild.icon,
                    memberCount: guild.memberCount
                },
                user: req.user || null,
                isAdmin: false,
                users: [],
                pagination: null,
                monthKey,
                availableMonths: [],
                entriesByUser: {},
                error: 'Community support tracking is not enabled for this server.'
            });
        }

        // Get available months for the dropdown
        const [monthRows] = await pool.execute(
            `SELECT DISTINCT month_key FROM community_support_entries
             WHERE guild_id = ? ORDER BY month_key DESC LIMIT 12`,
            [guildId]
        );
        const availableMonths = monthRows.map(r => r.month_key);

        // Ensure current month is in the list
        if (!availableMonths.includes(monthKey)) {
            availableMonths.unshift(monthKey);
        }

        // Get leaderboard data with offset for pagination
        const [rows] = await pool.execute(
            `SELECT user_id, SUM(points_awarded) as total_points,
                    COUNT(*) as total_entries,
                    SUM(CASE WHEN entry_type = 'raid' THEN 1 ELSE 0 END) as raid_count,
                    SUM(CASE WHEN entry_type = 'raid' AND target_is_affiliate = 1 THEN 1 ELSE 0 END) as raid_affiliate_count,
                    SUM(CASE WHEN entry_type = 'raid' AND target_is_affiliate = 0 THEN 1 ELSE 0 END) as raid_non_affiliate_count,
                    SUM(CASE WHEN entry_type = 'support' THEN 1 ELSE 0 END) as support_count
             FROM community_support_entries
             WHERE guild_id = ? AND month_key = ?
             GROUP BY user_id
             ORDER BY total_points DESC
             LIMIT ? OFFSET ?`,
            [guildId, monthKey, limit, offset]
        );

        // Count total users for pagination
        const [countResult] = await pool.execute(
            `SELECT COUNT(DISTINCT user_id) as total FROM community_support_entries
             WHERE guild_id = ? AND month_key = ?`,
            [guildId, monthKey]
        );
        const total = countResult[0].total;
        const totalPages = Math.ceil(total / limit);

        // Resolve Discord members
        const userIds = rows.map(r => r.user_id);
        const fetchedMembers = new Map();
        try {
            const members = await guild.members.fetch({ user: userIds });
            for (const [id, member] of members) {
                fetchedMembers.set(id, member);
            }
        } catch {
            for (const id of userIds) {
                const m = guild.members.cache.get(id);
                if (m) fetchedMembers.set(id, m);
            }
        }

        // Build leaderboard entries
        const users = [];
        let rankOffset = 0;
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const member = fetchedMembers.get(row.user_id);
            if (!member) {
                rankOffset++;
                continue;
            }
            const user = member.user;

            let avatarURL;
            if (user.avatar) {
                avatarURL = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
            } else {
                const defaultIndex = (BigInt(user.id) >> 22n) % 6n;
                avatarURL = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
            }

            users.push({
                rank: offset + index + 1 - rankOffset,
                userId: row.user_id,
                displayName: member.displayName || user.globalName || user.username,
                username: user.username,
                avatarURL,
                totalPoints: Number(row.total_points),
                raidCount: Number(row.raid_count),
                raidAffiliateCount: Number(row.raid_affiliate_count),
                raidNonAffiliateCount: Number(row.raid_non_affiliate_count),
                supportCount: Number(row.support_count),
                totalEntries: Number(row.total_entries)
            });
        }

        // Fetch individual entries for users on this page (for detail/proof view)
        const entriesByUser = {};
        if (users.length > 0) {
            const pageUserIds = users.map(u => u.userId);
            const placeholders = pageUserIds.map(() => '?').join(',');
            const [entryRows] = await pool.execute(
                `SELECT id, user_id, entry_type, target_username, target_twitch_id, target_is_affiliate, points_awarded, message_id, channel_id, created_at
                 FROM community_support_entries
                 WHERE guild_id = ? AND month_key = ? AND user_id IN (${placeholders})
                 ORDER BY created_at DESC`,
                [guildId, monthKey, ...pageUserIds]
            );
            for (const entry of entryRows) {
                if (!entriesByUser[entry.user_id]) entriesByUser[entry.user_id] = [];
                entriesByUser[entry.user_id].push({
                    id: entry.id,
                    type: entry.entry_type,
                    target: entry.target_username,
                    targetTwitchId: entry.target_twitch_id,
                    isAffiliate: !!entry.target_is_affiliate,
                    points: entry.points_awarded,
                    messageLink: `https://discord.com/channels/${guildId}/${entry.channel_id}/${entry.message_id}`,
                    twitchLink: `https://twitch.tv/${entry.target_username}`,
                    date: entry.created_at
                });
            }
        }

        // Check if logged-in user is an admin of this guild
        let isAdmin = false;
        if (req.user && guild) {
            try {
                const botClient = global.botManager?.getClientForGuild(guildId);
                const member = await guild.members.fetch(req.user.id).catch(() => null);
                if (member && (member.permissions.has('ManageGuild') || member.permissions.has('Administrator'))) {
                    isAdmin = true;
                }
            } catch {}
        }

        res.render('community-support-leaderboard', {
            title: `${guild.name} - Community Supporters`,
            guild: {
                id: guild.id,
                name: guild.name,
                icon: guild.icon,
                memberCount: guild.memberCount
            },
            user: req.user || null,
            isAdmin,
            users,
            entriesByUser,
            pagination: {
                page,
                totalPages,
                total,
                limit
            },
            monthKey,
            availableMonths,
            error: null
        });

    } catch (error) {
        logger.error('[Community Support Leaderboard] Error:', { error: error.message, guildId: req.params.guildId });
        res.status(500).render('community-support-leaderboard', {
            title: 'Supporters Error',
            guild: null,
            user: req.user || null,
            isAdmin: false,
            users: [],
            pagination: null,
            monthKey: null,
            availableMonths: [],
            entriesByUser: {},
            error: 'Something went wrong loading the leaderboard.'
        });
    }
});

/**
 * POST /supporters/:guildId/rename-streamer
 * Rename a target_username across ALL entries (admin only)
 */
router.post('/supporters/:guildId/rename-streamer', async (req, res) => {
    const { guildId } = req.params;
    const { old_username, new_username, new_twitch_id, new_is_affiliate } = req.body;

    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    if (!old_username || !new_username) return res.status(400).json({ error: 'Both old and new username required' });

    try {
        // Verify user is admin of this guild
        let isAdmin = false;
        if (global.botManager) {
            const botClient = global.botManager.getClientForGuild(guildId);
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (guild) {
                const member = await guild.members.fetch(req.user.id).catch(() => null);
                if (member && (member.permissions.has('ManageGuild') || member.permissions.has('Administrator'))) {
                    isAdmin = true;
                }
            }
        }

        if (!isAdmin) return res.status(403).json({ error: 'Not an admin of this server' });

        const cleanOld = old_username.trim().toLowerCase();
        const cleanNew = new_username.trim().toLowerCase();

        // Get all affected entries (need message_id and channel_id for Discord edits)
        const [entries] = await pool.execute(
            'SELECT id, message_id, channel_id FROM community_support_entries WHERE guild_id = ? AND LOWER(target_username) = ?',
            [guildId, cleanOld]
        );

        // Build update for entries — always update username, optionally twitch_id and affiliate
        const entryUpdates = ['target_username = ?'];
        const entryValues = [cleanNew];
        if (new_twitch_id !== undefined && new_twitch_id !== null) {
            entryUpdates.push('target_twitch_id = ?');
            entryValues.push(new_twitch_id || null);
        }
        if (new_is_affiliate !== undefined && new_is_affiliate !== null) {
            entryUpdates.push('target_is_affiliate = ?');
            entryValues.push(new_is_affiliate ? 1 : 0);

            // Recalculate points — affiliate raids=5, non-affiliate raids=10, support=3
            if (new_is_affiliate) {
                // Changed TO affiliate: raid entries change from 10 → 5
                await pool.execute(
                    "UPDATE community_support_entries SET points_awarded = 5 WHERE guild_id = ? AND LOWER(target_username) = ? AND entry_type = 'raid' AND target_is_affiliate = 0",
                    [guildId, cleanOld]
                ).catch(() => {});
            } else {
                // Changed FROM affiliate: raid entries change from 5 → 10
                await pool.execute(
                    "UPDATE community_support_entries SET points_awarded = 10 WHERE guild_id = ? AND LOWER(target_username) = ? AND entry_type = 'raid' AND target_is_affiliate = 1",
                    [guildId, cleanOld]
                ).catch(() => {});
            }
        }
        entryValues.push(guildId, cleanOld);

        const [result] = await pool.execute(
            `UPDATE community_support_entries SET ${entryUpdates.join(', ')} WHERE guild_id = ? AND LOWER(target_username) = ?`,
            entryValues
        );

        // Update community_twitch_links
        const linkUpdates = ['twitch_username = ?'];
        const linkValues = [cleanNew];
        if (new_twitch_id !== undefined) {
            linkUpdates.push('twitch_user_id = ?');
            linkValues.push(new_twitch_id || null);
        }
        if (new_is_affiliate !== undefined) {
            linkUpdates.push('is_affiliate = ?');
            linkValues.push(new_is_affiliate ? 1 : 0);
        }
        linkValues.push(guildId, cleanOld);
        await pool.execute(
            `UPDATE community_twitch_links SET ${linkUpdates.join(', ')} WHERE guild_id = ? AND LOWER(twitch_username) = ?`,
            linkValues
        ).catch(() => {});

        // Update shoutouts
        await pool.execute(
            'UPDATE community_support_shoutouts SET twitch_username = ? WHERE guild_id = ? AND LOWER(twitch_username) = ?',
            [cleanNew, guildId, cleanOld]
        ).catch(() => {});

        // Edit Discord messages containing the old username
        // Search ALL messages from the bot in the raid/support channels, not just tracked entries
        let editedMessages = 0;
        try {
            const botClient = global.botManager?.getClientForGuild(guildId) || req.app?.locals?.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (guild) {
                const oldRegex = new RegExp(cleanOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

                // Collect all unique channel IDs from entries + config
                const channelIds = new Set(entries.map(e => e.channel_id).filter(Boolean));
                try {
                    const [cfgRows] = await pool.execute('SELECT raid_channel_id, support_channel_id, shoutout_channel_id FROM community_support_config WHERE guild_id = ?', [guildId]);
                    if (cfgRows.length) {
                        if (cfgRows[0].raid_channel_id) channelIds.add(cfgRows[0].raid_channel_id);
                        if (cfgRows[0].support_channel_id) channelIds.add(cfgRows[0].support_channel_id);
                        if (cfgRows[0].shoutout_channel_id) channelIds.add(cfgRows[0].shoutout_channel_id);
                    }
                } catch {}

                for (const channelId of channelIds) {
                    try {
                        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
                        if (!channel) continue;

                        // Fetch last 100 messages and check for old username
                        const messages = await channel.messages.fetch({ limit: 100 });
                        const botMessages = messages.filter(m => m.author.id === botClient.user.id);

                        for (const [, msg] of botMessages) {
                            let changed = false;
                            let editPayload = {};

                            // Check content
                            if (msg.content && oldRegex.test(msg.content)) {
                                editPayload.content = msg.content.replace(oldRegex, cleanNew);
                                changed = true;
                            }

                            // Check embeds
                            if (msg.embeds.length > 0) {
                                const embeds = msg.embeds.map(e => {
                                    const json = e.toJSON();
                                    let embedChanged = false;

                                    // Replace in every text field
                                    for (const key of ['title', 'description', 'url']) {
                                        if (json[key] && oldRegex.test(json[key])) {
                                            json[key] = json[key].replace(oldRegex, cleanNew);
                                            embedChanged = true;
                                        }
                                    }
                                    if (json.author?.name && oldRegex.test(json.author.name)) {
                                        json.author.name = json.author.name.replace(oldRegex, cleanNew);
                                        embedChanged = true;
                                    }
                                    if (json.author?.url && oldRegex.test(json.author.url)) {
                                        json.author.url = json.author.url.replace(oldRegex, cleanNew);
                                        embedChanged = true;
                                    }
                                    if (json.footer?.text && oldRegex.test(json.footer.text)) {
                                        json.footer.text = json.footer.text.replace(oldRegex, cleanNew);
                                        embedChanged = true;
                                    }
                                    if (json.fields) {
                                        for (const field of json.fields) {
                                            if (field.name && oldRegex.test(field.name)) { field.name = field.name.replace(oldRegex, cleanNew); embedChanged = true; }
                                            if (field.value && oldRegex.test(field.value)) { field.value = field.value.replace(oldRegex, cleanNew); embedChanged = true; }
                                        }
                                    }

                                    if (embedChanged) changed = true;
                                    return json;
                                });
                                if (changed) editPayload.embeds = embeds;
                            }

                            if (changed) {
                                try {
                                    await msg.edit(editPayload);
                                    editedMessages++;
                                    // Rate limit — pause every 3 edits
                                    if (editedMessages % 3 === 0) await new Promise(r => setTimeout(r, 1500));
                                } catch { /* edit failed — message may be webhook-owned */ }
                            }
                        }
                    } catch (chErr) {
                        logger.warn(`[CommunitySupport] Error scanning channel ${channelId}:`, { error: chErr.message });
                    }
                }
            }
        } catch (err) {
            logger.warn(`[CommunitySupport] Error editing Discord messages during rename:`, { error: err.message });
        }

        logger.info(`[CommunitySupport] Renamed "${cleanOld}" → "${cleanNew}" in guild ${guildId}: ${result.affectedRows} DB entries, ${editedMessages} Discord messages edited by ${req.user.username}`);
        res.json({ success: true, updated: result.affectedRows, messagesEdited: editedMessages });
    } catch (error) {
        logger.error('[CommunitySupport] Rename error:', { error: error.message, guildId });
        res.status(500).json({ error: 'Failed to rename' });
    }
});

export default router;
