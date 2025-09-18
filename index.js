console.log('--- EXECUTING LATEST INDEX.JS ---');
const { Client, GatewayIntentBits, Collection, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, MessageFlags, Partials, PermissionsBitField, EmbedBuilder, ChannelType, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const initCycleTLS = require('cycletls');
const db = require('./utils/db');
const apiChecks = require('./utils/api_checks.js');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));
const { updateAnnouncement } = require('./utils/announcer');

const { pendingInteractions } = require('./commands/addstreamer');

let isChecking = false;
let isCheckingTeams = false;
let isFirstCheck = true; // Flag for the initial avatar check

async function main() {
    const client = new Client({
        intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration ],
        partials: [Partials.User, Partials.GuildMember]
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
            let cycleTLS = null;
            try {
                if (data.platforms.includes('kick')) cycleTLS = await initCycleTLS({ timeout: 60000 });
                for (const platform of data.platforms) {
                    try {
                        let streamerInfo = null, pfp = null;
                        if(platform === 'twitch'){const u = await apiChecks.getTwitchUser(data.username);if(u){streamerInfo = {puid:u.id,dbUsername:u.login};pfp=u.profile_image_url;}}
                        else if(platform === 'kick' && cycleTLS){const u = await apiChecks.getKickUser(cycleTLS,data.username);if(u){streamerInfo = {puid:u.id.toString(),dbUsername:u.user.username};pfp=u.user.profile_pic;}}
                        else if(platform === 'youtube'){const c=await apiChecks.getYouTubeChannelId(data.username);if(c?.channelId)streamerInfo={puid:c.channelId,dbUsername:c.channelName||data.username};}
                        else if(['tiktok','trovo'].includes(platform)){streamerInfo={puid:data.username,dbUsername:data.username};}
                        if (!streamerInfo) { failed.push(`${data.username} on ${platform} (Not Found)`); continue; }
                        await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=IF(? IS NOT NULL, VALUES(discord_user_id), discord_user_id), profile_image_url=VALUES(profile_image_url)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, data.discordUserId, pfp || null, data.discordUserId]);
                        const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
                        for(const channelId of channelIds){const [res]=await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url, custom_message) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url), custom_message=VALUES(custom_message)`,[data.guildId,streamer.streamer_id,channelId,nickname,data.avatarUrl,customMessage]);if(res.affectedRows>1){updated.push(`${streamerInfo.dbUsername} on ${platform}`);}else{added.push(`${streamerInfo.dbUsername} on ${platform}`);}}
                    } catch (e) { console.error(`AddStreamer Modal Error for ${platform}:`, e); failed.push(`${data.username} on ${platform} (Error)`); }
                }
            } finally { if (cycleTLS) try { await cycleTLS.exit(); } catch (e) {} }
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
            const requestData = platforms.map(platform => {
                const username = interaction.fields.getTextInputValue(`${platform}_username`);
                return { platform, username };
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
            const serializedData = parts.slice(3).join('_');

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
                const originalChannel = await client.channels.fetch(originalChannelId);
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
            await startupCleanup(client);
            await checkTeams(client);
            await checkStreams(client);
            setInterval(() => checkStreams(client), 180 * 1000);
            setInterval(() => checkTeams(client), 15 * 60 * 1000);
            dashboard.start(client);
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

async function startupCleanup(client) {
    console.log('[Startup Cleanup] Starting...');
    try {
        // --- STAGE 1: Proactive Role Validation and Cleanup ---
        console.log('[Startup Cleanup] Stage 1: Validating all configured role IDs...');
        const [guildRoles] = await db.execute('SELECT guild_id, live_role_id FROM guilds WHERE live_role_id IS NOT NULL');
        const [teamRoles] = await db.execute('SELECT guild_id, live_role_id FROM twitch_teams WHERE live_role_id IS NOT NULL');
        const allRoleConfigs = [...guildRoles, ...teamRoles];
        const uniqueGuildIds = [...new Set(allRoleConfigs.map(c => c.guild_id))];

        for (const guildId of uniqueGuildIds) {
            try {
                const guild = await client.guilds.fetch(guildId);
                const rolesForGuild = allRoleConfigs.filter(c => c.guild_id === guildId);
                const uniqueRoleIds = [...new Set(rolesForGuild.map(c => c.live_role_id))];

                for (const roleId of uniqueRoleIds) {
                    if (!roleId) continue;
                    const roleExists = await guild.roles.fetch(roleId).catch(() => null);
                    if (!roleExists) {
                        console.log(`[Startup Cleanup] Found invalid role ${roleId} in guild ${guildId} during validation.`);
                        await cleanupInvalidRole(guildId, roleId);
                    }
                }
            } catch (e) {
                // Guild likely no longer exists, ignore.
            }
        }
        console.log('[Startup Cleanup] Stage 1: Proactive role validation complete.');

        // --- STAGE 2: Remove Roles from Members ---
        console.log('[Startup Cleanup] Stage 2: Removing live roles from all members...');
        const [allGuildsWithRoles] = await db.execute('SELECT DISTINCT guild_id FROM guilds WHERE live_role_id IS NOT NULL');
        const [allTeamsWithRoles] = await db.execute('SELECT DISTINCT guild_id FROM twitch_teams WHERE live_role_id IS NOT NULL');
        const allGuildsForRolePurge = [...new Set([...allGuildsWithRoles.map(g => g.guild_id), ...allTeamsWithRoles.map(g => g.guild_id)])];

        for (const guildId of allGuildsForRolePurge) {
            try {
                const guild = await client.guilds.fetch(guildId);
                console.log(`[Startup Cleanup] Processing guild for roles: ${guild.name} (${guildId}). Fetching all members...`);
                const members = await guild.members.fetch({ force: true, cache: true });
                console.log(`[Startup Cleanup] Member cache for ${guild.name} is full (${members.size} members). Clearing roles...`);

                const [guildLiveRole] = await db.execute('SELECT live_role_id FROM guilds WHERE guild_id = ?', [guildId]);
                const [teamLiveRoles] = await db.execute('SELECT live_role_id FROM twitch_teams WHERE guild_id = ?', [guildId]);
                const roleIds = new Set([
                    guildLiveRole[0]?.live_role_id,
                    ...teamLiveRoles.map(t => t.live_role_id)
                ].filter(Boolean));

                if (roleIds.size === 0) {
                    console.log(`[Startup Cleanup] No live roles configured for guild ${guild.name} (${guildId}). Skipping role removal.`);
                    continue;
                }

                for (const roleId of roleIds) {
                    const role = guild.roles.cache.get(roleId);
                    if (role) {
                        const membersWithRole = members.filter(member => member.roles.cache.has(roleId));
                        if (membersWithRole.size > 0) {
                            console.log(`[Startup Cleanup] Removing role '${role.name}' from ${membersWithRole.size} member(s) in ${guild.name}.`);
                            for (const member of membersWithRole.values()) {
                                await member.roles.remove(role, 'Bot restart cleanup').catch(e => {
                                    console.error(`[Startup Cleanup] Failed to remove role ${role.name} from ${member.user.tag} (${member.id}): ${e.message}`);
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[Startup Cleanup] Failed to process guild ${guildId}:`, e.message);
            }
        }
        console.log('[Startup Cleanup] Stage 2: Live role removal from members complete.');

        // --- STAGE 3: Purge Old Announcements ---
        console.log('[Startup Cleanup] Stage 3: Purging all bot messages from announcement channels...');
        const [allGuildsWithSettingsForPurge] = await db.execute('SELECT DISTINCT guild_id FROM guilds');
        const [allGuildsWithSubsForPurge] = await db.execute('SELECT DISTINCT guild_id FROM subscriptions');
        const allGuildsForPurge = [...new Set([...allGuildsWithSettingsForPurge.map(g => g.guild_id), ...allGuildsWithSubsForPurge.map(g => g.guild_id)])];

        for (const guildId of allGuildsForPurge) {
            try {
                const guild = await client.guilds.fetch(guildId);
                console.log(`[Startup Cleanup] Purging announcements for guild: ${guild.name} (${guildId})`);

                const [defaultChannels] = await db.execute('SELECT DISTINCT announcement_channel_id FROM guilds WHERE guild_id = ? AND announcement_channel_id IS NOT NULL', [guildId]);
                const [subscriptionChannels] = await db.execute('SELECT DISTINCT announcement_channel_id FROM subscriptions WHERE guild_id = ? AND announcement_channel_id IS NOT NULL', [guildId]);
                const allChannelIdsForGuild = [...new Set([...defaultChannels.map(r => r.announcement_channel_id), ...subscriptionChannels.map(r => r.announcement_channel_id)])];

                for (const channelId of allChannelIdsForGuild) {
                    if (!channelId) continue;
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (channel && channel.isTextBased() && channel.guild.members.me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages)) {
                            console.log(`[Startup Cleanup] Purging messages from #${channel.name} (${channel.id})`);
                            let deletedCount = 0;
                            let lastMessageId = null;
                            let totalFetched;
                            do {
                                const messages = await channel.messages.fetch({ limit: 100, before: lastMessageId });
                                totalFetched = messages.size;
                                if (totalFetched === 0) break;
                                const botMessages = messages.filter(m => m.webhookId !== null || m.author.id === client.user.id);
                                if (botMessages.size > 0) {
                                    const deleted = await channel.bulkDelete(botMessages, true);
                                    deletedCount += deleted.size;
                                }
                                lastMessageId = messages.last().id;
                            } while (totalFetched === 100);
                            if (deletedCount > 0) {
                                console.log(`[Startup Cleanup] Purged ${deletedCount} messages from #${channel.name}.`);
                            }
                        }
                    } catch (e) {
                        console.error(`[Startup Cleanup] Failed to purge channel ${channelId}: ${e.message}`);
                    }
                }
            } catch (e) {
                console.error(`[Startup Cleanup] Failed to process guild ${guildId} for announcement purge: ${e.message}`);
            }
        }
        await db.execute('TRUNCATE TABLE announcements');
        console.log('[Startup Cleanup] Announcements table cleared.');

    } catch (e) { console.error('[Startup Cleanup] A CRITICAL ERROR occurred:', e); }
    console.log('[Startup Cleanup] Full-stage purge process has finished.');
}

