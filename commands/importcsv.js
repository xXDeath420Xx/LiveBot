const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const Papa = require('papaparse');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const { getBrowser } = require('../utils/browserManager');

module.exports = {
  data: new SlashCommandBuilder().setName('importcsv').setDescription('Bulk adds/updates streamer subscriptions from a CSV file.')
    .addAttachmentOption(o => o.setName('csvfile')
        .setDescription('CSV Headers: platform,username,announcement_channel_id,discord_user_id,etc.')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    
  async execute(interaction) {
    const file = interaction.options.getAttachment('csvfile');
    if(!file.name.endsWith('.csv')) return interaction.reply({ content:'Invalid file type. Must be a `.csv` file.', flags: [MessageFlags.Ephemeral] });
    
    await interaction.deferReply({ ephemeral: true });

    const added = [], updated = [], failed = [];
    let browser;
    
    try {
        const fileContent = await axios.get(file.url, { responseType: 'text' }).then(res => res.data);
        const { data: rows } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
        if (!rows || rows.length === 0) {
            return interaction.editReply({ content: 'CSV is empty or missing required headers.' });
        }
      
        if (rows.some(r => ['tiktok', 'trovo'].includes(r.platform))) browser = await getBrowser();

        for (const row of rows) {
            const { platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url, announcement_channel_id } = row;
            if (!platform || !username) { 
                failed.push(`(Skipped row: missing platform/username)`); 
                continue; 
            }

            let correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
            if (discord_user_id && !correctedDiscordId) failed.push(`${username} (Invalid Discord ID)`);

            try {
                let [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?', [platform, username]);
                let streamerId = streamer?.streamer_id;

                if (!streamerId) {
                    let streamerInfo = null;
                    if (platform === 'twitch') { const u = await apiChecks.getTwitchUser(username); if (u) streamerInfo = { puid: u.id, dbUsername: u.login }; }
                    else if (platform === 'kick') { const u = await apiChecks.getKickUser(username); if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username }; }
                    else if (platform === 'youtube') { const c = await apiChecks.getYouTubeChannelId(username); if (c?.channelId) streamerInfo = { puid: c.channelId, dbUsername: c.channelName || username }; }
                    else if (['tiktok', 'trovo'].includes(platform)) streamerInfo = { puid: username, dbUsername: username };
                    
                    if (!streamerInfo) {
                        failed.push(`${username} (${platform}, Not Found via API)`);
                        continue;
                    }
                    
                    const [result] = await db.execute('INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)', [platform, streamerInfo.dbUsername, streamerInfo.puid, correctedDiscordId]);
                    streamerId = result.insertId;
                }
                
                const channelIds = (announcement_channel_id || '').split(',').map(id => id.trim()).filter(Boolean);
                const channelsToProcess = channelIds.length > 0 ? channelIds : [null];

                for (const channelId of channelsToProcess) {
                    const [subResult] = await db.execute(
                        `INSERT INTO subscriptions (guild_id, streamer_id, custom_message, override_nickname, override_avatar_url, announcement_channel_id) VALUES (?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)`,
                        [interaction.guild.id, streamerId, custom_message || null, override_nickname || null, override_avatar_url || null, channelId]
                    );

                    if (subResult.affectedRows > 1) updated.push(`${username} (Channel: ${channelId || 'Default'})`);
                    else added.push(`${username} (Channel: ${channelId || 'Default'})`);
                }
            } catch (err) { console.error(`CSV Row Error for ${username}:`, err); failed.push(`${username}(DB Error)`); }
        }
    } catch(e) {
      console.error('CSV Main Error:', e); 
      return await interaction.editReply({content:'A critical error occurred processing the file.'}); 
    }
    
    const embed = new EmbedBuilder().setTitle('CSV Import Complete').setColor('#5865F2');
    const field = (l) => l.length > 0 ? [...new Set(l)].join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        {name:`✅ Added (${[...new Set(added)].length} subscriptions)`, value: field(added)},
        {name:`🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated)},
        {name:`❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed)}
    );
    await interaction.editReply({ embeds: [embed] });
  },
};