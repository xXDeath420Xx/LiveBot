const { SlashCommandBuilder, PermissionsBitField, MessageFlags, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removestreamer')
    .setDescription('Removes a streamer from this server and purges their active announcements.')
    .addStringOption(option =>
        option.setName('platform')
            .setDescription('The streaming platform.')
            .setRequired(true)
            .addChoices(
                { name: 'Twitch', value: 'twitch' }, { name: 'YouTube', value: 'youtube' },
                { name: 'Kick', value: 'kick' }, { name: 'TikTok', value: 'tiktok' },
                { name: 'Trovo', value: 'trovo' }
            ))
    .addStringOption(option => option.setName('username').setDescription('The case-insensitive username of the streamer.').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username');
    const guildId = interaction.guild.id;

    try {
      const [rows] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)', [platform, username]);
      const streamer = rows[0];

      if (!streamer) {
        return interaction.editReply(`Streamer \`${username}\` (${platform}) was not found in the bot's database.`);
      }
      
      let purgedMessageCount = 0;
      const [announcementsToPurge] = await db.execute(
        `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND streamer_id = ?`,
        [guildId, streamer.streamer_id]
      );

      if (announcementsToPurge.length > 0) {
        const purgePromises = announcementsToPurge.map(ann => {
            return interaction.client.channels.fetch(ann.channel_id)
                .then(channel => channel?.messages.delete(ann.message_id))
                .catch(() => {}); // Ignore errors if message/channel is already gone
        });
        await Promise.allSettled(purgePromises);
        purgedMessageCount = announcementsToPurge.length;
      }
      
      const [result] = await db.execute('DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [guildId, streamer.streamer_id]);

      if (result.affectedRows > 0 || purgedMessageCount > 0) {
        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle(`Successfully Removed ${username}`)
            .setDescription(`All data for **${username}** (${platform}) has been removed from this server.`)
            .addFields(
                { name: 'Subscriptions Removed', value: `${result.affectedRows}`, inline: true },
                { name: 'Announcements Purged', value: `${purgedMessageCount}`, inline: true }
            );
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply(`**${username}** (${platform}) was not on this server's notification list. No action taken.`);
      }
    } catch (error) {
      console.error('Remove Streamer Error:', error);
      await interaction.editReply('An error occurred while removing the streamer.');
    }
  },
};