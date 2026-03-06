import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const router = express.Router();

/** XP required to go from level L to level L+1 */
function getXPForLevel(level) {
    return 5 * (level ** 2) + 50 * level + 100;
}

/** Total cumulative XP earned to reach a given level + current progress */
function getTotalXP(level, currentXP) {
    let total = currentXP;
    for (let i = 1; i <= level; i++) {
        total += getXPForLevel(i);
    }
    return total;
}

/**
 * GET /lb/:guildId
 * Public leaderboard page — no auth required
 */
router.get('/lb/:guildId', async (req, res) => {
    try {
        const { guildId } = req.params;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 25;
        const offset = (page - 1) * limit;

        // Resolve guild from bot manager
        let guild = null;
        if (global.botManager) {
            const botClient = global.botManager.getClientForGuild(guildId);
            if (botClient) {
                guild = botClient.guilds.cache.get(guildId);
            }
        }

        if (!guild) {
            return res.status(404).render('public-leaderboard', {
                title: 'Leaderboard Not Found',
                guild: null,
                users: [],
                pagination: null,
                error: 'Server not found or bot is not in this server.'
            });
        }

        // Check if leveling is enabled
        const [configRows] = await pool.execute(
            'SELECT enabled FROM level_config WHERE guild_id = ?',
            [guildId]
        );

        if (configRows.length === 0 || !configRows[0].enabled) {
            return res.render('public-leaderboard', {
                title: `${guild.name} - Leaderboard`,
                guild: {
                    id: guild.id,
                    name: guild.name,
                    icon: guild.icon,
                    memberCount: guild.memberCount
                },
                users: [],
                pagination: null,
                error: 'Leveling is not enabled for this server.'
            });
        }

        // Fetch leaderboard data — sorted by level DESC, then XP progress DESC
        const [rows] = await pool.execute(`
            SELECT user_id, xp, level
            FROM user_levels
            WHERE guild_id = ? AND (level > 0 OR xp > 0)
            ORDER BY level DESC, xp DESC
            LIMIT ? OFFSET ?
        `, [guildId, limit, offset]);

        // Count total users for pagination
        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM user_levels WHERE guild_id = ? AND (level > 0 OR xp > 0)',
            [guildId]
        );
        const total = countResult[0].total;
        const totalPages = Math.ceil(total / limit);

        // Fetch members from Discord API (not just cache) for accurate display
        const userIds = rows.map(r => r.user_id);
        const fetchedMembers = new Map();
        try {
            const members = await guild.members.fetch({ user: userIds });
            for (const [id, member] of members) {
                fetchedMembers.set(id, member);
            }
        } catch {
            // Fallback: use whatever is in cache
            for (const id of userIds) {
                const m = guild.members.cache.get(id);
                if (m) fetchedMembers.set(id, m);
            }
        }

        // Build leaderboard entries, skipping users that can't be resolved
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

            const totalXP = getTotalXP(row.level, row.xp);
            const xpForNext = getXPForLevel(row.level + 1);
            const xpProgress = xpForNext > 0 ? Math.min(100, Math.round((row.xp / xpForNext) * 100)) : 0;

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
                level: row.level,
                xp: row.xp,
                totalXP,
                xpForNext,
                xpProgress
            });
        }

        res.render('public-leaderboard', {
            title: `${guild.name} - Leaderboard`,
            guild: {
                id: guild.id,
                name: guild.name,
                icon: guild.icon,
                memberCount: guild.memberCount
            },
            users,
            pagination: {
                page,
                totalPages,
                total,
                limit
            },
            error: null
        });

    } catch (error) {
        logger.error('[Public Leaderboard] Error:', { error: error.message, guildId: req.params.guildId });
        res.status(500).render('public-leaderboard', {
            title: 'Leaderboard Error',
            guild: null,
            users: [],
            pagination: null,
            error: 'Something went wrong loading the leaderboard.'
        });
    }
});

export default router;
