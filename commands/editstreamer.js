const {SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("editstreamer")
    .setDescription("Edit settings for a specific streamer subscription.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addStringOption(option =>
      option.setName("username")
        .setDescription("The username of the streamer to edit.")
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const username = interaction.options.getString("username");
    const guildId = interaction.guild.id;

    try {
      const [subscriptions] = await db.execute(`
        SELECT sub.subscription_id, sub.announcement_channel_id, s.platform, s.username, s.streamer_id
        FROM subscriptions sub
        JOIN streamers s ON sub.streamer_id = s.streamer_id
        WHERE sub.guild_id = ? AND s.username = ? AND sub.team_subscription_id IS NULL
      `, [guildId, username]);

      if (subscriptions.length === 0) {
        return interaction.editReply({content: `No editable (non-team) subscriptions found for "${username}" in this server.`});
      }

      const options = await Promise.all(subscriptions.map(async (sub) => {
        const channel = sub.announcement_channel_id ? await interaction.guild.channels.fetch(sub.announcement_channel_id).catch(() => null) : null;
        const channelName = channel ? `#${channel.name}` : "Server Default";
        return {
          label: `${sub.platform.toUpperCase()} in ${channelName}`,
          description: `ID: ${sub.subscription_id}`,
          value: sub.subscription_id.toString(),
        };
      }));

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`editstreamer_select_${interaction.id}`)
        .setPlaceholder("Select a subscription to edit")
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const reply = await interaction.editReply({
        content: `Found ${subscriptions.length} subscription(s) for "${username}". Please select one to edit.`,
        components: [row]
      });

      const filter = i => i.customId === `editstreamer_select_${interaction.id}` && i.user.id === interaction.user.id;
      const collector = reply.createMessageComponentCollector({filter, time: 60000});

      collector.on("collect", async i => {
        const subscriptionId = i.values[0];
        const [[subDetails]] = await db.execute("SELECT * FROM subscriptions WHERE subscription_id = ?", [subscriptionId]);

        if (!subDetails) {
          return i.update({content: "Could not find subscription details. Please try again.", components: []});
        }

        const modal = new ModalBuilder()
          .setCustomId(`editstreamer_modal_${subscriptionId}`)
          .setTitle("Edit Subscription");

        const messageInput = new TextInputBuilder().setCustomId("custom_message").setLabel("Custom Announcement Message").setStyle(TextInputStyle.Paragraph).setValue(subDetails.custom_message || "").setRequired(false);
        const nicknameInput = new TextInputBuilder().setCustomId("override_nickname").setLabel("Custom Webhook Name").setStyle(TextInputStyle.Short).setValue(subDetails.override_nickname || "").setRequired(false);
        const avatarInput = new TextInputBuilder().setCustomId("override_avatar_url").setLabel("Custom Webhook Avatar URL").setStyle(TextInputStyle.Short).setValue(subDetails.override_avatar_url || "").setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(messageInput),
          new ActionRowBuilder().addComponents(nicknameInput),
          new ActionRowBuilder().addComponents(avatarInput)
        );

        await i.showModal(modal);
        collector.stop(); // Modal has been shown, stop listening for select menu interaction
      });

      collector.on("end", async (collected, reason) => {
        if (reason === "time" && collected.size === 0) {
          await interaction.editReply({content: "You did not make a selection in time.", components: []});
        } else if (reason !== "time") {
          // If the collector ended for a reason other than timeout (e.g., 'stop' was called),
          // and a selection was made, the interaction has already been updated by i.update.
          // No need to editReply again.
        }
        if (reason === "time" && collected.size === 0) {
          logger.info(`[EditStreamer] Select menu interaction timed out for user ${interaction.user.id}.`);
        }
      });

    } catch (error) {
      logger.error("Error executing editstreamer command:", {error});
      interaction.editReply({content: "An error occurred while fetching subscription data."});
    }
  },
};