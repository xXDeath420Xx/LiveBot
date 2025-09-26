const { EmbedBuilder } = require("discord.js");
const { pool: db } = require("../../utils/db");
const logger = require("../../utils/logger");
const { startupCleanup } = require("../../core/startup"); // Import the startupCleanup function

module.exports = {
    customId: "confirm_reinit",
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guildId;
        const client = interaction.client;

        const statusEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle("Reinitialization in Progress...")
            .setDescription("Starting server-specific reinitialization. This may take a moment.");

        try {
            await interaction.editReply({ embeds: [statusEmbed] });

            // Call the shared startupCleanup logic, scoped to this specific guild
            await startupCleanup(client, guildId); 

            const successEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle("✅ Server Reinitialization Complete")
                .setDescription("The server has been successfully reinitialized. The bot will now build a fresh set of announcements and re-evaluate live roles on its next cycle.");

            await interaction.editReply({ embeds: [successEmbed], components: [] });

        } catch (error) {
            logger.error(`[Reinit] A critical error occurred during reinitialization for guild ${guildId}: ${error.message}`, {error});
            const errorEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("❌ Error")
                .setDescription("A critical error occurred during reinitialization. Please check the bot's logs for more details.");
            await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }
    },
};