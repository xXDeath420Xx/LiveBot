/**
 * Invite Link Filter
 * Blocks Discord invite links from non-staff members
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';

// Discord invite patterns
const INVITE_PATTERNS = [
    /discord\.gg\/[a-zA-Z0-9]+/i,
    /discord\.com\/invite\/[a-zA-Z0-9]+/i,
    /discordapp\.com\/invite\/[a-zA-Z0-9]+/i,
    /discord\.me\/[a-zA-Z0-9]+/i,
    /invite\.gg\/[a-zA-Z0-9]+/i
];

export default {
    name: 'messageCreate',
    async execute(message) {
        // Ignore bots, DMs, and system messages
        if (message.author.bot || !message.guild || message.system) return;

        // Check if message contains invite link
        const hasInvite = INVITE_PATTERNS.some(pattern => pattern.test(message.content));
        if (!hasInvite) return;

        // Check if user is staff
        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) {
            const isStaff = member.permissions.has('ManageGuild') ||
                member.permissions.has('ManageMessages') ||
                member.roles.cache.some(r =>
                    r.name.toLowerCase().includes('mod') ||
                    r.name.toLowerCase().includes('admin') ||
                    r.name.toLowerCase().includes('staff') ||
                    r.name.toLowerCase().includes('owner')
                );
            if (isStaff) return;
        }

        // Delete the message
        try {
            await message.delete();

            // Warn the user
            const warning = await message.channel.send({
                content: `🚫 ${message.author}, posting Discord invite links is not allowed. If you'd like to share a server, please contact staff.`
            });

            setTimeout(() => warning.delete().catch(() => {}), 10000);

            logger.info(`[InviteFilter] Deleted invite link`, {
                guildId: message.guild.id,
                channelId: message.channel.id,
                userId: message.author.id
            });

            // Log to mod-log
            const modLogChannel = message.guild.channels.cache.find(c =>
                c.name.includes('mod-log') || c.name.includes('modlog')
            );

            if (modLogChannel) {
                const embed = new EmbedBuilder()
                    .setColor(0x9B59B6)
                    .setTitle('🔗 Invite Link Blocked')
                    .addFields(
                        { name: 'User', value: `${message.author} (${message.author.tag})`, inline: true },
                        { name: 'Channel', value: `${message.channel}`, inline: true },
                        { name: 'Message', value: message.content.substring(0, 500) || '*Empty*', inline: false }
                    )
                    .setTimestamp();

                await modLogChannel.send({ embeds: [embed] }).catch(() => {});
            }

        } catch (error) {
            logger.debug(`[InviteFilter] Could not delete message: ${error.message}`);
        }
    }
};
