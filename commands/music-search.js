const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music-search')
    .setDescription('Searches YouTube for a song to play.')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('The song name to search for.')
        .setRequired(true)),

  async execute(interaction) {
    const query = interaction.options.getString('query');
    const results = await musicManager.search(query);

    if (results.length === 0) {
      return interaction.reply({ content: `No results found for "${query}".`, ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('music_search_select')
        .setPlaceholder('Select a song to add to the queue')
        .addOptions(
            results.map((track, index) => ({
                label: track.title.substring(0, 100),
                description: `by ${track.author} (${track.duration})`.substring(0, 100),
                value: track.url,
            }))
        );

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'Select a song from the list below:', components: [row], ephemeral: true });
  },
};