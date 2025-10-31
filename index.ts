import 'dotenv-flow/config';
import { Client, GatewayIntentBits, Collection, Events, Partials, EmbedBuilder, MessageFlags } from 'discord.js';
import { Player, BaseExtractor, Track } from 'discord-player';
import path from 'path';
import fs from 'fs';
import { getCycleTLSInstance } from './utils/tls-manager';
import { PlaywrightYouTubeExtractor } from './core/playwright-youtube-extractor';
import { YtdlpExtractor } from './core/ytdlp-extractor';
import { LocalFileExtractor } from './core/local-file-extractor';
import DJManager from './core/dj-manager';
import MusicPanel from './core/music-panel';
import BirthdayManager from './core/birthday-manager';
import WeatherManager from './core/weather-manager';
import DNDManager from './core/dnd-manager';
import MusicStatusManager from './core/music-status-manager';
import VerificationManager from './core/verification-manager';
import AdvancedAutomodManager from './core/advanced-automod-manager';
import VoiceActivityManager from './core/voice-activity-manager';
// Phase 6 Managers
import EnhancedLevelingManager from './core/enhanced-leveling-manager';
import ScheduledAnnouncementsManager from './core/scheduled-announcements-manager';
import ServerInsightsManager from './core/server-insights-manager';
import TikTokIntegrationManager from './core/tiktok-integration-manager';
import EnhancedReactionRoleManager from './core/enhanced-reaction-role-manager';
import EnhancedVoiceChannelManager from './core/enhanced-voice-channel-manager';
import TimedModerationManager from './core/timed-moderation-manager';
import RaidProtectionManager from './core/raid-protection-manager';
import RolePersistenceManager from './core/role-persistence-manager';
import ModmailManager from './core/modmail-manager';
import PollsManager from './core/polls-manager';
import StarboardManager from './core/starboard-manager';
import AFKManager from './core/afk-manager';
import TagsManager from './core/tags-manager';
import JoinableRanksManager from './core/joinable-ranks-manager';
// Phase 7 Managers - New Feature Systems
import ContextMenuManager from './core/context-menu-manager';
import ForumManager from './core/forum-manager';
import ScheduledEventsManager from './core/scheduled-events-manager';
import AssetsManager from './core/assets-manager';
import SoundboardManager from './core/soundboard-manager';
import WebhookManager from './core/webhook-manager';
import I18nManager from './core/i18n-manager';
import aiErrorMonitor from './core/ai-error-monitor';
import comprehensiveTester from './core/comprehensive-tester';
import logger from './utils/logger';
import * as geminiApi from './utils/gemini-api';
import { initializeIntelligenceSystems } from './init-intelligence';

// --- All Module Imports Moved to Top Level (except dashboard) ---
import db from './utils/db';
import { handleInteraction } from './core/interaction-handler';
import { handleMessageXP } from './core/xp-manager';
import { handleReactionAdd as handleReactionRole, handleReactionRemove } from './core/reaction-role-manager';
import { handleReactionAdd as handleStarboard } from './core/starboard-manager';
import * as automod from './core/automod';
import * as joinGate from './core/join-gate';
import * as inviteManager from './core/invite-manager';
import { handleGuildMemberAdd, handleGuildMemberRemove } from './core/greeting-manager';
import { handleNewMessage as handleAutoPublish } from './core/auto-publisher';
import { handleNewMember as handleAutorole } from './core/autorole-manager';
import * as logManager from './core/log-manager';
import { handleMemberJoin as handleAntiRaid } from './core/anti-raid';
import { incrementMessageCount } from './core/stats-manager';
import { checkGiveaways } from './core/giveaway-manager';
import { checkPolls } from './core/poll-manager';
import { saveUserRoles, restoreUserRoles } from './core/sticky-roles-manager';
import { handleVoiceStateUpdate as handleTempChannel } from './core/temp-channel-manager';
import { checkAfkStatus } from './core/afk-manager';
import { syncTwitchSchedules } from './core/twitch-schedule-sync';
import { setStatus, Status } from './core/status-manager';
import { setupSystemJobs } from './jobs/stream-check-scheduler';
import { scanMessage, scanUsername } from './core/ai-scanner';
import { logMessageActivity, logVoiceStateUpdate } from './core/activity-logger';
import startSystemWorker from './jobs/system-worker';
import startAnalyticsScheduler from './jobs/analytics-scheduler';
import startReminderWorker from './jobs/reminder-worker';
import startAnnouncementWorker from './jobs/announcement-worker';
import startOfflineWorker from './jobs/offline-worker';
import startSocialFeedWorker from './jobs/social-feed-worker';
import startPollScheduler from './jobs/poll-scheduler';
import startTicketWorker from './jobs/ticket-worker';
import { scheduleSocialFeedChecks } from './jobs/social-feed-scheduler';
import { scheduleTicketChecks } from './jobs/ticket-scheduler';
import { startupCleanup } from './core/startup';
import * as streamManager from './core/stream-manager';
import { URL } from 'url';
import type { ExtendedClient, Command } from './types';
import type { ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction, Message, GuildMember, VoiceState, MessageReaction, User, Invite, Guild } from 'discord.js';
import type { Connection, RowDataPacket } from 'mysql2/promise';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildInvites
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
        Partials.User,
        Partials.GuildMember
    ],
}) as ExtendedClient;

