/**
 * Invite Link Filter
 *
 * Blocks Discord invite links based on per-guild configuration stored in
 * `invite_filter_config`. When `use_whitelist` is enabled, consults the
 * unified user/role/channel whitelist in `automod_link_whitelist`.
 *
 * Hard safety floor: members with ManageGuild or ManageMessages always bypass
 * (this is a Discord permission-based exemption, not a configurable whitelist,
 * to prevent admins from locking themselves out of their own settings channels).
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { getConfig, isAllowed } from '../utils/link-whitelist.js';

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

        // Fast-path: no invite pattern in content → nothing to do (skip DB lookup)
        const hasInvite = INVITE_PATTERNS.some(pattern => pattern.test(message.content));
        if (!hasInvite) return;

        // Load guild config
        const config = await getConfig(message.guild.id);
        if (!config.enabled) return;

        // Hard permission floor — admins/mods always bypass
        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member && (member.permissions.has('ManageGuild') || member.permissions.has('ManageMessages'))) {
            return;
        }

        // Optional configurable whitelist
        if (config.use_whitelist && member) {
            const allowed = await isAllowed(message.guild.id, {
                userId: message.author.id,
                roleIds: [...member.roles.cache.keys()],
                channelId: message.channel.id
            });
            if (allowed) return;
        }

        // Apply configured action
        try {
            if (config.action === 'delete' || config.action === 'delete_warn') {
                await message.delete();
            }

            if (config.action === 'delete_warn') {
                const warning = await message.channel.send({
                    content: `🚫 ${message.author}, posting Discord invite links is not allowed. If you'd like to share a server, please contact staff.`
                });
                setTimeout(() => warning.delete().catch(() => {}), 10000);
            }

            logger.info(`[InviteFilter] ${config.action} triggered`, {
                guildId: message.guild.id,
                channelId: message.channel.id,
                userId: message.author.id,
                action: config.action
            });

            // Log to configured channel (fall back to no log if not set)
            if (config.log_channel_id) {
                const logChannel = message.guild.channels.cache.get(config.log_channel_id);
                if (logChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(0x9B59B6)
                        .setTitle('🔗 Invite Link Blocked')
                        .addFields(
                            { name: 'User', value: `${message.author} (${message.author.tag})`, inline: true },
                            { name: 'Channel', value: `${message.channel}`, inline: true },
                            { name: 'Action', value: config.action, inline: true },
                            { name: 'Message', value: message.content.substring(0, 500) || '*Empty*', inline: false }
                        )
                        .setTimestamp();
                    await logChannel.send({ embeds: [embed] }).catch(() => {});
                }
            }
        } catch (error) {
            logger.debug(`[InviteFilter] Action failed: ${error.message}`);
        }
    }
};
