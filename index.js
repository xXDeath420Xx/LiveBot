require("dotenv-flow").config();

const {Client, GatewayIntentBits, Collection, Events, Partials, EmbedBuilder} = require("discord.js");
const {Player, BaseExtractor} = require("discord-player");
const { DefaultExtractors } = require("@discord-player/extractor");
const {YtDlp} = require("ytdlp-nodejs");
const path = require("path");
const fs = require("fs");
const { getCycleTLSInstance } = require("./utils/tls-manager.js");
const DJManager = require("./core/dj-manager.js");
const logger = require("./utils/logger.js");

// --- ytdlp-nodejs Setup ---
const ytdlp = new YtDlp();
const cookieFilePath = process.env.YOUTUBE_COOKIE_PATH || path.join(__dirname, "cookies.txt");
if (fs.existsSync(cookieFilePath)) {
  console.log(`[YtDlp] Using cookie file at: ${cookieFilePath}`);
}

// --- Custom Extractor using ytdlp-nodejs ---
class YtDlpExtractor extends BaseExtractor {
  static identifier = "com.livebot.ytdlp";

  async validate(query, searchOptions) {
    return true;
  }

  async handle(query, searchOptions) {
    try {
        // Handle local file paths
        if (fs.existsSync(query) && fs.statSync(query).isFile()) {
            const track = this.buildTrack({
                title: path.basename(query, path.extname(query)),
                url: query,
                duration: 0,
                thumbnail: null,
                uploader: 'Local File',
            }, searchOptions);
            return { playlist: null, tracks: track ? [track] : [] };
        }
    } catch (e) { /* Not a file path, continue to youtube search */ }

    const isUrl = query.includes("youtube.com") || query.includes("youtu.be");

    // If it's not a URL, we force it to be a single video search.
    const search = isUrl ? query : `ytsearch1:${query}`;

    const info = await ytdlp.getInfoAsync(search, {cookies: cookieFilePath});

    // If it was a URL and it's a playlist, process all entries.
    if (isUrl && info.entries) {
      const tracks = info.entries.map(entry => this.buildTrack(entry, searchOptions)).filter(t => t !== null);
      return {
        playlist: {
          title: info.title,
          url: info.webpage_url,
          thumbnail: info.thumbnail || null,
          author: info.uploader || "N/A",
        },
        tracks,
      };
    }
    
    // For searches, or single video URLs.
    // If the search returned a playlist, info will have an 'entries' property. We take the first one.
    const entry = info.entries ? info.entries[0] : info;
    const track = this.buildTrack(entry, searchOptions);
    return {playlist: null, tracks: track ? [track] : []};
  }

  async stream(info) {
    const isLocalFile = !info.url.startsWith('http');

    if (isLocalFile) {
        // It's a local file (like commentary), just stream it.
        console.log(`[Player] Streaming local file: ${info.url}`);
        return fs.createReadStream(info.url);
    }

    // It's a youtube URL, download it first.
    const tempDir = path.join(__dirname, 'temp_audio');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    const videoId = info.url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?=&|#|$)/)?.[1];
    const fileName = `${videoId || info.id || Date.now()}.opus`;
    const filePath = path.join(tempDir, fileName);

    // Attach local path for cleanup
    info.metadata = { ...info.metadata, localPath: filePath };

    if (fs.existsSync(filePath)) {
        console.log(`[Player] Using cached file for ${info.title}: ${filePath}`);
        return fs.createReadStream(filePath);
    }

    console.log(`[Player] Downloading ${info.title} to ${filePath}`);

    const ytdlpProcess = ytdlp.exec(info.url, {
      output: filePath,
      format: "bestaudio[ext=opus]/bestaudio/best",
      "audio-quality": 0,
      cookies: cookieFilePath,
    });

    await new Promise((resolve, reject) => {
        ytdlpProcess.on('close', (code) => {
            if (code === 0) resolve();
            else {
                if (fs.existsSync(filePath)) fs.unlink(filePath, ()=>{}); // cleanup failed download
                reject(new Error(`ytdlp exited with code ${code}`));
            }
        });
        ytdlpProcess.on('error', (err) => {
            if (fs.existsSync(filePath)) fs.unlink(filePath, ()=>{}); // cleanup failed download
            reject(err);
        });
    });

    console.log(`[Player] Finished downloading ${info.title}.`);
    return fs.createReadStream(filePath);
  }

