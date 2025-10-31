const { db } = require("../../utils/db");
const { logger } = require("../../utils/logger");

module.exports = {
  customId: /^editstreamer_modal_/,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const subscriptionId = interaction.customId.split("_")[2];

    try {
      const customMessage = interaction.fields.getTextInputValue('custom_message');
      const overrideNickname = interaction.fields.getTextInputValue('override_nickname');
      const overrideAvatarUrl = interaction.fields.getTextInputValue('override_avatar_url');

      await db.execute(
        `UPDATE subscriptions 
         SET custom_message = ?, override_nickname = ?, override_avatar_url = ? 
         WHERE subscription_id = ?`,
        [customMessage || null, overrideNickname || null, overrideAvatarUrl || null, subscriptionId]
      );

      await interaction.editReply({ content: "Subscription updated successfully!" });

    } catch (error) {
      logger.error("[Edit Streamer Modal] Failed to update subscription:", { error });
      await interaction.editReply({ content: "An error occurred while updating the subscription." });
    }
  },
};