async function start(): Promise<void> {
    console.log(" Initializing Player...");

    const player = new Player(client, {
        fallbackExtractor: PlaywrightYouTubeExtractor
    });

    // Register yt-dlp YouTube Extractor (primary method with local caching)
    await player.extractors.register(YtdlpExtractor, {});
    console.log("[Player] Registered yt-dlp YouTube Extractor (download + cache).");

    // Register Playwright YouTube Extractor (fallback method)
    await player.extractors.register(PlaywrightYouTubeExtractor, {});
    console.log("[Player] Registered Playwright YouTube Extractor (browser automation fallback).");

    // Register Local File Extractor for DJ commentary and local audio files
    await player.extractors.register(LocalFileExtractor, {});
    console.log("[Player] Registered Local File Extractor for commentary playback.");

    // Load default extractors for everything else (Spotify, SoundCloud, etc.)
    try {
        const { DefaultExtractors } = await import('@discord-player/extractor');
        // Filter out YouTube extractor since we're using Playwright instead
        const extractorsToLoad = DefaultExtractors.filter((ext: any) => !ext.identifier?.includes('youtube'));
        await player.extractors.loadMulti(extractorsToLoad);
        console.log("[Player] Loaded default extractors (excluding YouTube).");
    } catch (err) {
        console.log("[Player] Could not load @discord-player/extractor, skipping default extractors.");
    }

    (client as any).player = player;
    console.log(" Player Initialized.");

    (client as any).djManager = new DJManager(client);
    console.log(" DJ Manager Initialized.");

    (client as any).birthdayManager = new BirthdayManager(client);
    console.log(" Birthday Manager Initialized.");

    (client as any).weatherManager = new WeatherManager(client);
    console.log(" Weather Manager Initialized.");

    (client as any).dndManager = new DNDManager(client);
    console.log(" D&D Manager Initialized.");

    (client as any).musicStatusManager = new MusicStatusManager(client);
    console.log(" Music Status Manager Initialized.");

    (client as any).verificationManager = new VerificationManager(client);
    console.log(" Verification Manager Initialized.");

    (client as any).advancedAutomod = new AdvancedAutomodManager(client);
    console.log(" Advanced Automod Manager Initialized.");

    (client as any).voiceActivityManager = new VoiceActivityManager(client);
    console.log(" Voice Activity Manager Initialized.");

    // Phase 6A Managers
    (client as any).enhancedLeveling = new EnhancedLevelingManager(client);
    console.log(" Enhanced Leveling Manager Initialized.");

    (client as any).scheduledAnnouncements = new ScheduledAnnouncementsManager(client);
    console.log(" Scheduled Announcements Manager Initialized.");

    (client as any).serverInsights = new ServerInsightsManager(client);
    console.log(" Server Insights Manager Initialized.");

    (client as any).tiktok = new TikTokIntegrationManager(client);
    console.log(" TikTok Integration Manager Initialized.");

    (client as any).enhancedReactionRoles = new EnhancedReactionRoleManager(client);
    console.log(" Enhanced Reaction Role Manager Initialized.");

    (client as any).enhancedVoiceChannels = new EnhancedVoiceChannelManager(client);
    console.log(" Enhanced Voice Channel Manager Initialized.");

    // Phase 6B Managers
    (client as any).timedModeration = new TimedModerationManager(client);
    console.log(" Timed Moderation Manager Initialized.");

    (client as any).raidProtection = new RaidProtectionManager(client);
    console.log(" Raid Protection Manager Initialized.");

    (client as any).rolePersistence = new RolePersistenceManager(client);
    console.log(" Role Persistence Manager Initialized.");

    (client as any).modmail = new ModmailManager(client);
    console.log(" Modmail Manager Initialized.");

    (client as any).polls = new PollsManager(client);
    console.log(" Polls Manager Initialized.");

    (client as any).starboard = new StarboardManager(client);
    console.log(" Starboard Manager Initialized.");

    (client as any).afk = new AFKManager(client);
    console.log(" AFK Manager Initialized.");

    (client as any).tags = new TagsManager(client);
    console.log(" Tags Manager Initialized.");

    (client as any).joinableRanks = new JoinableRanksManager(client);
    console.log(" Joinable Ranks Manager Initialized.");

    // Phase 7 Managers
    (client as any).contextMenu = new ContextMenuManager(client);
    console.log(" Context Menu Manager Initialized.");

    (client as any).forum = new ForumManager(client);
    console.log(" Forum Manager Initialized.");

    (client as any).scheduledEvents = new ScheduledEventsManager(client);
    console.log(" Scheduled Events Manager Initialized.");

    (client as any).assets = new AssetsManager(client);
    console.log(" Assets Manager Initialized.");

    (client as any).soundboard = new SoundboardManager(client);
    console.log(" Soundboard Manager Initialized.");

    (client as any).webhook = new WebhookManager(client);
    console.log(" Webhook Manager Initialized.");

    (client as any).i18n = new I18nManager(client);
    console.log(" i18n Manager Initialized.");

    (client as any).musicPanelManager = new Collection();

    (client as any).player.events.on("debug", (queue: any, message: string) => {
        logger.debug(`[Player Debug] Guild ${queue?.guild?.id || 'N/A'}: ${message}`);
    });

    setStatus(Status.STARTING);

    process.on('unhandledRejection', (reason: unknown, promise: Promise<any>) => {
        console.error('****************************************************************');
        console.error('[Unhandled Rejection] A promise was rejected but the error could not be fully serialized.');
        if (reason instanceof Error) {
            console.error(`[Unhandled Rejection] Message: ${reason.message}`);
            console.error(`[Unhandled Rejection] Stack: ${reason.stack}`);
        } else {
            console.error('[Unhandled Rejection] Reason:', reason);
        }
        console.error('****************************************************************');
    });

    process.on('uncaughtException', (error: Error) => {
        const errorMessage: string = error.stack || error.message;
        logger.error(`[Uncaught Exception] ${errorMessage}`);
    });

    try {
        await getCycleTLSInstance();
    } catch (cycleTlsError: unknown) {
        setStatus(Status.ERROR, "Failed to initialize CycleTLS.");
        console.error(" Error initializing CycleTLS:", (cycleTlsError as Error).stack);
        return;
    }

    client.commands = new Collection<string, Command>();
    const commandsPath: string = path.join(__dirname, "commands");
    const commandFiles: string[] = fs.readdirSync(commandsPath).filter((f: string) => f.endsWith(".js"));
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.data && command.execute) {
                client.commands.set(command.data.name, command);
            }
        } catch (e: unknown) {
            console.error(` ${file}:`, (e as Error).stack);
        }
    }
    console.log(` ${client.commands.size} commands loaded.`);

    client.buttons = new Collection();
    client.modals = new Collection();
    (client as any).selects = new Collection();
    const interactionsPath: string = path.join(__dirname, "interactions");
    if (fs.existsSync(interactionsPath)) {
        for (const folder of fs.readdirSync(interactionsPath)) {
            const fullPath: string = path.join(interactionsPath, folder);
            if (fs.statSync(fullPath).isDirectory()) {
                const componentFiles: string[] = fs.readdirSync(fullPath).filter((f: string) => f.endsWith(".js"));
                for (const file of componentFiles) {
                    try {
                        const component = require(path.join(fullPath, file));
                        if (component.customId && component.execute) {
                            if (folder === "buttons") {
                                client.buttons.set(component.customId, component);
                            } else if (folder === "modals") {
                                client.modals.set(component.customId, component);
                            } else if (folder === "selects") {
                                (client as any).selects.set(component.customId, component);
                            }
                        }
                    } catch (e: unknown) {
                        console.error(`[Component Load Error] ${file}:`, (e as Error).stack);
                    }
                }
            }
        }
    }
    console.log(` ${client.buttons.size} buttons, ${client.modals.size} modals, and ${(client as any).selects.size} select menus loaded.`);

    // --- Player Event Handlers ---

    (client as any).player.events.on("playerStart", async (queue: any, track: any) => {
        logger.info(`[Player Event] playerStart triggered for track: ${track.title}`, { guildId: queue.guild.id });
        const panel = (client as any).musicPanelManager.get(queue.guild.id);
        if (panel) {
            await panel.updatePanel(queue);
        }

        if (track.metadata?.isDJCommentary) return;
        if (panel && panel.message.channelId === queue.metadata.channelId) return;

        let requesterTag: string = 'Unknown User';
        if (track.requestedBy && track.requestedBy.id !== client.user?.id) {
            requesterTag = track.requestedBy.tag;
        } else if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
            try {
                const djUser = await client.users.fetch(queue.metadata.djInitiatorId);
                requesterTag = djUser.tag;
            } catch {}
        }

        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && channel.isTextBased()) {
            const embed = new EmbedBuilder()
                .setColor("#57F287")
                .setAuthor({name: "Now Playing"})
                .setTitle(track.title)
                .setURL(track.url)
                .setThumbnail(track.thumbnail || null)
                .addFields(
                    {name: "Artist", value: track.author || "N/A", inline: true},
                    {name: "Duration", value: track.duration || "0:00", inline: true}
                )
                .setFooter({text: `Requested by ${requesterTag}`});
            (channel as any).send({embeds: [embed]});
        }

        if (track.requestedBy) {
            try {
                await db.execute(
                    `INSERT INTO music_history (guild_id, user_id, song_title, song_url, artist, timestamp)
                     VALUES (?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE timestamp = NOW()`,
                    [queue.guild.id, track.requestedBy.id, track.title, track.url, track.author]
                );
            } catch (error: unknown) {
                console.error((`[DB] Failed to log song to music_history for guild ${queue.guild.id}`, (error as any) as Error).message);
            }
        }

        // Pre-load next 2-3 tracks in queue (performance optimization)
        try {
            // Get next 3 YouTube tracks from queue
            const youtubeTracks = queue.tracks.toArray()
                .filter((t: any) => t.source === 'com.certifried.playwright-youtube')
                .slice(0, 3);

            if (youtubeTracks.length > 0) {
                logger.info(`[Pre-load] Starting batch pre-load for next ${youtubeTracks.length} tracks`);

                // Get the PlaywrightYouTubeExtractor instance
                const extractors = (client as any).player.extractors.store.values();
                let playwrightExtractor: any = null;
                for (const ext of extractors) {
                    if (ext.identifier === 'com.certifried.playwright-youtube') {
                        playwrightExtractor = ext;
                        break;
                    }
                }

                if (playwrightExtractor && playwrightExtractor.preloadManager) {
                    // Pre-load multiple tracks asynchronously (don't await - let it run in background)
                    playwrightExtractor.preloadManager.preloadMultiple(youtubeTracks).catch((err: Error) => {
                        logger.warn(`[Pre-load] Failed to batch pre-load tracks: ${err.message}`);
                    });
                } else {
                    logger.warn(`[Pre-load] Could not find Playwright extractor or preloadManager`);
                }
            }
        } catch (error: unknown) {
            logger.error(`[Pre-load] Error in pre-load logic: ${(error as Error).message}`);
        }
    });

    (client as any).player.events.on("audioTrackAdd", async (queue: any, track: any) => {
        if (queue.metadata?.djMode && (!track.requestedBy || track.requestedBy.id === client.user?.id) && queue.metadata?.djInitiatorId) {
            try {
                track.requestedBy = await client.users.fetch(queue.metadata.djInitiatorId);
            } catch (e: unknown) {
                logger.warn(`[Attribution Fix] Could not fetch DJ initiator user with ID ${queue.metadata.djInitiatorId}`);
            }
        }

        const panel = (client as any).musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);

        if (track.metadata?.isDJCommentary || (panel && panel.message.channelId === queue.metadata.channelId)) return;

        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (!channel) return;

        let requesterTag: string = track.requestedBy ? track.requestedBy.tag : 'Unknown User';
        const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({name: "Added to Queue"})
            .setTitle(track.title)
            .setURL(track.url)
            .setThumbnail(track.thumbnail || null)
            .addFields(
                {name: "Position in queue", value: `${queue.tracks.size}`, inline: true},
                {name: "Duration", value: track.duration || "0:00", inline: true}
            )
            .setFooter({text: `Requested by ${requesterTag}`});
        if ((channel as any).send) {
            (channel as any).send({embeds: [embed]});
        }

        // Pre-load next tracks if queue has enough songs
        try {
            if (queue.currentTrack && queue.tracks.size >= 1) {
                // Get next 3 YouTube tracks from queue
                const youtubeTracks = queue.tracks.toArray()
                    .filter((t: any) => t.source === 'com.certifried.playwright-youtube')
                    .slice(0, 3);

                if (youtubeTracks.length > 0) {
                    const extractors = (client as any).player.extractors.store.values();
                    let playwrightExtractor: any = null;
                    for (const ext of extractors) {
                        if (ext.identifier === 'com.certifried.playwright-youtube') {
                            playwrightExtractor = ext;
                            break;
                        }
                    }

                    if (playwrightExtractor && playwrightExtractor.preloadManager) {
                        playwrightExtractor.preloadManager.preloadMultiple(youtubeTracks).catch((err: Error) => {
                            logger.warn(`[Pre-load] Failed to batch pre-load added tracks: ${err.message}`);
                        });
                    }
                }
            }
        } catch (error: unknown) {
            logger.error(`[Pre-load] Error in audioTrackAdd pre-load logic: ${(error as Error).message}`);
        }
    });

    (client as any).player.events.on("audioTracksAdd", async (queue: any, tracks: any[]) => {
        if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
            try {
                const djUser = await client.users.fetch(queue.metadata.djInitiatorId);
                if (djUser) {
                    tracks.forEach((track: any) => {
                        if (!track.requestedBy || track.requestedBy.id === client.user?.id) track.requestedBy = djUser;
                    });
                }
            } catch (e: unknown) {
                logger.warn(`[Attribution Fix] Could not fetch DJ initiator user for batch add with ID ${queue.metadata.djInitiatorId}`);
            }
        }

        const panel = (client as any).musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);

        if (tracks.some((t: any) => t.metadata?.isDJCommentary) || (panel && panel.message.channelId === queue.metadata.channelId)) return;

        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (!channel) return;

        const firstTrack = tracks[0];
        let requesterTag: string = firstTrack.requestedBy ? firstTrack.requestedBy.tag : 'Unknown User';

        if (firstTrack?.playlist) {
            const embed = new EmbedBuilder()
                .setColor("#3498DB")
                .setAuthor({ name: "Added Playlist to Queue" })
                .setTitle(firstTrack.playlist.title)
                .setURL(firstTrack.playlist.url)
                .setThumbnail(firstTrack.playlist.thumbnail || null)
                .addFields({ name: "Tracks", value: `${tracks.length}`, inline: true })
                .setFooter({ text: `Requested by ${requesterTag}` });
            if ((channel as any).send) {
                (channel as any).send({ embeds: [embed] });
            }
        } else {
            const embed = new EmbedBuilder()
                .setColor("#3498DB")
                .setAuthor({ name: "Added to Queue" })
                .setDescription(`Added **${tracks.length}** songs to the queue.`)
                .setFooter({ text: `Requested by ${requesterTag}` });
            if ((channel as any).send) {
                (channel as any).send({ embeds: [embed] });
            }
        }
    });

    (client as any).player.events.on("emptyQueue", (queue: any) => {
        logger.info(`[Player Event] emptyQueue triggered for guild: ${queue.guild.id}`);
        const panel = (client as any).musicPanelManager.get(queue.guild.id);
        if (panel) {
            panel.updatePanel(queue);
        }
    });

    (client as any).player.events.on("playerStop", (queue: any) => {
        logger.info(`[Player Event] playerStop triggered for guild: ${queue.guild.id}`);
        const panel = (client as any).musicPanelManager.get(queue.guild.id);
        if (panel) {
            panel.updatePanel(queue);
        }
    });

    (client as any).player.events.on("error", async (queue: any, error: Error) => {
        logger.error(`[Player Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
        const panel = (client as any).musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && channel.isTextBased() && (!panel || panel.message.channelId !== (channel as any).id)) {
            (channel as any).send(`❌ | An error occurred: ${error.message.slice(0, 1900)}`);
        }
    });

    (client as any).player.events.on("playerError", async (queue: any, error: Error) => {
        logger.error(`[Player Connection Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
        const panel = (client as any).musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && channel.isTextBased() && (!panel || panel.message.channelId !== (channel as any).id)) {
            (channel as any).send(`❌ | A connection error occurred: ${error.message.slice(0, 1900)}`);
        }
    });

    // --- Interaction Handlers ---

    client.on(Events.InteractionCreate, async (interaction) => {
        // Phase 6 managers - button/select menu handlers
        if (interaction.isButton() && interaction.customId.startsWith('reaction_role_')) {
            if ((client as any).enhancedReactionRoles) {
                await (client as any).enhancedReactionRoles.handleButtonInteraction(interaction);
                return;
            }
        } else if (interaction.isButton() && interaction.customId.startsWith('poll_vote_')) {
            if ((client as any).polls) {
                await (client as any).polls.handleVote(interaction);
                return;
            }
        } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reaction_role_select_')) {
            if ((client as any).enhancedReactionRoles) {
                await (client as any).enhancedReactionRoles.handleSelectMenuInteraction(interaction);
                return;
            }
        }

        if (interaction.isChatInputCommand()) {
            handleInteraction(interaction);
        } else if (interaction.isButton() && interaction.customId.startsWith('music-')) {
            const panel = (client as any).musicPanelManager.get(interaction.guildId);
            if (panel) {
                panel.handleInteraction(interaction);
            } else {
                await interaction.reply({ content: 'This music panel is no longer active. Please create a new one.', flags: MessageFlags.Ephemeral });
            }
        } else if (interaction.isStringSelectMenu() && interaction.customId === 'music-add-song') {
            const panel = (client as any).musicPanelManager.get(interaction.guildId);
            if (panel) {
                panel.handleInteraction(interaction);
            } else {
                await interaction.reply({ content: 'This music panel is no longer active. Please create a new one.', flags: MessageFlags.Ephemeral });
            }
        } else if (interaction.isButton() && interaction.customId.startsWith('trivia_answer_')) {
            const funCommand = client.commands.get('fun');
            if (funCommand && (funCommand as any).handleButtonInteraction) {
                await (funCommand as any).handleButtonInteraction(interaction);
            } else {
                await interaction.reply({ content: 'Trivia handler not found. Please contact an administrator.', flags: MessageFlags.Ephemeral });
            }
        } else if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
            if ((client as any).verificationManager) {
                await (client as any).verificationManager.handleButtonInteraction(interaction);
            }
        } else if (interaction.isModalSubmit() && interaction.customId === 'add-song-modal') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const member = interaction.member as GuildMember;
            if (!member.voice.channel) {
                return interaction.editReply({ content: "You must be in a voice channel to add a song!" });
            }
            const query: string = interaction.fields.getTextInputValue('song-input');
            try {
                const { track } = await (client as any).player.play(member.voice.channel, query, {
                    requestedBy: interaction.user,
                    nodeOptions: {
                        metadata: { channelId: interaction.channel?.id }
                    }
                });
                await interaction.editReply({ content: `✅ | Added **${track.title}** to the queue.` });
            } catch (e: unknown) {
                logger.error("[Modal Song Add Error]", e as Record<string, any>);
                await interaction.editReply({ content: `An error occurred: ${(e as Error).message}` });
            }
        } else if (interaction.isModalSubmit() && interaction.customId === 'ai-dj-modal') {
            const member = interaction.member as GuildMember;
            const guild = interaction.guild!;

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (!member.voice.channel) {
                return interaction.editReply({ content: "You must be in a voice channel to start a DJ session." });
            }

            const [musicConfigRows] = await db.execute<RowDataPacket[]>("SELECT * FROM music_config WHERE guild_id = ?", [guild.id]);
            const musicConfig = musicConfigRows[0];
            if (!musicConfig || !musicConfig.dj_enabled) {
                return interaction.editReply({ content: "The AI DJ is not enabled on this server. An admin can enable it in the dashboard." });
            }

            const prompt: string = interaction.fields.getTextInputValue('dj-prompt-input');
            const inputSong: string = interaction.fields.getTextInputValue('dj-song-input');
            const inputArtist: string = interaction.fields.getTextInputValue('dj-artist-input');
            const inputGenre: string = interaction.fields.getTextInputValue('dj-genre-input');

            try {
                let queue = (client as any).player.nodes.get(guild.id);
                const isQueueActive: boolean = queue && queue.isPlaying();
                if (!queue) {
                    queue = (client as any).player.nodes.create(guild.id, {
                        metadata: { channelId: interaction.channel?.id, djMode: true, voiceChannelId: member.voice.channel.id, playedTracks: [], inputSong, inputArtist, inputGenre, prompt, djInitiatorId: interaction.user.id },
                        selfDeaf: true, volume: 80, leaveOnEmpty: true, leaveOnEmptyCooldown: 300000, leaveOnEnd: false, leaveOnEndCooldown: 300000,
                    });
                } else {
                    queue.metadata.djMode = true;
                    queue.leaveOnEnd = false;
                    if (!queue.metadata.djInitiatorId) queue.metadata.djInitiatorId = interaction.user.id;
                }
                if (!queue.connection) await queue.connect(member.voice.channel.id);
                if (!queue.metadata.playedTracks) queue.metadata.playedTracks = [];

                const geminiRecommendedTracks = await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, queue.metadata.playedTracks, prompt);
                if (!geminiRecommendedTracks || geminiRecommendedTracks.length === 0) {
                    return interaction.editReply({ content: `❌ | Gemini AI could not generate a playlist based on your request. Please try again with different inputs.` });
                }

                const trackPromises = geminiRecommendedTracks.map(async (recTrack: any) => {
                    const query: string = `${recTrack.title} ${recTrack.artist}`;
                    const searchResult = await (client as any).player.search(query, {
                        requestedBy: interaction.user,
                        metadata: { artist: recTrack.artist, fromPanel: true }
                    });
                    if (searchResult.hasTracks()) {
                        const track = searchResult.tracks[0];
                        if (!track.url.includes('youtube.com/shorts')) return track;
                    }
                    return null;
                });

                const allPlaylistTracks = (await Promise.all(trackPromises)).filter((track: any) => track !== null);

                if (allPlaylistTracks.length === 0) {
                    return interaction.editReply({ content: `❌ | Could not find any playable tracks for the generated playlist.` });
                }

                queue.metadata.playedTracks.push(...allPlaylistTracks.map((t: any) => t.title));
                await (client as any).djManager.playPlaylistIntro(queue, allPlaylistTracks, isQueueActive);

                if (!isQueueActive) {
                    await queue.node.play();
                }

                return interaction.editReply({ content: `🎧 | AI DJ session started! I've added ${allPlaylistTracks.length} songs to the queue.` });

            } catch (e: unknown) {
                logger.error("[AI DJ Modal Error]", e as Record<string, any>);
                return interaction.editReply({ content: `An error occurred: ${(e as Error).message}` });
            }
        }
    });

    // --- Other Event Handlers ---

    client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.bot || !message.guild) return;

        const funCommand = client.commands.get('fun');
        if (funCommand && (funCommand as any).handleMessage) {
            const handled = await (funCommand as any).handleMessage(message);
            if (handled) return;
        }

        if ((client as any).afk) await (client as any).afk.handleMessage(message);
        if ((client as any).enhancedLeveling) await (client as any).enhancedLeveling.handleMessageXP(message);
        if ((client as any).modmail) await (client as any).modmail.handleMessage(message);

        if (checkAfkStatus) await checkAfkStatus(message);
        if (incrementMessageCount) await incrementMessageCount(message.guild.id);
        if (handleMessageXP) await handleMessageXP(message);
        if (automod.processMessage) await automod.processMessage(message);
        if ((client as any).advancedAutomod) await (client as any).advancedAutomod.checkMessage(message);
        if (handleAutoPublish) await handleAutoPublish(message);
        if (scanMessage) await scanMessage(message);
        if (logMessageActivity) logMessageActivity(message);
    });

    client.on(Events.MessageReactionAdd, async (reaction: MessageReaction, user: User) => {
        if (user.bot) return;
        if ((client as any).starboard) await (client as any).starboard.handleReactionAdd(reaction, user);
        if (handleReactionRole) await handleReactionRole(reaction, user);
        if (handleStarboard) await handleStarboard(reaction, user);
    });

    if (handleReactionRemove) {
        client.on(Events.MessageReactionRemove, handleReactionRemove);
    }

    client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
        if ((client as any).raidProtection) await (client as any).raidProtection.handleMemberJoin(member);
        if ((client as any).rolePersistence) await (client as any).rolePersistence.handleMemberAdd(member);

        if (handleAntiRaid) await handleAntiRaid(member);
        if (joinGate.processNewMember) await joinGate.processNewMember(member);
        if ((client as any).verificationManager) await (client as any).verificationManager.handleMemberJoin(member);
        if (inviteManager.handleGuildMemberAdd) await inviteManager.handleGuildMemberAdd(member);
        if (handleGuildMemberAdd) await handleGuildMemberAdd(member);
        if (restoreUserRoles) await restoreUserRoles(member);
        if (handleAutorole) await handleAutorole(member);
        if (scanUsername) await scanUsername(member);
    });

    client.on(Events.GuildMemberRemove, async (member: GuildMember) => {
        if ((client as any).rolePersistence) await (client as any).rolePersistence.handleMemberRemove(member);

        if (inviteManager.handleGuildMemberRemove) await inviteManager.handleGuildMemberRemove(member);
        if (handleGuildMemberRemove) await handleGuildMemberRemove(member);
        if (saveUserRoles) await saveUserRoles(member);
        if (logManager.logGuildMemberRemove) await logManager.logGuildMemberRemove(member);
    });

    if (inviteManager.cacheInvites) {
        client.on(Events.InviteCreate, async (invite: Invite) => await inviteManager.cacheInvites(invite.guild!));
    }
    if (inviteManager.guildInvites) {
        client.on(Events.InviteDelete, (invite: Invite) => inviteManager.guildInvites.get(invite.guild!.id)?.delete(invite.code));
    }
    if (logManager.logMessageDelete) {
        client.on(Events.MessageDelete, logManager.logMessageDelete);
    }
    if (logManager.logMessageUpdate) {
        client.on(Events.MessageUpdate, logManager.logMessageUpdate);
    }

    client.on(Events.GuildMemberUpdate, async (oldMember: GuildMember, newMember: GuildMember) => {
        if ((client as any).rolePersistence) await (client as any).rolePersistence.handleRoleUpdate(oldMember, newMember);
        if (logManager.logMemberUpdate) logManager.logMemberUpdate(oldMember, newMember);
    });

    client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
        if ((client as any).enhancedLeveling) await (client as any).enhancedLeveling.handleVoiceStateUpdate(oldState, newState);
        if ((client as any).enhancedVoiceChannels) await (client as any).enhancedVoiceChannels.handleVoiceStateUpdate(oldState, newState);

        if (handleTempChannel) handleTempChannel(oldState, newState);
        if ((client as any).voiceActivityManager) await (client as any).voiceActivityManager.handleVoiceStateUpdate(oldState, newState);
        if (logManager.logVoiceStateUpdate) logManager.logVoiceStateUpdate(oldState, newState);
        if (logVoiceStateUpdate) logVoiceStateUpdate(oldState, newState);
    });

    // === ADVANCED LOGGING: Channel Events ===
    if (logManager.logChannelCreate) {
        client.on(Events.ChannelCreate, logManager.logChannelCreate);
    }
    if (logManager.logChannelDelete) {
        client.on(Events.ChannelDelete, logManager.logChannelDelete);
    }
    if (logManager.logChannelUpdate) {
        client.on(Events.ChannelUpdate, logManager.logChannelUpdate);
    }

    // === ADVANCED LOGGING: Thread Events ===
    if (logManager.logThreadCreate) {
        client.on(Events.ThreadCreate, logManager.logThreadCreate);
    }
    if (logManager.logThreadDelete) {
        client.on(Events.ThreadDelete, logManager.logThreadDelete);
    }
    if (logManager.logThreadUpdate) {
        client.on(Events.ThreadUpdate, logManager.logThreadUpdate);
    }

    // === ADVANCED LOGGING: Guild/Server Events ===
    if (logManager.logGuildUpdate) {
        client.on(Events.GuildUpdate, logManager.logGuildUpdate);
    }
    if (logManager.logGuildBanAdd) {
        client.on(Events.GuildBanAdd, logManager.logGuildBanAdd);
    }
    if (logManager.logGuildBanRemove) {
        client.on(Events.GuildBanRemove, logManager.logGuildBanRemove);
    }

    // === ADVANCED LOGGING: Role Events ===
    if (logManager.logRoleCreate) {
        client.on(Events.GuildRoleCreate, logManager.logRoleCreate);
    }
    if (logManager.logRoleDelete) {
        client.on(Events.GuildRoleDelete, logManager.logRoleDelete);
    }
    if (logManager.logRoleUpdate) {
        client.on(Events.GuildRoleUpdate, logManager.logRoleUpdate);
    }

    // === ADVANCED LOGGING: Emoji Events ===
    if (logManager.logEmojiCreate) {
        client.on(Events.GuildEmojiCreate, logManager.logEmojiCreate);
    }
    if (logManager.logEmojiDelete) {
        client.on(Events.GuildEmojiDelete, logManager.logEmojiDelete);
    }
    if (logManager.logEmojiUpdate) {
        client.on(Events.GuildEmojiUpdate, logManager.logEmojiUpdate);
    }

    // === ADVANCED LOGGING: Sticker Events ===
    if (logManager.logStickerCreate) {
        client.on(Events.GuildStickerCreate, logManager.logStickerCreate);
    }
    if (logManager.logStickerDelete) {
        client.on(Events.GuildStickerDelete, logManager.logStickerDelete);
    }
    if (logManager.logStickerUpdate) {
        client.on(Events.GuildStickerUpdate, logManager.logStickerUpdate);
    }

    // === ADVANCED LOGGING: Webhook/Integration Events ===
    if (logManager.logWebhookUpdate) {
        client.on(Events.WebhooksUpdate, logManager.logWebhookUpdate);
    }
    if (logManager.logIntegrationUpdate) {
        client.on(Events.GuildIntegrationsUpdate, logManager.logIntegrationUpdate);
    }

    // --- Client Ready Event ---

    client.once(Events.ClientReady, async (c: Client) => {
        (global as any).client = c;
        console.log(` Logged in as ${c.user?.tag}`);
        setStatus(Status.ONLINE);

        try {
            const [panelConfigs] = await db.execute<RowDataPacket[]>('SELECT * FROM music_panels');
            for (const config of panelConfigs) {
                try {
                    const guild = await client.guilds.fetch(config.guild_id);
                    const channel = await guild.channels.fetch(config.channel_id);
                    const message = await (channel as any).messages.fetch(config.message_id);

                    const panel = new MusicPanel(client, guild.id);
                    panel.message = message;
                    (client as any).musicPanelManager.set(guild.id, panel);

                    const queue = (client as any).player.nodes.get(guild.id);
                    await panel.updatePanel(queue);
                } catch (e: unknown) {
                    logger.error(`[Music Panel Load] Failed to load panel for guild ${config.guild_id}: ${(e as Error).message}`);
                }
            }
            console.log(`Loaded ${(client as any).musicPanelManager.size} music panels.`);
        } catch (e: unknown) {
            console.error("Error loading music panels from DB:", e as Record<string, any>);
        }

        // --- Job Schedulers & Workers ---

        try {
            await setupSystemJobs();
        } catch (e: unknown) {
            console.error(" Error during system job setup:", e);
        }
        try {
            startSystemWorker(c);
        } catch (e: unknown) {
            console.error(" Error starting system worker:", e);
        }
        try {
            startAnalyticsScheduler(c);
        } catch (e: unknown) {
            console.error(" Error starting analytics scheduler:", e);
        }
        try {
            startReminderWorker(c, db);
        } catch (e: unknown) {
            console.error(" Error starting reminder worker:", e);
        }
        try {
            startAnnouncementWorker(c);
        } catch (e: unknown) {
            console.error(" Error starting announcement worker:", e);
        }
        try {
            startOfflineWorker(c);
        } catch (e: unknown) {
            console.error(" Error starting offline worker:", e);
        }
        try {
            startPollScheduler(c);
        } catch (e: unknown) {
            console.error(" Error starting poll scheduler:", e);
        }
        try {
            startTicketWorker(c);
        } catch (e: unknown) {
            console.error(" Error starting ticket worker:", e);
        }
        try {
            await (client as any).birthdayManager.start();
            console.log("✅ Birthday manager started");
        } catch (e: unknown) {
            console.error(" Error starting birthday manager:", e);
        }
        try {
            await (client as any).weatherManager.start(60);
            console.log("✅ Weather manager started");
        } catch (e: unknown) {
            console.error(" Error starting weather manager:", e);
        }

        // --- Phase 6 Scheduler Starts ---
        try {
            if ((client as any).scheduledAnnouncements) {
                (client as any).scheduledAnnouncements.startScheduler();
                console.log("✅ Scheduled Announcements scheduler started");
            }
        } catch (e: unknown) {
            console.error(" Error starting scheduled announcements:", e);
        }
        try {
            if ((client as any).serverInsights) {
                (client as any).serverInsights.startMetricsCollection();
                console.log("✅ Server Insights metrics collection started");
            }
        } catch (e: unknown) {
            console.error(" Error starting server insights:", e);
        }
        try {
            if ((client as any).tiktok) {
                (client as any).tiktok.startMonitoring();
                console.log("✅ TikTok monitoring started");
            }
        } catch (e: unknown) {
            console.error(" Error starting TikTok monitoring:", e);
        }
        try {
            if ((client as any).timedModeration) {
                (client as any).timedModeration.startScheduler();
                console.log("✅ Timed Moderation scheduler started");
            }
        } catch (e: unknown) {
            console.error(" Error starting timed moderation:", e);
        }
        try {
            if ((client as any).polls) {
                (client as any).polls.startScheduler();
                console.log("✅ Polls scheduler started");
            }
        } catch (e: unknown) {
            console.error(" Error starting polls scheduler:", e);
        }

        // --- Phase 7 Manager Initializations ---
        try {
            if ((client as any).contextMenu) {
                await (client as any).contextMenu.init();
                console.log("✅ Context Menu Manager initialized");
            }
        } catch (e: unknown) {
            console.error(" Error initializing Context Menu Manager:", e);
        }
        try {
            if ((client as any).forum) {
                await (client as any).forum.init();
                console.log("✅ Forum Manager initialized");
            }
        } catch (e: unknown) {
            console.error(" Error initializing Forum Manager:", e);
        }
        try {
            if ((client as any).scheduledEvents) {
                await (client as any).scheduledEvents.init();
                console.log("✅ Scheduled Events Manager initialized");
            }
        } catch (e: unknown) {
            console.error(" Error initializing Scheduled Events Manager:", e);
        }
        try {
            if ((client as any).assets) {
                await (client as any).assets.init();
                console.log("✅ Assets Manager initialized");
            }
        } catch (e: unknown) {
            console.error(" Error initializing Assets Manager:", e);
        }
        try {
            if ((client as any).soundboard) {
                await (client as any).soundboard.init();
                console.log("✅ Soundboard Manager initialized");
            }
        } catch (e: unknown) {
            console.error(" Error initializing Soundboard Manager:", e);
        }
        try {
            if ((client as any).webhook) {
                await (client as any).webhook.init();
                console.log("✅ Webhook Manager initialized");
            }
        } catch (e: unknown) {
            console.error(" Error initializing Webhook Manager:", e);
        }
        try {
            if ((client as any).i18n) {
                await (client as any).i18n.init();
                console.log("✅ i18n Manager initialized");
            }
        } catch (e: unknown) {
            console.error(" Error initializing i18n Manager:", e);
        }

        if (process.env.IS_MAIN_PROCESS === "true") {
            try {
                await scheduleSocialFeedChecks();
            } catch (e: unknown) {
                console.error(" Failed to schedule social feed checks:", e);
            }
            try {
                await scheduleTicketChecks();
            } catch (e: unknown) {
                console.error(" Failed to schedule ticket checks:", e);
            }
        }

        if (checkGiveaways) {
            setInterval(checkGiveaways, 15 * 1000);
        }
        if (checkPolls) {
            setInterval(checkPolls, 30 * 1000);
        }
        if (syncTwitchSchedules) {
            setInterval(() => syncTwitchSchedules(c), 5 * 60 * 1000);
        }

        streamManager.init(c);

        try {
            await startupCleanup(c);
        } catch (e: unknown) {
            console.error(" Error during startup cleanup:", e);
        }

        if (process.env.IS_MAIN_PROCESS === "true") {
            const dashboard = await import(path.join(__dirname, "dashboard", "server.js"));
            dashboard.start(client);
        }

        try {
            logger.init(client, db);
        } catch (e: unknown) {
            console.error(" Error during logger initialization:", e);
        }

        try {
            await initializeIntelligenceSystems(client);
        } catch (e: unknown) {
            console.error(" Error during intelligence systems initialization:", e);
        }

        // --- AI Error Monitoring & Testing ---
        try {
            await aiErrorMonitor.startMonitoring(c);
            logger.info('[Bot] AI Error Monitoring started - monitoring all PM2 processes');
            console.log("✅ AI Error Monitor initialized");
        } catch (e: unknown) {
            console.error(" Error starting AI Error Monitor:", e);
        }

        try {
            const testResults = await comprehensiveTester.runAllTests(c);
            const passedTests = testResults.filter(r => r.status === 'pass').length;
            const failedTests = testResults.filter(r => r.status === 'fail').length;
            logger.info(`[Tester] Completed comprehensive tests: ${passedTests} passed, ${failedTests} failed`);
            console.log(`✅ Comprehensive Tests: ${passedTests} passed, ${failedTests} failed`);
        } catch (e: unknown) {
            console.error(" Error running comprehensive tests:", e);
        }
    });

    const token: string | undefined = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error('DISCORD_TOKEN is not defined in environment variables');
    }

    try {
        await client.login(token);
    } catch (loginError: unknown) {
        console.error(" Error logging in to Discord:", loginError);
        process.exit(1);
    }
}

start().catch((e: unknown) => {
    console.error("Unhandled error during bot startup:", e);
    process.exit(1);
});

const cleanup = async (): Promise<void> => {
    console.warn(" Received shutdown signal. Shutting down gracefully...");
    process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
