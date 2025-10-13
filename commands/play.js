const { SlashCommandBuilder } = require('discord.js');
const { useMainPlayer } = require('discord-player');
const { checkMusicPermissions } = require('../utils/music_helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a song or playlist.')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('A search term or URL.')
        .setRequired(true)),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    await interaction.deferReply();

    const player = useMainPlayer();
    const query = interaction.options.getString('query');

    try {
      const searchResult = await player.search(query, {
        requestedBy: interaction.user
      });

      if (!searchResult.hasTracks()) {
        return interaction.editReply({ content: 'No results found for your query.' });
      }

      await player.play(interaction.member.voice.channel, searchResult, {
        nodeOptions: {
          metadata: {
            channel: interaction.channel,
            requestedBy: interaction.user
          },
          volume: 80,
        }
      });

      const message = searchResult.playlist ? `Loading your playlist...` : `Loading your track...`;
      return interaction.editReply({ content: `⏱️ | ${message}` });

    } catch (e) {
      console.error('[Play Command Error]', e);
      return interaction.editReply({ content: `An error occurred: ${e.message}` });
    }
  },
};