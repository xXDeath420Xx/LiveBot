// B:/Code/LiveBot/index.js - Updated on 2025-10-01 - Unique Identifier: INDEX-FINAL-003
console.log('--- EXECUTING LATEST INDEX.JS ---');
const { Client, GatewayIntentBits, Collection, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, MessageFlags, Partials, PermissionsBitField, EmbedBuilder, ChannelType, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const db = require('./utils/db');
const apiChecks = require('./utils/api_checks.js');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));
const { checkStreams, checkTeams } = require('./core/stream-checker');
const { pendingInteractions } = require('./commands/addstreamer');
const logger = require('./utils/logger');

async function main() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages
        ],
        partials: [Partials.User, Partials.GuildMember, Partials.Channel, Partials.Message]
    });

    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = require('fs').readdirSync(commandsPath).filter(f => f.endsWith('.js') && f !== 'setcustommessage.js');
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.data && command.execute) client.commands.set(command.data.name, command);
        } catch (e) { console.error(`[CMD Load Error] ${file}:`, e); }
    }
    console.log(`[Startup] ${client.commands.size} commands loaded.`);

    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isChatInputCommand()) {
            const cmd = client.commands.get(interaction.commandName);
            if (cmd) try { await cmd.execute(interaction); } catch (e) { console.error(`Interaction Error for ${cmd.data.name}:`, e); }
        } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('addstreamer_platforms_')) {
            const interactionId = interaction.customId.split('_')[2];
            const initialData = pendingInteractions.get(interactionId);
            if (!initialData) return interaction.update({ content: 'This interaction has expired. Please run the command again.', components: [] });
            initialData.platforms = interaction.values;
            const modal = new ModalBuilder().setCustomId(`addstreamer_details_${interactionId}`).setTitle(`Details for ${initialData.username}`);
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channels').setLabel('Channel IDs (comma-separated, optional)').setStyle(TextInputStyle.Short).setRequired(false)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nickname').setLabel('Custom Webhook Name (Optional)').setStyle(TextInputStyle.Short).setRequired(false)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Custom Message (Optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)));
            await interaction.showModal(modal);
        } else if (interaction.isModalSubmit() && interaction.customId.startsWith('addstreamer_details_')) {
            await interaction.deferUpdate();
            const interactionId = interaction.customId.split('_')[2];
            const data = pendingInteractions.get(interactionId);
            if (!data) return interaction.editReply({ content: 'This interaction has expired.', components: [] });
            const channelIds = interaction.fields.getTextInputValue('channels') ? [...new Set(interaction.fields.getTextInputValue('channels').split(',').map(id => id.trim()).filter(Boolean))] : [null];
            const nickname = interaction.fields.getTextInputValue('nickname') || null;
            const customMessage = interaction.fields.getTextInputValue('message') || null;
            const added = [], updated = [], failed = [];
            try {
                for (const platform of data.platforms) {
                    try {
                        let streamerInfo = null, pfp = null;
                        const inputUsername = data.username;
                        if (!inputUsername || !inputUsername.trim()) {
                            console.error(`[AddStreamer Modal Error] Empty username provided for platform ${platform}. Skipping.`);
                            failed.push(`Empty username for ${platform}`);
                            continue;
                        }

                        if(platform === 'twitch'){const u = await apiChecks.getTwitchUser(inputUsername);if(u){streamerInfo = {puid:u.id,dbUsername:u.login};pfp=u.profile_image_url;}}
                        else if(platform === 'kick'){const u = await apiChecks.getKickUser(inputUsername);if(u){streamerInfo = {puid:u.id.toString(),dbUsername:u.user.username};pfp=u.user.profile_pic;}}
                        else if(platform === 'youtube'){const c=await apiChecks.getYouTubeChannelId(inputUsername);if(c?.channelId)streamerInfo={puid:c.channelId,dbUsername:c.channelName||inputUsername};}
                        else if(['tiktok','trovo'].includes(platform)){streamerInfo={puid:inputUsername,dbUsername:inputUsername};}

                        if (!streamerInfo || !streamerInfo.puid) {
                            console.error(`[AddStreamer Modal Error] Could not get streamerInfo or puid for ${inputUsername} on ${platform}. Skipping.`);
                            failed.push(`${inputUsername} on ${platform} (Not Found/Invalid PUID)`);
                            continue;
                        }

                        const finalPuid = streamerInfo.puid;
                        console.log(`DEBUG: Attempting to insert/update streamer: platform=${platform}, puid=${finalPuid}, username=${streamerInfo.dbUsername}`);

                        await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=IF(? IS NOT NULL, VALUES(discord_user_id), discord_user_id), profile_image_url=VALUES(profile_image_url)`, [platform, finalPuid, streamerInfo.dbUsername, data.discordUserId, pfp || null, data.discordUserId]);
                        const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, finalPuid]);
                        for(const channelId of channelIds){const [res]=await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url, custom_message) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url), custom_message=VALUES(custom_message)`,[data.guildId,streamer.streamer_id,channelId,nickname,data.avatarUrl,customMessage]);if(res.affectedRows>1){updated.push(`${streamerInfo.dbUsername} on ${platform}`);}else{added.push(`${streamerInfo.dbUsername} on ${platform}`);}}
                    } catch (e) { console.error(`AddStreamer Modal Error for ${platform}:`, e); failed.push(`${data.username} on ${platform} (Error)`); }
                }
            } finally {
                // Centralized shutdown hook will handle this
            }
            let summary = `**Report for ${data.username}**\n`;
            if (added.length > 0) summary += `✅ Added: ${[...new Set(added)].join(', ')}\n`;
            if (updated.length > 0) summary += `🔄 Updated: ${[...new Set(updated)].join(', ')}\n`;
            if (failed.length > 0) summary += `❌ Failed: ${[...new Set(failed)].join(', ')}\n`;
            await interaction.editReply({ content: summary, components: [] });
            pendingInteractions.delete(interactionId);
        } else if (interaction.isButton() && interaction.customId.startsWith('request_announcement_button_')) {
            const requestsChannelId = interaction.customId.split('_')[3];
            const platformSelect = new StringSelectMenuBuilder()
                .setCustomId(`request_platforms_${requestsChannelId}`)
                .setPlaceholder('Select the platform(s) you stream on')
                .setMinValues(1)
                .setMaxValues(5)
                .addOptions([
                    { label: 'Twitch', value: 'twitch', emoji: '🟣' },
                    { label: 'Kick', value: 'kick', emoji: '🟢' },
                    { label: 'YouTube', value: 'youtube', emoji: '🔴' },
                    { label: 'TikTok', value: 'tiktok', emoji: '⚫' },
                    { label: 'Trovo', value: 'trovo', emoji: '🟢' },
                ]);
            const row = new ActionRowBuilder().addComponents(platformSelect);
            await interaction.reply({ content: 'Please select all platforms you would like to be announced for.', components: [row], flags: [MessageFlags.Ephemeral] });
        } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('request_platforms_')) {
            const requestsChannelId = interaction.customId.split('_')[2];
            const platforms = interaction.values;
            const modal = new ModalBuilder()
                .setCustomId(`request_submit_${requestsChannelId}_${platforms.join(',')}`)
                .setTitle('Enter Your Usernames');
            platforms.forEach(platform => {
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId(`${platform}_username`)
                        .setLabel(`${platform.charAt(0).toUpperCase() + platform.slice(1)} Username`)
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ));
            });
            await interaction.showModal(modal);
        } else if (interaction.isModalSubmit() && interaction.customId.startsWith('request_submit_')) {
            const parts = interaction.customId.split('_');
            const requestsChannelId = parts[2];
            const platforms = parts[3].split(',');
            const requestData = platforms.map(d => {
                const username = interaction.fields.getTextInputValue(`${d}_username`);
                return { platform: d, username };
            });

            const requestsChannel = await client.channels.fetch(requestsChannelId);
            if (!requestsChannel) {
                return interaction.reply({ content: 'Error: The requests channel could not be found.', flags: [MessageFlags.Ephemeral] });
            }

            const serializedData = requestData.map(d => `${d.platform}:${d.username}`).join(';');
            const approveButton = new ButtonBuilder().setCustomId(`approve_request_${interaction.user.id}_${serializedData}`).setLabel('Approve').setStyle(ButtonStyle.Success);
            const denyButton = new ButtonBuilder().setCustomId(`deny_request_${interaction.user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger);
            const row = new ActionRowBuilder().addComponents(approveButton, denyButton);

            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('New Streamer Request')
                .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
                .addFields(requestData.map(d => ({ name: d.platform.charAt(0).toUpperCase() + d.platform.slice(1), value: d.username, inline: true })))
                .setFooter({ text: `User ID: ${interaction.user.id}` });

            await requestsChannel.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: 'Your request has been submitted for approval.', flags: [MessageFlags.Ephemeral] });
        } else if (interaction.isButton() && interaction.customId.startsWith('approve_request_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'You do not have permission to approve requests.', flags: [MessageFlags.Ephemeral] });
            }
            const parts = interaction.customId.split('_');
            const requestingUserId = parts[2];
            const originalChannelId = parts[3];
            const originalMessageId = parts[4];
            const serializedData = parts.slice(5).join('_');

            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`approve_channels_${requestingUserId}_${interaction.channelId}_${interaction.message.id}_${serializedData}`)
                .setPlaceholder('Select announcement channels for this user.')
                .setMinValues(1)
                .setMaxValues(25)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

            const row = new ActionRowBuilder().addComponents(channelSelect);
            await interaction.reply({ content: 'Please select the channel(s) to add this streamer to:', components: [row], flags: [MessageFlags.Ephemeral] });

        } else if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('approve_channels_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'You do not have permission to approve requests.', flags: [MessageFlags.Ephemeral] });
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
            let failed = [];
            for (const { platform, username } of requestData) {
                try {
                    let streamerInfo = null;
                    if (!username || !username.trim()) {
                        console.error(`[Approve Request Error] Empty username for platform ${platform}. Skipping.`);
                        failed.push(`${platform} (Empty Username)`);
                        continue;
                    }

                    if (platform === 'twitch') { const u = await apiChecks.getTwitchUser(username); if (u) streamerInfo = { puid: u.id, dbUsername: u.login }; }
                    else if (platform === 'kick') { const u = await apiChecks.getKickUser(username); if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username }; }
                    else if (platform === 'youtube') { const c = await apiChecks.getYouTubeChannelId(username); if (c?.channelId) streamerInfo = { puid: c.channelId, dbUsername: c.channelName || username }; }
                    else if(['tiktok','trovo'].includes(platform)){ streamerInfo={puid:username,dbUsername:username}; }

                    if (!streamerInfo || !streamerInfo.puid) {
                        console.error(`[Approve Request Error] Could not get streamerInfo or puid for ${username} on ${platform}. Skipping.`);
                        failed.push(`${username} on ${platform} (Not Found/Invalid PUID)`);
                        continue;
                    }

                    const finalPuid = streamerInfo.puid;
                    console.log(`DEBUG: Approving streamer - platform=${platform}, puid=${finalPuid}, username=${streamerInfo.dbUsername}`);

                    await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=IF(? IS NOT NULL, VALUES(discord_user_id), discord_user_id)`, [platform, finalPuid, streamerInfo.dbUsername, requestingUserId, requestingUserId]);
                    const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, finalPuid]);
                    for (const channelId of channelIds) {
                        await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)', [interaction.guild.id, streamer.streamer_id, channelId]);
                        addedCount++;
                    }
                } catch (e) { console.error(`Error approving streamer request:`, e); failed.push(`${username} on ${platform} (Error)`); }
            }

            try {
                const originalChannel = await client.channels.fetch(originalChannelId);
                const originalMessage = await originalChannel.messages.fetch(originalMessageId);

                const originalEmbed = originalMessage.embeds[0];
                const updatedEmbed = new EmbedBuilder(originalEmbed)
                    .setColor('#57F287')
                    .setTitle('Request Approved')
                    .setFooter({ text: `Approved by ${interaction.user.tag}` });

                await originalMessage.edit({ embeds: [updatedEmbed], components: [] });
                await interaction.editReply({ content: `Approved request and added ${addedCount} subscriptions. Failures: ${failed.join(', ')}`, components: [] });
            } catch (error) {
                console.error("Error updating original request message:", error);
                await interaction.editReply({ content: `Approved request and added ${addedCount} subscriptions, but failed to update the original message. Failures: ${failed.join(', ')}`, components: [] });
            }

        } else if (interaction.isButton() && interaction.customId.startsWith('deny_request_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'You do not have permission to deny requests.', flags: [MessageFlags.Ephemeral] });
            }
            const originalEmbed = interaction.message.embeds[0];
            const updatedEmbed = new EmbedBuilder(originalEmbed)
                .setColor('#ED4245')
                .setTitle('Request Denied')
                .setFooter({ text: `Denied by ${interaction.user.tag}` });

            await interaction.update({ embeds: [updatedEmbed], components: [] });
            await interaction.followUp({ content: 'Request has been denied.', flags: [MessageFlags.Ephemeral] });
        }
    });

    client.once(Events.ClientReady, async c => {
        console.log(`[READY] Logged in as ${c.user.tag}`);
        try {
            dashboard.start(client);
            await apiChecks.getCycleTLSInstance(); // Pre-initialize CycleTLS
            checkTeams(client);
            checkStreams(client);
            setInterval(() => checkStreams(client), 180 * 1000);
            setInterval(() => checkTeams(client), 15 * 60 * 1000);
        } catch (e) { console.error('[ClientReady Error]', e); }
    });

    await client.login(process.env.DISCORD_TOKEN);
}

async function cleanupInvalidRole(guildId, roleId) {
    if (!guildId || !roleId) return;
    console.log(`[Role Cleanup] Aggressively purging invalid role ID ${roleId} for guild ${guildId}.`);
    try {
        await db.execute('UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
        await db.execute('UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
    } catch (dbError) {
        console.error(`[Role Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, dbError);
    }
}

// Graceful shutdown
const cleanup = async () => {
    console.log('[WARN] [Shutdown] Received shutdown signal. Shutting down gracefully...');
    await apiChecks.exitCycleTLSInstance();
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Listener for IPC messages from the dashboard or other processes
process.on('message', message => {
    if (message && message.type === 'restart-bot') {
        logger.info('[IPC] Received restart-bot signal. Shutting down for restart.');
        cleanup();
    }
});

main().catch(console.error);