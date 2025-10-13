const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Displays detailed information about a user.")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The user to get info about (defaults to you).")
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser("user") || interaction.user;
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      return interaction.editReply("Could not find that user in the server.");
    }

    const roles = member.roles.cache
      .sort((a, b) => b.position - a.position)
      .map(role => role.toString())
      .slice(0, -1); // Exclude @everyone

    const embed = new EmbedBuilder()
      .setColor(member.displayHexColor || "#95A5A6")
      .setAuthor({name: member.user.tag, iconURL: member.user.displayAvatarURL()})
      .setThumbnail(member.user.displayAvatarURL({dynamic: true, size: 256}))
      .addFields(
        {name: "User", value: `${member.user} (${member.id})`, inline: false},
        {name: "Nickname", value: member.nickname || "None", inline: true},
        {name: "Bot Account", value: member.user.bot ? "Yes" : "No", inline: true},
        {name: "Joined Server", value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true},
        {name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true},
        {name: `Roles [${roles.length}]`, value: roles.length > 0 ? roles.join(", ").substring(0, 1024) : "None"}
      )
      .setFooter({text: `Requested by ${interaction.user.tag}`})
      .setTimestamp();

    await interaction.editReply({embeds: [embed]});
  },
};