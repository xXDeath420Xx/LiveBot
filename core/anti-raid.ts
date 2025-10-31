import { GuildMember, EmbedBuilder, TextChannel } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket } from 'mysql2/promise';

interface AntiRaidConfig extends RowDataPacket {
    guild_id: string;
    is_enabled: boolean;
    join_limit: number;
    time_period_seconds: number;
    action: 'kick' | 'ban';
}

interface ModerationConfig extends RowDataPacket {
    guild_id: string;
    mod_log_channel_id: string | null;
}

interface JoinRecord {
    timestamp: number;
    memberId: string;
}

// In-memory cache to track recent joins. For sharded bots, a Redis-based solution would be better.
const recentJoins = new Map<string, JoinRecord[] | number>();

export async function handleMemberJoin(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;

    try {
        // Fetch config for the guild
        const [rows] = await db.execute<AntiRaidConfig[]>('SELECT * FROM anti_raid_config WHERE guild_id = ?', [guildId]);
        const config = rows[0];
        if (!config || !config.is_enabled) return;

        // Record the join
        const now = Date.now();
        if (!recentJoins.has(guildId)) {
            recentJoins.set(guildId, []);
        }
        const joinTimestamps = recentJoins.get(guildId) as JoinRecord[];

        // Add current join and filter out old ones
        joinTimestamps.push({ timestamp: now, memberId: member.id });
        const timeWindow = config.time_period_seconds * 1000;
        const recent = joinTimestamps.filter(j => now - j.timestamp < timeWindow);
        recentJoins.set(guildId, recent);

        // Check if the limit has been exceeded
        if (recent.length >= config.join_limit) {
            // Raid detected!
            logger.warn(`Raid detected. ${recent.length} joins in ${config.time_period_seconds} seconds.`, { guildId, category: 'anti-raid' });

            // Prevent this from firing multiple times for the same raid
            const lastRaid = recentJoins.get(`${guildId}-lastRaid`) as number | undefined;
            if (lastRaid && now - lastRaid < timeWindow) {
                return; // Already handling a raid
            }
            recentJoins.set(`${guildId}-lastRaid`, now);

            // Take action
            await takeAction(member.guild, recent, config.action);
        }
    } catch (error: unknown) {
        logger.error('Error in anti-raid handler.', { guildId, category: 'anti-raid', error: error instanceof Error ? error.stack : error });
    }
}

async function takeAction(guild: GuildMember['guild'], raiders: JoinRecord[], action: 'kick' | 'ban'): Promise<void> {
    const guildId = guild.id;
    const userIds = raiders.map(r => r.memberId);

    try {
        // Announce the raid in the mod log
        const [rows] = await db.execute<ModerationConfig[]>('SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [guildId]);
        const modConfig = rows[0];
        if (modConfig && modConfig.mod_log_channel_id) {
            const logChannel = await guild.channels.fetch(modConfig.mod_log_channel_id).catch(() => null);
            if (logChannel && logChannel.isTextBased()) {
                const embed = new EmbedBuilder()
                    .setColor('#E74C3C')
                    .setTitle('🚨 Raid Detected!')
                    .setDescription(`Detected **${raiders.length}** users joining rapidly. Action taken: **${action.toUpperCase()}**`)
                    .setTimestamp();
                await (logChannel as TextChannel).send({ embeds: [embed] });
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
            } catch (e: unknown) {
                logger.error(`Failed to ${action} member ${member.id}.`, { guildId, category: 'anti-raid', error: e instanceof Error ? e.stack : e });
            }
        }

        // Clear the tracked joins for this raid
        const joinTimestamps = recentJoins.get(guildId) as JoinRecord[];
        recentJoins.set(guildId, joinTimestamps.filter(j => !userIds.includes(j.memberId)));
    } catch (error: unknown) {
        logger.error('Error taking anti-raid action.', { guildId, category: 'anti-raid', error: error instanceof Error ? error.stack : error });
    }
}
