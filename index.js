
require("dotenv-flow").config();
const util = require("util");

const {Client, GatewayIntentBits, Collection, Events, Partials, EmbedBuilder} = require("discord.js");
const {Player, BaseExtractor, Track} = require("discord-player");
const {YtDlp} = require("ytdlp-nodejs");
const path = require("path");
const fs = require("fs");
const { getCycleTLSInstance } = require("./utils/tls-manager.js");
const DJManager = require("./core/dj-manager.js");
const MusicPanel = require("./core/music-panel.js");
const AudioCacheManager = require("./core/audio-cache-manager.js");
const logger = require("./utils/logger.js");
const geminiApi = require("./utils/gemini-api.js");

// --- All Module Imports Moved to Top Level (except dashboard) ---
const db = require("./utils/db");
const {handleInteraction} = require("./core/interaction-handler");
const {handleMessageXP} = require("./core/xp-manager");
const {handleReactionAdd: handleReactionRole, handleReactionRemove} = require("./core/reaction-role-manager");
const {handleReactionAdd: handleStarboard} = require("./core/starboard-manager");
const automod = require("./core/automod");
const joinGate = require("./core/join-gate");
const inviteManager = require("./core/invite-manager");
const {handleGuildMemberAdd, handleGuildMemberRemove} = require("./core/greeting-manager");
const {handleNewMessage: handleAutoPublish} = require("./core/auto-publisher");
const {handleNewMember: handleAutorole} = require("./core/autorole-manager");
const logManager = require("./core/log-manager");
const {handleMemberJoin: handleAntiRaid} = require("./core/anti-raid");
const {incrementMessageCount} = require("./core/stats-manager");
const {checkGiveaways} = require("./core/giveaway-manager");
const {checkPolls} = require("./core/poll-manager");
const {saveUserRoles, restoreUserRoles} = require("./core/sticky-roles-manager");
const {handleVoiceStateUpdate: handleTempChannel} = require("./core/temp-channel-manager");
const {checkAfkStatus} = require("./core/afk-manager");
const {syncTwitchSchedules} = require("./core/twitch-schedule-sync");
const {setStatus, Status} = require("./core/status-manager");
const {setupSystemJobs} = require("./jobs/stream-check-scheduler");
const {scanMessage, scanUsername} = require("./core/ai-scanner.js");
const {logMessageActivity, logVoiceStateUpdate} = require("./core/activity-logger.js");
const startSystemWorker = require("./jobs/system-worker.js");
const startAnalyticsScheduler = require("./jobs/analytics-scheduler.js");
const startReminderWorker = require("./jobs/reminder-worker.js");
const startAnnouncementWorker = require("./jobs/announcement-worker.js");
const startSocialFeedWorker = require("./jobs/social-feed-worker.js");
const startPollScheduler = require("./jobs/poll-scheduler.js");
const startTicketWorker = require("./jobs/ticket-worker.js");
const {scheduleSocialFeedChecks} = require("./jobs/social-feed-scheduler.js");
const {scheduleTicketChecks} = require("./jobs/ticket-scheduler.js");
const {startupCleanup} = require("./core/startup.js");
const streamManager = require("./core/stream-manager.js");

// --- ytdlp-nodejs Setup ---
const ytdlp = new YtDlp();
const cookieFilePath = process.env.YOUTUBE_COOKIE_PATH || path.join(__dirname, "cookies.txt");
if (fs.existsSync(cookieFilePath)) {
    console.log(`[YtDlp] Using cookie file at: ${cookieFilePath}`);
}

function formatDuration(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [h > 0 ? h : null, m, s]
        .filter(x => x !== null)
        .map(x => x.toString().padStart(2, '0'))
        .join(':');
}

// --- Custom Extractor using ytdlp-nodejs ---
class YtDlpExtractor extends BaseExtractor {
    static identifier = "com.livebot.ytdlp";
    static downloading = new Set();

