import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildScheduledEventUpdate,
    async execute(oldEvent, newEvent) {
        try {
            const guild = newEvent.guild;
            if (!guild) return;

            if (newEvent.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            const changes = [];
            if (oldEvent?.name !== newEvent.name) changes.push(`Name: ${oldEvent?.name || 'Unknown'} → ${newEvent.name}`);
            if (oldEvent?.description !== newEvent.description) changes.push('Description changed');
            if (oldEvent?.scheduledStartAt?.getTime() !== newEvent.scheduledStartAt?.getTime()) {
                changes.push(`Start time: ${newEvent.scheduledStartAt ? `<t:${Math.floor(newEvent.scheduledStartAt.getTime() / 1000)}:F>` : 'Unknown'}`);
            }
            if (oldEvent?.status !== newEvent.status) {
                const statuses = { 1: 'Scheduled', 2: 'Active', 3: 'Completed', 4: 'Cancelled' };
                changes.push(`Status: ${statuses[oldEvent?.status] || 'Unknown'} → ${statuses[newEvent.status] || 'Unknown'}`);
            }

            if (changes.length === 0) return;

            logger.info(`[ScheduledEvent] Event updated: ${newEvent.name}`, {
                guildId: guild.id,
                eventId: newEvent.id,
                changes,
                category: 'scheduledEvent'
            });

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📅 Scheduled Event Updated')
                .setDescription(`Event **${newEvent.name}** was modified`)
                .addFields(
                    { name: 'Event', value: newEvent.name, inline: true },
                    { name: 'Event ID', value: newEvent.id, inline: true },
                    { name: 'Changes', value: changes.join('\n'), inline: false }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'scheduledEventUpdate', embed);

            await saveAuditLog(
                guild.id,
                'SCHEDULED_EVENT_UPDATE',
                null,
                newEvent.id,
                null,
                null,
                'Scheduled event updated',
                null,
                oldEvent?.name,
                newEvent.name,
                { changes }
            );
        } catch (error) {
            logger.error('[ScheduledEvent] Error logging event update:', { error: error.message });
        }
    }
};
