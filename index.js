const { Client, GatewayIntentBits, Collection, Events, Partials, PermissionsBitField, EmbedBuilder, ChannelType, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv-flow').config();
const logger = require('./utils/logger');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));
const { handleInteraction } = require('./core/interaction-handler');
const { setStatus, getStatus } = require('./core/status-manager');
const db = require('./utils/db');
const cache = require('./utils/cache');
const axios = require('axios');
const { announcementQueue } = require('./jobs/announcement-queue');
const { summaryQueue } = require('./jobs/summary-queue');
const initCycleTLS = require('cycletls');
const { getBrowser } = require('./utils/browserManager');
const { updateAnnouncement } = require('./utils/announcer');
const apiChecks = require('./utils/api_checks'); // Import the api_checks module

// --- BEGIN: MAIN APPLICATION STARTUP ---
async function main() {
    try {
        setStatus('STARTING', 'Initializing Dashboard...');
        dashboard.start(null, getStatus);

        const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration], partials: [Partials.User, Partials.GuildMember] });

        // Graceful Shutdown
        let isShuttingDown = false;
        const intervals = [];
        async function shutdown(signal) {
            if (isShuttingDown) return;
            isShuttingDown = true;
            logger.warn(`[Shutdown] Received ${signal}. Shutting down gracefully...`);
            setStatus('MAINTENANCE', 'Bot is shutting down.');
            intervals.forEach(clearInterval);
            await client.destroy();
            await db.end();
            await cache.redis.quit();
            process.exit(0);
        }
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        // Load Commands (assuming command files are not corrupted)
        client.commands = new Collection();
        const commandsPath = path.join(__dirname, 'commands');
        const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
        for (const file of commandFiles) {
            try {
                const command = require(path.join(commandsPath, file));
                if (command.data && command.execute) client.commands.set(command.data.name, command);
            } catch (e) { logger.error(`[CMD Load Error] ${file}:`, { error: e.message, stack: e.stack }); }
        }
        logger.info(`[Startup] ${client.commands.size} commands loaded.`);

        // Load Interaction Handlers (assuming interaction files are not corrupted)
        function getFilesRecursively(directory) {
            let files = [];
            const items = fs.readdirSync(directory, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(directory, item.name);
                if (item.isDirectory()) { files = files.concat(getFilesRecursively(fullPath)); } 
                else { files.push(fullPath); }
            }
            return files;
        }
        client.buttons = new Collection();
        client.modals = new Collection();
        client.selects = new Collection();
        const interactionsPath = path.join(__dirname, 'interactions');
        const interactionFolders = fs.readdirSync(interactionsPath);
        for (const folder of interactionFolders) {
            const folderPath = path.join(interactionsPath, folder);
            const interactionFiles = getFilesRecursively(folderPath).filter(file => file.endsWith('.js'));
            for (const file of interactionFiles) {
                try {
                    const handler = require(file);
                    if (handler.customId && handler.execute) {
                        const key = handler.customId.toString();
                        if (folder === 'buttons') client.buttons.set(key, handler);
                        else if (folder === 'modals') client.modals.set(key, handler);
                        else if (folder === 'selects') client.selects.set(key, handler);
                    }
                } catch (e) { logger.error(`[Interaction Load Error] ${file}:`, { error: e.message, stack: e.stack }); }
            }
        }
        logger.info(`[Startup] Loaded ${client.buttons.size} button handlers, ${client.modals.size} modal handlers, and ${client.selects.size} select menu handlers.`);

        client.on(Events.InteractionCreate, handleInteraction);
        client.once(Events.ClientReady, async c => {
            logger.info(`[READY] Logged in as ${c.user.tag}${c.shard ? ` on Shard #${c.shard.ids.join()}` : ''}`);
            dashboard.setClient(c);
            setStatus('STARTING', 'Running startup cleanup...');
            await startupCleanup(c);
            setStatus('ONLINE', 'Bot is online and operational.');
            
            // Trigger initial checks immediately
            await checkStreams(c);
            await checkTeams(c);

            // Then schedule recurring checks
            intervals.push(setInterval(() => checkStreams(c), 180 * 1000));
            intervals.push(setInterval(() => checkTeams(c), 15 * 60 * 1000));
        });

        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        logger.error('[Main Error]', { error });
        process.exit(1);
    }
}