  buildTrack(entry, searchOptions) {
    const trackUrl = entry.url || entry.webpage_url;
    if (!entry || !trackUrl || !entry.title) {
      return null;
    }

    // Create a plain object for `requestedBy` to avoid circular references
    const requestedBy = searchOptions.requestedBy ? {
        id: searchOptions.requestedBy.id,
        tag: searchOptions.requestedBy.tag
    } : null;

    return {
      title: entry.title,
      url: trackUrl,
      durationMS: entry.duration ? (entry.duration * 1000) : 0,
      thumbnail: entry.thumbnail,
      author: entry.uploader,
      requestedBy: requestedBy,
      source: "youtube", // Keep as youtube to be handled by this extractor
    };
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

  // Load all default extractors
  await player.extractors.loadMulti(DefaultExtractors);
  console.log('[Player] Loaded default extractors.');

  // Unregister all the extractors we don't want to use for search
  await player.extractors.unregister('YouTubeExtractor');
  await player.extractors.unregister('SoundCloudExtractor');
  await player.extractors.unregister('AppleMusicExtractor');
  await player.extractors.unregister('VimeoExtractor');
  await player.extractors.unregister('ReverbnationExtractor');
  console.log('[Player] Unregistered unwanted online extractors.');

  // Register our custom one to handle search and youtube playback
  await player.extractors.register(YtDlpExtractor, {});
  console.log("[Player] Registered custom YtDlp Extractor.");

  client.player = player;
  console.log(" Player Initialized.");

  // Initialize the DJ Manager
  client.djManager = new DJManager(client.player);
  console.log(" DJ Manager Initialized.");

  // Add cleanup hook for downloaded files
  client.player.events.on("trackEnd", (queue, track) => {
    if (track.metadata && track.metadata.localPath) {
        fs.unlink(track.metadata.localPath, (err) => {
            if (err) console.error(`[Cleanup] Failed to delete temp file: ${track.metadata.localPath}`, err.message);
            else console.log(`[Cleanup] Deleted temp file: ${track.metadata.localPath}`);
        });
    }
  });

  // client.player.events.on("debug", (queue, message) => {
  //   console.log(`[Player Debug] Guild ${queue.guild.id}: ${message}`);
  // });

  const db = require("./utils/db");
  const dashboard = require(path.join(__dirname, "dashboard", "server.js"));
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

  setStatus(Status.STARTING);

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

  client.player.events.on("playerStart", async (queue, track) => {
    const channel = await client.channels.cache.get(queue.metadata.channelId);
    if (channel && !(track.metadata && track.metadata.isDJCommentary)) {
        const embed = new EmbedBuilder()
            .setColor("#57F287")
            .setAuthor({name: "Now Playing"})
            .setTitle(track.title)
            // Conditionally set URL
            .setURL(track.url && !(track.metadata && track.metadata.isDJCommentary) ? track.url : null)
            .setThumbnail(track.thumbnail)
            .addFields(
                {name: "Channel", value: track.author || "N/A", inline: true},
                {name: "Duration", value: track.duration || "0:00", inline: true}
            )
            .setFooter({text: `Requested by ${track.requestedBy ? track.requestedBy.tag : 'Unknown'}`});

        channel.send({embeds: [embed]});
    }

    if (track.requestedBy && !(track.metadata && track.metadata.isDJCommentary)) {
        try {
            await db.execute(
                `INSERT INTO music_history (guild_id, user_id, song_title, song_url, artist, timestamp)
                 VALUES (?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE timestamp = NOW()`,
                [
                    queue.guild.id,
                    track.requestedBy.id,
                    track.title,
                    track.url,
                    track.author
                ]
            );
        } catch (error) {
            console.error(`[DB] Failed to log song to music_history for guild ${queue.guild.id}`, error.message);
        }
    }
  });

  client.player.events.on("audioTrackAdd", async (queue, track) => {
    if (track.metadata && track.metadata.isDJCommentary) return;
    const channel = await client.channels.cache.get(queue.metadata.channelId);
    if (!channel) {
      return;
    }

    const embed = new EmbedBuilder()
      .setColor("#3498DB")
      .setAuthor({name: "Added to Queue"})
      .setTitle(track.title)
      // Conditionally set URL
      .setURL(track.url && !(track.metadata && track.metadata.isDJCommentary) ? track.url : null)
      .setThumbnail(track.thumbnail)
      .addFields(
        {name: "Position in queue", value: `${queue.tracks.size}`, inline: true},
        {name: "Duration", value: track.duration || "0:00", inline: true}
      )
      .setFooter({text: `Requested by ${track.requestedBy ? track.requestedBy.tag : 'Unknown'}`});

    channel.send({embeds: [embed]});
  });

  client.player.events.on("audioTracksAdd", async (queue, tracks) => {
    const channel = await client.channels.cache.get(queue.metadata.channelId);
    if (channel) {
      channel.send(`✅ | Added ${tracks.length} songs to queue!`);
    }
  });

  client.player.events.on("error", async (queue, error) => {
    console.error(`[Player Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
    const channel = await client.channels.cache.get(queue.metadata.channelId);
    if (channel) {
      channel.send(`❌ | An error occurred: ${error.message.slice(0, 1900)}`);
    }
  });

  client.player.events.on("playerError", async (queue, error) => {
    console.error(`[Player Connection Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
    const channel = await client.channels.cache.get(queue.metadata.channelId);
    if (channel) {
      channel.send(`❌ | A connection error encountered: ${error.message.slice(0, 1900)}`);
    }
  });

  if (handleInteraction) {
    client.on(Events.InteractionCreate, handleInteraction);
  }
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }
    if (checkAfkStatus) {
      await checkAfkStatus(message);
    }
    if (incrementMessageCount) {
      await incrementMessageCount(message.guild.id);
    }
    if (handleMessageXP) {
      await handleMessageXP(message);
    }
    if (automod.processMessage) {
      await automod.processMessage(message);
    }
    if (handleAutoPublish) {
      await handleAutoPublish(message);
    }
    if (scanMessage) {
      await scanMessage(message);
    }
    if (logMessageActivity) {
      logMessageActivity(message);
    }
  });
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) {
      return;
    }
    if (handleReactionRole) {
      await handleReactionRole(reaction, user);
    }
    if (handleStarboard) {
      await handleStarboard(reaction, user);
    }
  });
  if (handleReactionRemove) {
    client.on(Events.MessageReactionRemove, handleReactionRemove);
  }
  client.on(Events.GuildMemberAdd, async (member) => {
    if (handleAntiRaid) {
      await handleAntiRaid(member);
    }
    if (joinGate.processNewMember) {
      await joinGate.processNewMember(member);
    }
    if (inviteManager.handleGuildMemberAdd) {
      await inviteManager.handleGuildMemberAdd(member);
    }
    if (handleGuildMemberAdd) {
      await handleGuildMemberAdd(member);
    }
    if (restoreUserRoles) {
      await restoreUserRoles(member);
    }
    if (handleAutorole) {
      await handleAutorole(member);
    }
    if (scanUsername) {
      await scanUsername(member);
    }
  });
  client.on(Events.GuildMemberRemove, async (member) => {
    if (inviteManager.handleGuildMemberRemove) {
      await inviteManager.handleGuildMemberRemove(member);
    }
    if (handleGuildMemberRemove) {
      await handleGuildMemberRemove(member);
    }
    if (saveUserRoles) {
      await saveUserRoles(member);
    }
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
    if (logManager.logMemberRoleUpdate) {
      logManager.logMemberRoleUpdate(oldMember, newMember);
    }
    if (logManager.logMemberNicknameUpdate) {
      logManager.logMemberNicknameUpdate(oldMember, newMember);
    }
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (handleTempChannel) {
      handleTempChannel(oldState, newState);
    }
    if (logManager.logVoiceStateUpdate) {
      logManager.logVoiceStateUpdate(oldState, newState);
    }
    if (logVoiceStateUpdate) {
      logVoiceStateUpdate(oldState, newState);
    }
  });

  client.once(Events.ClientReady, async c => {
    global.client = c;
    console.log(` Logged in as ${c.user.tag}`);
    setStatus(Status.ONLINE);

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
