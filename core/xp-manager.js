const db = require('../utils/db');
const logger = require('../utils/logger');

// Cache to prevent DB spam for each message
const userCache = new Map();
const guildConfigCache = new Map();

async function handleMessageXP(message) {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const userId = message.author.id;

    // Fetch and cache guild config
    let config = guildConfigCache.get(guildId);
    if (!config) {
        const [[guildSettings]] = await db.execute('SELECT leveling_enabled, leveling_xp_rate, leveling_xp_cooldown, leveling_ignored_channels, leveling_ignored_roles FROM guilds WHERE guild_id = ?', [guildId]);
        config = guildSettings || { leveling_enabled: 0 };
        guildConfigCache.set(guildId, config);
    }
    
    if (!config.leveling_enabled) return;
    
    // Check ignored channels and roles
    const ignoredChannels = config.leveling_ignored_channels ? JSON.parse(config.leveling_ignored_channels) : [];
    if (ignoredChannels.includes(message.channel.id)) return;

    const ignoredRoles = config.leveling_ignored_roles ? JSON.parse(config.leveling_ignored_roles) : [];
    if (message.member.roles.cache.some(role => ignoredRoles.includes(role.id))) return;


    // Cooldown check
    const userKey = `${guildId}:${userId}`;
    const lastMessageTimestamp = userCache.get(userKey);
    const now = Date.now();
    const cooldown = (config.leveling_xp_cooldown || 60) * 1000;

    if (lastMessageTimestamp && (now - lastMessageTimestamp < cooldown)) {
        return;
    }
    userCache.set(userKey, now);

    // Grant XP
    const xpToGrant = Math.floor(Math.random() * 5) + (config.leveling_xp_rate || 20); // Random XP between rate and rate+5
    
    const [[user]] = await db.execute('SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    
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
    await db.execute(
        `INSERT INTO user_levels (guild_id, user_id, xp, level, last_message_timestamp) \n         VALUES (?, ?, ?, ?, NOW()) \n         ON DUPLICATE KEY UPDATE xp = VALUES(xp), level = VALUES(level), last_message_timestamp = VALUES(last_message_timestamp)`,
        [guildId, userId, currentXP, currentLevel]
    );

    if (leveledUp) {
        await checkRoleRewards(message.member, currentLevel);
    }
}

async function checkRoleRewards(member, newLevel) {
    const [rewards] = await db.execute('SELECT level, role_id FROM role_rewards WHERE guild_id = ? AND level <= ? ORDER BY level DESC', [member.guild.id, newLevel]);
    
    if (rewards.length === 0) return;

    // Find the highest reward the user qualifies for
    const rewardToGrant = rewards[0];
    const role = await member.guild.roles.fetch(rewardToGrant.role_id).catch(() => null);

    if (role && role.editable && !member.roles.cache.has(role.id)) {
        try {
            // Remove other reward roles to prevent stacking
            const allRewardRoleIds = rewards.map(r => r.role_id);
            const rolesToRemove = member.roles.cache.filter(r => allRewardRoleIds.includes(r.id) && r.id !== role.id);
            if (rolesToRemove.size > 0) {
                await member.roles.remove(rolesToRemove);
            }

            // Add the new role
            await member.roles.add(role);
            logger.info(`[RoleRewards] Granted role "${role.name}" to ${member.user.tag} for reaching level ${newLevel}.`);
        } catch (error) {
            logger.error(`[RoleRewards] Failed to grant role to ${member.user.tag}:`, error);
        }
    }
}

module.exports = { handleMessageXP };
