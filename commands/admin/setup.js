import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { renderStep } from '../../core/setup-wizard.js';
import logger from '../../utils/logger.js';

export default {
  category: 'admin',
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Guided walkthrough to turn the bot\'s features on or off, one at a time')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    try {
      const payload = await renderStep(interaction.guildId, 0);
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('[setup] start failed', { err: err.message });
      const msg = { content: `Couldn't start setup: ${err.message}`, flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  },
};
