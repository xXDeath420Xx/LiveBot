import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildScheduledEventDelete,
    async execute(event) {
        try {
            const guild = event.guild;
            if (!guild) return;

            if (event.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[ScheduledEvent] Event deleted: ${event.name}`, {
                guildId: guild.id,
                eventId: event.id,
                category: 'scheduledEvent'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('📅 Scheduled Event Deleted')
                .setDescription(`Event **${event.name}** was deleted`)
                .addFields(
                    { name: 'Event', value: event.name, inline: true },
                    { name: 'Event ID', value: event.id, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'scheduledEventDelete', embed);

            await saveAuditLog(
                guild.id,
                'SCHEDULED_EVENT_DELETE',
                null,
                event.id,
                null,
                null,
                'Scheduled event deleted',
                null,
                event.name,
                null,
                {}
            );
        } catch (error) {
            logger.error('[ScheduledEvent] Error logging event delete:', { error: error.message });
        }
    }
};