// --- START: FUNCTIONS FROM WORKING/index.js ---

async function cleanupInvalidRole(guildId, roleId) {
    if (!guildId || !roleId) return;
    logger.info(`[Role Cleanup] Aggressively purging invalid role ID ${roleId} for guild ${guildId}.`);
    try {
        await db.execute('UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
        await db.execute('UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
    } catch (dbError) {
        logger.error(`[Role Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, dbError);
    }
}

async function startupCleanup(client) {
    logger.info('[Startup Cleanup] Starting...');
    try {
        // --- STAGE 1: Proactive Role Validation and Cleanup ---
        logger.info('[Startup Cleanup] Stage 1: Validating all configured role IDs...');
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
                        logger.info(`[Startup Cleanup] Found invalid role ${roleId} in guild ${guildId} during validation.`);
                        await cleanupInvalidRole(guildId, roleId);
                    }
                }
            } catch (e) {
                // Guild likely no longer exists, ignore.
            }
        }
        logger.info('[Startup Cleanup] Stage 1: Proactive role validation complete.');

        // --- STAGE 2: Handle Deleted Announcement Messages ---
        logger.info('[Startup Cleanup] Stage 2: Checking for deleted announcement messages...');
        const [allAnnouncements] = await db.execute(
            'SELECT a.*, s.username, s.platform, s.profile_image_url, sub.custom_message, sub.override_nickname, sub.override_avatar_url, sub.discord_user_id FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id JOIN subscriptions sub ON a.subscription_id = sub.subscription_id'
        );

        for (const ann of allAnnouncements) {
            try {
                const channel = await client.channels.fetch(ann.channel_id).catch(e => {
                    if (e.code === 10003) { // Unknown Channel
                        logger.warn(`[Startup Cleanup] Channel ${ann.channel_id} for announcement ${ann.announcement_id} not found. Deleting announcement from DB.`);
                        return null;
                    }
                    throw e; // Re-throw other errors
                });

                if (!channel || !channel.isTextBased()) {
                    await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [ann.announcement_id]);
                    continue;
                }

                const message = await channel.messages.fetch(ann.message_id).catch(e => {
                    if (e.code === 10008) { // Unknown Message
                        logger.warn(`[Startup Cleanup] Message ${ann.message_id} for announcement ${ann.announcement_id} in channel ${ann.channel_id} not found. Reposting.`);
                        return null;
                    }
                    throw e; // Re-throw other errors
                });

                if (!message) {
                    // Message was deleted, need to repost
                    const [guildSettingsResult] = await db.execute('SELECT * FROM guilds WHERE guild_id = ?', [ann.guild_id]);
                    const guildSettings = guildSettingsResult[0] || {};

                    const [channelSettingsResult] = await db.execute('SELECT * FROM channel_settings WHERE guild_id = ? AND channel_id = ?', [ann.guild_id, ann.channel_id]);
                    const channelSettings = channelSettingsResult[0] || {};

                    const [teamSettingsResult] = await db.execute('SELECT * FROM twitch_teams WHERE guild_id = ? AND announcement_channel_id = ?', [ann.guild_id, ann.channel_id]);
                    const teamSettings = teamSettingsResult[0] || {};

                    const subContext = {
                        subscription_id: ann.subscription_id,
                        streamer_id: ann.streamer_id,
                        guild_id: ann.guild_id,
                        announcement_channel_id: ann.channel_id,
                        custom_message: ann.custom_message,
                        override_nickname: ann.override_nickname,
                        override_avatar_url: ann.override_avatar_url,
                        username: ann.username,
                        platform: ann.platform,
                        profile_image_url: ann.profile_image_url,
                        discord_user_id: ann.discord_user_id // Ensure discord_user_id is passed
                    };

                    const liveData = {
                        username: ann.username,
                        platform: ann.platform,
                        title: ann.stream_title,
                        game: ann.stream_game,
                        thumbnailUrl: ann.stream_thumbnail_url,
                        url: ann.platform === 'twitch' ? `https://twitch.tv/${ann.username}` : ann.platform === 'kick' ? `https://kick.com/${ann.username}` : `#` // Basic URL reconstruction
                    };

                    const repostedMessage = await updateAnnouncement(client, subContext, liveData, null, guildSettings, channelSettings, teamSettings);

                    if (repostedMessage && repostedMessage.id) {
                        await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [repostedMessage.id, ann.announcement_id]);
                        logger.info(`[Startup Cleanup] Reposted announcement ${ann.announcement_id} in channel ${ann.channel_id} with new message ID ${repostedMessage.id}.`);
                    } else {
                        logger.error(`[Startup Cleanup] Failed to repost announcement ${ann.announcement_id}. updateAnnouncement returned:`, repostedMessage);
                    }
                }
            } catch (e) {
                logger.error(`[Startup Cleanup] Error processing announcement ${ann.announcement_id}:`, { error: e.message, stack: e.stack });
            }
        }
        logger.info('[Startup Cleanup] Stage 2: Deleted announcement message check complete.');

        // --- STAGE 3: Load Existing Announcements for Persistence ---
        logger.info('[Startup Cleanup] Stage 3: Loading existing announcements for persistence...');
        // The announcementsMap is already populated in checkStreams, so we just need to ensure no TRUNCATE happens here.
        // Removed: await db.execute('TRUNCATE TABLE announcements');

    } catch (e) {
        logger.error('[Startup Cleanup] A CRITICAL ERROR occurred:', e);
    } finally {
        logger.info('[Startup Cleanup] Full-stage cleanup/load process has finished.');
    }
}

