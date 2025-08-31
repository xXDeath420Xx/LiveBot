const { SlashCommandBuilder, ChannelType, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder().setName('setchannel').setDescription('Sets the channel for live stream announcements.')
    .addChannelOption(o=>o.setName('channel').setDescription('The channel for notifications').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction){
    const channel=interaction.options.getChannel('channel');
    try{
      await db.execute('INSERT INTO guilds (guild_id,announcement_channel_id) VALUES (?,?) ON DUPLICATE KEY UPDATE announcement_channel_id=?',[interaction.guild.id,channel.id,channel.id]);
      await interaction.reply({embeds:[new EmbedBuilder().setColor('#00FF00').setTitle('Channel Set!').setDescription(`Announcements will now be sent to ${channel}.`)],ephemeral:true});
    }catch(e){console.error(e);await interaction.reply({content:'An error occurred.',ephemeral:true});}
  },
};
