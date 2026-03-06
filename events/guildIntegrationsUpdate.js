import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildIntegrationsUpdate,
    async execute(guild) {
        try {
            if (!guild) return;

            if (guild.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[Integrations] Integrations updated in ${guild.name}`, {
                guildId: guild.id,
                category: 'integrations'
            });

            const embed = new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('🔗 Integrations Updated')
                .setDescription(`Server integrations were modified (bots, webhooks, etc.)`)
                .addFields(
                    { name: 'Server', value: `${guild.name} (${guild.id})`, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'integrationsUpdate', embed);

            await saveAuditLog(guild.id, 'GUILD_INTEGRATIONS_UPDATE', null, guild.id, null, null, 'Integrations updated', null, null, null, {});
        } catch (error) {
            logger.error('[Integrations] Error logging integrations update:', { error: error.message });
        }
    }
};
