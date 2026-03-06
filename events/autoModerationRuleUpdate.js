import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.AutoModerationRuleUpdate,
    async execute(oldRule, newRule) {
        try {
            const guild = newRule.guild;
            if (!guild) return;

            if (newRule.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            const changes = [];
            if (oldRule?.name !== newRule.name) changes.push(`Name: ${oldRule?.name || 'Unknown'} → ${newRule.name}`);
            if (oldRule?.enabled !== newRule.enabled) changes.push(`Enabled: ${oldRule?.enabled ? 'Yes' : 'No'} → ${newRule.enabled ? 'Yes' : 'No'}`);

            if (changes.length === 0) return;

            logger.info(`[AutoMod] Rule updated: ${newRule.name}`, {
                guildId: guild.id,
                ruleId: newRule.id,
                changes,
                category: 'automodRule'
            });

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🛡️ AutoMod Rule Updated')
                .setDescription(`AutoMod rule has been modified`)
                .addFields(
                    { name: 'Rule Name', value: newRule.name, inline: true },
                    { name: 'Rule ID', value: newRule.id, inline: true },
                    { name: 'Changes', value: changes.join('\n') || 'Unknown changes', inline: false }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'automodRuleUpdate', embed);

            await saveAuditLog(
                guild.id,
                'AUTOMOD_RULE_UPDATE',
                null,
                newRule.id,
                null,
                null,
                'AutoMod rule updated',
                null,
                oldRule?.name,
                newRule.name,
                { changes }
            );
        } catch (error) {
            logger.error('[AutoMod] Error logging rule update:', { error: error.message });
        }
    }
};
