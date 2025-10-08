const { SlashCommandBuilder } = require('discord.js');
const { checkMusicPermissions } = require('../utils/music_helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a song from any supported source (YouTube, Spotify, SoundCloud, etc.).')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('The song URL or search query.')
        .setRequired(true)),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const query = interaction.options.getString('query');
    const member = interaction.member;

    if (!member.voice.channel) {
      return interaction.reply({ content: 'You must be in a voice channel to play music!', ephemeral: true });
    }

    if (!member.voice.channel.joinable) {
      return interaction.reply({ content: 'I cannot join your voice channel!', ephemeral: true });
    }

    await interaction.reply({ content: `🎶 Searching for \`${query}\`...` });

    try {
      await interaction.client.distube.play(member.voice.channel, query, {
        member: member,
        textChannel: interaction.channel,
      });
      // DisTube will handle the "Now Playing" message via its event listeners.
      // We edit the reply here to remove the "Searching..." message.
      await interaction.deleteReply();

    } catch (error) {
      console.error('[Play Command Error]', error);
      await interaction.editReply({ content: `❌ Error: ${error.message}` });
    }
  },
};