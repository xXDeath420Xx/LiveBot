const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks'); // Now includes getKickUser

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addstreamer')
        .setDescription('Adds a streamer to the notification list for this server.')
        // ... options ...
        ,
        
    async execute(interaction) {
        // ... (options setup)
        
        try {
            let streamerInfo;
            if (platform === 'twitch') {
                const twitchUser = await apiChecks.getTwitchUser(username);
                if (!twitchUser) return interaction.editReply(`Could not find a Twitch user named \`${username}\`.`);
                streamerInfo = { platform_user_id: twitchUser.id, validatedUsername: twitchUser.login };
            } else if (platform === 'kick') { // FIXED: Correct Kick validation
                const kickUser = await apiChecks.getKickUser(username);
                if (!kickUser) return interaction.editReply(`Could not find a Kick user named \`${username}\`.`);
                streamerInfo = { platform_user_id: kickUser.id.toString(), validatedUsername: kickUser.user.username };
            } else if (platform === 'youtube') {
                // You could add a YouTube API call here to validate the Channel ID
                if (!username.startsWith('UC')) return interaction.editReply(`For YouTube, you must provide the Channel ID (it starts with 'UC').`);
                streamerInfo = { platform_user_id: username, validatedUsername: username };
            } else { // Trovo, TikTok
                 streamerInfo = { platform_user_id: username, validatedUsername: username };
            }

            // ... (rest of the database logic is the same)
        } // ... (error handling)
    }
};