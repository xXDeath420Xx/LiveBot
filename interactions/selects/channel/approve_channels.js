const { EmbedBuilder } = require('discord.js');
const db = require('../../../utils/db');
const apiChecks = require('../../../utils/api_checks');
const initCycleTLS = require('cycletls');

module.exports = {
    customId: /^approve_channels_/,
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return interaction.reply({ content: 'You do not have permission to approve requests.', ephemeral: true });
        }
        await interaction.deferUpdate();
        const parts = interaction.customId.split('_');
        const requestingUserId = parts[2];
        const originalChannelId = parts[3];
        const originalMessageId = parts[4];
        const serializedData = parts.slice(5).join('_');
        const requestData = serializedData.split(';').map(d => {
            const [platform, username] = d.split(':');
            return { platform, username };
        });
        const channelIds = interaction.values;

        let addedCount = 0;
        for (const { platform, username } of requestData) {
            try {
                let streamerInfo = null;
                if (platform === 'twitch') { const u = await apiChecks.getTwitchUser(username); if (u) streamerInfo = { puid: u.id, dbUsername: u.login }; }
                else if (platform === 'kick') { const u = await apiChecks.getKickUser(await initCycleTLS({ timeout: 60000 }), username); if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username }; }
                else if (platform === 'youtube') { const c = await apiChecks.getYouTubeChannelId(username); if (c?.channelId) streamerInfo = { puid: c.channelId, dbUsername: c.channelName || username }; }
                else { streamerInfo = { puid: username, dbUsername: username }; }

                if (streamerInfo) {
                    const [result] = await db.execute('INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=VALUES(discord_user_id)', [platform, streamerInfo.puid, streamerInfo.dbUsername, requestingUserId]);
                    const streamerId = result.insertId || (await db.execute('SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?', [platform, streamerInfo.puid]))[0][0].streamer_id;
                    for (const channelId of channelIds) {
                        await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)', [interaction.guild.id, streamerId, channelId]);
                        addedCount++;
                    }
                }
            } catch (e) { console.error('Error approving streamer request:', e); }
        }

        try {
            const originalChannel = await interaction.client.channels.fetch(originalChannelId);
            const originalMessage = await originalChannel.messages.fetch(originalMessageId);

            const originalEmbed = originalMessage.embeds[0];
            const updatedEmbed = new EmbedBuilder(originalEmbed)
                .setColor('#57F287')
                .setTitle('Request Approved')
                .setFooter({ text: `Approved by ${interaction.user.tag}` })
                .addFields({ name: 'Approved for Channels', value: channelIds.map(id => `<#${id}>`).join(', ') });

            await originalMessage.edit({ embeds: [updatedEmbed], components: [] });
            await interaction.editReply({ content: `Approved request and added ${addedCount} subscriptions.`, components: [] });
        } catch (error) {
            console.error("Error updating original request message:", error);
            await interaction.editReply({ content: `Approved request and added ${addedCount} subscriptions, but failed to update the original message.`, components: [] });
        }
    },
};