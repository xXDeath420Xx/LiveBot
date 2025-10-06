const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('cat')
        .setDescription('Sends a random picture of a cat.'),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const response = await axios.get('https://api.thecatapi.com/v1/images/search');
            const catImage = response.data[0].url;

            const embed = new EmbedBuilder()
                .setColor('#9B59B6')
                .setTitle('🐱 Here is a random cat!')
                .setImage(catImage)
                .setFooter({ text: 'Powered by thecatapi.com' });

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Cat Command Error]', error);
            await interaction.editReply('Sorry, I couldn\'t fetch a cat picture right now.');
        }
    },
};