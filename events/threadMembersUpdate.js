import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.ThreadMembersUpdate,
    async execute(addedMembers, removedMembers, thread) {
        try {
            if (!thread.guild) return;

            if (thread.client.isDefaultBot && await shouldIgnoreGuild(thread.guild.id)) return;

            if (addedMembers.size > 0) {
                const added = [...addedMembers.values()].map(m => m.user?.tag || m.id).join(', ');
                logger.info(`[Thread] Members added to ${thread.name}: ${added}`, {
                    guildId: thread.guild.id,
                    threadId: thread.id,
                    category: 'threadMembers'
                });

                const embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('🧵 Thread Members Added')
                    .setDescription(`Members joined thread **${thread.name}**`)
                    .addFields(
                        { name: 'Thread', value: `${thread.name} (${thread.id})`, inline: true },
                        { name: 'Members Added', value: added.substring(0, 1024) || 'Unknown', inline: false }
                    )
                    .setTimestamp();

                await sendLogEmbed(thread.guild, 'threadMembersUpdate', embed);
            }

            if (removedMembers.size > 0) {
                const removed = [...removedMembers.values()].map(m => m.user?.tag || m.id).join(', ');
                logger.info(`[Thread] Members removed from ${thread.name}: ${removed}`, {
                    guildId: thread.guild.id,
                    threadId: thread.id,
                    category: 'threadMembers'
                });

                const embed = new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('🧵 Thread Members Removed')
                    .setDescription(`Members left thread **${thread.name}**`)
                    .addFields(
                        { name: 'Thread', value: `${thread.name} (${thread.id})`, inline: true },
                        { name: 'Members Removed', value: removed.substring(0, 1024) || 'Unknown', inline: false }
                    )
                    .setTimestamp();

                await sendLogEmbed(thread.guild, 'threadMembersUpdate', embed);
            }
        } catch (error) {
            logger.error('[Thread] Error logging thread members update:', { error: error.message });
        }
    }
};