async function checkStreams(client) {
    if (isChecking) { return; }
    isChecking = true;
    console.log(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
    let cycleTLS = null;
    try {
        const [subscriptions] = await db.execute('SELECT sub.*, s.* FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id');
        const [announcementsInDb] = await db.execute('SELECT * FROM announcements');
        const announcementsMap = new Map(announcementsInDb.map(a => [a.subscription_id, a]));

        const [guildSettingsList] = await db.execute('SELECT * FROM guilds');
        const guildSettingsMap = new Map(guildSettingsList.map(g => [g.guild_id, g]));
        const [channelSettingsList] = await db.execute('SELECT * FROM channel_settings');
        const channelSettingsMap = new Map(channelSettingsList.map(cs => [`${cs.guild_id}-${cs.channel_id}`, cs]));
        const [teamConfigs] = await db.execute('SELECT * FROM twitch_teams');
        const teamSettingsMap = new Map(teamConfigs.map(t => [`${t.guild_id}-${t.announcement_channel_id}`, t]));

        cycleTLS = await initCycleTLS({ timeout: 60000 });
        const liveStatusMap = new Map();
        const uniqueStreamers = [...new Map(subscriptions.map(item => [item.streamer_id, item])).values()];

        for (const streamer of uniqueStreamers) {
            let primaryData, secondaryData;
            try {
                if (streamer.platform === 'twitch') {
                    primaryData = await apiChecks.checkTwitch(streamer);
                    if (primaryData.isLive) {
                        const user = await apiChecks.getTwitchUser(streamer.username);
                        if (user) primaryData.profileImageUrl = user.profile_image_url;
                    }
                    if (!primaryData.isLive && streamer.kick_username) {
                        secondaryData = await apiChecks.checkKick(cycleTLS, streamer.kick_username);
                        if (secondaryData.isLive) {
                            const user = await apiChecks.getKickUser(cycleTLS, streamer.kick_username);
                            if (user) secondaryData.profileImageUrl = user.user.profile_pic;
                        }
                    }
                } else if (streamer.platform === 'kick') {
                    primaryData = await apiChecks.checkKick(cycleTLS, streamer.username);
                    if (primaryData.isLive) {
                        const user = await apiChecks.getKickUser(cycleTLS, streamer.username);
                        if (user) primaryData.profileImageUrl = user.user.profile_pic;
                    }
                } else if (streamer.platform === 'youtube') {
                    primaryData = await apiChecks.checkYouTube(streamer.platform_user_id);
                } else if (streamer.platform === 'tiktok') {
                    primaryData = await apiChecks.checkTikTok(streamer.username);
                } else if (streamer.platform === 'trovo') {
                    primaryData = await apiChecks.checkTrovo(streamer.username);
                }

                if (primaryData?.isLive) liveStatusMap.set(streamer.streamer_id, primaryData);
                if (secondaryData?.isLive) {
                    const [[kickInfo]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform="kick" AND username=?', [streamer.kick_username]);
                    if (kickInfo) liveStatusMap.set(kickInfo.streamer_id, secondaryData);
                }
            } catch (e) {
                console.error(`[API Check Error] for ${streamer.username}:`, e);
            }
        }

        const desiredAnnouncementKeys = new Set();
        const successfulAnnouncements = new Map(); // streamer_id -> platform

        for (const sub of subscriptions) {
            const liveData = liveStatusMap.get(sub.streamer_id);
            if (!liveData) continue;

            const guildSettings = guildSettingsMap.get(sub.guild_id);
            const targetChannelId = sub.announcement_channel_id || guildSettings?.announcement_channel_id;
            if (!targetChannelId) continue;

            desiredAnnouncementKeys.add(sub.subscription_id);
            const existing = announcementsMap.get(sub.subscription_id);
            const channelSettings = channelSettingsMap.get(`${sub.guild_id}-${targetChannelId}`);
            const teamSettings = teamSettingsMap.get(`${sub.guild_id}-${targetChannelId}`);

            try {
                const sentMessage = await updateAnnouncement(client, sub, liveData, existing, guildSettings, channelSettings, teamSettings);
                if (sentMessage) {
                    if (!successfulAnnouncements.has(sub.streamer_id)) {
                        successfulAnnouncements.set(sub.streamer_id, new Set());
                    }
                    successfulAnnouncements.get(sub.streamer_id).add(liveData.platform);

                    if (!existing) {
                        console.log(`[Announce] CREATED new announcement for ${sub.username} in channel ${targetChannelId}`);
                        await db.execute('INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url) VALUES (?,?,?,?,?,?,?,?,?)', [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, targetChannelId, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null]);
                    } else if (existing && sentMessage.id !== existing.message_id) {
                        console.log(`[Announce] UPDATED message ID for ${sub.username}`);
                        await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [sentMessage.id, existing.announcement_id]);
                    }
                }
            } catch (e) {
                console.error(`[Announce] Error processing announcement for ${sub.username}:`, e);
            }
        }

        for (const [subscription_id, existing] of announcementsMap.entries()) {
            if (!desiredAnnouncementKeys.has(subscription_id)) {
                try {
                    console.log(`[Cleanup] Deleting announcement for subscription ${subscription_id}`);
                    const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
                    if (channel) {
                        await channel.messages.delete(existing.message_id).catch(err => {
                            if (err.code !== 10008) console.error(`[Cleanup] Failed to delete message ${existing.message_id}:`, err);
                        });
                    }
                    await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [existing.announcement_id]);
                } catch (e) {
                    console.error(`[Cleanup] Error during deletion for announcement ${existing.announcement_id}:`, e);
                }
            }
        }

        const usersToUpdate = new Map();
        for (const sub of subscriptions) {
            if (!sub.discord_user_id) continue;
            const key = `${sub.guild_id}-${sub.discord_user_id}`;
            if (!usersToUpdate.has(key)) {
                usersToUpdate.set(key, { guildId: sub.guild_id, userId: sub.discord_user_id, livePlatforms: new Set() });
            }
            if (successfulAnnouncements.has(sub.streamer_id)) {
                successfulAnnouncements.get(sub.streamer_id).forEach(platform => {
                    usersToUpdate.get(key).livePlatforms.add(platform);
                });
            }
        }

        for (const [key, userState] of usersToUpdate.entries()) {
            const { guildId, userId, livePlatforms } = userState;

            const member = await client.guilds.fetch(guildId).then(g => g.members.fetch(userId)).catch(() => null);
            if (!member) continue;

            const guildSettings = guildSettingsMap.get(guildId);
            const userSubscriptions = subscriptions.filter(s => s.discord_user_id === userId && s.guild_id === guildId);
            const allTeamConfigsForGuild = teamConfigs.filter(t => t.guild_id === guildId && t.live_role_id);

            const desiredRoles = new Set();

            // Determine guild-wide role
            if (guildSettings?.live_role_id && livePlatforms.size > 0) {
                desiredRoles.add(guildSettings.live_role_id);
            }

            // Determine team-specific roles
            for (const teamConfig of allTeamConfigsForGuild) {
                const isLiveOnTwitchForThisTeam = userSubscriptions.some(sub => 
                    sub.announcement_channel_id === teamConfig.announcement_channel_id && livePlatforms.has('twitch')
                );
                if (isLiveOnTwitchForThisTeam) {
                    desiredRoles.add(teamConfig.live_role_id);
                }
            }

            const allManagedRoles = new Set([guildSettings?.live_role_id, ...allTeamConfigsForGuild.map(t => t.live_role_id)].filter(Boolean));

            for (const roleId of allManagedRoles) {
                if (desiredRoles.has(roleId)) {
                    if (!member.roles.cache.has(roleId)) {
                        await handleRole(member, [roleId], 'add', guildId);
                    }
                } else {
                    if (member.roles.cache.has(roleId)) {
                        await handleRole(member, [roleId], 'remove', guildId);
                    }
                }
            }
        }

    } catch (e) {
        console.error("[checkStreams] CRITICAL ERROR:", e);
    } finally {
        if (cycleTLS) try { await cycleTLS.exit(); } catch (e) {}
        isChecking = false;
        isFirstCheck = false;
        console.log(`[Check] ---> Finished stream check`);
    }
}

