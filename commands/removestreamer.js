const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removestreamer')
    .setDescription('Removes a streamer from the notification list.')
    .addStringOption(option =>
        option.setName('platform')
            .setDescription('The streaming platform.')
            .setRequired(true)
            .addChoices(
                { name: 'Twitch', value: 'twitch' },
                { name: 'YouTube', value: 'youtube' },
                { name: 'Kick', value: 'kick' },
                { name: 'TikTok', value: 'tiktok' },
                { name: 'Trovo', value: 'trovo' }
            ))
    .addStringOption(option =>
        option.setName('username')
            .setDescription('The username of the streamer.')
            .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username').toLowerCase().trim();

    await interaction.deferReply({ ephemeral: true });

    try {
      const [streamers] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = ?', [platform, username]);

      if (streamers.length === 0) {
        return interaction.editReply(`Streamer \`${username}\` (${platform}) was not found in the global database.`);
      }

      const streamerId = streamers[0].streamer_id;
      
      const [result] = await db.execute('DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [interaction.guild.id, streamerId]);

      if (result.affectedRows > 0) {
        await interaction.editReply(`Successfully removed **${username}** (${platform}) from this server's notification list.`);
      } else {
        await interaction.editReply(`**${username}** (${platform}) was not on this server's notification list.`);
      }
    } catch (error) {
      console.error('Remove Streamer Error:', error);
      await interaction.editReply('An error occurred.');
    }
  },
};