let isChecking = false;
let isCheckingTeams = false;

async function fetchAndCache(key, fetcher, ttl) {
    let data = await cache.get(key);
    if (data) return data;
    data = await fetcher();
    if (data) await cache.set(key, data, ttl);
    return data;
}

async function checkStreams(client) {
    if (isChecking) { return; }
    isChecking = true;
    logger.info(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
    let cycleTLS = null;
    try {
        // Fetch all subscriptions and join with streamers to get streamer's Discord ID
        const [subscriptionsWithStreamerInfo] = await db.execute(
            'SELECT sub.*, s.discord_user_id AS streamer_discord_user_id, s.platform_user_id, s.username, s.platform, s.kick_username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id'
        );
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
        const uniqueStreamers = [...new Map(subscriptionsWithStreamerInfo.map(item => [item.streamer_id, item])).values()];

        for (const streamer of uniqueStreamers) {
            try {
                // Check primary platform
                let primaryLiveData = null;
                if (streamer.platform === 'twitch') {
                    primaryLiveData = await apiChecks.checkTwitch(streamer);
                } else if (streamer.platform === 'kick') {
                    primaryLiveData = await apiChecks.checkKick(cycleTLS, streamer.username);
                } else if (streamer.platform === 'youtube') {
                    primaryLiveData = await apiChecks.checkYouTube(streamer.platform_user_id);
                } else if (streamer.platform === 'tiktok') {
                    primaryLiveData = await apiChecks.checkTikTok(streamer.username);
                }
                else if (streamer.platform === 'trovo') {
                    primaryLiveData = await apiChecks.checkTrovo(streamer.username);
                }

                if (primaryLiveData && primaryLiveData.profileImageUrl && primaryLiveData.profileImageUrl !== streamer.profile_image_url) {
                    await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [primaryLiveData.profileImageUrl, streamer.streamer_id]);
                    logger.info(`[Avatar Update] Updated ${streamer.username}'s avatar.`);
                }
                if (primaryLiveData?.isLive) {
                    liveStatusMap.set(streamer.streamer_id, primaryLiveData);
                }

                // Check for linked Kick account if it exists, regardless of primary platform status
                if (streamer.platform === 'twitch' && streamer.kick_username) {
                    const [[kickInfo]] = await db.execute('SELECT streamer_id, profile_image_url FROM streamers WHERE platform="kick" AND username=?', [streamer.kick_username]);
                    if (kickInfo) {
                        const linkedKickLiveData = await apiChecks.checkKick(cycleTLS, streamer.kick_username);
                        if (linkedKickLiveData && linkedKickLiveData.profileImageUrl && linkedKickLiveData.profileImageUrl !== kickInfo.profile_image_url) {
                            await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [linkedKickLiveData.profileImageUrl, kickInfo.streamer_id]);
                            logger.info(`[Avatar Update] Updated linked Kick account ${streamer.kick_username}'s avatar.`);
                        }
                        if (linkedKickLiveData?.isLive) {
                            liveStatusMap.set(kickInfo.streamer_id, linkedKickLiveData);
                        }
                    }
                }
            } catch (e) {
                logger.error(`[API Check Error] for ${streamer.username}:`, e);
            }
        }

        const desiredAnnouncementKeys = new Set();
        const successfulAnnouncements = new Map(); // streamer_id -> platform

        for (const sub of subscriptionsWithStreamerInfo) { // Use subscriptionsWithStreamerInfo
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
                
                // Corrected check for sentMessage and its properties
                if (sentMessage && sentMessage.id && sentMessage.channel_id) { // Check for top-level channel_id
                    if (!existing) {
                        logger.info(`[Announce] CREATED new announcement for ${sub.username} in channel ${targetChannelId}`);
                        const [announcementResult] = await db.execute('INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url) VALUES (?,?,?,?,?,?,?,?,?)', [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, sentMessage.channel_id, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null]);
                        
                        const newAnnouncementId = announcementResult.insertId;
                        if (newAnnouncementId) {
                            await db.execute(
                                'INSERT INTO stream_sessions (announcement_id, streamer_id, guild_id, start_time, game_name) VALUES (?, ?, ?, NOW(), ?)',
                                [newAnnouncementId, sub.streamer_id, sub.guild_id, liveData.game || null]
                            );
                            logger.info(`[Stats] Started tracking new stream session for announcement ID: ${newAnnouncementId}`);
                        }

                    } else if (existing && sentMessage.id !== existing.message_id) {
                        logger.info(`[Announce] UPDATED message ID for ${sub.username}`);
                        await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [sentMessage.id, existing.announcement_id]);
                    }
                } else {
                    logger.error(`[Announce] updateAnnouncement did not return a valid message object with ID and channel ID for job for ${sub.username}. Sent message:`, sentMessage);
                }
            } catch (error) {
                // --- THIS IS THE FIX ---
                // Add a specific check for ECONNREFUSED to give a more helpful error message.
                if (error.code === 'ECONNREFUSED') {
                    logger.error(`[FATAL DB Error] Connection to the database was refused for streamer ${sub.username}. Please ensure the database is running and check its 'wait_timeout' setting.`, error);
                } else {
                    logger.error(`[Announce] Error processing announcement for ${sub.username}:`, error);
                }
                // --- END OF FIX ---
            }
        }

        for (const [subscription_id, existing] of announcementsMap.entries()) {
            if (!desiredAnnouncementKeys.has(subscription_id)) {
                try {
                    logger.info(`[Cleanup] Deleting announcement for subscription ${subscription_id}`);
                    const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
                    if (channel) {
                        await channel.messages.delete(existing.message_id).catch(err => {
                            if (err.code !== 10008) logger.error(`[Cleanup] Failed to delete message ${existing.message_id}:`, err);
                        });
                    }
                    await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [existing.announcement_id]);
                } catch (e) {
                    logger.error(`[Cleanup] Error during deletion for announcement ${existing.announcement_id}:`, e);
                }
            }
        }

        const usersToUpdate = new Map();
        for (const sub of subscriptionsWithStreamerInfo) { // Use subscriptionsWithStreamerInfo
            // Use the streamer's Discord ID for role management
            if (!sub.streamer_discord_user_id) continue; 
            const key = `${sub.guild_id}-${sub.streamer_discord_user_id}`;
            if (!usersToUpdate.has(key)) {
                usersToUpdate.set(key, { guildId: sub.guild_id, userId: sub.streamer_discord_user_id, livePlatforms: new Set() });
            }
            if (liveStatusMap.has(sub.streamer_id)) { // Check liveStatusMap for the streamer_id
                usersToUpdate.get(key).livePlatforms.add(sub.platform); // Add the platform of the live stream
            }
        }

        logger.info(`[Role Management] Processing ${usersToUpdate.size} users for role updates.`);
        for (const [key, userState] of usersToUpdate.entries()) {
            const { guildId, userId, livePlatforms } = userState;
            logger.debug(`[Role Management] User: ${userId}, Guild: ${guildId}, Live Platforms: ${[...livePlatforms].join(', ')}`);

            const member = await client.guilds.fetch(guildId).then(g => g.members.fetch(userId)).catch(e => {
                logger.warn(`[Role Management] Could not fetch member ${userId} in guild ${guildId}: ${e.message}`);
                return null;
            });
            if (!member) {
                logger.debug(`[Role Management] Skipping role update for ${userId} in ${guildId} as member not found.`);
                continue;
            }
            logger.debug(`[Role Management] Member ${member.user.tag} fetched for guild ${guildId}.`);

            const guildSettings = guildSettingsMap.get(guildId);
            // Filter userSubscriptions to only include those relevant to this specific streamer's Discord ID
            const streamerSubscriptions = subscriptionsWithStreamerInfo.filter(s => s.streamer_discord_user_id === userId && s.guild_id === guildId);
            const allTeamConfigsForGuild = teamConfigs.filter(t => t.guild_id === guildId && t.live_role_id);

            logger.debug(`[Role Management] Guild settings for ${guildId}: ${JSON.stringify(guildSettings)}`);
            logger.debug(`[Role Management] Streamer subscriptions for ${userId} in ${guildId}: ${streamerSubscriptions.length} found.`);
            logger.debug(`[Role Management] Team configs for ${guildId}: ${allTeamConfigsForGuild.length} found.`);

            const desiredRoles = new Set();

            // Determine guild-wide role
            if (guildSettings?.live_role_id && livePlatforms.size > 0) {
                desiredRoles.add(guildSettings.live_role_id);
                logger.debug(`[Role Management] Added guild-wide role ${guildSettings.live_role_id} to desiredRoles.`);
            }

            // Determine team-specific roles
            for (const teamConfig of allTeamConfigsForGuild) {
                // Check if this streamer is part of this team's subscriptions
                const isStreamerInTeam = streamerSubscriptions.some(sub =>
                    sub.announcement_channel_id === teamConfig.announcement_channel_id && sub.platform === 'twitch' // Assuming teams are Twitch-specific
                );
                if (isStreamerInTeam && livePlatforms.size > 0) {
                    desiredRoles.add(teamConfig.live_role_id);
                    logger.debug(`[Role Management] Added team-specific role ${teamConfig.live_role_id} to desiredRoles for team ${teamConfig.team_name}.`);
                }
            }

            const allManagedRoles = new Set([guildSettings?.live_role_id, ...allTeamConfigsForGuild.map(t => t.live_role_id)].filter(Boolean));
            logger.debug(`[Role Management] All managed roles for ${guildId}: ${[...allManagedRoles].join(', ')}`);
            logger.debug(`[Role Management] Final desired roles for ${userId} in ${guildId}: ${[...desiredRoles].join(', ')}`);

            for (const roleId of allManagedRoles) {
                if (desiredRoles.has(roleId)) {
                    if (!member.roles.cache.has(roleId)) {
                        logger.info(`[Role Management] Adding role ${roleId} to member ${userId} in guild ${guildId}.`);
                        await handleRole(member, [roleId], 'add', guildId);
                    } else {
                        logger.debug(`[Role Management] Member ${userId} already has desired role ${roleId}.`);
                    }
                } else {
                    if (member.roles.cache.has(roleId)) {
                        logger.info(`[Role Management] Removing role ${roleId} from member ${userId} in guild ${guildId}.`);
                        await handleRole(member, [roleId], 'remove', guildId);
                    }
                    else {
                        logger.debug(`[Role Management] Member ${userId} does not have un-desired role ${roleId}.`);
                    }
                }
            }
        }

    } catch (e) {
        logger.error("[checkStreams] CRITICAL ERROR:", e);
    } finally {
        if (cycleTLS) try { await cycleTLS.exit(); } catch (e) {}
        isChecking = false;
        logger.info('[Check] ---> Finished stream check');
    }
}

