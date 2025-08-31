const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const { getTwitchUser, checkKick, checkTrovo } = require('../utils/api_checks');

module.exports = {
  data: new SlashCommandBuilder().setName('massaddstreamer').setDescription('Adds multiple streamers from a platform.')
    .addStringOption(o => o.setName('platform').setDescription('The streaming platform').setRequired(true).addChoices(
        {name:'Twitch',value:'twitch'},
        {name:'YouTube',value:'youtube'},
        {name:'Kick',value:'kick'},
        {name:'TikTok',value:'tiktok'},
        {name:'Trovo',value:'trovo'}
    ))
    .addStringOption(o => o.setName('usernames').setDescription('A comma-separated list of usernames or YT channel IDs').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    const platform = interaction.options.getString('platform');
    const usernames = [...new Set(interaction.options.getString('usernames').split(',').map(name => name.trim()).filter(name => name))];
    if (usernames.length === 0) return interaction.reply({ content: 'Please provide at least one username.', ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });

    const added = [], failed = [], existed = [];

    for (const username of usernames) {
        try {
            const [existingSub] = await db.execute(`
                SELECT sub.subscription_id FROM subscriptions sub
                JOIN streamers s ON s.streamer_id = sub.streamer_id
                WHERE s.platform = ? AND LOWER(s.username) = ? AND sub.guild_id = ?`,
                [platform, username.toLowerCase(), interaction.guild.id]
            );

            if (existingSub.length > 0) {
                existed.push(username);
                continue;
            }

            let [existingStreamer] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = ?', [platform, username.toLowerCase()]);
            let streamerId;

            if (existingStreamer.length > 0) {
                streamerId = existingStreamer[0].streamer_id;
            } else {
                let puid = null;
                let dbUsername = username;
                if (platform === 'twitch') {
                    const user = await getTwitchUser(username);
                    if (!user) { failed.push(`${username} (Not Found)`); continue; }
                    puid = user.id; dbUsername = user.login;
                } else if (platform === 'youtube') {
                    if (!username.startsWith('UC')) {failed.push(`${username} (YT requires Channel ID)`); continue;}
                    puid = username;
                } else if (platform === 'kick') {
                    const user = await checkKick(username);
                    if (!user || !user.id) { failed.push(`${username} (Not Found)`); continue; }
                    puid = user.id.toString(); dbUsername = user.user.username;
                } else if (platform === 'tiktok') {
                    puid = username;
                } else if (platform === 'trovo') {
                    const user = await checkTrovo(username);
                    if (!user || !user.user_id) { failed.push(`${username} (Not Found)`); continue; }
                    puid = user.user_id; dbUsername = user.username;
                }

                 [existingStreamer] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = ?', [platform, dbUsername.toLowerCase()]);
                 if(existingStreamer.length > 0) {
                     streamerId = existingStreamer[0].streamer_id;
                 } else {
                    const [result] = await db.execute('INSERT INTO streamers (platform,username,platform_user_id) VALUES (?,?,?)', [platform, dbUsername, puid]);
                    streamerId = result.insertId;
                 }
            }
            
            const [subResult] = await db.execute('INSERT INTO subscriptions (guild_id,streamer_id) VALUES (?,?)', [interaction.guild.id, streamerId]);
            if (subResult.affectedRows > 0) added.push(username);
            
        } catch (e) {
            console.error(`Mass add error for ${username}:`, e);
            failed.push(`${username} (API/DB Error)`);
        }
    }

    const embed = new EmbedBuilder().setTitle('Mass Add Report').setColor('#0099ff');
    const createField = l => l.length > 0 ? l.join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        { name: `✅ Added (${added.length})`, value: createField(added) },
        { name: `ℹ️ Already Existed (${existed.length})`, value: createField(existed) },
        { name: `❌ Failed (${failed.length})`, value: createField(failed) }
    );
    await interaction.editReply({ embeds: [embed] });
  },
};