    async _download(url, filePath) {
        if (YtDlpExtractor.downloading.has(filePath)) {
            logger.info(`[Download] Already downloading to ${filePath}, waiting.`);
            while (YtDlpExtractor.downloading.has(filePath)) {
                await new Promise(res => setTimeout(res, 500));
            }
            return;
        }

        if (fs.existsSync(filePath)) {
            logger.info(`[Download] File already exists at ${filePath}, skipping download.`);
            return;
        }

        YtDlpExtractor.downloading.add(filePath);
        logger.info(`[Download] Starting download for ${url} to ${filePath}`);
        try {
            const ytdlpProcess = ytdlp.exec(url, {
                output: filePath,
                format: "bestaudio[ext=opus]/bestaudio/best",
                "audio-quality": 0,
                cookies: cookieFilePath,
            });
            await new Promise((resolve, reject) => {
                ytdlpProcess.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`ytdlp exited with code ${code}`));
                });
                ytdlpProcess.on('error', reject);
            });
            logger.info(`[Download] Finished downloading to ${filePath}`);
        } catch (error) {
            logger.error(`[Download] Failed to download to ${filePath}: ${error.message}`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // Clean up failed download
        } finally {
            YtDlpExtractor.downloading.delete(filePath);
        }
    }

    async preloadTracks(tracks) {
        logger.info(`[Preload] Preloading ${tracks.length} tracks...`);
        const preloadPromises = tracks.map(track => this.preloadTrack(track));
        await Promise.all(preloadPromises);
        logger.info("[Preload] All tracks preloaded.");
    }

    async preloadTrack(track) {
        const tempDir = path.join(__dirname, 'temp_audio');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const videoId = track.url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?=&|#|$)/)?.[1];
        if (!videoId) {
            logger.warn(`[Preload] Could not get video ID for ${track.title}, skipping preload.`);
            return;
        }
        const fileName = `${videoId}.opus`;
        const filePath = path.join(tempDir, fileName);
        await this._download(track.url, filePath);
    }

    async validate(query, searchOptions) {
        return true;
    }

    async handle(query, searchOptions) {
        logger.info(`[YtDlpExtractor] Handle method called for query: ${query}`);

        try {
            if (fs.existsSync(query) && fs.statSync(query).isFile()) {
                logger.info(`[YtDlpExtractor] Query is a local file: ${query}`);
                const track = this.buildTrack({
                    title: path.basename(query, path.extname(query)),
                    url: query,
                    duration: 0, // Will be calculated by the stream, but needs a placeholder
                    thumbnail: null,
                    author: 'Local File',
                }, searchOptions);
                return { playlist: null, tracks: [track] };
            }
        } catch (e) {
            // Not a file path
        }

        const isUrl = query.includes("youtube.com") || query.includes("youtu.be");
        const search = isUrl ? query : `ytsearch1:${query}`;

        const info = await ytdlp.getInfoAsync(search, {cookies: cookieFilePath});

        if (isUrl && info.entries) {
            const tracks = info.entries.map(entry => this.buildTrack(entry, searchOptions)).filter(t => t !== null);
            return {
                playlist: { title: info.title, url: info.webpage_url, thumbnail: info.thumbnail || null, author: info.uploader || "N/A" },
                tracks,
            };
        }

        const entry = info.entries ? info.entries[0] : info;
        const track = this.buildTrack(entry, searchOptions);
        return {playlist: null, tracks: track ? [track] : []};
    }

    async stream(info) {
        logger.info(`[YtDlpExtractor] Stream method called for: ${info.title}`);
        const isLocalFile = fs.existsSync(info.url) && !info.url.startsWith('http');

        if (isLocalFile) {
            logger.info(`[Player] Creating stream for local file: ${info.url}`);
            return fs.createReadStream(info.url);
        }

        const tempDir = path.join(__dirname, 'temp_audio');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const videoId = info.url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?=&|#|$)/)?.[1];
        const fileName = videoId ? `${videoId}.opus` : `${Date.now()}.opus`;
        const filePath = path.join(tempDir, fileName);

        await this._download(info.url, filePath);

        if (fs.existsSync(filePath)) {
            logger.info(`[Player] Creating stream from ${filePath}`);
            return fs.createReadStream(filePath);
        } else {
            throw new Error(`Failed to download and stream track: ${info.title}`);
        }
    }

    buildTrack(entry, searchOptions) {
        const trackUrl = entry.url || entry.webpage_url;
        if (!entry || !trackUrl || !entry.title) return null;

        const track = new Track(this.context.player, {
            title: entry.title,
            url: trackUrl,
            duration: formatDuration(entry.duration),
            thumbnail: entry.thumbnail || null,
            author: entry.uploader,
            source: 'com.livebot.ytdlp',
            requestedBy: searchOptions.requestedBy, // Pass the user object here
            metadata: searchOptions.metadata
        });

        return track;
    }
}


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
});

