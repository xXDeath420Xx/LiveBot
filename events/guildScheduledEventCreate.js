import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildScheduledEventCreate,
    async execute(event) {
        try {
            const guild = event.guild;
            if (!guild) return;

            if (event.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[ScheduledEvent] Event created: ${event.name}`, {
                guildId: guild.id,
                eventId: event.id,
                category: 'scheduledEvent'
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('📅 Scheduled Event Created')
                .setDescription(`New event: **${event.name}**`)
                .addFields(
                    { name: 'Event', value: event.name, inline: true },
                    { name: 'Created By', value: event.creatorId ? `<@${event.creatorId}>` : 'Unknown', inline: true },
                    { name: 'Start Time', value: event.scheduledStartAt ? `<t:${Math.floor(event.scheduledStartAt.getTime() / 1000)}:F>` : 'Unknown', inline: true }
                )
                .setTimestamp();

            if (event.description) {
                embed.addFields({ name: 'Description', value: event.description.substring(0, 1024), inline: false });
            }

            if (event.channel) {
                embed.addFields({ name: 'Location', value: `${event.channel}`, inline: true });
            } else if (event.entityMetadata?.location) {
                embed.addFields({ name: 'Location', value: event.entityMetadata.location, inline: true });
            }

            if (event.image) {
                embed.setImage(event.coverImageURL({ size: 512 }));
            }

            await sendLogEmbed(guild, 'scheduledEventCreate', embed);

            await saveAuditLog(
                guild.id,
                'SCHEDULED_EVENT_CREATE',
                event.creatorId,
                event.id,
                event.creatorId,
                event.channelId,
                'Scheduled event created',
                null,
                null,
                event.name,
                { startTime: event.scheduledStartAt?.toISOString(), description: event.description }
            );
        } catch (error) {
            logger.error('[ScheduledEvent] Error logging event create:', { error: error.message });
        }
    }
};
