const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Papa = require('papaparse');
const db = require('../utils/db');
const { getTwitchUser, checkKick, checkTrovo } = require('../utils/api_checks');

module.exports = {
  data: new SlashCommandBuilder().setName('importcsv').setDescription('Adds/updates streamers from a CSV.')
    .addAttachmentOption(o=>o.setName('csvfile').setDescription("Headers: platform,username,discord_user_id,custom_message").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    
  async execute(interaction) {
    const file=interaction.options.getAttachment('csvfile');
    if(!file.name.endsWith('.csv'))return interaction.reply({content:'Invalid file. Must be `.csv`.',ephemeral:true});
    await interaction.deferReply({ephemeral:true});
    try{
      const fileContent=await axios.get(file.url,{responseType:'text'}).then(res=>res.data);
      const parseResult=Papa.parse(fileContent,{header:true,skipEmptyLines:true});
      const rows=parseResult.data;
      if(!rows||rows.length===0||!rows[0].platform||!rows[0].username) return interaction.editReply({content:'CSV is empty or missing `platform` and `username` headers.'});
      
      const added=[],updated=[],failed=[];
      
      for(const row of rows){
        const platform=row.platform?.toLowerCase().trim();
        const username=row.username?.trim();
        const discordId=row.discord_user_id?.trim()||null;
        const customMsg=row.custom_message?.trim()||null;

        if(!platform||!username){failed.push(`(Malformed Row)`); continue;}
        if(!['twitch','youtube','kick', 'tiktok', 'trovo'].includes(platform)){failed.push(`${username || 'N/A'} (Invalid Platform)`); continue;}

        try{
          let [streamers]=await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = ?',[platform, username.toLowerCase()]);
          let streamerId;

          if(streamers.length > 0){
            streamerId=streamers[0].streamer_id;
            if(discordId) await db.execute('UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?',[discordId,streamerId]);
          } else {
            let puid = null;
            let dbUsername = username;

            if(platform==='twitch'){const u=await getTwitchUser(username);if(!u){failed.push(`${username}(Not Found)`);continue;} puid=u.id; dbUsername=u.login;}
            else if(platform==='youtube'){if(!username.startsWith('UC')){failed.push(`${username}(YouTube requires Channel ID)`);continue;}puid=username;}
            else if(platform==='kick'){const u=await checkKick(username);if(!u||!u.id){failed.push(`${username}(Not Found)`);continue;} puid=u.id.toString();dbUsername=u.user.username;}
            else if(platform==='tiktok'){puid=username;}
            else if(platform==='trovo'){const u=await checkTrovo(username);if(!u||!u.user_id){failed.push(`${username}(Not Found)`);continue;}puid=u.user_id;dbUsername=u.username;}

            const[result]=await db.execute('INSERT INTO streamers (platform,username,platform_user_id,discord_user_id) VALUES (?,?,?,?)',[platform,dbUsername,puid,discordId]);
            streamerId=result.insertId;
          }
          
          const[subs]=await db.execute('SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',[interaction.guild.id,streamerId]);
          if(subs.length>0){
            if (customMsg) {
              await db.execute('UPDATE subscriptions SET custom_message = ? WHERE guild_id = ? AND streamer_id = ?',[customMsg,interaction.guild.id,streamerId]);
              updated.push(username);
            }
          } else {
            await db.execute('INSERT INTO subscriptions (guild_id,streamer_id,custom_message) VALUES (?,?,?)',[interaction.guild.id,streamerId,customMsg]);
            added.push(username);
          }
        }catch(err){console.error(`CSV Error for ${username}:`,err);failed.push(`${username}(DB/API Error)`);}
      }

      const embed=new EmbedBuilder().setTitle('CSV Import Complete').setColor('#0099ff');
      const createField=(l)=>l.length>0?l.join(', ').substring(0,1020):'None';
      embed.addFields({name:`✅ Added(${added.length})`,value:createField(added)},{name:`🔄 Updated(${updated.length})`,value:createField(updated)},{name:`❌ Failed(${failed.length})`,value:createField(failed)});
      await interaction.editReply({embeds:[embed]});
    }catch(e){console.error('CSV import error:',e);await interaction.editReply({content:'A critical error occurred.'});}
  },
};
