const { Client, GatewayIntentBits, Collection, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, MessageFlags, Partials, PermissionsBitField, EmbedBuilder, ChannelType } = require('discord.js');
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
            await interaction.reply({ content: 'Please select all platforms you would like to be announced for.', components: [row], ephemeral: true });
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
                return interaction.reply({ content: 'Error: The requests channel could not be found.', ephemeral: true });
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
            await interaction.reply({ content: 'Your request has been submitted for approval.', ephemeral: true });
        } else if (interaction.isButton() && interaction.customId.startsWith('approve_request_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'You do not have permission to approve requests.', ephemeral: true });
            }
            const parts = interaction.customId.split('_');
            const requestingUserId = parts[2];
            const serializedData = parts.slice(3).join('_');

            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`approve_channels_${requestingUserId}_${serializedData}`)
                .setPlaceholder('Select announcement channels for this user.')
                .setMinValues(1)
                .setMaxValues(25)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

            const row = new ActionRowBuilder().addComponents(channelSelect);
            await interaction.reply({ content: 'Please select the channel(s) to add this streamer to:', components: [row], ephemeral: true });
        
        } else if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('approve_channels_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'You do not have permission to approve requests.', ephemeral: true });
            }
            await interaction.deferUpdate();
            const parts = interaction.customId.split('_');
            const requestingUserId = parts[2];
            const serializedData = parts.slice(3).join('_');
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

            const originalEmbed = interaction.message.embeds[0];
            const updatedEmbed = new EmbedBuilder(originalEmbed)
                .setColor('#57F287')
                .setTitle('Request Approved')
                .setFooter({ text: `Approved by ${interaction.user.tag}` })
                .addFields({ name: 'Approved for Channels', value: channelIds.map(id => `<#${id}>`).join(', ') });

            await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
            await interaction.editReply({ content: `Approved request and added ${addedCount} subscriptions.`, components: [] });

        } else if (interaction.isButton() && interaction.customId.startsWith('deny_request_')) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'You do not have permission to deny requests.', ephemeral: true });
            }
            const originalEmbed = interaction.message.embeds[0];
            const updatedEmbed = new EmbedBuilder(originalEmbed)
                .setColor('#ED4245')
                .setTitle('Request Denied')
                .setFooter({ text: `Denied by ${interaction.user.tag}` });

            await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
            await interaction.reply({ content: 'Request has been denied.', ephemeral: true });
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
        const allGuilds = [...client.guilds.cache.values()];
        console.log(`[Startup Cleanup] Found ${allGuilds.length} guilds to process.`);

        for (const guild of allGuilds) {
            console.log(`[Startup Cleanup] Processing guild: ${guild.name} (${guild.id})`);
            try {
                // --- STAGE 1 (for this guild): Role Validation ---
                const [guildRoles] = await db.execute('SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
                const [teamRoles] = await db.execute('SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
                const allRoleIdsForGuild = [...new Set([...guildRoles.map(r => r.live_role_id), ...teamRoles.map(r => r.live_role_id)].filter(Boolean))];

                for (const roleId of allRoleIdsForGuild) {
                    const roleExists = await guild.roles.fetch(roleId).catch(() => null);
                    if (!roleExists) {
                        console.log(`[Startup Cleanup] Found invalid role ${roleId} in guild ${guild.name}.`);
                        await cleanupInvalidRole(guild.id, roleId);
                    }
                }

                // --- STAGE 2 (for this guild): Role Removal ---
                const [validGuildRoles] = await db.execute('SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
                const [validTeamRoles] = await db.execute('SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
                const validRoleIds = [...new Set([...validGuildRoles.map(r => r.live_role_id), ...validTeamRoles.map(r => r.live_role_id)].filter(Boolean))];

                if (validRoleIds.length > 0) {
                    console.log(`[Startup Cleanup] Fetching all members for ${guild.name} to clear roles...`);
                    const members = await guild.members.fetch({ force: true, cache: true });
                    console.log(`[Startup Cleanup] Member cache for ${guild.name} is full (${members.size} members).`);

                    for (const roleId of validRoleIds) {
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
                }

                // --- STAGE 3 (for this guild): Message Purge ---
                const [defaultChannels] = await db.execute('SELECT DISTINCT announcement_channel_id FROM guilds WHERE guild_id = ? AND announcement_channel_id IS NOT NULL', [guild.id]);
                const [subscriptionChannels] = await db.execute('SELECT DISTINCT announcement_channel_id FROM subscriptions WHERE guild_id = ? AND announcement_channel_id IS NOT NULL', [guild.id]);
                const allChannelIdsForGuild = [...new Set([...defaultChannels.map(r => r.announcement_channel_id), ...subscriptionChannels.map(r => r.announcement_channel_id)].filter(Boolean))];

                if (allChannelIdsForGuild.length > 0) {
                    console.log(`[Startup Cleanup] Found ${allChannelIdsForGuild.length} announcement channels to purge for ${guild.name}.`);
                    for (const channelId of allChannelIdsForGuild) {
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
                }
            } catch (e) {
                console.error(`[Startup Cleanup] Failed to process guild ${guild.id}:`, e.message);
            }
        }

        await db.execute('TRUNCATE TABLE announcements');
        console.log('[Startup Cleanup] Announcements table cleared globally.');

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
        if (subscriptions.length === 0) { isChecking = false; return; }

        cycleTLS = await initCycleTLS({ timeout: 60000 });
        const liveStatusMap = new Map();
        const uniqueStreamers = [...new Map(subscriptions.map(item => [item.streamer_id, item])).values()];

        for (const streamer of uniqueStreamers) {
            let primaryData, secondaryData;
            try {
                let currentPfp = null;
                if (streamer.platform === 'twitch') {
                    primaryData = await apiChecks.checkTwitch(streamer);
                    currentPfp = primaryData?.pfp;
                    if (!primaryData.isLive && streamer.kick_username) {
                        secondaryData = await apiChecks.checkKick(cycleTLS, streamer.kick_username);
                        if(secondaryData?.pfp) {
                            const [[kickInfo]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform="kick" AND username=?', [streamer.kick_username]);
                            if (kickInfo) await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [secondaryData.pfp, kickInfo.streamer_id]);
                        }
                    }
                } else if (streamer.platform === 'kick') {
                    primaryData = await apiChecks.checkKick(cycleTLS, streamer.username);
                    currentPfp = primaryData?.pfp;
                } else if (streamer.platform === 'youtube') {
                    primaryData = await apiChecks.checkYouTube(streamer.platform_user_id);
                    currentPfp = primaryData?.pfp;
                } else if (streamer.platform === 'tiktok') {
                    primaryData = await apiChecks.checkTikTok(streamer.username);
                    currentPfp = primaryData?.pfp;
                } else if (streamer.platform === 'trovo') {
                    primaryData = await apiChecks.checkTrovo(streamer.username);
                    currentPfp = primaryData?.pfp;
                }

                const shouldUpdateAvatar = (isFirstCheck && currentPfp && currentPfp !== streamer.profile_image_url) || (streamer.profile_image_url === null && currentPfp);
                if (shouldUpdateAvatar) {
                    console.log(`[Avatar Update] Updating avatar for ${streamer.username} (Reason: ${isFirstCheck ? 'Initial Check' : 'Null Value'}).`);
                    await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [currentPfp, streamer.streamer_id]);
                }

                if (primaryData?.isLive) liveStatusMap.set(streamer.streamer_id, primaryData);
                if (secondaryData?.isLive) {
                    const [[kickInfo]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform="kick" AND username=?', [streamer.kick_username]);
                    if (kickInfo) liveStatusMap.set(kickInfo.streamer_id, secondaryData);
                }
            } catch(e) { console.error(`[API Check Error] for ${streamer.username}:`, e); }
        }

        const [announcements] = await db.execute('SELECT * FROM announcements');
        const guildSettingsMap = new Map((await db.execute('SELECT * FROM guilds'))[0].map(g => [g.guild_id, g]));
        const channelSettingsMap = new Map((await db.execute('SELECT * FROM channel_settings'))[0].map(c => [c.channel_id, c]));
        
        for (const sub of subscriptions) {
            try {
                const liveData = liveStatusMap.get(sub.streamer_id);
                const existingAnnouncement = announcements.find(a => a.subscription_id === sub.subscription_id);
                await processSubscription(client, sub, liveData, existingAnnouncement, guildSettingsMap.get(sub.guild_id), channelSettingsMap.get(sub.announcement_channel_id));
            } catch (e) {
                console.error(`[ProcessSubscription Error] for sub ${sub.subscription_id} (${sub.username}):`, e);
            }
        }
    } catch (e) { console.error("[checkStreams] CRITICAL ERROR:", e);
    } finally {
        if (cycleTLS) try { await cycleTLS.exit(); } catch (e) {}
        isChecking = false;
        isFirstCheck = false; // Set the flag to false after the first run completes
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

async function handleRole(member, roleId, action, guildId) {
    if (!member || !roleId) return;
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

async function processSubscription(client, sub, liveData, existing, guildSettings, channelSettings) {
    const isLive = liveData && liveData.isLive;
    let member = null;
    if (sub.discord_user_id) {
        const guild = await client.guilds.fetch(sub.guild_id).catch(() => {});
        if (guild) member = await guild.members.fetch(sub.discord_user_id).catch(() => {});
    }

    if (isLive) {
        if (member) {
            let targetRoleId = guildSettings?.live_role_id;
            const [teamSubs] = await db.execute('SELECT tt.live_role_id FROM twitch_teams tt JOIN subscriptions s ON tt.announcement_channel_id = s.announcement_channel_id AND tt.guild_id = s.guild_id WHERE s.streamer_id = ? AND tt.live_role_id IS NOT NULL', [sub?.streamer_id]);
            if (teamSubs.length > 0) targetRoleId = teamSubs[0].live_role_id;
            await handleRole(member, targetRoleId, 'add', sub.guild_id);
        }

        const sentMessage = await updateAnnouncement(client, sub, liveData, existing, guildSettings, channelSettings);

        if (sentMessage) {
            if (existing) {
                if (sentMessage.id !== existing.message_id) {
                    await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [sentMessage.id, existing.announcement_id]);
                }
            } else {
                console.log(`[Announce] Posted for ${liveData.username} (${liveData.platform})`);
                await db.execute('INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url) VALUES (?,?,?,?,?,?,?,?,?)',
                    [sub?.subscription_id??null, sub?.streamer_id??null, sub?.guild_id??null, sentMessage?.id??null, sentMessage?.channelId??null, liveData?.game??null, liveData?.title??null, liveData?.platform??null, liveData?.thumbnailUrl??null]);
            }
        }
    } else if (existing) {
        if (member) {
            let targetRoleId = guildSettings?.live_role_id;
            const [teamSubs] = await db.execute('SELECT tt.live_role_id FROM twitch_teams tt JOIN subscriptions s ON tt.announcement_channel_id = s.announcement_channel_id AND tt.guild_id = s.guild_id WHERE s.streamer_id = ? AND tt.live_role_id IS NOT NULL', [sub?.streamer_id]);
            if (teamSubs.length > 0) targetRoleId = teamSubs[0].live_role_id;
            await handleRole(member, targetRoleId, 'remove', sub.guild_id);
        }

        try {
            const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
            if (channel) {
                await channel.messages.delete(existing.message_id).catch(() => {});
            }
        } catch (e) {}
        await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [existing.announcement_id]);
    }
}

main().catch(console.error);