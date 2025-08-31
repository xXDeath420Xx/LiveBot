const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder().setName('setcustommessage').setDescription('Sets a custom announcement message.')
    .addStringOption(o=>o.setName('platform').setDescription("Platform.").setRequired(true).addChoices(
        {name:'Twitch',value:'twitch'},
        {name:'YouTube',value:'youtube'},
        {name:'Kick',value:'kick'},
        {name:'TikTok', value: 'tiktok'},
        {name:'Trovo', value: 'trovo'}
    ))
    .addStringOption(o=>o.setName('username').setDescription('Username.').setRequired(true))
    .addStringOption(o=>o.setName('message').setDescription('Placeholders: {username}, {url}, etc. Type "default" to remove.').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction){
    const platform=interaction.options.getString('platform');
    const username=interaction.options.getString('username').toLowerCase().trim();
    let message=interaction.options.getString('message');
    if(message.toLowerCase()==='default')message=null;
    
    await interaction.deferReply({ ephemeral: true });

    try{
      const[streamers]=await db.execute('SELECT streamer_id FROM streamers WHERE platform=? AND LOWER(username)=?',[platform,username]);
      if(streamers.length===0) return interaction.editReply({content:`Streamer not found. Please add them first.`});
      
      const streamerId=streamers[0].streamer_id;
      const[subs]=await db.execute('SELECT subscription_id FROM subscriptions WHERE guild_id=? AND streamer_id=?',[interaction.guild.id,streamerId]);
      if(subs.length===0) return interaction.editReply({content:`That streamer is not tracked on this server.`});

      await db.execute('UPDATE subscriptions SET custom_message=? WHERE guild_id=? AND streamer_id=?',[message,interaction.guild.id,streamerId]);
      
      const embed=new EmbedBuilder().setColor('#00FF00').setTitle('Custom Message Updated!');

      if(message){
        const exampleMessage = message
            .replace(/{username}/g, username)
            .replace(/{url}/g, `https://...`)
            .replace(/{platform}/g, platform.charAt(0).toUpperCase() + platform.slice(1))
            .replace(/{title}/g, "Example Stream Title!")
            .replace(/{game}/g, "Example Game");
        embed.setDescription(`Message for **${username}** updated.`).addFields({name:'New Message Preview',value: exampleMessage });
      } else {
        embed.setDescription(`Message for **${username}** reset to default.`);
      }

      await interaction.editReply({embeds:[embed]});
    }catch(e){
        console.error('Set custom message error:',e);
        await interaction.editReply({content:'An error occurred.',ephemeral:true});
    }
  },
};
