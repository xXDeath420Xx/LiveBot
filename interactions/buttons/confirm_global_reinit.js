const logger = require("../../utils/logger");
const fetch = require('node-fetch');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID || "365905620060340224";

module.exports = {
  customId: "confirm_global_reinit",
  async execute(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
      return interaction.reply({
        content: "You do not have permission to use this button.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });
    const dashboardPort = process.env.DASHBOARD_PORT || 3000;

    try {
      const response = await fetch(`http://localhost:${dashboardPort}/api/reinit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await response.json();
      if (response.ok && result.success) {
        await interaction.editReply({ content: `Bot re-initialization initiated: ${result.message}` });
      } else {
        await interaction.editReply({ content: `Failed to re-initialize bot: ${result.message || 'Unknown error'}` });
      }
    } catch (error) {
      logger.error("[Button] Global Reinit API call failed:", { error });
      await interaction.editReply({ content: `An error occurred while trying to re-initialize the bot: ${error.message}` });
    }
  },
};