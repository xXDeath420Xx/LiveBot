const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
require('dotenv').config();

// Initialize the Custom Search API client
const customsearch = google.customsearch('v1');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Searches Google for a query and shows the top results.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The search query.')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const query = interaction.options.getString('query');

        if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CSE_ID) {
            console.error('[Search Command] Missing GOOGLE_API_KEY or GOOGLE_CSE_ID in .env file.');
            return interaction.editReply('The search feature is not configured correctly on the bot. Please contact the administrator.');
        }

        try {
            const res = await customsearch.cse.list({
                cx: process.env.GOOGLE_CSE_ID,
                q: query,
                auth: process.env.GOOGLE_API_KEY,
                num: 5, // Get the top 5 results
            });

            const results = res.data.items;

            if (!results || results.length === 0) {
                return interaction.editReply(`No search results found for **${query}**.`);
            }

            const embed = new EmbedBuilder()
                .setColor('#4285F4') // Google's blue color
                .setTitle(`🔍 Search Results for "${query}"`)
                .setDescription(
                    results.map((result, index) => 
                        `**${index + 1}. [${result.title}](${result.link})**\n${result.snippet}`
                    ).join('\n\n')
                );

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Search Command Error]', error);
            await interaction.editReply('An error occurred while trying to connect to the search service.');
        }
    },
};