async function checkTeams(client) {
    if (isCheckingTeams) { return; }
    isCheckingTeams = true;
    logger.info(`[Team Sync] ---> Starting team sync @ ${new Date().toLocaleTimeString()}`);
    let cycleTLS = null; // Initialize cycleTLS for Kick API calls if needed
    try {
        const [teamSubscriptions] = await db.execute('SELECT * FROM twitch_teams');
        if (teamSubscriptions.length === 0) { logger.info('[Team Sync] No teams are subscribed for syncing.'); isCheckingTeams = false; return; }

        logger.info(`[Team Sync] Found ${teamSubscriptions.length} team subscription(s) to process.`);
        for (const sub of teamSubscriptions) {
            try {
                const apiMembers = await apiChecks.getTwitchTeamMembers(sub.team_name);
                if (!apiMembers) continue;
                const apiMemberIds = new Set(apiMembers.map(m => m.user_id));

                // Fetch existing subscriptions for this guild/channel/platform to determine what to remove
                const [dbTwitchSubs] = await db.execute(`SELECT s.streamer_id, s.platform_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.platform = 'twitch'`, [sub.guild_id, sub.announcement_channel_id]);
                const [dbKickSubs] = await db.execute(`SELECT s.streamer_id, s.platform_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.platform = 'kick'`, [sub.guild_id, sub.announcement_channel_id]);

                const currentTwitchStreamerIds = new Set();
                const currentKickStreamerIds = new Set();

                for (const member of apiMembers) {
                    // --- Handle Twitch Streamer ---
                    // DO NOT update discord_user_id here. It should be set manually or via a linking command.
                    await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES ('twitch', ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, [member.user_id, member.user_login, member.profile_image_url || null]);
                    const [[ts]] = await db.execute('SELECT streamer_id, kick_username FROM streamers WHERE platform=? AND platform_user_id=?', ['twitch', member.user_id]);
                    if (ts) {
                        currentTwitchStreamerIds.add(ts.streamer_id);
                        await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)', [sub.guild_id, ts.streamer_id, sub.announcement_channel_id]);

                        // --- Handle Linked Kick Streamer if exists ---
                        if (ts.kick_username) {
                            // Ensure cycleTLS is initialized if we need to call Kick API for profile_pic
                            if (!cycleTLS) cycleTLS = await initCycleTLS({ timeout: 60000 });

                            // Get Kick user info to ensure we have the correct ID and profile pic
                            // Only update username and profile_image_url, DO NOT update discord_user_id here.
                            const kickUser = await apiChecks.getKickUser(cycleTLS, ts.kick_username);
                            if (kickUser && kickUser.id) {
                                await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES ('kick', ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, [kickUser.id.toString(), kickUser.user.username, kickUser.user.profile_pic || null]);
                                const [[kickStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?', ['kick', kickUser.id.toString()]);
                                if (kickStreamer) {
                                    currentKickStreamerIds.add(kickStreamer.streamer_id);
                                    await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)', [sub.guild_id, kickStreamer.streamer_id, sub.announcement_channel_id]);
                                }
                            } else {
                                logger.warn(`[Team Sync] Could not find Kick user details for linked username ${ts.kick_username} for Twitch member ${member.user_login}.`);
                            }
                        }
                    }
                }

                // --- Remove old Twitch subscriptions ---
                const twitchToRemove = dbTwitchSubs.filter(dbSub => !currentTwitchStreamerIds.has(dbSub.streamer_id));
                if (twitchToRemove.length > 0) {
                    const idsToRemove = twitchToRemove.map(s => s.streamer_id);
                    await db.execute(`DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ? AND platform = 'twitch'`, [idsToRemove, sub.guild_id, sub.announcement_channel_id]);
                    logger.info(`[Team Sync] Removed ${twitchToRemove.length} old Twitch subscriptions.`);
                }

                // --- Remove old Kick subscriptions (if any were managed by this team sync) ---
                const kickToRemove = dbKickSubs.filter(dbSub => !currentKickStreamerIds.has(dbSub.streamer_id));
                if (kickToRemove.length > 0) {
                    const idsToRemove = kickToRemove.map(s => s.streamer_id);
                    await db.execute(`DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ? AND platform = 'kick'`, [idsToRemove, sub.guild_id, sub.announcement_channel_id]);
                    logger.info(`[Team Sync] Removed ${kickToRemove.length} old Kick subscriptions.`);
                }

            } catch (e) { logger.error(`[Team Sync] Error processing team ${sub.team_name}:`, { error: e.message }); }
        }
    } catch (error) { logger.error('[Team Sync] CRITICAL ERROR:', { error: error }); }
    finally {
        if (cycleTLS) try { await cycleTLS.exit(); } catch(e){ logger.error('[Team Sync] Error exiting cycleTLS:', e); }
        isCheckingTeams = false;
        logger.info('[Team Sync] ---> Finished team sync.');
    }
}

