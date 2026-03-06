import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.AutoModerationRuleCreate,
    async execute(rule) {
        try {
            const guild = rule.guild;
            if (!guild) return;

            if (rule.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[AutoMod] Rule created: ${rule.name}`, {
                guildId: guild.id,
                ruleId: rule.id,
                category: 'automodRule'
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🛡️ AutoMod Rule Created')
                .setDescription(`New AutoMod rule has been created`)
                .addFields(
                    { name: 'Rule Name', value: rule.name, inline: true },
                    { name: 'Rule ID', value: rule.id, inline: true },
                    { name: 'Created By', value: rule.creatorId ? `<@${rule.creatorId}>` : 'Unknown', inline: true },
                    { name: 'Enabled', value: rule.enabled ? 'Yes' : 'No', inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'automodRuleCreate', embed);

            await saveAuditLog(
                guild.id,
                'AUTOMOD_RULE_CREATE',
                rule.creatorId,
                rule.id,
                rule.creatorId,
                null,
                'AutoMod rule created',
                null,
                null,
                rule.name,
                { enabled: rule.enabled }
            );
        } catch (error) {
            logger.error('[AutoMod] Error logging rule create:', { error: error.message });
        }
    }
};
