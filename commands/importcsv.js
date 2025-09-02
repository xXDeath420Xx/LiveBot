const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Papa = require('papaparse');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');

module.exports = {
  data: new SlashCommandBuilder().setName('importcsv').setDescription('Bulk adds/updates streamers from a CSV file.')
    .addAttachmentOption(o=>o.setName('csvfile').setDescription("Headers: platform,username,discord_user_id,custom_message").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    
  async execute(interaction) {
    const file = interaction.options.getAttachment('csvfile');
    if(!file.name.endsWith('.csv')) return interaction.reply({ content:'Invalid file type. Must be a `.csv` file.', ephemeral:true });
    
    await interaction.deferReply({ ephemeral: true });

    try {
      const fileContent = await axios.get(file.url, { responseType: 'text' }).then(res => res.data);
      const { data: rows, meta } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
      if (!rows || rows.length === 0 || !meta.fields.includes('platform') || !meta.fields.includes('username')) {
        return interaction.editReply({ content: 'CSV is empty or is missing required `platform` and `username` headers.' });
      }
      
      const added = [], updated = [], failed = [];
      
      for (const row of rows) {
        const { platform, username, discord_user_id, custom_message } = row;
        if (!platform || !username) { failed.push(`(Skipped row with missing platform/username)`); continue; }

        try {
          let streamerId;
          // Step 1: Validate streamer and get canonical data
          let validatedData;
          if (platform === 'twitch') {
              const u = await apiChecks.getTwitchUser(username);
              if (!u) { failed.push(`${username} (Twitch Not Found)`); continue; }
              validatedData = { puid: u.id, dbUsername: u.login };
          } else if (platform === 'kick') {
              const u = await apiChecks.getKickUser(username);
              if (!u) { failed.push(`${username} (Kick Not Found)`); continue; }
              validatedData = { puid: u.id.toString(), dbUsername: u.user.username };
          } else { // Simplified for others
              validatedData = { puid: username, dbUsername: username };
          }
          
          // Step 2: Find or create the global streamer record
          let [streamer] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, validatedData.puid]);
          if (streamer.length > 0) {
            streamerId = streamer[0].streamer_id;
          } else {
            const [result] = await db.execute('INSERT INTO streamers (platform,username,platform_user_id,discord_user_id) VALUES (?,?,?,?)', [platform, validatedData.dbUsername, validatedData.puid, discord_user_id || null]);
            streamerId = result.insertId;
          }
          
          // Step 3: Create or update the server-specific subscription
          const [sub] = await db.execute('SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [interaction.guild.id, streamerId]);
          if (sub.length > 0) {
            if (custom_message) await db.execute('UPDATE subscriptions SET custom_message = ? WHERE guild_id = ? AND streamer_id = ?', [custom_message, interaction.guild.id, streamerId]);
            updated.push(username);
          } else {
            await db.execute('INSERT INTO subscriptions (guild_id,streamer_id,custom_message) VALUES (?,?,?)', [interaction.guild.id, streamerId, custom_message || null]);
            added.push(username);
          }
        } catch (err) { console.error(`CSV Error for ${username}:`, err); failed.push(`${username}(DB/API Error)`); }
      }

      const embed = new EmbedBuilder().setTitle('CSV Import Complete').setColor('#0099ff');
      const field = (l) => l.length > 0 ? l.join(', ').substring(0, 1020) : 'None';
      embed.addFields(
          {name:`✅ Added (${added.length})`, value: field(added)},
          {name:`🔄 Updated (${updated.length})`, value: field(updated)},
          {name:`❌ Failed (${failed.length})`, value: field(failed)}
      );
      await interaction.editReply({ embeds: [embed] });
    } catch(e) { console.error('CSV import error:', e); await interaction.editReply({content:'A critical error occurred processing the file.'}); }
  },
};