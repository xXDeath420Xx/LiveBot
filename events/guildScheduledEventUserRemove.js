import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { themeColor } from '../core/guild-theme.js';
import { handleUserRemove } from '../core/event-reminder-manager.js';

export default {
    name: Events.GuildScheduledEventUserRemove,
    async execute(event, user) {
        try {
            const guild = event.guild;
            if (!guild) return;

            if (event.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            // Reminder / recurring-event bookkeeping (core/event-reminder-manager.js). Kept apart
            // from the log embed below so a failure in one never suppresses the other.
            try {
                await handleUserRemove(event, user);
            } catch (trackError) {
                logger.error('[ScheduledEvent] Event tracking failed', { error: trackError.message, guildId: guild.id, eventId: event.id });
            }

            logger.info(`[ScheduledEvent] User ${user.tag} un-RSVPed from ${event.name}`, {
                guildId: guild.id,
                eventId: event.id,
                userId: user.id,
                category: 'scheduledEventRSVP'
            });

            const embed = new EmbedBuilder()
                .setColor(themeColor(guild?.id, 'danger'))
                .setTitle('📅 Event RSVP Removed')
                .setDescription(`${user} is no longer interested in **${event.name}**`)
                .addFields(
                    { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
                    { name: 'Event', value: event.name, inline: true }
                )
                .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            await sendLogEmbed(guild, 'scheduledEventUserRemove', embed);

            await saveAuditLog(
                guild.id,
                'SCHEDULED_EVENT_USER_REMOVE',
                user.id,
                event.id,
                null,
                null,
                'User un-RSVPed from event',
                null,
                null,
                null,
                { eventName: event.name }
            );
        } catch (error) {
            logger.error('[ScheduledEvent] Error logging user remove:', { error: error.message });
        }
    }
};