async function start() {
    console.log(" Initializing Player...");

    const player = new Player(client, {
        fallbackExtractor: YtDlpExtractor
    });

    await player.extractors.register(YtDlpExtractor, {});
    console.log("[Player] Registered custom YtDlp Extractor.");

    client.player = player;
    console.log(" Player Initialized.");

    client.djManager = new DJManager(client);
    console.log(" DJ Manager Initialized.");

    client.musicPanelManager = new Collection();

    client.audioCacheManager = new AudioCacheManager(client);

    client.player.events.on("debug", (queue, message) => {
        logger.debug(`[Player Debug] Guild ${queue?.guild?.id || 'N/A'}: ${message}`);
    });

    setStatus(Status.STARTING);

    process.on('unhandledRejection', (reason, promise) => {
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

    process.on('uncaughtException', (error) => {
        const errorMessage = error.stack || error.message;
        logger.error(`[Uncaught Exception] ${errorMessage}`);
    });

    try {
        await getCycleTLSInstance();
    } catch (cycleTlsError) {
        setStatus(Status.ERROR, "Failed to initialize CycleTLS.");
        console.error(" Error initializing CycleTLS:", cycleTlsError.stack);
        return;
    }

    client.commands = new Collection();
    const commandsPath = path.join(__dirname, "commands");
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.data && command.execute) {
                client.commands.set(command.data.name, command);
            }
        } catch (e) {
            console.error(` ${file}:`, e.stack);
        }
    }
    console.log(` ${client.commands.size} commands loaded.`);

    client.buttons = new Collection();
    client.modals = new Collection();
    client.selects = new Collection();
    const interactionsPath = path.join(__dirname, "interactions");
    if (fs.existsSync(interactionsPath)) {
        for (const folder of fs.readdirSync(interactionsPath)) {
            const fullPath = path.join(interactionsPath, folder);
            if (fs.statSync(fullPath).isDirectory()) {
                const componentFiles = fs.readdirSync(fullPath).filter(f => f.endsWith(".js"));
                for (const file of componentFiles) {
                    try {
                        const component = require(path.join(fullPath, file));
                        if (component.customId && component.execute) {
                            if (folder === "buttons") {
                                client.buttons.set(component.customId, component);
                            } else if (folder === "modals") {
                                client.modals.set(component.customId, component);
                            } else if (folder === "selects") {
                                client.selects.set(component.customId, component);
                            }
                        }
                    } catch (e) {
                        console.error(`[Component Load Error] ${file}:`, e.stack);
                    }
                }
            }
        }
    }
    console.log(` ${client.buttons.size} buttons, ${client.modals.size} modals, and ${client.selects.size} select menus loaded.`);

    // --- Player Event Handlers --- 

    client.player.events.on("playerStart", async (queue, track) => {
        logger.info(`[Player Event] playerStart triggered for track: ${track.title}`, { guildId: queue.guild.id });
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) {
            await panel.updatePanel(queue);
        }

        if (track.metadata?.isDJCommentary) return;
        if (panel && panel.message.channelId === queue.metadata.channelId) return;

        let requesterTag = 'Unknown User';
        if (track.requestedBy && track.requestedBy.id !== client.user.id) {
            requesterTag = track.requestedBy.tag;
        } else if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
            try {
                const djUser = await client.users.fetch(queue.metadata.djInitiatorId);
                requesterTag = djUser.tag;
            } catch {}
        }

        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel) {
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
            channel.send({embeds: [embed]});
        }

        if (track.requestedBy) {
            try {
                await db.execute(
                    `INSERT INTO music_history (guild_id, user_id, song_title, song_url, artist, timestamp)
                     VALUES (?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE timestamp = NOW()`,
                    [queue.guild.id, track.requestedBy.id, track.title, track.url, track.author]
                );
            } catch (error) {
                console.error(`[DB] Failed to log song to music_history for guild ${queue.guild.id}`, error.message);
            }
        }
    });

    client.player.events.on("audioTrackAdd", async (queue, track) => {
        if (queue.metadata?.djMode && (!track.requestedBy || track.requestedBy.id === client.user.id) && queue.metadata?.djInitiatorId) {
            try {
                track.requestedBy = await client.users.fetch(queue.metadata.djInitiatorId);
            } catch (e) {
                logger.warn(`[Attribution Fix] Could not fetch DJ initiator user with ID ${queue.metadata.djInitiatorId}`);
            }
        }

        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);

        if (track.metadata?.isDJCommentary || (panel && panel.message.channelId === queue.metadata.channelId)) return;

        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (!channel) return;

        let requesterTag = track.requestedBy ? track.requestedBy.tag : 'Unknown User';
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
        channel.send({embeds: [embed]});
    });

    client.player.events.on("audioTracksAdd", async (queue, tracks) => {
        if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
            try {
                const djUser = await client.users.fetch(queue.metadata.djInitiatorId);
                if (djUser) {
                    tracks.forEach(track => {
                        if (!track.requestedBy || track.requestedBy.id === client.user.id) track.requestedBy = djUser;
                    });
                }
            } catch (e) {
                logger.warn(`[Attribution Fix] Could not fetch DJ initiator user for batch add with ID ${queue.metadata.djInitiatorId}`);
            }
        }

        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);

        if (tracks.some(t => t.metadata?.isDJCommentary) || (panel && panel.message.channelId === queue.metadata.channelId)) return;

        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (!channel) return;

        const firstTrack = tracks[0];
        let requesterTag = firstTrack.requestedBy ? firstTrack.requestedBy.tag : 'Unknown User';

        if (firstTrack?.playlist) {
            const embed = new EmbedBuilder()
                .setColor("#3498DB")
                .setAuthor({ name: "Added Playlist to Queue" })
                .setTitle(firstTrack.playlist.title)
                .setURL(firstTrack.playlist.url)
                .setThumbnail(firstTrack.playlist.thumbnail || null)
                .addFields({ name: "Tracks", value: `${tracks.length}`, inline: true })
                .setFooter({ text: `Requested by ${requesterTag}` });
            channel.send({ embeds: [embed] });
        } else {
            const embed = new EmbedBuilder()
                .setColor("#3498DB")
                .setAuthor({ name: "Added to Queue" })
                .setDescription(`Added **${tracks.length}** songs to the queue.`)
                .setFooter({ text: `Requested by ${requesterTag}` });
            channel.send({ embeds: [embed] });
        }
    });

    client.player.events.on("emptyQueue", (queue) => {
        logger.info(`[Player Event] emptyQueue triggered for guild: ${queue.guild.id}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) {
            panel.updatePanel(queue);
        }
    });

    client.player.events.on("playerStop", (queue) => {
        logger.info(`[Player Event] playerStop triggered for guild: ${queue.guild.id}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) {
            panel.updatePanel(queue);
        }
    });

    client.player.events.on("error", async (queue, error) => {
        logger.error(`[Player Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && (!panel || panel.message.channelId !== channel.id)) {
            channel.send(`❌ | An error occurred: ${error.message.slice(0, 1900)}`);
        }
    });

    client.player.events.on("playerError", async (queue, error) => {
        logger.error(`[Player Connection Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
        const panel = client.musicPanelManager.get(queue.guild.id);
        if (panel) await panel.updatePanel(queue);
        const channel = await client.channels.cache.get(queue.metadata.channelId);
        if (channel && (!panel || panel.message.channelId !== channel.id)) {
            channel.send(`❌ | A connection error occurred: ${error.message.slice(0, 1900)}`);
        }
    });

    // --- Interaction Handlers ---

    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isCommand()) {
            handleInteraction(interaction);
        } else if (interaction.isButton() && interaction.customId.startsWith('music-')) {
            const panel = client.musicPanelManager.get(interaction.guildId);
            if (panel) {
                panel.handleInteraction(interaction);
            } else {
                // This might happen if the bot restarts and the panel message is old
                await interaction.reply({ content: 'This music panel is no longer active. Please create a new one.', ephemeral: true });
            }
        } else if (interaction.isStringSelectMenu() && interaction.customId === 'music-add-song') {
            const panel = client.musicPanelManager.get(interaction.guildId);
            if (panel) {
                panel.handleInteraction(interaction);
            } else {
                await interaction.reply({ content: 'This music panel is no longer active. Please create a new one.', ephemeral: true });
            }
        } else if (interaction.isModalSubmit() && interaction.customId === 'add-song-modal') {
            if (!interaction.member.voice.channel) {
                return interaction.reply({ content: "You must be in a voice channel to add a song!", ephemeral: true });
            }
            const query = interaction.fields.getTextInputValue('song-input');
            await interaction.deferReply({ ephemeral: true });
            try {
                const { track } = await client.player.play(interaction.member.voice.channel, query, {
                    requestedBy: interaction.user,
                    nodeOptions: {
                        metadata: { channelId: interaction.channel.id }
                    }
                });
                await interaction.editReply({ content: `✅ | Added **${track.title}** to the queue.` });
            } catch (e) {
                logger.error("[Modal Song Add Error]", e);
                await interaction.editReply({ content: `An error occurred: ${e.message}` });
            }
        } else if (interaction.isModalSubmit() && interaction.customId === 'ai-dj-modal') {
            const { member, guild, client } = interaction;
            if (!member.voice.channel) {
                return interaction.reply({ content: "You must be in a voice channel to start a DJ session.", ephemeral: true });
            }

            const [musicConfigRows] = await db.execute("SELECT * FROM music_config WHERE guild_id = ?", [guild.id]);
            const musicConfig = musicConfigRows[0];
            if (!musicConfig || !musicConfig.dj_enabled) {
                return interaction.reply({ content: "The AI DJ is not enabled on this server. An admin can enable it in the dashboard.", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const prompt = interaction.fields.getTextInputValue('dj-prompt-input');
            const inputSong = interaction.fields.getTextInputValue('dj-song-input');
            const inputArtist = interaction.fields.getTextInputValue('dj-artist-input');
            const inputGenre = interaction.fields.getTextInputValue('dj-genre-input');

            try {
                let queue = client.player.nodes.get(guild.id);
                const isQueueActive = queue && queue.isPlaying();
                if (!queue) {
                    queue = client.player.nodes.create(guild.id, {
                        metadata: { channelId: interaction.channel.id, djMode: true, voiceChannelId: member.voice.channel.id, playedTracks: [], inputSong, inputArtist, inputGenre, prompt, djInitiatorId: interaction.user.id },
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

                const trackPromises = geminiRecommendedTracks.map(async (recTrack) => {
                    const query = `${recTrack.title} ${recTrack.artist}`;
                    const searchResult = await client.player.search(query, {
                        searchEngine: 'com.livebot.ytdlp',
                        requestedBy: interaction.user,
                        metadata: { artist: recTrack.artist, fromPanel: true }
                    });
                    if (searchResult.hasTracks()) {
                        const track = searchResult.tracks[0];
                        if (!track.url.includes('youtube.com/shorts')) return track;
                    }
                    return null;
                });

                const allPlaylistTracks = (await Promise.all(trackPromises)).filter(track => track !== null);

                if (allPlaylistTracks.length === 0) {
                    return interaction.editReply({ content: `❌ | Could not find any playable tracks for the generated playlist.` });
                }

                queue.metadata.playedTracks.push(...allPlaylistTracks.map(t => t.title));
                client.player.extractors.get('com.livebot.ytdlp').preloadTracks(allPlaylistTracks);
                await client.djManager.playPlaylistIntro(queue, allPlaylistTracks, isQueueActive);

                if (!isQueueActive) {
                    await queue.node.play();
                }

                return interaction.editReply({ content: `🎧 | AI DJ session started! I've added ${allPlaylistTracks.length} songs to the queue.` });

            } catch (e) {
                logger.error("[AI DJ Modal Error]", e);
                return interaction.editReply({ content: `An error occurred: ${e.message}` });
            }
        }
    });

    // --- Other Event Handlers ---

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
    if (handleReactionRemove) {
        client.on(Events.MessageReactionRemove, handleReactionRemove);
    }
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
    if (inviteManager.cacheInvites) {
        client.on(Events.InviteCreate, async (invite) => await inviteManager.cacheInvites(invite.guild));
    }
    if (inviteManager.guildInvites) {
        client.on(Events.InviteDelete, (invite) => inviteManager.guildInvites.get(invite.guild.id)?.delete(invite.code));
    }
    if (logManager.logMessageDelete) {
        client.on(Events.MessageDelete, logManager.logMessageDelete);
    }
    if (logManager.logMessageUpdate) {
        client.on(Events.MessageUpdate, logManager.logMessageUpdate);
    }
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
        if (logManager.logMemberRoleUpdate) logManager.logMemberRoleUpdate(oldMember, newMember);
        if (logManager.logMemberNicknameUpdate) logManager.logMemberNicknameUpdate(oldMember, newMember);
    });
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        if (handleTempChannel) handleTempChannel(oldState, newState);
        if (logManager.logVoiceStateUpdate) logManager.logVoiceStateUpdate(oldState, newState);
        if (logVoiceStateUpdate) logVoiceStateUpdate(oldState, newState);
    });

    // --- Client Ready Event ---

    client.once(Events.ClientReady, async c => {
        global.client = c;
        console.log(` Logged in as ${c.user.tag}`);
        setStatus(Status.ONLINE);

        try {
            const [panelConfigs] = await db.execute('SELECT * FROM music_panels');
            for (const config of panelConfigs) {
                try {
                    const guild = await client.guilds.fetch(config.guild_id);
                    const channel = await guild.channels.fetch(config.channel_id);
                    const message = await channel.messages.fetch(config.message_id);

                    const panel = new MusicPanel(client, guild.id);
                    panel.message = message;
                    client.musicPanelManager.set(guild.id, panel);

                    const queue = client.player.nodes.get(guild.id);
                    await panel.updatePanel(queue);
                } catch (e) {
                    logger.error(`[Music Panel Load] Failed to load panel for guild ${config.guild_id}: ${e.message}`);
                }
            }
            console.log(`Loaded ${client.musicPanelManager.size} music panels.`);
        } catch (e) {
            console.error("Error loading music panels from DB:", e);
        }

        // --- Job Schedulers & Workers ---

        try {
            await setupSystemJobs();
        } catch (e) {
            console.error(" Error during system job setup:", e);
        }
        try {
            startSystemWorker(c, db);
        } catch (e) {
            console.error(" Error starting system worker:", e);
        }
        try {
            startAnalyticsScheduler(c, db);
        } catch (e) {
            console.error(" Error starting analytics scheduler:", e);
        }
        try {
            startReminderWorker(c, db);
        } catch (e) {
            console.error(" Error starting reminder worker:", e);
        }
        try {
            startAnnouncementWorker(c, db);
        } catch (e) {
            console.error(" Error starting announcement worker:", e);
        }
        try {
            startPollScheduler(c, db);
        } catch (e) {
            console.error(" Error starting poll scheduler:", e);
        }
        try {
            startTicketWorker(c, db);
        } catch (e) {
            console.error(" Error starting ticket worker:", e);
        }

        if (process.env.IS_MAIN_PROCESS === "true") {
            try {
                await scheduleSocialFeedChecks();
            } catch (e) {
                console.error(" Failed to schedule social feed checks:", e);
            }
            try {
                await scheduleTicketChecks();
            } catch (e) {
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
        } catch (e) {
            console.error(" Error during startup cleanup:", e);
        }

        if (process.env.IS_MAIN_PROCESS === "true") {
            const dashboard = require(path.join(__dirname, "dashboard", "server.js"));
            dashboard.start(client);
        }

        try {
            logger.init(client, db);
        } catch (e) {
            console.error(" Error during logger initialization:", e);
        }
    });

    try {
        await client.login(process.env.DISCORD_TOKEN);
    } catch (loginError) {
        console.error(" Error logging in to Discord:", loginError);
        process.exit(1);
    }
}

start().catch(e => {
    console.error(" Unhandled error during bot startup:", e);
    process.exit(1);
});

const cleanup = async () => {
    console.warn(" Received shutdown signal. Shutting down gracefully...");
    process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