async function handleRole(member, roleIds, action, guildId) {
    if (!member || !roleIds || roleIds.length === 0) return;
    for (const roleId of roleIds) {
        if (!roleId) {
            logger.warn(`[handleRole] Attempted to ${action} a null/undefined roleId for member ${member.id} in guild ${guildId}.`);
            continue;
        }
        try {
            if (action === 'add' && !member.roles.cache.has(roleId)) {
                logger.debug(`[handleRole] Attempting to add role ${roleId} to member ${member.id} in guild ${guildId}.`);
                await member.roles.add(roleId);
                logger.info(`[handleRole] Successfully added role ${roleId} to member ${member.id} in guild ${guildId}.`);
            } else if (action === 'remove' && member.roles.cache.has(roleId)) {
                logger.debug(`[handleRole] Attempting to remove role ${roleId} from member ${member.id} in guild ${guildId}.`);
                await member.roles.remove(roleId);
                logger.info(`[handleRole] Successfully removed role ${roleId} from member ${member.id} in guild ${guildId}.`);
            }
            else {
                logger.debug(`[handleRole] No action needed for role ${roleId} on member ${member.id} (action: ${action}, hasRole: ${member.roles.cache.has(roleId)}).`);
            }
        }
        catch (e) {
            if (e.code === 10011 || (e.message && e.message.includes('Unknown Role'))) {
                logger.warn(`[handleRole] Discord API Error: Role ${roleId} is unknown or invalid for member ${member.id} in guild ${guildId}. Initiating cleanup.`);
                await cleanupInvalidRole(guildId, roleId);
            }
            else if (e.code === 50013) { // Missing Permissions
                logger.error(`[handleRole] Discord API Error: Missing permissions to ${action} role ${roleId} for member ${member.id} in guild ${guildId}. Ensure bot has 'Manage Roles' permission and role hierarchy is correct.`, { error: e.message });
            }
            else {
                logger.error(`[handleRole] Failed to ${action} role ${roleId} for member ${member.id} in guild ${guildId}: ${e.message}`, { error: e });
            }
        }
    }
}

// --- END: FUNCTIONS FROM WORKING/index.js ---

main();