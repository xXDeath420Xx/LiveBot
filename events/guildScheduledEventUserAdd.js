import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildScheduledEventUserAdd,
    async execute(event, user) {
        try {
            const guild = event.guild;
            if (!guild) return;

            if (event.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[ScheduledEvent] User ${user.tag} RSVPed to ${event.name}`, {
                guildId: guild.id,
                eventId: event.id,
                userId: user.id,
                category: 'scheduledEventRSVP'
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('📅 Event RSVP')
                .setDescription(`${user} is interested in **${event.name}**`)
                .addFields(
                    { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
                    { name: 'Event', value: event.name, inline: true }
                )
                .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            await sendLogEmbed(guild, 'scheduledEventUserAdd', embed);

            await saveAuditLog(
                guild.id,
                'SCHEDULED_EVENT_USER_ADD',
                user.id,
                event.id,
                null,
                null,
                'User RSVPed to event',
                null,
                null,
                null,
                { eventName: event.name }
            );
        } catch (error) {
            logger.error('[ScheduledEvent] Error logging user add:', { error: error.message });
        }
    }
};
