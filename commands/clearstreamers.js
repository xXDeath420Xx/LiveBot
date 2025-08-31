const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearstreamers')
    .setDescription('⚠️ Deletes ALL tracked streamers from this server.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('⚠️ Confirmation Required')
      .setDescription('Are you absolutely sure you want to remove **ALL** streamers from this server? This action cannot be undone.')
      .setColor('#FF0000');
    
    const confirmButton = new ButtonBuilder()
        .setCustomId('confirm_clear')
        .setLabel('Yes, delete them all')
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('cancel_clear')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);
    
    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    const response = await interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true
    });

    const collectorFilter = i => i.user.id === interaction.user.id;
    try {
      const confirmation = await response.awaitMessageComponent({ filter: collectorFilter, time: 60_000 });

      if (confirmation.customId === 'confirm_clear') {
        const [result] = await db.execute('DELETE FROM subscriptions WHERE guild_id = ?', [interaction.guild.id]);
        
        await confirmation.update({
          content: `✅ Successfully removed **${result.affectedRows}** streamer subscriptions from this server.`,
          embeds: [],
          components: []
        });
      } else if (confirmation.customId === 'cancel_clear') {
        await confirmation.update({
          content: 'Action cancelled.',
          embeds: [],
          components: []
        });
      }
    } catch (e) {
      await interaction.editReply({
        content: 'Confirmation not received within 1 minute, cancelling.',
        embeds: [],
        components: []
      });
    }
  },
};
