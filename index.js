try {
    const { Client, GatewayIntentBits, Collection, Events, Partials, EmbedBuilder } = require('discord.js');
    const path = require('path');
    const fs = require('fs');
    require('dotenv').config({ path: path.resolve(__dirname, '.env') });

    const logger = require('./utils/logger');
    const db = require('./utils/db');
    const { redisOptions } = require('./utils/cache');
    const apiChecks = require('./utils/api_checks.js');
    const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));
    const { handleInteraction } = require('./core/interaction-handler');
    const { handleMessageXP } = require('./core/xp-manager');
    const { handleReactionAdd: handleReactionRole, handleReactionRemove } = require('./core/reaction-role-manager');
    const { handleReactionAdd: handleStarboard } = require('./core/starboard-manager');
    const automod = require('./core/automod');
    const joinGate = require('./core/join-gate');
    const inviteManager = require('./core/invite-manager');
    const { handleGuildMemberAdd, handleGuildMemberRemove } = require('./core/greeting-manager');
    const { handleNewMessage: handleAutoPublish } = require('./core/auto-publisher');
    const { handleNewMember: handleAutorole } = require('./core/autorole-manager');
    const logManager = require('./core/log-manager');
    const { handleMemberJoin: handleAntiRaid } = require('./core/anti-raid');
    const { incrementMessageCount } = require('./core/stats-manager');
    const { checkGiveaways } = require('./core/giveaway-manager');
    const { checkPolls } = require('./core/poll-manager');
    const { saveUserRoles, restoreUserRoles } = require('./core/sticky-roles-manager');
    const { handleVoiceStateUpdate: handleTempChannel } = require('./core/temp-channel-manager');
    const { checkAfkStatus } = require('./core/afk-manager');
    const { syncTwitchSchedules } = require('./core/twitch-schedule-sync');
    const { setStatus, Status } = require('./core/status-manager');
    const { DisTube } = require('distube');
    const { SoundCloudPlugin } = require('@distube/soundcloud');
    const { SpotifyPlugin } = require('@distube/spotify');
    const { YtDlpPlugin } = require('@distube/yt-dlp');
    const { Worker } = require('bullmq');
    const { setupSystemJobs } = require('./jobs/stream-check-scheduler');
    const { checkStreams, checkTeams } = require('./core/stream-checker');
    const { scanMessage, scanUsername } = require('./core/ai-scanner.js');
    const { logMessageActivity, logVoiceStateUpdate, flushVoiceActivity } = require('./core/activity-logger.js');

    let giveawayInterval, pollInterval, twitchScheduleInterval;

    async function main() {
        setStatus(Status.STARTING);

        let client;
        try {
            client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMembers,
                    GatewayIntentBits.GuildModeration,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.DirectMessages,
                    GatewayIntentBits.GuildInvites,
                    GatewayIntentBits.GuildMessageReactions,
                    GatewayIntentBits.GuildVoiceStates,
                ],
                partials: [Partials.User, Partials.GuildMember, Partials.Channel, Partials.Message, Partials.Reaction]
            });
        } catch (clientInitError) {
            setStatus(Status.ERROR, 'Failed to initialize Discord client.');
            logger.error('[CRITICAL] Error initializing Discord client:', { error: clientInitError.stack });
            return;
        }

        try {
            logger.init(client, db);
        } catch (loggerInitError) {
            setStatus(Status.ERROR, 'Failed to initialize logger.');
            logger.error('[CRITICAL] Error during logger initialization:', { error: loggerInitError.stack });
            return;
        }

        // Command Loader
        client.commands = new Collection();
        try {
            const commandsPath = path.join(__dirname, 'commands');
            const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
            for (const file of commandFiles) {
                try {
                    const command = require(path.join(commandsPath, file));
                    if (command.data && command.execute) {
                        client.commands.set(command.data.name, command);
                    }
                } catch (e) {
                    logger.error(`[CMD Load Error] ${file}:`, { error: e.stack });
                }
            }
        } catch (commandLoaderError) {
            setStatus(Status.ERROR, 'Failed to load commands.');
            logger.error('[CRITICAL] Error in command loader:', { error: commandLoaderError.stack });
            return;
        }
        logger.info(`[Startup] ${client.commands.size} commands loaded.`);

        // Interaction Component Loader
        client.buttons = new Collection();
        client.modals = new Collection();
        client.selects = new Collection();
        try {
            const interactionsPath = path.join(__dirname, 'interactions');
            if (fs.existsSync(interactionsPath)) {
                for (const folder of fs.readdirSync(interactionsPath)) {
                    const fullPath = path.join(interactionsPath, folder);
                    if (fs.statSync(fullPath).isDirectory()) {
                        const componentFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.js'));
                        for (const file of componentFiles) {
                            try {
                                const component = require(path.join(fullPath, file));
                                if (component.customId && component.execute) {
                                    if (folder === 'buttons') client.buttons.set(component.customId, component);
                                    else if (folder === 'modals') client.modals.set(component.customId, component);
                                    else if (folder === 'selects') client.selects.set(component.customId, component);
                                }
                            } catch (e) {
                                logger.error(`[Component Load Error] ${file}:`, { error: e.stack });
                            }
                        }
                    }
                }
            }
        } catch (interactionLoaderError) {
            setStatus(Status.ERROR, 'Failed to load interaction components.');
            logger.error('[CRITICAL] Error in interaction component loader:', { error: interactionLoaderError.stack });
            return;
        }
        logger.info(`[Startup] ${client.buttons.size} buttons, ${client.modals.size} modals, and ${client.selects.size} select menus loaded.`);

        // Event Handlers
        if (handleInteraction) client.on(Events.InteractionCreate, handleInteraction);
        client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot || !message.guild) return;
            if (checkAfkStatus) await checkAfkStatus(message);
            if (incrementMessageCount) await incrementMessageCount(message.guild.id);
            if (handleMessageXP) await handleMessageXP(message);
            if (automod.processMessage) await automod.processMessage(message);
            if (handleAutoPublish) await handleAutoPublish(message);
            if (scanMessage) await scanMessage(message);
            if (logMessageActivity) logMessageActivity(message);
        });
        client.on(Events.MessageReactionAdd, async (reaction, user) => {
            if (user.bot) return;
            if (handleReactionRole) await handleReactionRole(reaction, user);
            if (handleStarboard) await handleStarboard(reaction, user);
        });
        if (handleReactionRemove) client.on(Events.MessageReactionRemove, handleReactionRemove);
        client.on(Events.GuildMemberAdd, async (member) => {
            if (handleAntiRaid) await handleAntiRaid(member);
            if (joinGate.processNewMember) await joinGate.processNewMember(member);
            if (inviteManager.handleGuildMemberAdd) await inviteManager.handleGuildMemberAdd(member);
            if (handleGuildMemberAdd) await handleGuildMemberAdd(member);
            if (restoreUserRoles) await restoreUserRoles(member);
            if (handleAutorole) await handleAutorole(member);
            if (scanUsername) await scanUsername(member);
        });
        client.on(Events.GuildMemberRemove, async (member) => {
            if (inviteManager.handleGuildMemberRemove) await inviteManager.handleGuildMemberRemove(member);
            if (handleGuildMemberRemove) await handleGuildMemberRemove(member);
            if (saveUserRoles) await saveUserRoles(member);
        });
        if (inviteManager.cacheInvites) client.on(Events.InviteCreate, async (invite) => await inviteManager.cacheInvites(invite.guild));
        if (inviteManager.guildInvites) client.on(Events.InviteDelete, (invite) => inviteManager.guildInvites.get(invite.guild.id)?.delete(invite.code));
        if (logManager.logMessageDelete) client.on(Events.MessageDelete, logManager.logMessageDelete);
        if (logManager.logMessageUpdate) client.on(Events.MessageUpdate, logManager.logMessageUpdate);
        client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
            if (logManager.logMemberRoleUpdate) logManager.logMemberRoleUpdate(oldMember, newMember);
            if (logManager.logMemberNicknameUpdate) logManager.logMemberNicknameUpdate(oldMember, newMember);
        });
        if (logManager.logChannelCreate) client.on(Events.ChannelCreate, logManager.logChannelCreate);
        if (logManager.logChannelDelete) client.on(Events.ChannelDelete, logManager.logChannelDelete);
        if (logManager.logRoleCreate) client.on(Events.RoleCreate, logManager.logRoleCreate);
        if (logManager.logRoleDelete) client.on(Events.RoleDelete, logManager.logRoleDelete);
        client.on(Events.VoiceStateUpdate, (oldState, newState) => {
            if (handleTempChannel) handleTempChannel(oldState, newState);
            if (logManager.logVoiceStateUpdate) logManager.logVoiceStateUpdate(oldState, newState);
            if (logVoiceStateUpdate) logVoiceStateUpdate(oldState, newState);
        });

        try {
            client.distube = new DisTube(client, {
                emitNewSongOnly: true,
                emitAddSongWhenCreatingQueue: true,
                emitAddListWhenCreatingQueue: true,
                plugins: [
                    new SoundCloudPlugin(),
                    new SpotifyPlugin({
                        api: {
                            clientId: process.env.SPOTIFY_CLIENT_ID,
                            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
                        },
                    }),
                    new YtDlpPlugin()
                ]
            });
        } catch (distubeError) {
            setStatus(Status.ERROR, 'Failed to initialize DisTube.');
            logger.error('[CRITICAL] Error initializing DisTube:', { error: distubeError.stack });
        }

        // DisTube Event Handlers
        client.distube
            .on('playSong', (queue, song) => {
                const embed = new EmbedBuilder()
                    .setColor('#57F287')
                    .setAuthor({ name: 'Now Playing' })
                    .setTitle(song.name)
                    .setURL(song.url)
                    .setThumbnail(song.thumbnail)
                    .addFields(
                        { name: 'Channel', value: song.uploader.name, inline: true },
                        { name: 'Duration', value: song.formattedDuration, inline: true }
                    )
                    .setFooter({ text: `Requested by ${song.user.tag}` });
                queue.textChannel.send({ embeds: [embed] });
            })
            .on('addSong', (queue, song) => {
                const embed = new EmbedBuilder()
                    .setColor('#3498DB')
                    .setAuthor({ name: 'Added to Queue' })
                    .setTitle(song.name)
                    .setURL(song.url)
                    .setThumbnail(song.thumbnail)
                    .addFields(
                        { name: 'Position in queue', value: `${queue.songs.length - 1}`.toString(), inline: true },
                        { name: 'Duration', value: song.formattedDuration, inline: true }
                    )
                    .setFooter({ text: `Requested by ${song.user.tag}` });
                queue.textChannel.send({ embeds: [embed] });
            })
            .on('addList', (queue, playlist) => {
                 queue.textChannel.send(
                    `✅ | Added \`${playlist.name}\` playlist (${playlist.songs.length} songs) to queue!`
                 );
            })
            .on('error', (channel, error) => {
                logger.error('[DisTube Error]', error);
                if (channel) channel.send(`❌ | An error encountered: ${error.message.slice(0, 1900)}`);
            });

        client.once(Events.ClientReady, async c => {
            global.client = c;
            logger.info(`[READY] Logged in as ${c.user.tag}`);
            setStatus(Status.ONLINE);

            try { // Added try-catch around setupSystemJobs
                await setupSystemJobs();
            } catch (setupJobsError) {
                setStatus(Status.ERROR, 'Failed to setup system jobs.');
                logger.error('[CRITICAL] Error during system job setup:', { error: setupJobsError.stack });
                return; // Prevent further execution if critical setup fails
            }

            if (checkGiveaways) giveawayInterval = setInterval(checkGiveaways, 15 * 1000);
            logger.info('[Startup] Giveaway checker started.');
            if (checkPolls) pollInterval = setInterval(checkPolls, 30 * 1000);
            logger.info('[Startup] Poll checker started.');
            if (syncTwitchSchedules) twitchScheduleInterval = setInterval(() => syncTwitchSchedules(client), 5 * 60 * 1000);
            logger.info('[Startup] Twitch schedule sync started.');

            try {
                await apiChecks.getCycleTLSInstance();
                if (process.env.IS_MAIN_PROCESS === 'true') {
                    dashboard.start(client);
                } else {
                    logger.info('[Dashboard] Skipping dashboard start in worker process.', { category: 'system' });
                }
            }
            catch (e) {
                setStatus(Status.ERROR, 'Failed during post-ready startup procedures.');
                logger.error('[ClientReady Error]', { error: e.stack });
            }
        });

        try {
            const worker = new Worker('system-tasks', async job => {
                if (job.name === 'check-streams') {
                    await checkStreams(client);
                } else if (job.name === 'sync-teams') {
                    await checkTeams(client);
                }
            }, {
                connection: redisOptions,
                autorun: true
            });

            worker.on('completed', job => {
                logger.info(`[Worker] Job ${job.id} (type: ${job.name}) has completed.`);
            });

            worker.on('failed', (job, err) => {
                logger.error(`[Worker] Job ${job.id} (type: ${job.name}) failed.`, { error: err.stack });
            });
        }
        catch (workerError) {
            setStatus(Status.ERROR, 'Failed to initialize BullMQ worker.');
            logger.error('[CRITICAL] Error initializing BullMQ worker:', { error: workerError.stack });
        }

        // Wrap client.login() in a try-catch block and write error to file
        try {
            await client.login(process.env.DISCORD_TOKEN);
        } catch (loginError) {
            setStatus(Status.ERROR, 'Failed to log in to Discord.');
            const errorDetails = loginError.stack || loginError.message || JSON.stringify(loginError);
            fs.writeFileSync('/tmp/discord_login_error.log', `[CRITICAL] Error logging in to Discord: ${errorDetails}\n`, { flag: 'a' });
            console.error('[CRITICAL] Error logging in to Discord (details written to /tmp/discord_login_error.log):', loginError);
            return; // Stop execution if login fails critically
        }
    }

    const cleanup = async () => {
        logger.warn('[Shutdown] Received shutdown signal. Shutting down gracefully...');
        if (giveawayInterval) clearInterval(giveawayInterval);
        if (pollInterval) clearInterval(pollInterval);
        if (twitchScheduleInterval) clearInterval(twitchScheduleInterval);
        if (flushVoiceActivity) await flushVoiceActivity();
        if (apiChecks && typeof apiChecks.exitCycleTLSInstance === 'function') {
            await apiChecks.exitCycleTLSInstance();
        }
        if (db && typeof db.end === 'function') {
            await db.end();
        }
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    main().catch(e => {
        setStatus(Status.ERROR, 'A critical error occurred in the main function.');
        const errorDetails = e.stack || e.message || 'No stack trace available.';
        logger.error('[CRITICAL] Unhandled error in main function:', { error: errorDetails });
    });

} catch (topLevelError) {
    // This catch block is for errors during the initial require statements or very early synchronous code.
    // Since logger might not be initialized yet, we'll use console.error.
    console.error('[CRITICAL] Unhandled error during top-level require or early startup:', topLevelError.stack);
    process.exit(1);
}