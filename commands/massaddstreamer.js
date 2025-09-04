// commands/massaddstreamer.js (DEFINITIVE - With Channel Override & All Platforms)
const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ChannelType } = require('discord.js');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');

module.exports = {
  data: new SlashCommandBuilder().setName('massaddstreamer').setDescription('Adds multiple streamers from a platform.')
    .addStringOption(o => o.setName('platform').setDescription('The platform to add streamers to.').setRequired(true).addChoices(
        {name:'Twitch',value:'twitch'}, {name:'YouTube',value:'youtube'},
        {name:'Kick',value:'kick'}, {name:'TikTok',value:'tiktok'}, {name:'Trovo',value:'trovo'}
    ))
    .addStringOption(o => o.setName('usernames').setDescription('A comma-separated list of usernames or Channel IDs.').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Announce all streamers in this list to a specific channel.').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const platform = interaction.options.getString('platform');
    const channelOverride = interaction.options.getChannel('channel');
    const channelOverrideId = channelOverride ? channelOverride.id : null;
    const usernames = [...new Set(interaction.options.getString('usernames').split(',').map(name => name.trim()).filter(Boolean))];
    if (usernames.length === 0) return interaction.editReply('Please provide at least one username.');
    
    const added = [], failed = [], updated = [];
    let cycleTLS = null;

    try {
        if (platform === 'kick') {
            cycleTLS = await initCycleTLS({ timeout: 60000 });
        }
        for (const username of usernames) {
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

                if (!streamerInfo) { failed.push(`${username} (Not Found)`); continue; }

                let [[existing]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
                let streamerId;
                if (existing) {
                    streamerId = existing.streamer_id;
                } else {
                    const [result] = await db.execute('INSERT INTO streamers (platform,username,platform_user_id) VALUES (?,?,?)', [platform, streamerInfo.dbUsername, streamerInfo.puid]);
                    streamerId = result.insertId;
                }
                
                const [subResult] = await db.execute(
                    `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?) 
                     ON DUPLICATE KEY UPDATE announcement_channel_id = IF(? IS NOT NULL, VALUES(announcement_channel_id), announcement_channel_id)`,
                    [interaction.guild.id, streamerId, channelOverrideId, channelOverrideId]
                );

                if (subResult.affectedRows > 1) { // 2 means it was updated.
                    updated.push(username);
                } else { // 1 means it was added.
                    added.push(username);
                }
            } catch (e) { console.error(`Mass add error for ${username}:`, e); failed.push(`${username} (API/DB Error)`); }
        }
    } finally { if (cycleTLS) cycleTLS.exit(); }

    const embed = new EmbedBuilder().setTitle('Mass Add Report').setColor('#5865F2');
    const field = (l) => l.length > 0 ? l.join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        { name: `✅ Added (${added.length})`, value: field(added) },
        { name: `🔄 Updated/Already Existed (${updated.length})`, value: field(updated) },
        { name: `❌ Failed (${failed.length})`, value: field(failed) }
    );
    if(channelOverride) embed.setFooter({ text: `All successful streamers will be announced in #${channelOverride.name}` });
    
    await interaction.editReply({ embeds: [embed] });
  },
};