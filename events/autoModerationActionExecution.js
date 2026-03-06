import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.AutoModerationActionExecution,
    async execute(action) {
        try {
            const guild = action.guild;
            if (!guild) return;

            if (action.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            const actionTypes = {
                1: 'Block Message',
                2: 'Send Alert',
                3: 'Timeout User',
                4: 'Block Member Interaction'
            };

            const triggerTypes = {
                1: 'Keyword',
                3: 'Spam',
                4: 'Keyword Preset',
                5: 'Mention Spam',
                6: 'Member Profile'
            };

            logger.info(`[AutoMod] Action executed in ${guild.name}`, {
                guildId: guild.id,
                userId: action.userId,
                ruleId: action.ruleId,
                actionType: action.action.type,
                category: 'automod'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🛡️ AutoMod Action')
                .setDescription(`AutoMod took action against a message`)
                .addFields(
                    { name: 'User', value: `<@${action.userId}> (${action.userId})`, inline: true },
                    { name: 'Action', value: actionTypes[action.action.type] || `Type ${action.action.type}`, inline: true },
                    { name: 'Trigger', value: triggerTypes[action.ruleTriggerType] || `Type ${action.ruleTriggerType}`, inline: true },
                    { name: 'Channel', value: action.channelId ? `<#${action.channelId}>` : 'Unknown', inline: true },
                    { name: 'Rule ID', value: action.ruleId || 'Unknown', inline: true }
                )
                .setTimestamp();

            if (action.content) {
                embed.addFields({ name: 'Content', value: action.content.substring(0, 1024), inline: false });
            }

            if (action.matchedKeyword) {
                embed.addFields({ name: 'Matched Keyword', value: `\`${action.matchedKeyword}\``, inline: true });
            }

            if (action.matchedContent) {
                embed.addFields({ name: 'Matched Content', value: action.matchedContent.substring(0, 256), inline: false });
            }

            await sendLogEmbed(guild, 'automodAction', embed);

            await saveAuditLog(
                guild.id,
                'AUTOMOD_ACTION',
                action.userId,
                action.messageId || null,
                null,
                action.channelId,
                actionTypes[action.action.type] || 'AutoMod Action',
                null,
                null,
                null,
                {
                    ruleId: action.ruleId,
                    triggerType: action.ruleTriggerType,
                    content: action.content?.substring(0, 500),
                    matchedKeyword: action.matchedKeyword
                }
            );
        } catch (error) {
            logger.error('[AutoMod] Error logging action:', {
                error: error.message,
                stack: error.stack
            });
        }
    }
};
