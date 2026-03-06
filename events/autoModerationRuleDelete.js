import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.AutoModerationRuleDelete,
    async execute(rule) {
        try {
            const guild = rule.guild;
            if (!guild) return;

            if (rule.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[AutoMod] Rule deleted: ${rule.name}`, {
                guildId: guild.id,
                ruleId: rule.id,
                category: 'automodRule'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🛡️ AutoMod Rule Deleted')
                .setDescription(`AutoMod rule has been deleted`)
                .addFields(
                    { name: 'Rule Name', value: rule.name, inline: true },
                    { name: 'Rule ID', value: rule.id, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'automodRuleDelete', embed);

            await saveAuditLog(
                guild.id,
                'AUTOMOD_RULE_DELETE',
                null,
                rule.id,
                null,
                null,
                'AutoMod rule deleted',
                null,
                rule.name,
                null,
                {}
            );
        } catch (error) {
            logger.error('[AutoMod] Error logging rule delete:', { error: error.message });
        }
    }
};
