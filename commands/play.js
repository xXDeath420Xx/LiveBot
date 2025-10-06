const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a song from YouTube in your voice channel.')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('The YouTube URL or search query for the song.')
        .setRequired(true)),

  async execute(interaction) {
    const query = interaction.options.getString('query');
    const member = interaction.member;

    if (!member.voice.channel) {
      return interaction.reply({ content: 'You must be in a voice channel to play music!', ephemeral: true });
    }

    if (!member.voice.channel.joinable) {
      return interaction.reply({ content: 'I cannot join your voice channel!', ephemeral: true });
    }

    await interaction.deferReply();

    try {
      const result = await musicManager.play(member.voice.channel, query, interaction.user);
      
      const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setAuthor({ name: result.addedToQueue ? 'Added to Queue' : 'Now Playing' })
        .setTitle(result.song.title)
        .setURL(result.song.url)
        .setThumbnail(result.song.thumbnail)
        .addFields(
          { name: 'Channel', value: result.song.channel, inline: true },
          { name: 'Duration', value: result.song.duration, inline: true }
        )
        .setFooter({ text: `Requested by ${interaction.user.tag}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('[Play Command Error]', error);
      await interaction.editReply({ content: `❌ Error: ${error.message}` });
    }
  },
};