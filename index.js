const { Client, GatewayIntentBits, Collection, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags, Partials } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const initCycleTLS = require('cycletls');
const db = require('./utils/db');
const { getBrowser, closeBrowser } = require('./utils/browserManager');
const apiChecks = require('./utils/api_checks.js');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));
const { updateAnnouncement } = require('./utils/announcer');

const { pendingInteractions } = require('./commands/addstreamer');

let isChecking = false;
let isCheckingTeams = false;

async function main() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildModeration
        ],
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
        }
        else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('addstreamer_platforms_')) {
            const interactionId = interaction.customId.split('_')[2];
            const initialData = pendingInteractions.get(interactionId);
            if (!initialData) return interaction.update({ content: 'This interaction has expired. Please run the command again.', components: [] });
            initialData.platforms = interaction.values;
            const modal = new ModalBuilder().setCustomId(`addstreamer_details_${interactionId}`).setTitle(`Details for ${initialData.username}`);
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channels').setLabel('Channel IDs (comma-separated, optional)').setStyle(TextInputStyle.Short).setRequired(false)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nickname').setLabel('Custom Webhook Name (Optional)').setStyle(TextInputStyle.Short).setRequired(false)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Custom Message (Optional)').setStyle(TextInputStyle.Paragraph).setRequired(false))
            );
            await interaction.showModal(modal);
        }
        else if (interaction.isModalSubmit() && interaction.customId.startsWith('addstreamer_details_')) {
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
                        if (platform === 'twitch') { const u = await apiChecks.getTwitchUser(data.username); if (u) { streamerInfo = { puid: u.id, dbUsername: u.login }; pfp = u.profile_image_url; } }
                        else if (platform === 'kick' && cycleTLS) { const u = await apiChecks.getKickUser(cycleTLS, data.username); if (u) { streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username }; pfp = u.user.profile_pic; } }
                        else if (platform === 'youtube') { const c = await apiChecks.getYouTubeChannelId(data.username); if (c?.channelId) streamerInfo = { puid: c.channelId, dbUsername: c.channelName || data.username }; }
                        else if (['tiktok', 'trovo'].includes(platform)) { streamerInfo = { puid: data.username, dbUsername: data.username }; }

                        if (!streamerInfo) { failed.push(`${data.username} on ${platform} (Not Found)`); continue; }

                        await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), discord_user_id = IF(? IS NOT NULL, VALUES(discord_user_id), discord_user_id), profile_image_url = VALUES(profile_image_url)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, data.discordUserId, pfp || null, data.discordUserId]);
                        const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);

                        for (const channelId of channelIds) {
                            const [res] = await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url, custom_message) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_nickname = VALUES(override_nickname), override_avatar_url = VALUES(override_avatar_url), custom_message = VALUES(custom_message)`, [data.guildId, streamer.streamer_id, channelId, nickname, data.avatarUrl, customMessage]);
                            if (res.affectedRows > 1) { updated.push(`${streamerInfo.dbUsername} on ${platform}`); } else { added.push(`${streamerInfo.dbUsername} on ${platform}`); }
                        }
                    } catch (e) { 
                        console.error(`AddStreamer Modal Error for ${platform}:`, e);
                        failed.push(`${data.username} on ${platform} (Error)`); 
                    }
                }
            } finally {
                if (cycleTLS) try { await cycleTLS.exit(); } catch (e) {}
            }

            let summary = `**Report for ${data.username}**\n`;
            if (added.length > 0) summary += `✅ Added: ${[...new Set(added)].join(', ')}\n`;
            if (updated.length > 0) summary += `🔄 Updated: ${[...new Set(updated)].join(', ')}\n`;
            if (failed.length > 0) summary += `❌ Failed: ${[...new Set(failed)].join(', ')}\n`;
            await interaction.editReply({ content: summary, components: [] });
            pendingInteractions.delete(interactionId);
        }
    });

    client.once(Events.ClientReady, async c => {
        console.log(`[READY] Logged in as ${c.user.tag}`);
        try {
            await startupCleanup(client);
            await checkTeams(client); 
            await checkStreams(client);
            setInterval(() => checkStreams(client), 90 * 1000);
            setInterval(() => checkTeams(client), 15 * 60 * 1000);
            dashboard.start(client);
        } catch (e) { console.error('[ClientReady Error]', e); }
    });

    await client.login(process.env.DISCORD_TOKEN);
}

async function startupCleanup(client) {
    console.log('[Startup Cleanup] Starting full purge...');
    try {
        const [guildRoles] = await db.execute('SELECT guild_id, live_role_id FROM guilds WHERE live_role_id IS NOT NULL');
        const [teamRoles] = await db.execute('SELECT guild_id, live_role_id FROM twitch_teams WHERE live_role_id IS NOT NULL');
        const allRoleConfigs = [...guildRoles, ...teamRoles];
        const rolesToCleanByGuild = new Map();

        for (const config of allRoleConfigs) {
            if (config.live_role_id) {
                if (!rolesToCleanByGuild.has(config.guild_id)) rolesToCleanByGuild.set(config.guild_id, new Set());
                rolesToCleanByGuild.get(config.guild_id).add(config.live_role_id);
            }
        }
        for (const [guildId, roleIds] of rolesToCleanByGuild.entries()) {
            try {
                const guild = await client.guilds.fetch(guildId);
                for (const roleId of roleIds) {
                    try {
                        const role = await guild.roles.fetch(roleId);
                        if (role) {
                            for (const member of role.members.values()) {
                                await member.roles.remove(role, 'Bot restart cleanup').catch(() => {});
                            }
                        }
                    } catch (roleError) {}
                }
            } catch (guildError) {}
        }
        const [existingAnnouncements] = await db.execute('SELECT announcement_id, channel_id, message_id FROM announcements');
        if (existingAnnouncements.length > 0) {
            console.log(`[Startup Cleanup] Purging ${existingAnnouncements.length} existing live announcement messages...`);
            const deletionPromises = existingAnnouncements.map(async (announcement) => {
                try {
                    const channel = await client.channels.fetch(announcement.channel_id).catch(() => null);
                    if (channel?.isTextBased()) await channel.messages.delete(announcement.message_id).catch(() => {});
                } catch (e) {}
            });
            await Promise.allSettled(deletionPromises);
        }
        await db.execute('TRUNCATE TABLE announcements');
        console.log('[Startup Cleanup] announcements table cleared.');
    } catch (e) { console.error('[Startup Cleanup] CRITICAL ERROR:', e); }
    console.log('[Startup Cleanup] Full purge complete.');
}

async function checkStreams(client) {
    if (isChecking) { return; }
    isChecking = true;
    console.log(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
    let browser = null, cycleTLS = null;
    try {
        const [subscriptions] = await db.execute('SELECT sub.subscription_id, sub.guild_id, sub.announcement_channel_id, s.* FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id');
        if (subscriptions.length === 0) {
            isChecking = false;
            return;
        }
        
        cycleTLS = await initCycleTLS({ timeout: 60000 });
        browser = await getBrowser();
        
        const liveStatusMap = new Map();
        const uniqueStreamers = [...new Map(subscriptions.map(item => [item.streamer_id, item])).values()];

        for (const streamer of uniqueStreamers) {
            let primaryData, secondaryData;
            try {
                if (streamer.platform === 'twitch') {
                    primaryData = await apiChecks.checkTwitch(streamer);
                    if (!primaryData.isLive && streamer.kick_username) {
                        secondaryData = await apiChecks.checkKick(cycleTLS, streamer.kick_username);
                    }
                } else if (streamer.platform === 'kick') {
                    primaryData = await apiChecks.checkKick(cycleTLS, streamer.username);
                } else if (streamer.platform === 'youtube') {
                    primaryData = await apiChecks.checkYouTube(browser, streamer.platform_user_id);
                } else if (streamer.platform === 'tiktok') {
                    primaryData = await apiChecks.checkTikTok(browser, streamer.username);
                } else if (streamer.platform === 'trovo') {
                    primaryData = await apiChecks.checkTrovo(browser, streamer.username);
                }
                
                if (primaryData?.isLive) {
                    liveStatusMap.set(streamer.streamer_id, primaryData);
                }
                if (secondaryData?.isLive) {
                     const [[kickStreamerInfo]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = "kick" AND username = ?', [streamer.kick_username]);
                     if(kickStreamerInfo) {
                        liveStatusMap.set(kickStreamerInfo.streamer_id, secondaryData);
                    }
                }
            } catch(e) { console.error(`[API Check Error] for ${streamer.username}:`, e); }
        }
        
        const [announcements] = await db.execute('SELECT * FROM announcements');
        const guildSettingsMap = new Map((await db.execute('SELECT * FROM guilds'))[0].map(g => [g.guild_id, g]));
        const channelSettingsMap = new Map((await db.execute('SELECT * FROM channel_settings'))[0].map(c => [c.channel_id, c]));

        for (const sub of subscriptions) {
            const liveData = liveStatusMap.get(sub.streamer_id);
            const existingAnnouncement = announcements.find(a => a.subscription_id === sub.subscription_id);
            await processSubscription(client, sub, liveData, existingAnnouncement, guildSettingsMap.get(sub.guild_id), channelSettingsMap.get(sub.announcement_channel_id));
        }

    } catch (e) { 
        console.error("[checkStreams] CRITICAL ERROR:", e); 
    } finally {
        if (browser) await closeBrowser();
        if (cycleTLS) try { await cycleTLS.exit(); } catch (e) {}
        isChecking = false;
        console.log(`[Check] ---> Finished stream check`);
    }
}

async function checkTeams(client) {
    if (isCheckingTeams) { return; }
    isCheckingTeams = true;
    console.log(`[Team Sync] ---> Starting team sync @ ${new Date().toLocaleTimeString()}`);
    try {
        const [teamSubscriptions] = await db.execute('SELECT * FROM twitch_teams');
        if (teamSubscriptions.length === 0) { isCheckingTeams = false; return; }

        for (const sub of teamSubscriptions) {
            try {
                const apiMembers = await apiChecks.getTwitchTeamMembers(sub.team_name);
                if (!apiMembers) continue;
                
                const apiMemberIds = new Set(apiMembers.map(m => m.user_id));
                const [dbSubs] = await db.execute(`SELECT s.streamer_id, s.platform_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.platform = 'twitch'`, [sub.guild_id, sub.announcement_channel_id]);

                for (const member of apiMembers) {
                    await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES ('twitch', ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), profile_image_url = VALUES(profile_image_url)`, [member.user_id, member.user_login, member.profile_image_url || null]);
                    const [[twitchStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', ['twitch', member.user_id]);
                    await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)', [sub.guild_id, twitchStreamer.streamer_id, sub.announcement_channel_id]);
                }
                
                const toRemove = dbSubs.filter(dbSub => !apiMemberIds.has(dbSub.platform_user_id));
                if (toRemove.length > 0) {
                    const streamerIdsToRemove = toRemove.map(s => s.streamer_id);
                    await db.execute(`DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ?`, [streamerIdsToRemove, sub.guild_id, sub.announcement_channel_id]);
                }
            } catch (e) {
                console.error(`[Team Sync] Error processing team ${sub.team_name}:`, e.message);
            }
        }
    } catch (error) {
        console.error('[Team Sync] CRITICAL ERROR:', error);
    } finally {
        isCheckingTeams = false;
        console.log('[Team Sync] ---> Finished team sync.');
    }
}

