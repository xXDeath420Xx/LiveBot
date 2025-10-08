const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearstreamers')
    .setDescription('⚠️ Deletes ALL tracked streamers from this server and purges their announcements.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('⚠️ Confirmation Required')
      .setDescription('This will remove **ALL** streamer subscriptions and delete **ALL** active live announcements from this server. This action cannot be undone.')
      .setColor('#FF0000');
    
    const confirmButton = new ButtonBuilder()
        .setCustomId('confirm_clear')
        .setLabel('Yes, delete everything')
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
        await confirmation.update({ content: '⚙️ Processing... Deleting announcements and subscriptions now.', embeds: [], components: [] });
        try {
          let purgedMessageCount = 0;
          const [announcementsToPurge] = await db.execute(`SELECT message_id, channel_id FROM announcements WHERE guild_id = ?`, [interaction.guild.id]);

          if (announcementsToPurge.length > 0) {
            const purgePromises = announcementsToPurge.map(ann => {
                return interaction.client.channels.fetch(ann.channel_id)
                    .then(channel => channel?.messages.delete(ann.message_id))
                    .catch(e => logger.warn(`Failed to delete message ${ann.message_id} in channel ${ann.channel_id}: ${e.message}`));
            });
            await Promise.allSettled(purgePromises);
            purgedMessageCount = announcementsToPurge.length;
          }
        
          const [result] = await db.execute('DELETE FROM subscriptions WHERE guild_id = ?', [interaction.guild.id]);
          
          await interaction.editReply({
            content: `✅ **Operation Complete!**\nRemoved **${result.affectedRows}** streamer subscriptions.\nPurged **${purgedMessageCount}** active announcement message(s).`,
          });

        } catch (dbError) {
          logger.error('[Clear Streamers Command Error] Database error:', dbError);
          await interaction.editReply({
            content: '❌ An error occurred while trying to clear the server. Please try again later.',
          });
        }
      } else if (confirmation.customId === 'cancel_clear') {
        await confirmation.update({
          content: 'Action cancelled.',
          embeds: [],
          components: []
        });
      }
    } catch (e) {
      logger.error('[Clear Streamers Command Error] Confirmation timeout or error:', e);
      await interaction.editReply({
        content: 'Confirmation not received within 1 minute, cancelling.',
        embeds: [],
        components: []
      });
    }
  },
};