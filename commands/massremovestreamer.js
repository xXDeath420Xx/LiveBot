const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('massremovestreamer')
    .setDescription('Removes multiple streamers.') // Simplified description
    .addStringOption(o => o.setName('platform').setDescription('The platform to remove streamers from.').setRequired(true).addChoices(
        {name:'Twitch',value:'twitch'}, {name:'YouTube',value:'youtube'},
        {name:'Kick',value:'kick'}, {name:'TikTok',value:'tiktok'}, {name:'Trovo',value:'trovo'}
    ))
    .addStringOption(o => o.setName('usernames').setDescription('A comma-separated list of usernames.').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    const platform = interaction.options.getString('platform');
    const usernames = [...new Set(interaction.options.getString('usernames').split(',').map(name => name.trim().toLowerCase()).filter(Boolean))];
    const guildId = interaction.guild.id;

    if (usernames.length === 0) {
      return interaction.reply({ content: 'Please provide at least one username.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Confirmation Required')
      .setDescription(`This will remove streamers.`) // Simplified description
      .setColor('#FF0000');

    const confirmButton = new ButtonBuilder()
        .setCustomId('confirm_mass_remove')
        .setLabel('Yes, remove them')
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('cancel_mass_remove')
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

      if (confirmation.customId === 'confirm_mass_remove') {
        await confirmation.update({ content: '⚙️ Processing... Removing streamers and purging announcements now.', embeds: [], components: [] });
        
        const removed = [], failed = [];
        let purgedMessageCount = 0;

        try {
          const usernamePlaceholders = usernames.map(() => '?').join(', ');
          const [streamers] = await db.execute(
              `SELECT streamer_id, LOWER(username) as lower_username FROM streamers WHERE platform = ? AND LOWER(username) IN (${usernamePlaceholders})`,
              [platform, ...usernames]
          );

          const streamerMap = new Map(streamers.map(s => [s.lower_username, s.streamer_id]));
          
          const idsToRemove = [];
          for(const username of usernames){
              if(streamerMap.has(username)) {
                  idsToRemove.push(streamerMap.get(username));
                  removed.push(username);
              } else {
                  failed.push(`${username} (Not Found)`);
              }
          }

          if (idsToRemove.length > 0) {
              const idPlaceholders = idsToRemove.map(() => '?').join(', ');

              const [announcementsToPurge] = await db.execute(
                `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`,
                [guildId, ...idsToRemove]
              );

              if (announcementsToPurge.length > 0) {
                const purgePromises = announcementsToPurge.map(ann => {
                    return interaction.client.channels.fetch(ann.channel_id)
                        .then(channel => channel?.messages.delete(ann.message_id))
                        .catch(() => {});
                });
                await Promise.allSettled(purgePromises);
                purgedMessageCount = announcementsToPurge.length;
              }

              await db.execute(
                  `DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`,
                  [guildId, ...idsToRemove]
              );
          }
          
          const resultEmbed = new EmbedBuilder().setTitle('Mass Remove Report').setColor('#f04747');
          const field = (l) => {
            const content = l.length > 0 ? l.join(', ') : 'None';
            return content.length > 1024 ? content.substring(0, 1020) + '...' : content;
          };

          resultEmbed.addFields(
              { name: `✅ Removed (${removed.length})`, value: field(removed) },
              { name: `❌ Failed (${failed.length})`, value: field(failed) },
              { name: `🗑️ Announcements Purged`, value: `${purgedMessageCount} message(s)` }
          );
          await interaction.editReply({ embeds: [resultEmbed] });
        } catch (error) {
          console.error('Error during mass streamer removal:', error);
          await interaction.editReply({ content: 'An error occurred while trying to remove streamers. Please try again later.' });
        }
      } else if (confirmation.customId === 'cancel_mass_remove') {
        await confirmation.update({
          content: 'Action cancelled.',
          embeds: [],
          components: []
        });
      }
    } catch (e) {
      await interaction.editReply({ content: 'Confirmation not received within 1 minute, cancelling.', embeds: [], components: [] });
    }
  },
};