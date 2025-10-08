const db = require('../utils/db');
const logger = require('../utils/logger');
const apiChecks = require('../utils/api_checks');
const { EmbedBuilder } = require('discord.js');

async function syncTwitchSchedules(client) {
    try {
        const [syncConfigs] = await db.execute('SELECT tssc.*, s.username as streamer_username, s.platform_user_id as twitch_user_id FROM twitch_schedule_sync_config tssc JOIN streamers s ON tssc.streamer_id = s.streamer_id WHERE tssc.is_enabled = 1');

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

                const accessToken = await apiChecks.getTwitchAccessToken();
                if (!accessToken) {
                    logger.error('Failed to get Twitch access token. Skipping sync for all.', { category: 'twitch-schedule' });
                    break;
                }

                const response = await apiChecks.fetchTwitchSchedule(twitchUserId, accessToken);
                const scheduleSegments = response?.data?.segments || [];

                const guild = client.guilds.cache.get(guildId);
                if (!guild) {
                    logger.warn(`Guild ${guildId} not found. Removing sync config.`, { guildId, category: 'twitch-schedule' });
                    await db.execute('DELETE FROM twitch_schedule_sync_config WHERE id = ?', [config.id]);
                    continue;
                }

                const channel = guild.channels.cache.get(config.discord_channel_id);
                if (!channel) {
                    logger.warn(`Announcement channel ${config.discord_channel_id} not found. Disabling sync for ${config.streamer_username}.`, { guildId, category: 'twitch-schedule' });
                    await db.execute('UPDATE twitch_schedule_sync_config SET is_enabled = 0 WHERE id = ?', [config.id]);
                    continue;
                }

                const [[lastAnnouncedScheduleJson]] = await db.execute('SELECT last_announced_schedule FROM twitch_schedule_sync_config WHERE id = ?', [config.id]);
                const lastAnnouncedSchedule = lastAnnouncedScheduleJson ? JSON.parse(lastAnnouncedScheduleJson.last_announced_schedule || '[]') : [];

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

                await db.execute('UPDATE twitch_schedule_sync_config SET last_synced = NOW(), last_announced_schedule = ? WHERE id = ?', [JSON.stringify(scheduleSegments), config.id]);

            } catch (error) {
                logger.error(`Error processing sync for streamer ${config.streamer_username} (ID: ${config.streamer_id}).`, { guildId, category: 'twitch-schedule', error: error.stack });
            }
        }
    } catch (error) {
        logger.error('CRITICAL ERROR in syncTwitchSchedules.', { category: 'twitch-schedule', error: error.stack });
    }
}

module.exports = { syncTwitchSchedules };