async function processSubscription(client, sub, liveData, existing, guildSettings, channelSettings) {
    const isLive = liveData && liveData.isLive;

    if (isLive) {
        if (sub.discord_user_id) {
            const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
            if (guild) {
                let targetRoleId = guildSettings?.live_role_id;
                const [teamSubs] = await db.execute(`SELECT tt.live_role_id FROM twitch_teams tt JOIN subscriptions s ON tt.announcement_channel_id = s.announcement_channel_id AND tt.guild_id = s.guild_id WHERE s.streamer_id = ? AND tt.live_role_id IS NOT NULL`, [sub?.streamer_id]);
                if (teamSubs.length > 0) targetRoleId = teamSubs[0].live_role_id;
                if (targetRoleId) {
                    try {
                        const member = await guild.members.fetch(sub.discord_user_id).catch(() => null);
                        if (member && !member.roles.cache.has(targetRoleId)) await member.roles.add(targetRoleId);
                    } catch (e) {}
                }
            }
        }
        
        const sentMessage = await updateAnnouncement(client, sub, liveData, existing, guildSettings, channelSettings);
        
        if (sentMessage) {
            if (existing) {
                if (sentMessage.id !== existing.message_id) {
                    await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [sentMessage.id, existing.announcement_id]);
                }
            } else {
                console.log(`[Announce] Posted for ${liveData.username} (${liveData.platform})`);
                await db.execute(
                    'INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        sub?.subscription_id ?? null, 
                        sub?.streamer_id ?? null, 
                        sub?.guild_id ?? null,
                        sentMessage?.id ?? null,
                        sentMessage?.channelId ?? null,
                        liveData?.game ?? null, 
                        liveData?.title ?? null, 
                        liveData?.platform ?? null, 
                        liveData?.thumbnailUrl ?? null
                    ]
                );
            }
        }
    } else if (existing) {
        console.log(`[Purge] ${sub.username} offline`);
        await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [existing.announcement_id]);
        try {
            const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
            if (channel) await channel.messages.delete(existing.message_id).catch(() => {});
        } catch (e) {}
    }
}

main().catch(console.error);