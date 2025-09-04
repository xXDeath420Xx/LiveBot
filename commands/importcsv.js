// commands/importcsv.js (DEFINITIVE - With Correct Variable Scope)
const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Papa = require('papaparse');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');

module.exports = {
  data: new SlashCommandBuilder().setName('importcsv').setDescription('Bulk adds/updates streamers from a CSV file.')
    .addAttachmentOption(o=>o.setName('csvfile').setDescription("Headers: platform,username,discord_user_id,custom_message").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    
  async execute(interaction) {
    const file = interaction.options.getAttachment('csvfile');
    if(!file.name.endsWith('.csv')) return interaction.reply({ content:'Invalid file type. Must be a `.csv` file.', ephemeral:true });
    
    await interaction.deferReply({ ephemeral: true });

    // --- THIS IS THE FIX ---
    // These arrays are now declared outside the try block, making them accessible in the final `embed` creation.
    const added = [], updated = [], failed = [];
    let cycleTLS = null;
    
    try {
      const fileContent = await axios.get(file.url, { responseType: 'text' }).then(res => res.data);
      const { data: rows } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
      if (!rows || rows.length === 0) {
        return interaction.editReply({ content: 'CSV is empty or missing headers.' });
      }
      
      cycleTLS = await initCycleTLS({ timeout: 60000 });
      
      for (const row of rows) {
        const { platform, username, discord_user_id, custom_message } = row;
        if (!platform || !username) { failed.push(`(Skipped row: missing data)`); continue; }

        try {
          let streamerInfo = null;
          if (platform === 'twitch') {
              const u = await apiChecks.getTwitchUser(username);
              if (u) streamerInfo = { puid: u.id, dbUsername: u.login };
          } else if (platform === 'kick') {
              const u = await apiChecks.getKickUser(cycleTLS, username);
              if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username };
          } else if (platform === 'youtube') {
              let channelId = username;
              if (!username.startsWith('UC')) channelId = await apiChecks.getYouTubeChannelId(username);
              if (channelId) streamerInfo = { puid: channelId, dbUsername: username };
          } else {
              streamerInfo = { puid: username, dbUsername: username };
          }
          
          if (!streamerInfo) { failed.push(`${username} (${platform}, API Not Found)`); continue; }
          
          let streamerId;
          const [[existingStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
          if (existingStreamer) {
              streamerId = existingStreamer.streamer_id;
              await db.execute('UPDATE streamers SET username = ?, discord_user_id = ? WHERE streamer_id = ?', [streamerInfo.dbUsername, discord_user_id || null, streamerId]);
          } else {
              const [result] = await db.execute('INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)', [platform, streamerInfo.dbUsername, streamerInfo.puid, discord_user_id || null]);
              streamerId = result.insertId;
          }
          
          const [subResult] = await db.execute(
            `INSERT INTO subscriptions (guild_id, streamer_id, custom_message) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message)`,
            [interaction.guild.id, streamerId, custom_message || null]
          );
          
          if (subResult.affectedRows > 1) { updated.push(username); } 
          else { added.push(username); }
        } catch (err) { console.error(`CSV Row Error for ${username}:`, err.message); failed.push(`${username}(Error)`); }
      }
    } catch(e) { console.error('CSV Main Error:', e); return await interaction.editReply({content:'A critical error occurred processing the file.'}); }
    finally { if (cycleTLS) cycleTLS.exit(); }

    const embed = new EmbedBuilder().setTitle('CSV Import Complete').setColor('#5865F2');
    const field = (l) => l.length > 0 ? l.join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        {name:`✅ Added (${added.length})`, value: field(added)},
        {name:`🔄 Updated (${updated.length})`, value: field(updated)},
        {name:`❌ Failed (${failed.length})`, value: field(failed)}
    );
    await interaction.editReply({ embeds: [embed] });
  },
};