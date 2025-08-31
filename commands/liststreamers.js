const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, escapeMarkdown } = require('discord.js');
const db = require('../utils/db');
const { checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo } = require('../utils/api_checks');

const sendPaginatedEmbeds = async (interaction, pages, isFirstReply, initialContent = null) => {
    if (pages.length === 0) return; let currentPage = 0;
    const uniqueId = `list:${interaction.id}`, prevId = `p:${uniqueId}`, nextId = `n:${uniqueId}`;
    const createBtns = () => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(prevId).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
        new ButtonBuilder().setCustomId(nextId).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pages.length - 1)
    );
    const payload = { content: isFirstReply ? initialContent : null, embeds: [pages[currentPage]], components: pages.length > 1 ? [createBtns()] : [], ephemeral: true };
    const res = isFirstReply ? await interaction.editReply(payload) : await interaction.followUp(payload);
    if (pages.length <= 1) return;
    const collector = res.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });
    collector.on('collect', async i => { 
      if (i.user.id !== interaction.user.id) return i.reply({ content: "You can't use these buttons.", ephemeral: true });
      i.customId===nextId ? currentPage++ : currentPage--; 
      await i.update({ embeds: [pages[currentPage]], components: [createBtns()] }); 
    });
    collector.on('end', async () => { const btns = createBtns(); btns.components.forEach(b=>b.setDisabled(true)); await res.edit({components:[btns]}).catch(()=>{}); });
};

module.exports = {
  data: new SlashCommandBuilder().setName('liststreamers').setDescription('Lists all tracked streamers and their status.').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const [rows] = await db.execute(`SELECT s.*, sub.custom_message FROM streamers s JOIN subscriptions sub ON s.streamer_id = sub.streamer_id WHERE sub.guild_id = ? ORDER BY s.platform, s.username`, [interaction.guild.id]);
      if (rows.length === 0) return interaction.editReply({ content: 'No streamers are tracked.'});
      
      await interaction.editReply({ content: `Checking ${rows.length} streamers...` });
      
      const statuses = await Promise.all(rows.map(async s => {
        let res = null;
        if(s.platform==='twitch')res=await checkTwitch(s);
        else if(s.platform==='youtube')res=await checkYouTube(s.platform_user_id);
        else if(s.platform==='kick')res=await checkKick(s.username);
        else if(s.platform==='tiktok')res=await checkTikTok(s.username);
        else if(s.platform==='trovo')res=await checkTrovo(s.username);
        let isLive = (s.platform==='twitch'&&res?.length>0)||(s.platform==='youtube'&&res?.is_live)||(s.platform==='kick'&&res?.livestream)||(s.platform==='tiktok'&&res?.is_live)||(s.platform==='trovo'&&res?.is_live);
        return { ...s, isLive };
      }));
      
      const liveCount = statuses.filter(s => s.isLive).length;
      const platformGroups = { twitch: [], youtube: [], kick: [], tiktok: [], trovo: [] };
      statuses.forEach(s => platformGroups[s.platform]?.push(s));

      const platformConfigs = [
        { name:'Twitch', color:'#9146FF', data:platformGroups.twitch }, { name:'YouTube', color:'#FF0000', data:platformGroups.youtube },
        { name:'Kick', color:'#52E252', data:platformGroups.kick }, { name:'TikTok', color:'#00f2ea', data:platformGroups.tiktok },
        { name:'Trovo', color:'#21d464', data:platformGroups.trovo }
      ];
      let isFirst = true;
      let sentAnyPages = false;

      for (const p of platformConfigs) {
        if(p.data.length===0) continue;
        sentAnyPages = true;
        const pages = [];
        for(let i=0; i<p.data.length; i+=15){
          const chunk = p.data.slice(i, i+15);
          const desc = chunk.map(r=>{
            let url='';
            if(r.platform==='twitch')url=`https://www.twitch.tv/${r.username}`;
            else if(r.platform==='youtube')url=`https://www.youtube.com/channel/${r.platform_user_id}`;
            else if(r.platform==='kick')url=`https://kick.com/${r.username}`;
            else if(r.platform==='tiktok')url=`https://www.tiktok.com/@${r.username}`;
            else if(r.platform==='trovo')url=`https://trovo.live/s/${r.username}`;
            return `${r.isLive ? '🟢' : '🔴'} [${escapeMarkdown(r.username)}](${url}) ${r.discord_user_id?`(<@${r.discord_user_id}>)`:''}`;
          }).join('\n');
          pages.push(new EmbedBuilder().setColor(p.color).setTitle(`${p.name} Streamers`).setDescription(desc).setFooter({text:`Page ${Math.floor(i/15)+1}/${Math.ceil(p.data.length/15)}`}));
        }
        await sendPaginatedEmbeds(interaction, pages, isFirst, isFirst ? `**Status check complete. Found ${liveCount} live streamer(s).**`:null);
        isFirst = false;
      }
       if (!sentAnyPages && isFirst) {
          await interaction.editReply({ content: 'Status check complete. No streamers are currently being tracked.' });
      }

    } catch (e) { 
        console.error('Error in /liststreamers:', e); 
        if(!interaction.replied) await interaction.editReply({content: 'An error occurred.'});
    }
  },
};
