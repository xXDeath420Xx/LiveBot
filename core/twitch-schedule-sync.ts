import db from '../utils/db';
import logger from '../utils/logger';
import * as twitchApi from '../utils/twitch-api';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface SyncConfig extends RowDataPacket {
    id: number;
    guild_id: string;
    streamer_id: string;
    streamer_username: string;
    twitch_user_id: string;
    discord_channel_id: string;
    custom_message: string | null;
    mention_role_id: string | null;
    is_enabled: number;
}

interface ScheduleSegment {
    id: string;
    start_time: string;
    end_time: string;
    title?: string;
    category?: {
        name: string;
    };
}

interface LastAnnouncedRow extends RowDataPacket {
    last_announced_schedule: string | null;
}

async function syncTwitchSchedules(client: Client): Promise<void> {
    try {
        const [syncConfigs] = await db.execute<SyncConfig[]>('SELECT tssc.*, s.username as streamer_username, s.platform_user_id as twitch_user_id FROM twitch_schedule_sync_config tssc JOIN streamers s ON tssc.streamer_id = s.streamer_id WHERE tssc.is_enabled = 1');

        if (syncConfigs.length === 0) {
            return;
        }

        logger.info(`Found ${syncConfigs.length} active sync configurations.`, { category: 'twitch-schedule' });

        for (const config of syncConfigs) {
            const guildId = config.guild_id;
            try {
                const twitchUserId = config.twitch_user_id;
                if (!twitchUserId) {
                    logger.warn(`Streamer ${config.streamer_username} (ID: ${config.streamer_id}) does not have a Twitch user ID. Skipping sync.`, { guildId, category: 'twitch-schedule' });
                    continue;
                }

                const response = await twitchApi.getStreamSchedule(twitchUserId);
                if (!response) {
                    logger.warn(`Failed to fetch Twitch schedule for user ${twitchUserId}. Skipping sync for this user.`, { guildId, category: 'twitch-schedule' });
                    continue;
                }

                const scheduleSegments: ScheduleSegment[] = response?.data?.data?.segments || [];

                const guild = client.guilds.cache.get(guildId);
                if (!guild) {
                    logger.warn(`Guild ${guildId} not found. Removing sync config.`, { guildId, category: 'twitch-schedule' });
                    await db.execute<ResultSetHeader>('DELETE FROM twitch_schedule_sync_config WHERE id = ?', [config.id]);
                    continue;
                }

                const channel = guild.channels.cache.get(config.discord_channel_id) as TextChannel;
                if (!channel) {
                    logger.warn(`Announcement channel ${config.discord_channel_id} not found. Disabling sync for ${config.streamer_username}.`, { guildId, category: 'twitch-schedule' });
                    await db.execute<ResultSetHeader>('UPDATE twitch_schedule_sync_config SET is_enabled = 0 WHERE id = ?', [config.id]);
                    continue;
                }

                const [[lastAnnouncedScheduleJson]] = await db.execute<LastAnnouncedRow[]>('SELECT last_announced_schedule FROM twitch_schedule_sync_config WHERE id = ?', [config.id]);
                const lastAnnouncedSchedule: ScheduleSegment[] = lastAnnouncedScheduleJson && lastAnnouncedScheduleJson.last_announced_schedule ? JSON.parse(lastAnnouncedScheduleJson.last_announced_schedule) : [];

                const newSegments = scheduleSegments.filter(segment =>
                    !lastAnnouncedSchedule.some(lastSegment => lastSegment.id === segment.id)
                );

                if (newSegments.length > 0) {
                    logger.info(`New schedule segments found for ${config.streamer_username}. Announcing...`, { guildId, category: 'twitch-schedule' });
                    for (const segment of newSegments) {
                        const startTime = new Date(segment.start_time);
                        const endTime = new Date(segment.end_time);
                        const title = segment.title || 'Untitled Segment';
                        const category = segment.category?.name || 'Just Chatting';

                        const embed = new EmbedBuilder()
                            .setColor('#9146FF')
                            .setTitle(`Twitch Schedule Update for ${config.streamer_username}`)
                            .setDescription(
                                `**${title}**\n` +
                                `Category: ${category}\n` +
                                `Time: <t:${Math.floor(startTime.getTime() / 1000)}:f> - <t:${Math.floor(endTime.getTime() / 1000)}:t> (<t:${Math.floor(startTime.getTime() / 1000)}:R>)`
                            )
                            .setURL(`https://www.twitch.tv/${config.streamer_username}/schedule`)
                            .setTimestamp();

                        let content = config.custom_message ? config.custom_message.replace(/{streamer}/g, config.streamer_username) : ``;
                        if (config.mention_role_id) {
                            content = `${content} <@&${config.mention_role_id}>`;
                        }

                        await channel.send({ content: content.trim(), embeds: [embed] });
                    }
                }

                await db.execute<ResultSetHeader>('UPDATE twitch_schedule_sync_config SET last_synced = NOW(), last_announced_schedule = ? WHERE id = ?', [JSON.stringify(scheduleSegments), config.id]);

            } catch (error) {
                const err = _error as Error;
                logger.error(`Error processing sync for streamer ${config.streamer_username} (ID: ${config.streamer_id}).`, { guildId, category: 'twitch-schedule', error: err.stack });
            }
        }
    } catch (error) {
        const err = _error as Error;
        logger.error('CRITICAL ERROR in syncTwitchSchedules.', { category: 'twitch-schedule', error: err.stack });
    }
}

export = { syncTwitchSchedules };
