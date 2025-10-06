const { SlashCommandBuilder } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Sets the loop mode for the queue.')
    .addStringOption(option =>
        option.setName('mode')
            .setDescription('The loop mode to set.')
            .setRequired(true)
            .addChoices(
                { name: 'Off', value: 'none' },
                { name: 'Loop Song', value: 'song' },
                { name: 'Loop Queue', value: 'queue' }
            )
    ),

  async execute(interaction) {
    const mode = interaction.options.getString('mode');
    
    if (musicManager.setLoop(interaction.guild.id, mode)) {
        await interaction.reply(`🔄 Loop mode set to **${mode}**.`);
    } else {
        await interaction.reply({ content: 'There is no active queue to set the loop mode for.', ephemeral: true });
    }
  },
};