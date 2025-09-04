// commands/removestreamer.js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removestreamer')
    .setDescription('Removes a streamer from this server\'s notification list.')
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
    await interaction.deferReply({ ephemeral: true });
    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username');

    try {
      const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)', [platform, username]);

      if (!streamer) {
        return interaction.editReply(`Streamer \`${username}\` (${platform}) was not found in the bot's database.`);
      }
      
      const [result] = await db.execute('DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [interaction.guild.id, streamer.streamer_id]);

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