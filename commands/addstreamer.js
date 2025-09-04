const { SlashCommandBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addstreamer')
        .setDescription('Adds a streamer to the notification list and optionally links a Discord user.')
        .addStringOption(option =>
            option.setName('platform').setDescription('The streaming platform.').setRequired(true)
                .addChoices(
                    { name: 'Twitch', value: 'twitch' }, { name: 'YouTube', value: 'youtube' },
                    { name: 'Kick', value: 'kick' }, { name: 'TikTok', value: 'tiktok' },
                    { name: 'Trovo', value: 'trovo' }
                ))
        .addStringOption(option => option.setName('username').setDescription('The username, @handle, or Channel ID.').setRequired(true))
        .addUserOption(option => option.setName('user').setDescription('The Discord user to link to this streamer for the Live Role.').setRequired(false))
        .addChannelOption(option => option.setName('channel').setDescription('Override the default announcement channel for this streamer.').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const platform = interaction.options.getString('platform');
        const usernameInput = interaction.options.getString('username').trim();
        const discordUser = interaction.options.getUser('user'); // Get the optional user object
        const discordUserId = discordUser ? discordUser.id : null;
        const channelOverride = interaction.options.getChannel('channel');
        const channelOverrideId = channelOverride ? channelOverride.id : null;

        let cycleTLS = null;
        try {
            let streamerInfo = null;

            // Platform-specific validation to get a unique ID (puid) and a canonical username (dbUsername)
            if (platform === 'twitch') {
                const twitchUser = await apiChecks.getTwitchUser(usernameInput);
                if (!twitchUser) return interaction.editReply(`Could not find a Twitch user named \`${usernameInput}\`.`);
                streamerInfo = { puid: twitchUser.id, dbUsername: twitchUser.login };
            } else if (platform === 'kick') {
                cycleTLS = await initCycleTLS({ timeout: 60000 });
                const kickUser = await apiChecks.getKickUser(cycleTLS, usernameInput);
                if (!kickUser) return interaction.editReply(`Could not find a Kick user named \`${usernameInput}\`.`);
                streamerInfo = { puid: kickUser.id.toString(), dbUsername: kickUser.user.username };
            } else if (platform === 'youtube') {
                let channelId = usernameInput;
                if (!usernameInput.startsWith('UC')) channelId = await apiChecks.getYouTubeChannelId(usernameInput);
                if (!channelId) return interaction.editReply(`Could not find a YouTube channel for \`${usernameInput}\`.`);
                streamerInfo = { puid: channelId, dbUsername: usernameInput };
            } else {
                streamerInfo = { puid: usernameInput, dbUsername: usernameInput };
            }

            // --- THIS IS THE DEFINITIVE FIX ---
            // Use an INSERT...ON DUPLICATE KEY UPDATE query to handle all cases in one database trip.
            // This is the most robust and correct way to handle this.
            const [upsertResult] = await db.execute(
              `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) 
               VALUES (?, ?, ?, ?) 
               ON DUPLICATE KEY UPDATE username = VALUES(username), discord_user_id = VALUES(discord_user_id)`,
              [platform, streamerInfo.puid, streamerInfo.dbUsername, discordUserId]
            );

            // Now, get the streamer_id of the record we just inserted or updated.
            const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
            const streamerId = streamer.streamer_id;
            
            await db.execute(
                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?) 
                 ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id)`,
                [interaction.guild.id, streamerId, channelOverrideId]
            );

            let successMessage = `Successfully added/updated **${streamerInfo.dbUsername}** (${platform}). `;
            if (discordUser) successMessage += `Linked to Discord user ${discordUser}. `;
            if (channelOverride) successMessage += `Announcements will be sent to ${channelOverride}.`;
            
            await interaction.editReply(successMessage);
            
        } catch (error) {
            console.error('Add Streamer Error:', error);
            await interaction.editReply('An error occurred while adding the streamer.');
        } finally {
            if (cycleTLS) cycleTLS.exit();
        }
    }
};