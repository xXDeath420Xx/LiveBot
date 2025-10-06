const db = require('../utils/db');
const logger = require('../utils/logger');
const { EmbedBuilder } = require('discord.js');

// In-memory cache to track recent joins. For sharded bots, a Redis-based solution would be better.
const recentJoins = new Map();

async function handleMemberJoin(member) {
    const guildId = member.guild.id;
    
    // Fetch config for the guild
    const [[config]] = await db.execute('SELECT * FROM anti_raid_config WHERE guild_id = ?', [guildId]);
    if (!config || !config.is_enabled) return;

    // Record the join
    const now = Date.now();
    if (!recentJoins.has(guildId)) {
        recentJoins.set(guildId, []);
    }
    const joinTimestamps = recentJoins.get(guildId);
    
    // Add current join and filter out old ones
    joinTimestamps.push({ timestamp: now, memberId: member.id });
    const timeWindow = config.time_period_seconds * 1000;
    const recent = joinTimestamps.filter(j => now - j.timestamp < timeWindow);
    recentJoins.set(guildId, recent);

    // Check if the limit has been exceeded
    if (recent.length >= config.join_limit) {
        // Raid detected!
        logger.warn(`[AntiRaid] Raid detected in guild ${guildId}. ${recent.length} joins in ${config.time_period_seconds} seconds.`);
        
        // Prevent this from firing multiple times for the same raid
        const lastRaid = recentJoins.get(`${guildId}-lastRaid`);
        if (lastRaid && now - lastRaid < timeWindow) {
            return; // Already handling a raid
        }
        recentJoins.set(`${guildId}-lastRaid`, now);

        // Take action
        await takeAction(member.guild, recent, config.action);
    }
}

async function takeAction(guild, raiders, action) {
    const userIds = raiders.map(r => r.memberId);
    
    // Announce the raid in the mod log
    const [[modConfig]] = await db.execute('SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [guild.id]);
    if (modConfig && modConfig.mod_log_channel_id) {
        const logChannel = await guild.channels.fetch(modConfig.mod_log_channel_id).catch(() => null);
        if (logChannel) {
            const embed = new EmbedBuilder()
                .setColor('#E74C3C')
                .setTitle('🚨 Raid Detected!')
                .setDescription(`Detected **${raiders.length}** users joining rapidly. Action taken: **${action.toUpperCase()}**`)
                .setTimestamp();
            await logChannel.send({ embeds: [embed] });
        }
    }
    
    // Execute the action
    for (const userId of userIds) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;

        try {
            switch (action) {
                case 'kick':
                    await member.kick('Automatic action: Raid detected.');
                    break;
                case 'ban':
                    await member.ban({ reason: 'Automatic action: Raid detected.' });
                    break;
            }
        } catch (e) {
            logger.error(`[AntiRaid] Failed to ${action} member ${member.id}:`, e);
        }
    }
    
    // Clear the tracked joins for this raid
    const joinTimestamps = recentJoins.get(guild.id);
    recentJoins.set(guild.id, joinTimestamps.filter(j => !userIds.includes(j.memberId)));
}


module.exports = { handleMemberJoin };