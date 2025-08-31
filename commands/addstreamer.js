const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const db = require('../utils/db');
const { getTwitchUser, checkKick, checkTrovo } = require('../utils/api_checks');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addstreamer')
        .setDescription('Adds a streamer to the notification list for this server.')
        .addStringOption(option =>
            option.setName('platform')
                .setDescription('The streaming platform.')
                .setRequired(true)
                .addChoices(
                    { name: 'Twitch', value: 'twitch' },
                    { name: 'YouTube', value: 'youtube' },
                    { name: 'Kick', value: 'kick' },
                    { name: 'TikTok', value: 'tiktok' },
                    { name: 'Trovo', value: 'trovo' }
                ))
        .addStringOption(option =>
            option.setName('username')
                .setDescription('The username, or Channel ID for YouTube.')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('discorduser')
                .setDescription('Link a Discord user for the "Live" role (optional).')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
        
    async execute(interaction) {
        const platform = interaction.options.getString('platform');
        const username = interaction.options.getString('username').trim();
        const discordUser = interaction.options.getUser('discorduser');
        const discord_user_id = discordUser ? discordUser.id : null;
        const guild_id = interaction.guild.id;

        await interaction.deferReply({ ephemeral: true });

        try {
            let [existing] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = ?', [platform, username.toLowerCase()]);
            let streamerId;

            if (existing.length > 0) {
                streamerId = existing[0].streamer_id;
                if (discord_user_id) {
                    await db.execute('UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?', [discord_user_id, streamerId]);
                }
            } else {
                 let platform_user_id = null, validatedUsername = username;
                
                if (platform === 'twitch') {
                    const twitchUser = await getTwitchUser(username);
                    if (!twitchUser) return interaction.editReply(`Could not find a Twitch user named \`${username}\`.`);
                    platform_user_id = twitchUser.id;
                    validatedUsername = twitchUser.login;
                } else if (platform === 'youtube') {
                    if (!username.startsWith('UC')) return interaction.editReply(`For YouTube, you must provide the Channel ID (it starts with 'UC').`);
                    platform_user_id = username;
                } else if (platform === 'kick') {
                    const kickData = await checkKick(username);
                    if (!kickData || !kickData.id) return interaction.editReply(`Could not find a Kick user named \`${username}\`.`);
                    platform_user_id = kickData.id.toString();
                    validatedUsername = kickData.user.username;
                } else if (platform === 'tiktok') {
                    platform_user_id = username;
                } else if (platform === 'trovo') {
                    const trovoData = await checkTrovo(username);
                    if (!trovoData || !trovoData.user_id) return interaction.editReply(`Could not find a Trovo user named \`${username}\`.`);
                    platform_user_id = trovoData.user_id;
                    validatedUsername = trovoData.username;
                }
                
                const [result] = await db.execute('INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)', [platform, validatedUsername, platform_user_id, discord_user_id]);
                streamerId = result.insertId;
            }

            const [subscriptionResult] = await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id) VALUES (?, ?)', [guild_id, streamerId]);

            if (subscriptionResult.affectedRows > 0) {
                await interaction.editReply(`Successfully added **${username}** (${platform}) to the notification list.`);
            } else {
                await interaction.editReply(`**${username}** (${platform}) is already on the notification list.`);
            }
        } catch (error) {
            console.error('[AddStreamer Command] Error:', error);
            await interaction.editReply('An error occurred while trying to add the streamer.');
        }
    }
};
