"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const twitchApi = __importStar(require("../utils/twitch-api"));
const discord_js_1 = require("discord.js");
async function syncTwitchSchedules(client) {
    try {
        const [syncConfigs] = await db_1.default.execute('SELECT tssc.*, s.username as streamer_username, s.platform_user_id as twitch_user_id FROM twitch_schedule_sync_config tssc JOIN streamers s ON tssc.streamer_id = s.streamer_id WHERE tssc.is_enabled = 1');
        if (syncConfigs.length === 0) {
            return;
        }
        logger_1.default.info(`Found ${syncConfigs.length} active sync configurations.`, { category: 'twitch-schedule' });
        for (const config of syncConfigs) {
            const guildId = config.guild_id;
            try {
                const twitchUserId = config.twitch_user_id;
                if (!twitchUserId) {
                    logger_1.default.warn(`Streamer ${config.streamer_username} (ID: ${config.streamer_id}) does not have a Twitch user ID. Skipping sync.`, { guildId, category: 'twitch-schedule' });
                    continue;
                }
                const response = await twitchApi.getStreamSchedule(twitchUserId);
                if (!response) {
                    logger_1.default.warn(`Failed to fetch Twitch schedule for user ${twitchUserId}. Skipping sync for this user.`, { guildId, category: 'twitch-schedule' });
                    continue;
                }
                const scheduleSegments = response?.data?.data?.segments || [];
                const guild = client.guilds.cache.get(guildId);
                if (!guild) {
                    logger_1.default.warn(`Guild ${guildId} not found. Removing sync config.`, { guildId, category: 'twitch-schedule' });
                    await db_1.default.execute('DELETE FROM twitch_schedule_sync_config WHERE id = ?', [config.id]);
                    continue;
                }
                const channel = guild.channels.cache.get(config.discord_channel_id);
                if (!channel) {
                    logger_1.default.warn(`Announcement channel ${config.discord_channel_id} not found. Disabling sync for ${config.streamer_username}.`, { guildId, category: 'twitch-schedule' });
                    await db_1.default.execute('UPDATE twitch_schedule_sync_config SET is_enabled = 0 WHERE id = ?', [config.id]);
                    continue;
                }
                const [[lastAnnouncedScheduleJson]] = await db_1.default.execute('SELECT last_announced_schedule FROM twitch_schedule_sync_config WHERE id = ?', [config.id]);
                const lastAnnouncedSchedule = lastAnnouncedScheduleJson && lastAnnouncedScheduleJson.last_announced_schedule ? JSON.parse(lastAnnouncedScheduleJson.last_announced_schedule) : [];
                const newSegments = scheduleSegments.filter(segment => !lastAnnouncedSchedule.some(lastSegment => lastSegment.id === segment.id));
                if (newSegments.length > 0) {
                    logger_1.default.info(`New schedule segments found for ${config.streamer_username}. Announcing...`, { guildId, category: 'twitch-schedule' });
                    for (const segment of newSegments) {
                        const startTime = new Date(segment.start_time);
                        const endTime = new Date(segment.end_time);
                        const title = segment.title || 'Untitled Segment';
                        const category = segment.category?.name || 'Just Chatting';
                        const embed = new discord_js_1.EmbedBuilder()
                            .setColor('#9146FF')
                            .setTitle(`Twitch Schedule Update for ${config.streamer_username}`)
                            .setDescription(`**${title}**\n` +
                            `Category: ${category}\n` +
                            `Time: <t:${Math.floor(startTime.getTime() / 1000)}:f> - <t:${Math.floor(endTime.getTime() / 1000)}:t> (<t:${Math.floor(startTime.getTime() / 1000)}:R>)`)
                            .setURL(`https://www.twitch.tv/${config.streamer_username}/schedule`)
                            .setTimestamp();
                        let content = config.custom_message ? config.custom_message.replace(/{streamer}/g, config.streamer_username) : ``;
                        if (config.mention_role_id) {
                            content = `${content} <@&${config.mention_role_id}>`;
                        }
                        await channel.send({ content: content.trim(), embeds: [embed] });
                    }
                }
                await db_1.default.execute('UPDATE twitch_schedule_sync_config SET last_synced = NOW(), last_announced_schedule = ? WHERE id = ?', [JSON.stringify(scheduleSegments), config.id]);
            }
            catch (error) {
                const err = error;
                logger_1.default.error(`Error processing sync for streamer ${config.streamer_username} (ID: ${config.streamer_id}).`, { guildId, category: 'twitch-schedule', error: err.stack });
            }
        }
    }
    catch (error) {
        const err = error;
        logger_1.default.error('CRITICAL ERROR in syncTwitchSchedules.', { category: 'twitch-schedule', error: err.stack });
    }
}
module.exports = { syncTwitchSchedules };
