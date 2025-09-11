// commands/setup-requests.js (DEFINITIVE - New Feature)
const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-requests')
    .setDescription('Creates the panel for users to request live announcements.')
    .addChannelOption(option => 
        option.setName('channel')
            .setDescription('The channel where the request panel will be posted.')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  async execute(interaction) {
    const targetChannel = interaction.options.getChannel('channel');

    // Create the message embed
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Request Live Stream Announcements')
      .setDescription('Click the button below to open a form and add your stream to the announcement list for this server.\n\nPlease have your exact username or channel ID ready.')
      .setFooter({ text: 'CertiFried Announcer | User Requests' });
    
    // Create the button
    const requestButton = new ButtonBuilder()
        .setCustomId('request_announcement_button') // This ID is crucial for the interaction handler
        .setLabel('Request Announcements')
        .setStyle(ButtonStyle.Success)
        .setEmoji('📡');
    
    const row = new ActionRowBuilder().addComponents(requestButton);

    try {
      await targetChannel.send({ embeds: [embed], components: [row] });
      await interaction.reply({
        content: `✅ Successfully posted the request panel in ${targetChannel}.`,
        ephemeral: true
      });
    } catch (error) {
      console.error("Failed to post request panel:", error);
      await interaction.reply({
        content: `❌ Could not post the panel in ${targetChannel}. Please ensure I have permissions to send messages and embeds there.`,
        ephemeral: true
      });
    }
  },
};