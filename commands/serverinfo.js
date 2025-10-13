const {SlashCommandBuilder, EmbedBuilder, ChannelType} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Displays detailed information about the current server."),

  async execute(interaction) {
    await interaction.deferReply();

    const guild = interaction.guild;

    // Fetch owner to ensure it's not cached
    const owner = await guild.fetchOwner();

    // Channel counts
    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
    const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
    const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;

    // Member counts
    const totalMembers = guild.memberCount;
    const humanMembers = guild.members.cache.filter(member => !member.user.bot).size;
    const botMembers = totalMembers - humanMembers;

    // Role count
    const roleCount = guild.roles.cache.size;

    // Verification and content filter levels
    const verificationLevels = ["None", "Low", "Medium", "High", "Very High"];
    const explicitContentFilters = ["Disabled", "Members without roles", "All members"];

    const embed = new EmbedBuilder()
      .setColor("#3498DB")
      .setTitle(`Server Info: ${guild.name}`)
      .setThumbnail(guild.iconURL({dynamic: true, size: 256}))
      .addFields(
        {name: "Owner", value: `${owner.user.tag} (${owner.id})`, inline: false},
        {name: "Server ID", value: guild.id, inline: false},
        {name: "Created On", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false},
        {name: "Members", value: `**Total:** ${totalMembers}\n**Humans:** ${humanMembers}\n**Bots:** ${botMembers}`, inline: true},
        {name: "Channels", value: `**Text:** ${textChannels}\n**Voice:** ${voiceChannels}\n**Categories:** ${categories}`, inline: true},
        {name: "Roles", value: `${roleCount}`, inline: true},
        {name: "Verification Level", value: verificationLevels[guild.verificationLevel], inline: true},
        {name: "Explicit Content Filter", value: explicitContentFilters[guild.explicitContentFilter], inline: true}
      )
      .setFooter({text: `Requested by ${interaction.user.tag}`})
      .setTimestamp();

    await interaction.editReply({embeds: [embed]});
  },
  category: "Utility",
};