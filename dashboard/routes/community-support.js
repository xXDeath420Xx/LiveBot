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
                `SELECT user_id, entry_type, target_username, target_is_affiliate, points_awarded, message_id, channel_id, created_at
                 FROM community_support_entries
                 WHERE guild_id = ? AND month_key = ? AND user_id IN (${placeholders})
                 ORDER BY created_at DESC`,
                [guildId, monthKey, ...pageUserIds]
            );
            for (const entry of entryRows) {
                if (!entriesByUser[entry.user_id]) entriesByUser[entry.user_id] = [];
                entriesByUser[entry.user_id].push({
                    type: entry.entry_type,
                    target: entry.target_username,
                    isAffiliate: !!entry.target_is_affiliate,
                    points: entry.points_awarded,
                    messageLink: `https://discord.com/channels/${guildId}/${entry.channel_id}/${entry.message_id}`,
                    twitchLink: `https://twitch.tv/${entry.target_username}`,
                    date: entry.created_at
                });
            }
        }

        res.render('community-support-leaderboard', {
            title: `${guild.name} - Community Supporters`,
            guild: {
                id: guild.id,
                name: guild.name,
                icon: guild.icon,
                memberCount: guild.memberCount
            },
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
            users: [],
            pagination: null,
            monthKey: null,
            availableMonths: [],
            error: 'Something went wrong loading the leaderboard.'
        });
    }
});

export default router;
