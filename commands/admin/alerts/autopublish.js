import { EmbedBuilder } from 'discord.js';
import logger from '../../../utils/logger.js';
import { enableAutoPublisher, disableAutoPublisher, getAutoPublisherStatus } from '../../../core/auto-publisher.js';

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  switch (subcommand) {
    case 'enable':
      try {
        const success = await enableAutoPublisher(guildId);
        if (success) {
          await interaction.reply({
            content: 'Auto-publisher has been enabled. Messages in announcement channels will now be automatically published.',
            ephemeral: true
          });

          logger.info('[Alerts AutoPublish] Enabled auto-publisher', {
            guildId,
            userId: interaction.user.id
          });
        } else {
          await interaction.reply({
            content: 'Failed to enable auto-publisher.',
            ephemeral: true
          });
        }
      } catch (error) {
        logger.error('[Alerts AutoPublish] Failed to enable auto-publisher', {
          error: error.message,
          guildId
        });
        await interaction.reply({
          content: `Failed to enable auto-publisher: ${error.message}`,
          ephemeral: true
        });
      }
      break;

    case 'disable':
      try {
        const success = await disableAutoPublisher(guildId);
        if (success) {
          await interaction.reply({
            content: 'Auto-publisher has been disabled.',
            ephemeral: true
          });

          logger.info('[Alerts AutoPublish] Disabled auto-publisher', {
            guildId,
            userId: interaction.user.id
          });
        } else {
          await interaction.reply({
            content: 'Failed to disable auto-publisher.',
            ephemeral: true
          });
        }
      } catch (error) {
        logger.error('[Alerts AutoPublish] Failed to disable auto-publisher', {
          error: error.message,
          guildId
        });
        await interaction.reply({
          content: `Failed to disable auto-publisher: ${error.message}`,
          ephemeral: true
        });
      }
      break;

    case 'status':
      try {
        const isEnabled = await getAutoPublisherStatus(guildId);
        const statusEmbed = new EmbedBuilder()
          .setTitle('Auto-Publisher Status')
          .setColor(isEnabled ? 0x00FF00 : 0xFF0000)
          .setDescription(isEnabled
            ? 'Auto-publisher is **enabled**. Messages in announcement channels will be automatically published.'
            : 'Auto-publisher is **disabled**. Messages in announcement channels will not be automatically published.')
          .setTimestamp();

        await interaction.reply({ embeds: [statusEmbed], ephemeral: true });
      } catch (error) {
        logger.error('[Alerts AutoPublish] Failed to check auto-publisher status', {
          error: error.message,
          guildId
        });
        await interaction.reply({
          content: `Failed to check auto-publisher status: ${error.message}`,
          ephemeral: true
        });
      }
      break;
  }
}
