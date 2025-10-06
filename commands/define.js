const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('define')
        .setDescription('Looks up a word or phrase on Urban Dictionary.')
        .addStringOption(option =>
            option.setName('term')
                .setDescription('The word or phrase to look up.')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const term = interaction.options.getString('term');

        try {
            const response = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(term)}`);
            const results = response.data.list;

            if (!results || results.length === 0) {
                return interaction.editReply(`No definitions found for **${term}**.`);
            }

            // Get the top-rated definition
            const definition = results.sort((a, b) => b.thumbs_up - a.thumbs_up)[0];

            // Clean up the definition and example text which often contain brackets
            const cleanDefinition = definition.definition.replace(/\[|\]/g, '');
            const cleanExample = definition.example ? definition.example.replace(/\[|\]/g, '') : 'No example provided.';

            const embed = new EmbedBuilder()
                .setColor('#1D2439') // Urban Dictionary's dark theme color
                .setTitle(definition.word)
                .setURL(definition.permalink)
                .setAuthor({ name: 'Urban Dictionary', iconURL: 'https://i.imgur.com/vdoHnaG.png' })
                .addFields(
                    { name: 'Definition', value: cleanDefinition.substring(0, 1024) },
                    { name: 'Example', value: cleanExample.substring(0, 1024) },
                    { name: 'Rating', value: `👍 ${definition.thumbs_up} | 👎 ${definition.thumbs_down}` }
                );
            
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Define Command Error]', error);
            await interaction.editReply('Sorry, I couldn\'t connect to the dictionary service right now.');
        }
    },
};