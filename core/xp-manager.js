"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMessageXP = handleMessageXP;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
// Cache to prevent DB spam for each message
const userCache = new Map();
const guildConfigCache = new Map();
async function handleMessageXP(message) {
    if (message.author.bot || !message.guild)
        return;
    const guildId = message.guild.id;
    const userId = message.author.id;
    // Fetch and cache guild config
    let config = guildConfigCache.get(guildId);
    if (!config) {
        try {
            const [[guildSettings]] = await db_1.default.execute('SELECT leveling_enabled, leveling_xp_rate, leveling_xp_cooldown, leveling_ignored_channels, leveling_ignored_roles FROM guilds WHERE guild_id = ?', [guildId]);
            config = guildSettings || { leveling_enabled: false };
            guildConfigCache.set(guildId, config);
        }
        catch (error) {
            logger_1.default.error('Failed to fetch guild settings for XP manager.', { guildId, category: 'xp', error: error.stack });
            return;
        }
    }
    if (!config.leveling_enabled)
        return;
    // Check ignored channels and roles
    try {
        const fullConfig = config;
        const ignoredChannels = fullConfig.leveling_ignored_channels ? JSON.parse(fullConfig.leveling_ignored_channels) : [];
        if (ignoredChannels.includes(message.channel.id))
            return;
        const ignoredRoles = fullConfig.leveling_ignored_roles ? JSON.parse(fullConfig.leveling_ignored_roles) : [];
        // FIX: Add null check for message.member before accessing roles
        if (message.member && message.member.roles.cache.some(role => ignoredRoles.includes(role.id)))
            return;
    }
    catch (error) {
        logger_1.default.error('Failed to parse ignored channels/roles for XP manager.', { guildId, category: 'xp', error: error.stack });
        // Continue execution, as this is not a critical failure
    }
    // Cooldown check
    const userKey = `${guildId}:${userId}`;
    const lastMessageTimestamp = userCache.get(userKey);
    const now = Date.now();
    const fullConfig = config;
    const cooldown = (fullConfig.leveling_xp_cooldown || 60) * 1000;
    if (lastMessageTimestamp && (now - lastMessageTimestamp < cooldown)) {
        return;
    }
    userCache.set(userKey, now);
    try {
        // Grant XP
        const xpToGrant = Math.floor(Math.random() * 5) + (fullConfig.leveling_xp_rate || 20); // Random XP between rate and rate+5
        const [[user]] = await db_1.default.execute('SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
        let currentXP = (user ? user.xp : 0) + xpToGrant;
        let currentLevel = user ? user.level : 0;
        let xpForNextLevel = 5 * (currentLevel ** 2) + 50 * currentLevel + 100;
        // Check for level up
        let leveledUp = false;
        while (currentXP >= xpForNextLevel) {
            currentXP -= xpForNextLevel;
            currentLevel++;
            xpForNextLevel = 5 * (currentLevel ** 2) + 50 * currentLevel + 100;
            leveledUp = true;
        }
        // Update database
        await db_1.default.execute(`INSERT INTO user_levels (guild_id, user_id, xp, level, last_message_timestamp)
             VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE xp = VALUES(xp), level = VALUES(level), last_message_timestamp = VALUES(last_message_timestamp)`, [guildId, userId, currentXP, currentLevel]);
        if (leveledUp && message.member) {
            logger_1.default.info(`${message.author.tag} has reached level ${currentLevel}!`, { guildId, category: 'xp' });
            await checkRoleRewards(message.member, currentLevel);
        }
    }
    catch (error) {
        logger_1.default.error('Failed to process XP for user.', { guildId, userId, category: 'xp', error: error.stack });
    }
}
async function checkRoleRewards(member, newLevel) {
    const guildId = member.guild.id;
    try {
        const [rewards] = await db_1.default.execute('SELECT level, role_id FROM role_rewards WHERE guild_id = ? AND level <= ? ORDER BY level DESC', [guildId, newLevel]);
        if (rewards.length === 0)
            return;
        // Find the highest reward the user qualifies for
        const rewardToGrant = rewards[0];
        const role = await member.guild.roles.fetch(rewardToGrant.role_id).catch(() => null);
        if (role && role.editable && !member.roles.cache.has(role.id)) {
            // Remove other reward roles to prevent stacking
            const allRewardRoleIds = rewards.map(r => r.role_id);
            const rolesToRemove = member.roles.cache.filter(r => allRewardRoleIds.includes(r.id) && r.id !== role.id);
            if (rolesToRemove.size > 0) {
                await member.roles.remove(rolesToRemove);
            }
            // Add the new role
            await member.roles.add(role);
            logger_1.default.info(`Granted role "${role.name}" to ${member.user.tag} for reaching level ${newLevel}.`, { guildId, category: 'role-rewards' });
        }
    }
    catch (error) {
        logger_1.default.error(`Failed to check/grant role rewards to ${member.user.tag}`, { guildId, category: 'role-rewards', error: error.stack });
    }
}
