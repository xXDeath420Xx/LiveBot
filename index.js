"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
require("dotenv-flow/config");
const discord_js_1 = require("discord.js");
const discord_player_1 = require("discord-player");
const path_1 = tslib_1.__importDefault(require("path"));
const fs_1 = tslib_1.__importDefault(require("fs"));
const tls_manager_1 = require("./utils/tls-manager");
const playwright_youtube_extractor_1 = require("./core/playwright-youtube-extractor");
const ytdlp_extractor_1 = require("./core/ytdlp-extractor");
const local_file_extractor_1 = require("./core/local-file-extractor");
const dj_manager_1 = tslib_1.__importDefault(require("./core/dj-manager"));
const music_panel_1 = tslib_1.__importDefault(require("./core/music-panel"));
const birthday_manager_1 = tslib_1.__importDefault(require("./core/birthday-manager"));
const weather_manager_1 = tslib_1.__importDefault(require("./core/weather-manager"));
const dnd_manager_1 = tslib_1.__importDefault(require("./core/dnd-manager"));
const music_status_manager_1 = tslib_1.__importDefault(require("./core/music-status-manager"));
const verification_manager_1 = tslib_1.__importDefault(require("./core/verification-manager"));
const advanced_automod_manager_1 = tslib_1.__importDefault(require("./core/advanced-automod-manager"));
const voice_activity_manager_1 = tslib_1.__importDefault(require("./core/voice-activity-manager"));
// Phase 6 Managers
const enhanced_leveling_manager_1 = tslib_1.__importDefault(require("./core/enhanced-leveling-manager"));
const scheduled_announcements_manager_1 = tslib_1.__importDefault(require("./core/scheduled-announcements-manager"));
const server_insights_manager_1 = tslib_1.__importDefault(require("./core/server-insights-manager"));
const tiktok_integration_manager_1 = tslib_1.__importDefault(require("./core/tiktok-integration-manager"));
const enhanced_reaction_role_manager_1 = tslib_1.__importDefault(require("./core/enhanced-reaction-role-manager"));
const enhanced_voice_channel_manager_1 = tslib_1.__importDefault(require("./core/enhanced-voice-channel-manager"));
const timed_moderation_manager_1 = tslib_1.__importDefault(require("./core/timed-moderation-manager"));
const raid_protection_manager_1 = tslib_1.__importDefault(require("./core/raid-protection-manager"));
const role_persistence_manager_1 = tslib_1.__importDefault(require("./core/role-persistence-manager"));
const modmail_manager_1 = tslib_1.__importDefault(require("./core/modmail-manager"));
const polls_manager_1 = tslib_1.__importDefault(require("./core/polls-manager"));
const starboard_manager_1 = tslib_1.__importDefault(require("./core/starboard-manager"));
const afk_manager_1 = tslib_1.__importDefault(require("./core/afk-manager"));
const tags_manager_1 = tslib_1.__importDefault(require("./core/tags-manager"));
const joinable_ranks_manager_1 = tslib_1.__importDefault(require("./core/joinable-ranks-manager"));
// Phase 7 Managers - New Feature Systems
const context_menu_manager_1 = tslib_1.__importDefault(require("./core/context-menu-manager"));
const forum_manager_1 = tslib_1.__importDefault(require("./core/forum-manager"));
const scheduled_events_manager_1 = tslib_1.__importDefault(require("./core/scheduled-events-manager"));
const assets_manager_1 = tslib_1.__importDefault(require("./core/assets-manager"));
const soundboard_manager_1 = tslib_1.__importDefault(require("./core/soundboard-manager"));
const webhook_manager_1 = tslib_1.__importDefault(require("./core/webhook-manager"));
const i18n_manager_1 = tslib_1.__importDefault(require("./core/i18n-manager"));
const ai_error_monitor_1 = tslib_1.__importDefault(require("./core/ai-error-monitor"));
const comprehensive_tester_1 = tslib_1.__importDefault(require("./core/comprehensive-tester"));
const logger_1 = tslib_1.__importDefault(require("./utils/logger"));
const geminiApi = tslib_1.__importStar(require("./utils/gemini-api"));
const init_intelligence_1 = require("./init-intelligence");
// --- All Module Imports Moved to Top Level (except dashboard) ---
const db_1 = tslib_1.__importDefault(require("./utils/db"));
const interaction_handler_1 = require("./core/interaction-handler");
const xp_manager_1 = require("./core/xp-manager");
const reaction_role_manager_1 = require("./core/reaction-role-manager");
const starboard_manager_2 = require("./core/starboard-manager");
const automod = tslib_1.__importStar(require("./core/automod"));
const joinGate = tslib_1.__importStar(require("./core/join-gate"));
const inviteManager = tslib_1.__importStar(require("./core/invite-manager"));
const greeting_manager_1 = require("./core/greeting-manager");
const auto_publisher_1 = require("./core/auto-publisher");
const autorole_manager_1 = require("./core/autorole-manager");
const logManager = tslib_1.__importStar(require("./core/log-manager"));
const anti_raid_1 = require("./core/anti-raid");
const stats_manager_1 = require("./core/stats-manager");
const giveaway_manager_1 = require("./core/giveaway-manager");
const poll_manager_1 = require("./core/poll-manager");
const sticky_roles_manager_1 = require("./core/sticky-roles-manager");
const temp_channel_manager_1 = require("./core/temp-channel-manager");
const afk_manager_2 = require("./core/afk-manager");
const twitch_schedule_sync_1 = require("./core/twitch-schedule-sync");
const status_manager_1 = require("./core/status-manager");
const stream_check_scheduler_1 = require("./jobs/stream-check-scheduler");
const ai_scanner_1 = require("./core/ai-scanner");
const activity_logger_1 = require("./core/activity-logger");
const system_worker_1 = tslib_1.__importDefault(require("./jobs/system-worker"));
const analytics_scheduler_1 = tslib_1.__importDefault(require("./jobs/analytics-scheduler"));
const reminder_worker_1 = tslib_1.__importDefault(require("./jobs/reminder-worker"));
const announcement_worker_1 = tslib_1.__importDefault(require("./jobs/announcement-worker"));
const offline_worker_1 = tslib_1.__importDefault(require("./jobs/offline-worker"));
const poll_scheduler_1 = tslib_1.__importDefault(require("./jobs/poll-scheduler"));
const ticket_worker_1 = tslib_1.__importDefault(require("./jobs/ticket-worker"));
const social_feed_scheduler_1 = require("./jobs/social-feed-scheduler");
const ticket_scheduler_1 = require("./jobs/ticket-scheduler");
const startup_1 = require("./core/startup");
const streamManager = tslib_1.__importStar(require("./core/stream-manager"));
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMembers,
        discord_js_1.GatewayIntentBits.GuildVoiceStates,
        discord_js_1.GatewayIntentBits.GuildMessages,
        discord_js_1.GatewayIntentBits.MessageContent,
        discord_js_1.GatewayIntentBits.GuildMessageReactions,
        discord_js_1.GatewayIntentBits.GuildInvites
    ],
    partials: [
        discord_js_1.Partials.Message,
        discord_js_1.Partials.Channel,
        discord_js_1.Partials.Reaction,
        discord_js_1.Partials.User,
        discord_js_1.Partials.GuildMember
    ],
});
async function start() {
    console.log(" Initializing Player...");
    const player = new discord_player_1.Player(client, {
        fallbackExtractor: playwright_youtube_extractor_1.PlaywrightYouTubeExtractor
    });
    // Register yt-dlp YouTube Extractor (primary method with local caching)
    await player.extractors.register(ytdlp_extractor_1.YtdlpExtractor, {});
    console.log("[Player] Registered yt-dlp YouTube Extractor (download + cache).");
    // Register Playwright YouTube Extractor (fallback method)
    await player.extractors.register(playwright_youtube_extractor_1.PlaywrightYouTubeExtractor, {});
    console.log("[Player] Registered Playwright YouTube Extractor (browser automation fallback).");
    // Register Local File Extractor for DJ commentary and local audio files
    await player.extractors.register(local_file_extractor_1.LocalFileExtractor, {});
    console.log("[Player] Registered Local File Extractor for commentary playback.");
    // Load default extractors for everything else (Spotify, SoundCloud, etc.)
    try {
        const { DefaultExtractors } = await Promise.resolve().then(() => tslib_1.__importStar(require('@discord-player/extractor')));
        // Filter out YouTube extractor since we're using Playwright instead
        const extractorsToLoad = DefaultExtractors.filter((ext) => !ext.identifier?.includes('youtube'));
        await player.extractors.loadMulti(extractorsToLoad);
        console.log("[Player] Loaded default extractors (excluding YouTube).");
    }
    catch (err) {
        console.log("[Player] Could not load @discord-player/extractor, skipping default extractors.");
    }
    client.player = player;
    console.log(" Player Initialized.");
    client.djManager = new dj_manager_1.default(client);
    console.log(" DJ Manager Initialized.");
    client.birthdayManager = new birthday_manager_1.default(client);
    console.log(" Birthday Manager Initialized.");
    client.weatherManager = new weather_manager_1.default(client);
    console.log(" Weather Manager Initialized.");
    client.dndManager = new dnd_manager_1.default(client);
    console.log(" D&D Manager Initialized.");
    client.musicStatusManager = new music_status_manager_1.default(client);
    console.log(" Music Status Manager Initialized.");
    client.verificationManager = new verification_manager_1.default(client);
    console.log(" Verification Manager Initialized.");
    client.advancedAutomod = new advanced_automod_manager_1.default(client);
    console.log(" Advanced Automod Manager Initialized.");
    client.voiceActivityManager = new voice_activity_manager_1.default(client);
    console.log(" Voice Activity Manager Initialized.");
    // Phase 6A Managers
    client.enhancedLeveling = new enhanced_leveling_manager_1.default(client);
    console.log(" Enhanced Leveling Manager Initialized.");
    client.scheduledAnnouncements = new scheduled_announcements_manager_1.default(client);
    console.log(" Scheduled Announcements Manager Initialized.");
    client.serverInsights = new server_insights_manager_1.default(client);
    console.log(" Server Insights Manager Initialized.");
    client.tiktok = new tiktok_integration_manager_1.default(client);
    console.log(" TikTok Integration Manager Initialized.");
    client.enhancedReactionRoles = new enhanced_reaction_role_manager_1.default(client);
    console.log(" Enhanced Reaction Role Manager Initialized.");
    client.enhancedVoiceChannels = new enhanced_voice_channel_manager_1.default(client);
    console.log(" Enhanced Voice Channel Manager Initialized.");
    // Phase 6B Managers
    client.timedModeration = new timed_moderation_manager_1.default(client);
    console.log(" Timed Moderation Manager Initialized.");
    client.raidProtection = new raid_protection_manager_1.default(client);
    console.log(" Raid Protection Manager Initialized.");
    client.rolePersistence = new role_persistence_manager_1.default(client);
    console.log(" Role Persistence Manager Initialized.");
    client.modmail = new modmail_manager_1.default(client);
    console.log(" Modmail Manager Initialized.");
    client.polls = new polls_manager_1.default(client);
    console.log(" Polls Manager Initialized.");
    client.starboard = new starboard_manager_1.default(client);
    console.log(" Starboard Manager Initialized.");
    client.afk = new afk_manager_1.default(client);
    console.log(" AFK Manager Initialized.");
    client.tags = new tags_manager_1.default(client);
    console.log(" Tags Manager Initialized.");
    client.joinableRanks = new joinable_ranks_manager_1.default(client);
    console.log(" Joinable Ranks Manager Initialized.");
    // Phase 7 Managers
    client.contextMenu = new context_menu_manager_1.default(client);
    console.log(" Context Menu Manager Initialized.");
    client.forum = new forum_manager_1.default(client);
    console.log(" Forum Manager Initialized.");
    client.scheduledEvents = new scheduled_events_manager_1.default(client);
    console.log(" Scheduled Events Manager Initialized.");
    client.assets = new assets_manager_1.default(client);
    console.log(" Assets Manager Initialized.");
    client.soundboard = new soundboard_manager_1.default(client);
    console.log(" Soundboard Manager Initialized.");
    client.webhook = new webhook_manager_1.default(client);
    console.log(" Webhook Manager Initialized.");
    client.i18n = new i18n_manager_1.default(client);
    console.log(" i18n Manager Initialized.");
    client.musicPanelManager = new discord_js_1.Collection();
    client.player.events.on("debug", (queue, message) => {
        logger_1.default.debug(`[Player Debug] Guild ${queue?.guild?.id || 'N/A'}: ${message}`);
    });
    (0, status_manager_1.setStatus)(status_manager_1.Status.STARTING);
    process.on('unhandledRejection', (reason, promise) => {
        console.error('****************************************************************');
        console.error('[Unhandled Rejection] A promise was rejected but the error could not be fully serialized.');
        if (reason instanceof Error) {
            console.error(`[Unhandled Rejection] Message: ${reason.message}`);
            console.error(`[Unhandled Rejection] Stack: ${reason.stack}`);
        }
        else {
            console.error('[Unhandled Rejection] Reason:', reason);
        }
        console.error('****************************************************************');
    });
    process.on('uncaughtException', (error) => {
        const errorMessage = error.stack || error.message;
        logger_1.default.error(`[Uncaught Exception] ${errorMessage}`);
    });
    try {
        await (0, tls_manager_1.getCycleTLSInstance)();
    }
    catch (cycleTlsError) {
        (0, status_manager_1.setStatus)(status_manager_1.Status.ERROR, "Failed to initialize CycleTLS.");
        console.error(" Error initializing CycleTLS:", cycleTlsError.stack);
        return;
    }
    client.commands = new discord_js_1.Collection();
    const commandsPath = path_1.default.join(__dirname, "commands");
    const commandFiles = fs_1.default.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));
    for (const file of commandFiles) {
        try {
            const command = require(path_1.default.join(commandsPath, file));
            if (command.data && command.execute) {
                client.commands.set(command.data.name, command);
            }
        }
        catch (e) {
            console.error(` ${file}:`, e.stack);
        }
    }
    console.log(` ${client.commands.size} commands loaded.`);
    client.buttons = new discord_js_1.Collection();
    client.modals = new discord_js_1.Collection();
    client.selects = new discord_js_1.Collection();
    const interactionsPath = path_1.default.join(__dirname, "interactions");
    if (fs_1.default.existsSync(interactionsPath)) {
        for (const folder of fs_1.default.readdirSync(interactionsPath)) {
            const fullPath = path_1.default.join(interactionsPath, folder);
            if (fs_1.default.statSync(fullPath).isDirectory()) {
                const componentFiles = fs_1.default.readdirSync(fullPath).filter((f) => f.endsWith(".js"));
                for (const file of componentFiles) {
                    try {
                        const component = require(path_1.default.join(fullPath, file));
                        if (component.customId && component.execute) {
                            if (folder === "buttons") {
                                client.buttons.set(component.customId, component);
                            }
                            else if (folder === "modals") {
                                client.modals.set(component.customId, component);
                            }
                            else if (folder === "selects") {
                                client.selects.set(component.customId, component);
                            }
                        }
                    }
                    catch (e) {
                        console.error(`[Component Load Error] ${file}:`, e.stack);
                    }
                }
            }
        }
    }
    console.log(` ${client.buttons.size} buttons, ${client.modals.size} modals, and ${client.selects.size} select menus loaded.`);
    // --- Player Event Handlers ---
    client.player.events.on("playerStart", async (queue, track) => {
        logger_1.default.info(`[Player Event] playerStart triggered for track: ${track.title}`, { guildId: queue.guild.id });
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) {
            await panel.updatePanel(queue);
        }
        if (track.metadata?.isDJCommentary)
            return;
        if (panel && panel.message.channelId === queue.metadata.channelId)
            return;
        let requesterTag = 'Unknown User';
        if (track.requestedBy && track.requestedBy.id !== client.user?.id) {
            requesterTag = track.requestedBy.tag;
        }
        else if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
            try {
                const djUser = await client.users.fetch(queue.metadata.djInitiatorId);
                requesterTag = djUser.tag;
            }
            catch { }
        }
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && channel.isTextBased()) {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor("#57F287")
                .setAuthor({ name: "Now Playing" })
                .setTitle(track.title)
                .setURL(track.url)
                .setThumbnail(track.thumbnail || null)
                .addFields({ name: "Artist", value: track.author || "N/A", inline: true }, { name: "Duration", value: track.duration || "0:00", inline: true })
                .setFooter({ text: `Requested by ${requesterTag}` });
            channel.send({ embeds: [embed] });
        }
        if (track.requestedBy) {
            try {
                await db_1.default.execute(`INSERT INTO music_history (guild_id, user_id, song_title, song_url, artist, timestamp)
                     VALUES (?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE timestamp = NOW()`, [queue.guild.id, track.requestedBy.id, track.title, track.url, track.author]);
            }
            catch (error) {
                console.error((`[DB] Failed to log song to music_history for guild ${queue.guild.id}`, error).message);
            }
        }
        // Pre-load next 2-3 tracks in queue (performance optimization)
        try {
            // Get next 3 YouTube tracks from queue
            const youtubeTracks = queue.tracks.toArray()
                .filter((t) => t.source === 'com.certifried.playwright-youtube')
                .slice(0, 3);
            if (youtubeTracks.length > 0) {
                logger_1.default.info(`[Pre-load] Starting batch pre-load for next ${youtubeTracks.length} tracks`);
                // Get the PlaywrightYouTubeExtractor instance
                const extractors = client.player.extractors.store.values();
                let playwrightExtractor = null;
                for (const ext of extractors) {
                    if (ext.identifier === 'com.certifried.playwright-youtube') {
                        playwrightExtractor = ext;
                        break;
                    }
                }
                if (playwrightExtractor && playwrightExtractor.preloadManager) {
                    // Pre-load multiple tracks asynchronously (don't await - let it run in background)
                    playwrightExtractor.preloadManager.preloadMultiple(youtubeTracks).catch((err) => {
                        logger_1.default.warn(`[Pre-load] Failed to batch pre-load tracks: ${err.message}`);
                    });
                }
                else {
                    logger_1.default.warn(`[Pre-load] Could not find Playwright extractor or preloadManager`);
                }
            }
        }
        catch (error) {
            logger_1.default.error(`[Pre-load] Error in pre-load logic: ${error.message}`);
        }
    });
    client.player.events.on("audioTrackAdd", async (queue, track) => {
        if (queue.metadata?.djMode && (!track.requestedBy || track.requestedBy.id === client.user?.id) && queue.metadata?.djInitiatorId) {
            try {
                track.requestedBy = await client.users.fetch(queue.metadata.djInitiatorId);
            }
            catch (e) {
                logger_1.default.warn(`[Attribution Fix] Could not fetch DJ initiator user with ID ${queue.metadata.djInitiatorId}`);
            }
        }
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel)
            await panel.updatePanel(queue);
        if (track.metadata?.isDJCommentary || (panel && panel.message.channelId === queue.metadata.channelId))
            return;
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (!channel)
            return;
        let requesterTag = track.requestedBy ? track.requestedBy.tag : 'Unknown User';
        const embed = new discord_js_1.EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: "Added to Queue" })
            .setTitle(track.title)
            .setURL(track.url)
            .setThumbnail(track.thumbnail || null)
            .addFields({ name: "Position in queue", value: `${queue.tracks.size}`, inline: true }, { name: "Duration", value: track.duration || "0:00", inline: true })
            .setFooter({ text: `Requested by ${requesterTag}` });
        if (channel.send) {
            channel.send({ embeds: [embed] });
        }
        // Pre-load next tracks if queue has enough songs
        try {
            if (queue.currentTrack && queue.tracks.size >= 1) {
                // Get next 3 YouTube tracks from queue
                const youtubeTracks = queue.tracks.toArray()
                    .filter((t) => t.source === 'com.certifried.playwright-youtube')
                    .slice(0, 3);
                if (youtubeTracks.length > 0) {
                    const extractors = client.player.extractors.store.values();
                    let playwrightExtractor = null;
                    for (const ext of extractors) {
                        if (ext.identifier === 'com.certifried.playwright-youtube') {
                            playwrightExtractor = ext;
                            break;
                        }
                    }
                    if (playwrightExtractor && playwrightExtractor.preloadManager) {
                        playwrightExtractor.preloadManager.preloadMultiple(youtubeTracks).catch((err) => {
                            logger_1.default.warn(`[Pre-load] Failed to batch pre-load added tracks: ${err.message}`);
                        });
                    }
                }
            }
        }
        catch (error) {
            logger_1.default.error(`[Pre-load] Error in audioTrackAdd pre-load logic: ${error.message}`);
        }
    });
    client.player.events.on("audioTracksAdd", async (queue, tracks) => {
        if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
            try {
                const djUser = await client.users.fetch(queue.metadata.djInitiatorId);
                if (djUser) {
                    tracks.forEach((track) => {
                        if (!track.requestedBy || track.requestedBy.id === client.user?.id)
                            track.requestedBy = djUser;
                    });
                }
            }
            catch (e) {
                logger_1.default.warn(`[Attribution Fix] Could not fetch DJ initiator user for batch add with ID ${queue.metadata.djInitiatorId}`);
            }
        }
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel)
            await panel.updatePanel(queue);
        if (tracks.some((t) => t.metadata?.isDJCommentary) || (panel && panel.message.channelId === queue.metadata.channelId))
            return;
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (!channel)
            return;
        const firstTrack = tracks[0];
        let requesterTag = firstTrack.requestedBy ? firstTrack.requestedBy.tag : 'Unknown User';
        if (firstTrack?.playlist) {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor("#3498DB")
                .setAuthor({ name: "Added Playlist to Queue" })
                .setTitle(firstTrack.playlist.title)
                .setURL(firstTrack.playlist.url)
                .setThumbnail(firstTrack.playlist.thumbnail || null)
                .addFields({ name: "Tracks", value: `${tracks.length}`, inline: true })
                .setFooter({ text: `Requested by ${requesterTag}` });
            if (channel.send) {
                channel.send({ embeds: [embed] });
            }
        }
        else {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor("#3498DB")
                .setAuthor({ name: "Added to Queue" })
                .setDescription(`Added **${tracks.length}** songs to the queue.`)
                .setFooter({ text: `Requested by ${requesterTag}` });
            if (channel.send) {
                channel.send({ embeds: [embed] });
            }
        }
    });
    client.player.events.on("emptyQueue", (queue) => {
        logger_1.default.info(`[Player Event] emptyQueue triggered for guild: ${queue.guild.id}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) {
            panel.updatePanel(queue);
        }
    });
    client.player.events.on("playerStop", (queue) => {
        logger_1.default.info(`[Player Event] playerStop triggered for guild: ${queue.guild.id}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) {
            panel.updatePanel(queue);
        }
    });
    client.player.events.on("error", async (queue, error) => {
        logger_1.default.error(`[Player Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel)
            await panel.updatePanel(queue);
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && channel.isTextBased() && (!panel || panel.message.channelId !== channel.id)) {
            channel.send(`❌ | An error occurred: ${error.message.slice(0, 1900)}`);
        }
    });
    client.player.events.on("playerError", async (queue, error) => {
        logger_1.default.error(`[Player Connection Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel)
            await panel.updatePanel(queue);
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && channel.isTextBased() && (!panel || panel.message.channelId !== channel.id)) {
            channel.send(`❌ | A connection error occurred: ${error.message.slice(0, 1900)}`);
        }
    });
    // --- Interaction Handlers ---
    client.on(discord_js_1.Events.InteractionCreate, async (interaction) => {
        // Phase 6 managers - button/select menu handlers
        if (interaction.isButton() && interaction.customId.startsWith('reaction_role_')) {
            if (client.enhancedReactionRoles) {
                await client.enhancedReactionRoles.handleButtonInteraction(interaction);
                return;
            }
        }
        else if (interaction.isButton() && interaction.customId.startsWith('poll_vote_')) {
            if (client.polls) {
                await client.polls.handleVote(interaction);
                return;
            }
        }
        else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reaction_role_select_')) {
            if (client.enhancedReactionRoles) {
                await client.enhancedReactionRoles.handleSelectMenuInteraction(interaction);
                return;
            }
        }
        if (interaction.isChatInputCommand()) {
            (0, interaction_handler_1.handleInteraction)(interaction);
        }
        else if (interaction.isButton() && interaction.customId.startsWith('music-')) {
            const panel = client.musicPanelManager.get(interaction.guildId);
            if (panel) {
                panel.handleInteraction(interaction);
            }
            else {
                await interaction.reply({ content: 'This music panel is no longer active. Please create a new one.', flags: discord_js_1.MessageFlags.Ephemeral });
            }
        }
        else if (interaction.isStringSelectMenu() && interaction.customId === 'music-add-song') {
            const panel = client.musicPanelManager.get(interaction.guildId);
            if (panel) {
                panel.handleInteraction(interaction);
            }
            else {
                await interaction.reply({ content: 'This music panel is no longer active. Please create a new one.', flags: discord_js_1.MessageFlags.Ephemeral });
            }
        }
        else if (interaction.isButton() && interaction.customId.startsWith('trivia_answer_')) {
            const funCommand = client.commands.get('fun');
            if (funCommand && funCommand.handleButtonInteraction) {
                await funCommand.handleButtonInteraction(interaction);
            }
            else {
                await interaction.reply({ content: 'Trivia handler not found. Please contact an administrator.', flags: discord_js_1.MessageFlags.Ephemeral });
            }
        }
        else if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
            if (client.verificationManager) {
                await client.verificationManager.handleButtonInteraction(interaction);
            }
        }
        else if (interaction.isModalSubmit() && interaction.customId === 'add-song-modal') {
            await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
            const member = interaction.member;
            if (!member.voice.channel) {
                return interaction.editReply({ content: "You must be in a voice channel to add a song!" });
            }
            const query = interaction.fields.getTextInputValue('song-input');
            try {
                const { track } = await client.player.play(member.voice.channel, query, {
                    requestedBy: interaction.user,
                    nodeOptions: {
                        metadata: { channelId: interaction.channel?.id }
                    }
                });
                await interaction.editReply({ content: `✅ | Added **${track.title}** to the queue.` });
            }
            catch (e) {
                logger_1.default.error("[Modal Song Add Error]", e);
                await interaction.editReply({ content: `An error occurred: ${e.message}` });
            }
        }
        else if (interaction.isModalSubmit() && interaction.customId === 'ai-dj-modal') {
            const member = interaction.member;
            const guild = interaction.guild;
            await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
            if (!member.voice.channel) {
                return interaction.editReply({ content: "You must be in a voice channel to start a DJ session." });
            }
            const [musicConfigRows] = await db_1.default.execute("SELECT * FROM music_config WHERE guild_id = ?", [guild.id]);
            const musicConfig = musicConfigRows[0];
            if (!musicConfig || !musicConfig.dj_enabled) {
                return interaction.editReply({ content: "The AI DJ is not enabled on this server. An admin can enable it in the dashboard." });
            }
            const prompt = interaction.fields.getTextInputValue('dj-prompt-input');
            const inputSong = interaction.fields.getTextInputValue('dj-song-input');
            const inputArtist = interaction.fields.getTextInputValue('dj-artist-input');
            const inputGenre = interaction.fields.getTextInputValue('dj-genre-input');
            try {
                let queue = client.player.nodes.get(guild.id);
                const isQueueActive = queue && queue.isPlaying();
                if (!queue) {
                    queue = client.player.nodes.create(guild.id, {
                        metadata: { channelId: interaction.channel?.id, djMode: true, voiceChannelId: member.voice.channel.id, playedTracks: [], inputSong, inputArtist, inputGenre, prompt, djInitiatorId: interaction.user.id },
                        selfDeaf: true, volume: 80, leaveOnEmpty: true, leaveOnEmptyCooldown: 300000, leaveOnEnd: false, leaveOnEndCooldown: 300000,
                    });
                }
                else {
                    queue.metadata.djMode = true;
                    queue.leaveOnEnd = false;
                    if (!queue.metadata.djInitiatorId)
                        queue.metadata.djInitiatorId = interaction.user.id;
                }
                if (!queue.connection)
                    await queue.connect(member.voice.channel.id);
                if (!queue.metadata.playedTracks)
                    queue.metadata.playedTracks = [];
                const geminiRecommendedTracks = await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, queue.metadata.playedTracks, prompt);
                if (!geminiRecommendedTracks || geminiRecommendedTracks.length === 0) {
                    return interaction.editReply({ content: `❌ | Gemini AI could not generate a playlist based on your request. Please try again with different inputs.` });
                }
                const trackPromises = geminiRecommendedTracks.map(async (recTrack) => {
                    const query = `${recTrack.title} ${recTrack.artist}`;
                    const searchResult = await client.player.search(query, {
                        requestedBy: interaction.user,
                        metadata: { artist: recTrack.artist, fromPanel: true }
                    });
                    if (searchResult.hasTracks()) {
                        const track = searchResult.tracks[0];
                        if (!track.url.includes('youtube.com/shorts'))
                            return track;
                    }
                    return null;
                });
                const allPlaylistTracks = (await Promise.all(trackPromises)).filter((track) => track !== null);
                if (allPlaylistTracks.length === 0) {
                    return interaction.editReply({ content: `❌ | Could not find any playable tracks for the generated playlist.` });
                }
                queue.metadata.playedTracks.push(...allPlaylistTracks.map((t) => t.title));
                await client.djManager.playPlaylistIntro(queue, allPlaylistTracks, isQueueActive);
                if (!isQueueActive) {
                    await queue.node.play();
                }
                return interaction.editReply({ content: `🎧 | AI DJ session started! I've added ${allPlaylistTracks.length} songs to the queue.` });
            }
            catch (e) {
                logger_1.default.error("[AI DJ Modal Error]", e);
                return interaction.editReply({ content: `An error occurred: ${e.message}` });
            }
        }
    });
    // --- Other Event Handlers ---
    client.on(discord_js_1.Events.MessageCreate, async (message) => {
        if (message.author.bot || !message.guild)
            return;
        const funCommand = client.commands.get('fun');
        if (funCommand && funCommand.handleMessage) {
            const handled = await funCommand.handleMessage(message);
            if (handled)
                return;
        }
        if (client.afk)
            await client.afk.handleMessage(message);
        if (client.enhancedLeveling)
            await client.enhancedLeveling.handleMessageXP(message);
        if (client.modmail)
            await client.modmail.handleMessage(message);
        if (afk_manager_2.checkAfkStatus)
            await (0, afk_manager_2.checkAfkStatus)(message);
        if (stats_manager_1.incrementMessageCount)
            await (0, stats_manager_1.incrementMessageCount)(message.guild.id);
        if (xp_manager_1.handleMessageXP)
            await (0, xp_manager_1.handleMessageXP)(message);
        if (automod.processMessage)
            await automod.processMessage(message);
        if (client.advancedAutomod)
            await client.advancedAutomod.checkMessage(message);
        if (auto_publisher_1.handleNewMessage)
            await (0, auto_publisher_1.handleNewMessage)(message);
        if (ai_scanner_1.scanMessage)
            await (0, ai_scanner_1.scanMessage)(message);
        if (activity_logger_1.logMessageActivity)
            (0, activity_logger_1.logMessageActivity)(message);
    });
    client.on(discord_js_1.Events.MessageReactionAdd, async (reaction, user) => {
        if (user.bot)
            return;
        if (client.starboard)
            await client.starboard.handleReactionAdd(reaction, user);
        if (reaction_role_manager_1.handleReactionAdd)
            await (0, reaction_role_manager_1.handleReactionAdd)(reaction, user);
        if (starboard_manager_2.handleReactionAdd)
            await (0, starboard_manager_2.handleReactionAdd)(reaction, user);
    });
    if (reaction_role_manager_1.handleReactionRemove) {
        client.on(discord_js_1.Events.MessageReactionRemove, reaction_role_manager_1.handleReactionRemove);
    }
    client.on(discord_js_1.Events.GuildMemberAdd, async (member) => {
        if (client.raidProtection)
            await client.raidProtection.handleMemberJoin(member);
        if (client.rolePersistence)
            await client.rolePersistence.handleMemberAdd(member);
        if (anti_raid_1.handleMemberJoin)
            await (0, anti_raid_1.handleMemberJoin)(member);
        if (joinGate.processNewMember)
            await joinGate.processNewMember(member);
        if (client.verificationManager)
            await client.verificationManager.handleMemberJoin(member);
        if (inviteManager.handleGuildMemberAdd)
            await inviteManager.handleGuildMemberAdd(member);
        if (greeting_manager_1.handleGuildMemberAdd)
            await (0, greeting_manager_1.handleGuildMemberAdd)(member);
        if (sticky_roles_manager_1.restoreUserRoles)
            await (0, sticky_roles_manager_1.restoreUserRoles)(member);
        if (autorole_manager_1.handleNewMember)
            await (0, autorole_manager_1.handleNewMember)(member);
        if (ai_scanner_1.scanUsername)
            await (0, ai_scanner_1.scanUsername)(member);
    });
    client.on(discord_js_1.Events.GuildMemberRemove, async (member) => {
        if (client.rolePersistence)
            await client.rolePersistence.handleMemberRemove(member);
        if (inviteManager.handleGuildMemberRemove)
            await inviteManager.handleGuildMemberRemove(member);
        if (greeting_manager_1.handleGuildMemberRemove)
            await (0, greeting_manager_1.handleGuildMemberRemove)(member);
        if (sticky_roles_manager_1.saveUserRoles)
            await (0, sticky_roles_manager_1.saveUserRoles)(member);
        if (logManager.logGuildMemberRemove)
            await logManager.logGuildMemberRemove(member);
    });
    if (inviteManager.cacheInvites) {
        client.on(discord_js_1.Events.InviteCreate, async (invite) => await inviteManager.cacheInvites(invite.guild));
    }
    if (inviteManager.guildInvites) {
        client.on(discord_js_1.Events.InviteDelete, (invite) => inviteManager.guildInvites.get(invite.guild.id)?.delete(invite.code));
    }
    if (logManager.logMessageDelete) {
        client.on(discord_js_1.Events.MessageDelete, logManager.logMessageDelete);
    }
    if (logManager.logMessageUpdate) {
        client.on(discord_js_1.Events.MessageUpdate, logManager.logMessageUpdate);
    }
    client.on(discord_js_1.Events.GuildMemberUpdate, async (oldMember, newMember) => {
        if (client.rolePersistence)
            await client.rolePersistence.handleRoleUpdate(oldMember, newMember);
        if (logManager.logMemberUpdate)
            logManager.logMemberUpdate(oldMember, newMember);
    });
    client.on(discord_js_1.Events.VoiceStateUpdate, async (oldState, newState) => {
        if (client.enhancedLeveling)
            await client.enhancedLeveling.handleVoiceStateUpdate(oldState, newState);
        if (client.enhancedVoiceChannels)
            await client.enhancedVoiceChannels.handleVoiceStateUpdate(oldState, newState);
        if (temp_channel_manager_1.handleVoiceStateUpdate)
            (0, temp_channel_manager_1.handleVoiceStateUpdate)(oldState, newState);
        if (client.voiceActivityManager)
            await client.voiceActivityManager.handleVoiceStateUpdate(oldState, newState);
        if (logManager.logVoiceStateUpdate)
            logManager.logVoiceStateUpdate(oldState, newState);
        if (activity_logger_1.logVoiceStateUpdate)
            (0, activity_logger_1.logVoiceStateUpdate)(oldState, newState);
    });
    // === ADVANCED LOGGING: Channel Events ===
    if (logManager.logChannelCreate) {
        client.on(discord_js_1.Events.ChannelCreate, logManager.logChannelCreate);
    }
    if (logManager.logChannelDelete) {
        client.on(discord_js_1.Events.ChannelDelete, logManager.logChannelDelete);
    }
    if (logManager.logChannelUpdate) {
        client.on(discord_js_1.Events.ChannelUpdate, logManager.logChannelUpdate);
    }
    // === ADVANCED LOGGING: Thread Events ===
    if (logManager.logThreadCreate) {
        client.on(discord_js_1.Events.ThreadCreate, logManager.logThreadCreate);
    }
    if (logManager.logThreadDelete) {
        client.on(discord_js_1.Events.ThreadDelete, logManager.logThreadDelete);
    }
    if (logManager.logThreadUpdate) {
        client.on(discord_js_1.Events.ThreadUpdate, logManager.logThreadUpdate);
    }
    // === ADVANCED LOGGING: Guild/Server Events ===
    if (logManager.logGuildUpdate) {
        client.on(discord_js_1.Events.GuildUpdate, logManager.logGuildUpdate);
    }
    if (logManager.logGuildBanAdd) {
        client.on(discord_js_1.Events.GuildBanAdd, logManager.logGuildBanAdd);
    }
    if (logManager.logGuildBanRemove) {
        client.on(discord_js_1.Events.GuildBanRemove, logManager.logGuildBanRemove);
    }
    // === ADVANCED LOGGING: Role Events ===
    if (logManager.logRoleCreate) {
        client.on(discord_js_1.Events.GuildRoleCreate, logManager.logRoleCreate);
    }
    if (logManager.logRoleDelete) {
        client.on(discord_js_1.Events.GuildRoleDelete, logManager.logRoleDelete);
    }
    if (logManager.logRoleUpdate) {
        client.on(discord_js_1.Events.GuildRoleUpdate, logManager.logRoleUpdate);
    }
    // === ADVANCED LOGGING: Emoji Events ===
    if (logManager.logEmojiCreate) {
        client.on(discord_js_1.Events.GuildEmojiCreate, logManager.logEmojiCreate);
    }
    if (logManager.logEmojiDelete) {
        client.on(discord_js_1.Events.GuildEmojiDelete, logManager.logEmojiDelete);
    }
    if (logManager.logEmojiUpdate) {
        client.on(discord_js_1.Events.GuildEmojiUpdate, logManager.logEmojiUpdate);
    }
    // === ADVANCED LOGGING: Sticker Events ===
    if (logManager.logStickerCreate) {
        client.on(discord_js_1.Events.GuildStickerCreate, logManager.logStickerCreate);
    }
    if (logManager.logStickerDelete) {
        client.on(discord_js_1.Events.GuildStickerDelete, logManager.logStickerDelete);
    }
    if (logManager.logStickerUpdate) {
        client.on(discord_js_1.Events.GuildStickerUpdate, logManager.logStickerUpdate);
    }
    // === ADVANCED LOGGING: Webhook/Integration Events ===
    if (logManager.logWebhookUpdate) {
        client.on(discord_js_1.Events.WebhooksUpdate, logManager.logWebhookUpdate);
    }
    if (logManager.logIntegrationUpdate) {
        client.on(discord_js_1.Events.GuildIntegrationsUpdate, logManager.logIntegrationUpdate);
    }
    // --- Client Ready Event ---
    client.once(discord_js_1.Events.ClientReady, async (c) => {
        global.client = c;
        console.log(` Logged in as ${c.user?.tag}`);
        (0, status_manager_1.setStatus)(status_manager_1.Status.ONLINE);
        try {
            const [panelConfigs] = await db_1.default.execute('SELECT * FROM music_panels');
            for (const config of panelConfigs) {
                try {
                    const guild = await client.guilds.fetch(config.guild_id);
                    const channel = await guild.channels.fetch(config.channel_id);
                    const message = await channel.messages.fetch(config.message_id);
                    const panel = new music_panel_1.default(client, guild.id);
                    panel.message = message;
                    client.musicPanelManager.set(guild.id, panel);
                    const queue = client.player.nodes.get(guild.id);
                    await panel.updatePanel(queue);
                }
                catch (e) {
                    logger_1.default.error(`[Music Panel Load] Failed to load panel for guild ${config.guild_id}: ${e.message}`);
                }
            }
            console.log(`Loaded ${client.musicPanelManager.size} music panels.`);
        }
        catch (e) {
            console.error("Error loading music panels from DB:", e);
        }
        // --- Job Schedulers & Workers ---
        try {
            await (0, stream_check_scheduler_1.setupSystemJobs)();
        }
        catch (e) {
            console.error(" Error during system job setup:", e);
        }
        try {
            (0, system_worker_1.default)(c);
        }
        catch (e) {
            console.error(" Error starting system worker:", e);
        }
        try {
            (0, analytics_scheduler_1.default)(c);
        }
        catch (e) {
            console.error(" Error starting analytics scheduler:", e);
        }
        try {
            (0, reminder_worker_1.default)(c, db_1.default);
        }
        catch (e) {
            console.error(" Error starting reminder worker:", e);
        }
        try {
            (0, announcement_worker_1.default)(c);
        }
        catch (e) {
            console.error(" Error starting announcement worker:", e);
        }
        try {
            (0, offline_worker_1.default)(c);
        }
        catch (e) {
            console.error(" Error starting offline worker:", e);
        }
        try {
            (0, poll_scheduler_1.default)(c);
        }
        catch (e) {
            console.error(" Error starting poll scheduler:", e);
        }
        try {
            (0, ticket_worker_1.default)(c);
        }
        catch (e) {
            console.error(" Error starting ticket worker:", e);
        }
        try {
            await client.birthdayManager.start();
            console.log("✅ Birthday manager started");
        }
        catch (e) {
            console.error(" Error starting birthday manager:", e);
        }
        try {
            await client.weatherManager.start(60);
            console.log("✅ Weather manager started");
        }
        catch (e) {
            console.error(" Error starting weather manager:", e);
        }
        // --- Phase 6 Scheduler Starts ---
        try {
            if (client.scheduledAnnouncements) {
                client.scheduledAnnouncements.startScheduler();
                console.log("✅ Scheduled Announcements scheduler started");
            }
        }
        catch (e) {
            console.error(" Error starting scheduled announcements:", e);
        }
        try {
            if (client.serverInsights) {
                client.serverInsights.startMetricsCollection();
                console.log("✅ Server Insights metrics collection started");
            }
        }
        catch (e) {
            console.error(" Error starting server insights:", e);
        }
        try {
            if (client.tiktok) {
                client.tiktok.startMonitoring();
                console.log("✅ TikTok monitoring started");
            }
        }
        catch (e) {
            console.error(" Error starting TikTok monitoring:", e);
        }
        try {
            if (client.timedModeration) {
                client.timedModeration.startScheduler();
                console.log("✅ Timed Moderation scheduler started");
            }
        }
        catch (e) {
            console.error(" Error starting timed moderation:", e);
        }
        try {
            if (client.polls) {
                client.polls.startScheduler();
                console.log("✅ Polls scheduler started");
            }
        }
        catch (e) {
            console.error(" Error starting polls scheduler:", e);
        }
        // --- Phase 7 Manager Initializations ---
        try {
            if (client.contextMenu) {
                await client.contextMenu.init();
                console.log("✅ Context Menu Manager initialized");
            }
        }
        catch (e) {
            console.error(" Error initializing Context Menu Manager:", e);
        }
        try {
            if (client.forum) {
                await client.forum.init();
                console.log("✅ Forum Manager initialized");
            }
        }
        catch (e) {
            console.error(" Error initializing Forum Manager:", e);
        }
        try {
            if (client.scheduledEvents) {
                await client.scheduledEvents.init();
                console.log("✅ Scheduled Events Manager initialized");
            }
        }
        catch (e) {
            console.error(" Error initializing Scheduled Events Manager:", e);
        }
        try {
            if (client.assets) {
                await client.assets.init();
                console.log("✅ Assets Manager initialized");
            }
        }
        catch (e) {
            console.error(" Error initializing Assets Manager:", e);
        }
        try {
            if (client.soundboard) {
                await client.soundboard.init();
                console.log("✅ Soundboard Manager initialized");
            }
        }
        catch (e) {
            console.error(" Error initializing Soundboard Manager:", e);
        }
        try {
            if (client.webhook) {
                await client.webhook.init();
                console.log("✅ Webhook Manager initialized");
            }
        }
        catch (e) {
            console.error(" Error initializing Webhook Manager:", e);
        }
        try {
            if (client.i18n) {
                await client.i18n.init();
                console.log("✅ i18n Manager initialized");
            }
        }
        catch (e) {
            console.error(" Error initializing i18n Manager:", e);
        }
        if (process.env.IS_MAIN_PROCESS === "true") {
            try {
                await (0, social_feed_scheduler_1.scheduleSocialFeedChecks)();
            }
            catch (e) {
                console.error(" Failed to schedule social feed checks:", e);
            }
            try {
                await (0, ticket_scheduler_1.scheduleTicketChecks)();
            }
            catch (e) {
                console.error(" Failed to schedule ticket checks:", e);
            }
        }
        if (giveaway_manager_1.checkGiveaways) {
            setInterval(giveaway_manager_1.checkGiveaways, 15 * 1000);
        }
        if (poll_manager_1.checkPolls) {
            setInterval(poll_manager_1.checkPolls, 30 * 1000);
        }
        if (twitch_schedule_sync_1.syncTwitchSchedules) {
            setInterval(() => (0, twitch_schedule_sync_1.syncTwitchSchedules)(c), 5 * 60 * 1000);
        }
        streamManager.init(c);
        try {
            await (0, startup_1.startupCleanup)(c);
        }
        catch (e) {
            console.error(" Error during startup cleanup:", e);
        }
        if (process.env.IS_MAIN_PROCESS === "true") {
            const dashboard = await Promise.resolve(`${path_1.default.join(__dirname, "dashboard", "server.js")}`).then(s => tslib_1.__importStar(require(s)));
            dashboard.start(client);
        }
        try {
            logger_1.default.init(client, db_1.default);
        }
        catch (e) {
            console.error(" Error during logger initialization:", e);
        }
        try {
            await (0, init_intelligence_1.initializeIntelligenceSystems)(client);
        }
        catch (e) {
            console.error(" Error during intelligence systems initialization:", e);
        }
        // --- AI Error Monitoring & Testing ---
        try {
            await ai_error_monitor_1.default.startMonitoring(c);
            logger_1.default.info('[Bot] AI Error Monitoring started - monitoring all PM2 processes');
            console.log("✅ AI Error Monitor initialized");
        }
        catch (e) {
            console.error(" Error starting AI Error Monitor:", e);
        }
        try {
            const testResults = await comprehensive_tester_1.default.runAllTests(c);
            const passedTests = testResults.filter(r => r.status === 'pass').length;
            const failedTests = testResults.filter(r => r.status === 'fail').length;
            logger_1.default.info(`[Tester] Completed comprehensive tests: ${passedTests} passed, ${failedTests} failed`);
            console.log(`✅ Comprehensive Tests: ${passedTests} passed, ${failedTests} failed`);
        }
        catch (e) {
            console.error(" Error running comprehensive tests:", e);
        }
    });
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error('DISCORD_TOKEN is not defined in environment variables');
    }
    try {
        await client.login(token);
    }
    catch (loginError) {
        console.error(" Error logging in to Discord:", loginError);
        process.exit(1);
    }
}
start().catch((e) => {
    console.error("Unhandled error during bot startup:", e);
    process.exit(1);
});
const cleanup = async () => {
    console.warn(" Received shutdown signal. Shutting down gracefully...");
    process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
//# sourceMappingURL=index.js.map