async function checkTeams(client) {
    if (isCheckingTeams) { return; }
    isCheckingTeams = true;
    console.log(`[Team Sync] ---> Starting team sync @ ${new Date().toLocaleTimeString()}`);
    try {
        const [teamSubscriptions] = await db.execute('SELECT * FROM twitch_teams');
        if (teamSubscriptions.length === 0) { console.log('[Team Sync] No teams are subscribed for syncing.'); isCheckingTeams = false; return; }

        console.log(`[Team Sync] Found ${teamSubscriptions.length} team subscription(s) to process.`);
        for (const sub of teamSubscriptions) {
            try {
                const apiMembers = await apiChecks.getTwitchTeamMembers(sub.team_name);
                if (!apiMembers) continue;
                const apiMemberIds = new Set(apiMembers.map(m => m.user_id));
                const [dbSubs] = await db.execute(`SELECT s.streamer_id, s.platform_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.platform = 'twitch'`, [sub.guild_id, sub.announcement_channel_id]);
                for (const member of apiMembers) {
                    await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES ('twitch', ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, [member.user_id, member.user_login, member.profile_image_url || null]);
                    const [[ts]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?', ['twitch', member.user_id]);
                    await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)', [sub.guild_id, ts.streamer_id, sub.announcement_channel_id]);
                }
                const toRemove = dbSubs.filter(dbSub => !apiMemberIds.has(dbSub.platform_user_id));
                if (toRemove.length > 0) {
                    const idsToRemove = toRemove.map(s => s.streamer_id);
                    await db.execute(`DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ?`, [idsToRemove, sub.guild_id, sub.announcement_channel_id]);
                }
            } catch (e) { console.error(`[Team Sync] Error processing team ${sub.team_name}:`, e.message); }
        }
    } catch (error) { console.error('[Team Sync] CRITICAL ERROR:', error); }
    finally { isCheckingTeams = false; console.log('[Team Sync] ---> Finished team sync.'); }
}

async function handleRole(member, roleIds, action, guildId) {
    if (!member || !roleIds || roleIds.length === 0) return;
    for (const roleId of roleIds) {
        if (!roleId) continue;
        try {
            if (action === 'add' && !member.roles.cache.has(roleId)) {
                await member.roles.add(roleId);
            } else if (action === 'remove' && member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId);
            }
        } catch (e) {
            if (e.code === 10011 || (e.message && e.message.includes('Unknown Role'))) {
                await cleanupInvalidRole(guildId, roleId);
            } else {
                console.error(`Failed to ${action} role ${roleId} for ${member.id} in ${guildId}: ${e.message}`);
            }
        }
    }
}

main().catch(console.error);