import { Client, Collection, GatewayIntentBits, Partials, Events } from 'discord.js';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import pool from './utils/db.js';
import botManager from './core/bot-manager.js';
import UptimeTracker from './utils/uptime-tracker.js';
import memoryMonitor from './utils/memoryMonitor.js';
import ReactionRoleManager from './core/reaction-role-manager.js';
import PollsManager from './core/polls-manager.js';
import GiveawayManager from './core/giveaway-manager.js';
import LevelingManager from './core/leveling-manager.js';
import MusicStatusManager from './core/music-status-manager.js';
import { getPlayerErrorReason } from './utils/music-error-reasons.js';
import DJManager from './core/dj-manager.js';
import MusicPanel from './core/music-panel.js';
import RPGCharacterManager from './core/rpg-character-manager.js';
import RPGCombatManager from './core/rpg-combat-manager.js';
import RPGQuestManager from './core/rpg-quest-manager.js';
import RPGShopManager from './core/rpg-shop-manager.js';
import VoiceActivityManager from './core/voice-activity-manager.js';
import StarboardManager from './core/starboard-manager.js';
import BirthdayManager from './core/birthday-manager.js';
import AFKManager from './core/afk-manager.js';
import ReminderManager from './core/reminder-manager.js';
import WeatherManager from './core/weather-manager.js';
import AntiNukeManager from './core/anti-nuke-manager.js';
import RaidDetectionManager from './core/raid-detection-manager.js';
import SelfbotDetectionManager from './core/selfbot-detection-manager.js';
import AdaptiveSpamManager from './core/adaptive-spam-manager.js';
import PhishingDetectionManager from './core/phishing-detection-manager.js';
import GlobalBanManager from './core/global-ban-manager.js';
import VCSoundManager from './core/vc-sound-manager.js';
import { startAnnouncementScheduler, stopAnnouncementScheduler } from './jobs/announcement-scheduler.js';
import startPollScheduler from './jobs/poll-scheduler.js';
import startGiveawayScheduler from './jobs/giveaway-scheduler.js';
import { startSocialFeedScheduler, stopSocialFeedScheduler } from './jobs/social-feed-scheduler.js';
import { startStreamCheckScheduler, stopStreamCheckScheduler } from './jobs/stream-check-scheduler.js';
import { startAnnouncementUpdater, stopAnnouncementUpdater } from './jobs/announcement-updater.js';
import { startTeamSyncScheduler, stopTeamSyncScheduler } from './jobs/team-sync-scheduler.js';
import { startBirthdayScheduler, stopBirthdayScheduler } from './jobs/birthday-scheduler.js';
import { startTwitchScheduleScheduler, stopTwitchScheduleScheduler } from './jobs/twitch-schedule-scheduler.js';
import { startFreeGamesScheduler, stopFreeGamesScheduler } from './jobs/free-games-scheduler.js';
import { startSteamWatchScheduler, stopSteamWatchScheduler } from './jobs/steam-watch-scheduler.js';
import { startQOTDScheduler, stopQOTDScheduler } from './jobs/qotd-scheduler.js';
import initReminderScheduler from './jobs/reminder-scheduler.js';
import { startTikTokVideoChecker, stopTikTokVideoChecker } from './jobs/tiktok-video-checker.js';
import AutoMemeManager from './core/auto-meme-manager.js';
import { startAutoMemeScheduler, stopAutoMemeScheduler } from './jobs/auto-meme-scheduler.js';
import { startPokerMemeScheduler, stopPokerMemeScheduler } from './jobs/poker-meme-scheduler.js';
import { startCommunityRotation, stopCommunityRotation } from './jobs/community-support-rotation.js';
import { startMonthlyResetScheduler, stopMonthlyResetScheduler } from './jobs/leveling-monthly-reset.js';
import { startUnverifiedReaper, stopUnverifiedReaper } from './jobs/unverified-reaper.js';
import { startAffiliateRecheckScheduler, stopAffiliateRecheckScheduler } from './jobs/affiliate-recheck-scheduler.js';
import { startTimeCapsuleScheduler, stopTimeCapsuleScheduler } from './jobs/time-capsule-scheduler.js';
import { startHabitTrackerScheduler, stopHabitTrackerScheduler } from './jobs/habit-tracker-scheduler.js';
import { startPetStatDecayScheduler, stopPetStatDecayScheduler } from './jobs/pet-stat-decay-scheduler.js';
import { startThroneScheduler, stopThroneScheduler } from './jobs/throne-scheduler.js';
import { startServerStatsScheduler, stopServerStatsScheduler } from './jobs/server-stats-scheduler.js';
import { startStatDisplayScheduler, stopStatDisplayScheduler } from './jobs/stat-display-scheduler.js';
import { startGamePatchScheduler, stopGamePatchScheduler } from './jobs/game-patch-scheduler.js';
import GamePatchWatcherManager from './core/game-patch-watcher-manager.js';
import { startPurgeScheduler, stopPurgeScheduler } from './jobs/purge-scheduler.js';
import { startBackupScheduler } from './jobs/backup-scheduler.js';
import { startCrossNetworkScheduler, stopCrossNetworkScheduler } from './jobs/cross-network-scheduler.js';
import initGrowReminderScheduler from './jobs/grow-reminder-scheduler.js';
import cleanupScheduler from './jobs/cleanup-scheduler.js';
import { startVCSoundScheduler, stopVCSoundScheduler } from './jobs/vc-sound-scheduler.js';
import { startPhishingListUpdater, stopPhishingListUpdater } from './jobs/phishing-list-updater.js';
import { startGlobalBanAggregator, stopGlobalBanAggregator } from './jobs/global-ban-aggregator.js';
import { startFourthwallCleanup, stopFourthwallCleanup } from './jobs/fourthwall-cleanup.js';
import { startFourthwallTracker, stopFourthwallTracker } from './jobs/fourthwall-shop-tracker-scheduler.js';
import AchievementManager from './core/achievement-manager.js';
import ServerStatsManager from './core/server-stats-manager.js';
import StatDisplayManager from './core/stat-display-manager.js';
import EmojiStatsManager from './core/emoji-stats-manager.js';
import ScheduleManager from './core/schedule-manager.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Import discord-player (NOTE: Requires npm install discord-player + yt-dlp binary)
let Player;
let useMainPlayer;
try {
  const discordPlayer = await import('discord-player');
  Player = discordPlayer.Player;
  useMainPlayer = discordPlayer.useMainPlayer;
  logger.info('[Music] discord-player loaded successfully');
} catch (error) {
  logger.warn('[Music] discord-player not installed. Music features will be disabled.');
  logger.warn('[Music] Run: npm install discord-player (also ensure yt-dlp is installed)');
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load all command files for a client
 */
async function loadCommands(client) {
  const commandsPath = join(__dirname, 'commands');

  if (!fs.existsSync(commandsPath)) {
    logger.warn('[Commands] Commands directory does not exist, creating...');
    fs.mkdirSync(commandsPath, { recursive: true });
    return;
  }

  const commandFolders = fs.readdirSync(commandsPath).filter(item => {
    return fs.statSync(join(commandsPath, item)).isDirectory();
  });

  let loadedCount = 0;

  for (const folder of commandFolders) {
    const folderPath = join(commandsPath, folder);
    const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
      try {
        const filePath = join(folderPath, file);
        const command = await import(`file://${filePath}`);

        if (command.default && command.default.data && command.default.execute) {
          client.commands.set(command.default.data.name, command.default);
          loadedCount++;
          logger.debug(`[Commands] Loaded ${folder}/${file}`);
        } else {
          logger.warn(`[Commands] ${folder}/${file} is missing required exports`);
        }
      } catch (error) {
        logger.error(`[Commands] Failed to load ${folder}/${file}`, { error: error.message });
      }
    }
  }

  logger.info(`[Commands] Loaded ${loadedCount} command(s) from ${commandFolders.length} categor${commandFolders.length === 1 ? 'y' : 'ies'}`);
}

/**
 * Load all event files for a client
 */
async function loadEvents(client) {
  const eventsPath = join(__dirname, 'events');

  if (!fs.existsSync(eventsPath)) {
    logger.warn('[Events] Events directory does not exist, creating...');
    fs.mkdirSync(eventsPath, { recursive: true });
    return;
  }

  const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
  let loadedCount = 0;

  for (const file of eventFiles) {
    try {
      const filePath = join(eventsPath, file);
      const event = await import(`file://${filePath}`);

      if (event.default && event.default.name && event.default.execute) {
        if (event.default.once) {
          client.once(event.default.name, (...args) => event.default.execute(...args));
        } else {
          client.on(event.default.name, (...args) => event.default.execute(...args));
        }
        loadedCount++;
        logger.debug(`[Events] Loaded ${file}`);
      } else {
        logger.warn(`[Events] ${file} is missing required exports`);
      }
    } catch (error) {
      logger.error(`[Events] Failed to load ${file}`, { error: error.message });
    }
  }

  logger.info(`[Events] Loaded ${loadedCount} event handler(s)`);
}

/**
 * Main startup function
 */
// Function to initialize all managers and schedulers
async function initializeManagers(client) {
  // Reaction role manager
  client.reactionRoleManager = new ReactionRoleManager(client);
  logger.info('[Core] Reaction role manager initialized');

  // Polls manager
  client.pollsManager = new PollsManager(client);
  logger.info('[Core] Polls manager initialized');

  // Giveaway manager
  client.giveawayManager = new GiveawayManager(client);
  logger.info('[Core] Giveaway manager initialized');

  // Leveling manager
  client.levelingManager = new LevelingManager(client);
  logger.info('[Core] Leveling manager initialized');

  // Voice activity manager
  client.voiceActivityManager = new VoiceActivityManager(client);
  logger.info('[Core] Voice activity manager initialized');

  // VC sound drop manager
  client.vcSoundManager = new VCSoundManager(client);
  logger.info('[Core] VC sound manager initialized');

  // Starboard manager
  client.starboardManager = new StarboardManager(client);
  logger.info('[Core] Starboard manager initialized');

  // Birthday manager
  client.birthdayManager = new BirthdayManager(client);
  logger.info('[Core] Birthday manager initialized');

  // AFK manager
  client.afkManager = new AFKManager(client);
  logger.info('[Core] AFK manager initialized');

  // Reminder manager
  client.reminderManager = new ReminderManager(client);
  logger.info('[Core] Reminder manager initialized');

  // Weather manager
  client.weatherManager = new WeatherManager(client);
  logger.info('[Core] Weather manager initialized');

  // Anti-Nuke manager
  client.antiNukeManager = new AntiNukeManager(client);
  logger.info('[Core] Anti-Nuke manager initialized');

  // Raid Detection manager (Sery Bot feature)
  client.raidDetectionManager = new RaidDetectionManager(client);
  logger.info('[Core] Raid Detection manager initialized');

  // Self-Bot Detection manager (Sery Bot feature)
  client.selfbotDetectionManager = new SelfbotDetectionManager(client);
  logger.info('[Core] Self-Bot Detection manager initialized');

  // Adaptive Spam manager (Sery Bot feature)
  client.adaptiveSpamManager = new AdaptiveSpamManager(client);
  logger.info('[Core] Adaptive Spam manager initialized');

  // Phishing Detection manager
  client.phishingDetectionManager = new PhishingDetectionManager(client);
  await client.phishingDetectionManager.loadDomains();
  logger.info('[Core] Phishing Detection manager initialized');

  // Global Ban manager
  client.globalBanManager = new GlobalBanManager(client);
  await client.globalBanManager.loadBanCache();
  client.globalBanManager.startRefreshInterval(300000); // Refresh every 5 minutes
  logger.info('[Core] Global Ban manager initialized');

  // Auto-Meme manager
  client.autoMemeManager = new AutoMemeManager(client);
  logger.info('[Core] Auto-Meme manager initialized');

  // Achievement manager
  client.achievementManager = new AchievementManager(client);
  await client.achievementManager.initialize();
  logger.info('[Core] Achievement manager initialized');

  // Server Stats manager
  client.serverStatsManager = new ServerStatsManager(client);
  logger.info('[Core] Server Stats manager initialized');

  // Stat Display manager (voice channel counters)
  client.statDisplayManager = new StatDisplayManager(client);
  logger.info('[Core] Stat Display manager initialized');

  // Game Patch Watcher manager (per-game patch notes via cod-blog / fortnite-news)
  client.gamePatchWatcherManager = new GamePatchWatcherManager(client);
  logger.info('[Core] Game Patch Watcher manager initialized');

  // Emoji Stats manager
  client.emojiStatsManager = new EmojiStatsManager(client);
  logger.info('[Core] Emoji Stats manager initialized');

  // Schedule manager
  client.scheduleManager = new ScheduleManager(client);
  client.scheduleManager.startTickerUpdates(60000); // Update tickers every minute
  logger.info('[Core] Schedule manager initialized');

  // RPG managers
  client.rpgCharacterManager = new RPGCharacterManager(client);
  logger.info('[Core] RPG character manager initialized');

  client.rpgCombatManager = new RPGCombatManager(client, client.rpgCharacterManager);
  logger.info('[Core] RPG combat manager initialized');

  client.rpgQuestManager = new RPGQuestManager(client, client.rpgCharacterManager);
  logger.info('[Core] RPG quest manager initialized');

  client.rpgShopManager = new RPGShopManager(client, client.rpgCharacterManager);
  logger.info('[Core] RPG shop manager initialized');

  // Share the main bot's player with custom bots so music commands work everywhere
  // Use a proxy that lazily resolves global.player (may not be created yet at init time)
  if (!client.player) {
    Object.defineProperty(client, 'player', {
      get() { return global.player || null; },
      set(v) { Object.defineProperty(client, 'player', { value: v, writable: true, configurable: true }); },
      configurable: true,
    });
    logger.info('[Music] Deferred player binding for custom bot (resolves from global.player)');
  }

  // Music panel manager — shared globally so player events can find any bot's panels
  if (!global.musicPanelManager) global.musicPanelManager = new Map();
  client.musicPanelManager = global.musicPanelManager;
  logger.info('[Core] Music panel manager initialized (shared global)');

  // CAH (Cards Against Humanity) — seed built-in deck, rehydrate in-flight games, start cleanup cron
  try {
    const { seedBuiltinDeck } = await import('./core/cah-deck-importer.js');
    await seedBuiltinDeck();
    const { rehydrateActiveGames } = await import('./core/cah-manager.js');
    await rehydrateActiveGames(client);
    const { startCahCleanup } = await import('./jobs/cah-cleanup.js');
    startCahCleanup();
    logger.info('[Core] CAH engine ready');
  } catch (err) {
    logger.error(`[Core] CAH init failed: ${err.message}`);
  }

  // Fourthwall integration manager
  try {
    const { default: FourthwallManager } = await import('./core/fourthwall-manager.js');
    client.fourthwallManager = new FourthwallManager(client);
    logger.info('[Core] Fourthwall manager initialized');
  } catch (err) {
    logger.error(`[Core] Fourthwall manager init failed: ${err.message}`);
  }

  logger.info('[Core] All managers initialized');

  // Start memory monitoring and register important Maps
  memoryMonitor.watchMap('commands', client.commands);
  memoryMonitor.watchMap('cooldowns', client.cooldowns);
  if (client.levelingManager?.xpCooldowns) {
    memoryMonitor.watchMap('xpCooldowns', client.levelingManager.xpCooldowns);
  }
  if (client.levelingManager?.voiceSessions) {
    memoryMonitor.watchMap('voiceSessions', client.levelingManager.voiceSessions);
  }
  if (client.adaptiveSpamManager?.recentMessages) {
    memoryMonitor.watchMap('spamRecentMessages', client.adaptiveSpamManager.recentMessages);
  }
  if (client.globalBanManager?.banCache) {
    memoryMonitor.watchMap('globalBanCache', client.globalBanManager.banCache);
  }
  memoryMonitor.start();
  logger.info('[Core] Memory monitoring started');
}

/**
 * Initialize schedulers and dashboard (only called for default bot)
 */
async function initializeSchedulersAndDashboard(client) {
  // Initialize music system if discord-player is available
  if (Player) {
    try {
      // Create player instance - use yt-dlp directly for everything
      const player = new Player(client, {
        ytdlOptions: {
          quality: 'highestaudio',
          highWaterMark: 1 << 25,
          filter: 'audioonly',
          opusEncoded: false,
          fmt: 'bestaudio',
          dlChunkSize: 0
        },
        skipFFmpeg: false,  // Always use FFmpeg for proper audio format
        useLegacyFFmpeg: false,
        connectionTimeout: 60000 // 60s voice connection timeout (default 20s too short with 23 bot clients)
      });
      client.player = player;
      global.player = player;
      logger.info('[Music] Player instance created');

      // Register extractors - ORDER MATTERS!
      // 1. LocalFileExtractor first (for DJ commentary WAV files)
      try {
        const { LocalFileExtractor } = await import('./core/local-file-extractor.js');
        await player.extractors.register(LocalFileExtractor, {});
        logger.info('[Music] LocalFileExtractor registered');
      } catch (error) {
        logger.warn('[Music] Could not register LocalFileExtractor:', error);
      }

      // 2. YtDlpExtractor BEFORE SpotifyExtractor - handles all searches including YouTube
      // SpotifyExtractor claims AUTO_SEARCH but returns empty for non-Spotify content
      try {
        const { YtDlpExtractor } = await import('./core/ytdlp-extractor.js');
        await player.extractors.register(YtDlpExtractor, {});
        logger.info('[Music] YtDlp extractor registered');
      } catch (error) {
        logger.error('[Music] Could not load yt-dlp extractor:', error);
      }

      // 3. SpotifyExtractor last (only for explicit Spotify URLs now)
      try {
        const { SpotifyExtractor } = await import('@discord-player/extractor');
        await player.extractors.register(SpotifyExtractor, {
          clientId: process.env.SPOTIFY_CLIENT_ID,
          clientSecret: process.env.SPOTIFY_CLIENT_SECRET
        });
        logger.info('[Music] SpotifyExtractor registered with credentials');
      } catch (error) {
        logger.warn('[Music] Could not register SpotifyExtractor:', error.message);
      }

      // Queue mutations — refresh the panel so queue size / "Up Next" stay accurate
      // when tracks are added while something is already playing. playerStart only
      // fires on the first track, not on subsequent enqueues.
      player.events.on('audioTrackAdd', (queue, track) => {
        logger.info(`[Music Debug] Track added: ${track.title}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('audioTracksAdd', (queue, tracks) => {
        logger.info(`[Music Debug] ${tracks?.length || 0} tracks added in batch`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      // Set up player event handlers
      player.events.on('playerStart', (queue, track) => {
        logger.info(`[Music] Started playing: ${track.title} in guild ${queue.guild.id}`);
        logger.info(`[Music Debug] Track URL: ${track.url}`);
        logger.info(`[Music Debug] Track Source: ${track.source}`);
        logger.info(`[Music Debug] Track Duration: ${track.duration}`);
        logger.info(`[Music Debug] Queue node paused: ${queue.node.isPaused()}`);
        logger.info(`[Music Debug] Voice connection state: ${queue.connection?.state?.status || 'unknown'}`);
        logger.info(`[Music Debug] DJ Mode: ${queue.metadata?.djMode ? 'ENABLED' : 'DISABLED'}`);
        logger.info(`[Music Debug] DJ Voice: ${queue.metadata?.djVoice || 'not set'}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('playerPause', (queue) => {
        logger.info(`[Music] Player paused in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('playerResume', (queue) => {
        logger.info(`[Music] Player resumed in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('playerSkip', (queue, track) => {
        logger.info(`[Music] Skipped track in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('disconnect', async (queue) => {
        logger.info(`[Music] Disconnected from voice in guild ${queue.guild.id}`);
        client.musicStatusManager?.removeMusicSession(queue.guild.id);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel();

        // Voice camp: if this guild has a camp channel, reconnect to it shortly after.
        // resolveCampChannel returns null for non-camp guilds, so this is a no-op there.
        const guildId = queue.guild.id;
        try {
          const { rejoinCamp, CAMP_REJOIN_DELAY_MS } = await import('./core/voice-camp-manager.js');
          setTimeout(() => {
            rejoinCamp(client, player, guildId).catch((err) =>
              logger.error(`[VoiceCamp] Rejoin after disconnect failed in guild ${guildId}: ${err.message}`)
            );
          }, CAMP_REJOIN_DELAY_MS);
        } catch (error) {
          logger.error(`[VoiceCamp] Error scheduling camp rejoin in guild ${guildId}: ${error.message}`);
        }
      });

      player.events.on('emptyQueue', async (queue) => {
        logger.info(`[Music] Queue is empty in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel();

        // If DJ mode is enabled, the DJ manager handles this via its own queueEnd listener
        // Don't duplicate the call here to prevent race conditions
        if (queue.metadata?.djMode) {
          logger.info(`[DJ Mode] Queue empty - DJ manager will handle playlist generation via queueEnd event`);
          return; // Don't also trigger autoplay
        }

        // Autoplay: Fetch and queue similar tracks when queue ends
        try {
          const { isAutoplayEnabled, getAutoplaySource, is247Enabled } = await import('./utils/music_helpers.js');
          const autoplayEnabled = await isAutoplayEnabled(queue.guild.id);

          if (autoplayEnabled && queue.history.previousTrack) {
            logger.info(`[Autoplay] Queue empty, fetching similar tracks for guild ${queue.guild.id}`);
            const source = await getAutoplaySource(queue.guild.id);
            const previousTrack = queue.history.previousTrack;

            try {
              let searchQuery;

              if (source === 'ai') {
                // Use Gemini for AI-powered recommendations
                const { generatePlaylistRecommendations } = await import('./utils/gemini-api.js');
                const recommendations = await generatePlaylistRecommendations(previousTrack.title, previousTrack.author, null, [], null);
                if (recommendations && recommendations.length > 0) {
                  // Pick a random recommendation
                  const randomRec = recommendations[Math.floor(Math.random() * Math.min(recommendations.length, 5))];
                  searchQuery = `${randomRec.title} ${randomRec.artist}`;
                } else {
                  searchQuery = `${previousTrack.title} similar songs`;
                }
              } else {
                // YouTube-based autoplay - search for similar content
                searchQuery = `${previousTrack.title} ${previousTrack.author || ''} similar`.trim();
              }

              logger.info(`[Autoplay] Searching for: ${searchQuery}`);
              const result = await player.search(searchQuery, {
                requestedBy: client.user,
                searchEngine: 'ext:com.certifried.ytdlp-universal'
              });

              if (result.tracks.length > 0) {
                // Filter out the track we just played
                const newTracks = result.tracks.filter(t =>
                  t.url !== previousTrack.url && t.title !== previousTrack.title
                ).slice(0, 3);

                if (newTracks.length > 0) {
                  for (const track of newTracks) {
                    queue.addTrack(track);
                  }
                  logger.info(`[Autoplay] Added ${newTracks.length} similar tracks to queue`);

                  // Start playing if not already
                  if (!queue.isPlaying()) {
                    await queue.node.play();
                  }
                }
              }
            } catch (autoplayError) {
              logger.error(`[Autoplay] Error fetching similar tracks: ${autoplayError.message}`);
            }
          }

          // 24/7 Mode: Don't disconnect even if queue is empty
          const is247 = await is247Enabled(queue.guild.id);
          if (is247) {
            logger.info(`[24/7] Keeping connection alive in guild ${queue.guild.id}`);
          }

          // Voice camp: if a camp channel is configured, return home when idle.
          const { returnToCamp } = await import('./core/voice-camp-manager.js');
          await returnToCamp(player, queue);
        } catch (error) {
          logger.error(`[Autoplay/24/7] Error: ${error.message}`);
        }
      });

      player.events.on('error', (queue, error) => {
        logger.error(`[Music] Player error in guild ${queue.guild.id}:`, { error: error.message });
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('playerError', async (queue, error) => {
        logger.error(`[Music] Track error in guild ${queue.guild.id}: ${error.message}`, {
          errorMessage: error.message,
          errorCode: error.code,
          track: queue.currentTrack?.title || 'none',
          url: queue.currentTrack?.url || 'none',
          voiceStatus: queue.connection?.state?.status || 'unknown'
        });

        // If voice connection aborted, destroy queue — skipping won't help
        if (error.code === 'ABORT_ERR' || error.message?.includes('operation was aborted')) {
          logger.warn(`[Music] Voice connection aborted in guild ${queue.guild.id} — destroying queue`);
          try {
            queue.delete();
          } catch (e) {
            logger.error(`[Music] Could not delete queue:`, { error: e.message });
          }
          client.musicPanelManager?.get(queue.guild.id)?.updatePanel();
          return;
        }

        // Send user-friendly error message (only for non-DJ guilds; DJManager handles its own)
        if (!queue.metadata?.djMode) {
          try {
            const channel = client.channels.cache.get(queue.metadata?.channelId);
            if (channel?.isTextBased()) {
              const reason = getPlayerErrorReason(error.message);
              channel.send(`\u23ED\uFE0F | Skipped unavailable track: ${reason}`);
            }
          } catch (msgErr) {
            logger.warn(`[Music] Failed to send error message to channel: ${msgErr.message}`);
          }
        }

        // Auto-recovery: wait 3s then skip to next track (prevents YouTube rate-limit cascade)
        logger.warn(`[Music] Waiting 3s before auto-recovery skip (rate-limit protection)...`);
        await new Promise(r => setTimeout(r, 3000));
        try {
          if (queue.tracks.size > 0) {
            queue.node.skip();
            logger.info(`[Music] Auto-recovery: skipped to next track`);
          } else {
            logger.info(`[Music] Auto-recovery: no more tracks in queue, stopping player`);
            queue.node.stop();
          }
        } catch (recoveryError) {
          logger.error(`[Music] Auto-recovery failed:`, { error: recoveryError.message });
          try {
            queue.delete();
            logger.warn(`[Music] Deleted queue as last resort recovery`);
          } catch (deleteError) {
            logger.error(`[Music] Could not delete queue:`, { error: deleteError.message });
          }
        }

        // Update the music panel to reflect the new state
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('debug', (queue, message) => {
        logger.info(`[Music Debug] ${message}`);
      });

      // Initialize music managers
      client.musicStatusManager = new MusicStatusManager(client);
      logger.info('[Music] Music status manager initialized');

      client.djManager = new DJManager(client);
      logger.info('[Music] DJ manager initialized');

      // Reuse shared global map
      if (!client.musicPanelManager) {
        if (!global.musicPanelManager) global.musicPanelManager = new Map();
        client.musicPanelManager = global.musicPanelManager;
      }
      logger.info('[Music] Music panel manager ready (shared global)');

      // Load existing music panels from database (best-effort; lazy-load fallback exists in interactionCreate)
      try {
        const [panels] = await pool.execute('SELECT * FROM music_panels');
        for (const panelData of panels) {
          try {
            const channel = await client.channels.fetch(panelData.channel_id).catch(() => null);
            if (channel) {
              const message = await channel.messages.fetch(panelData.message_id).catch(() => null);
              if (message) {
                const panel = new MusicPanel(client, panelData.guild_id);
                panel.message = message;
                client.musicPanelManager.set(panelData.guild_id, panel);
                logger.info(`[Music] Loaded music panel for guild ${panelData.guild_id}`);
              } else {
                logger.warn(`[Music] Panel message not found for guild ${panelData.guild_id} (will lazy-load)`);
              }
            } else {
              logger.warn(`[Music] Panel channel not accessible for guild ${panelData.guild_id} (will lazy-load)`);
            }
          } catch (error) {
            logger.warn(`[Music] Could not load panel for guild ${panelData.guild_id}: ${error.message}`);
          }
        }
      } catch (error) {
        logger.error('[Music] Error loading music panels:', error);
      }

      // Voice camp: join configured camp channels for this client's guilds (best-effort).
      try {
        const { joinCampChannels } = await import('./core/voice-camp-manager.js');
        await joinCampChannels(client, player);
      } catch (error) {
        logger.error('[VoiceCamp] Error joining camp channels on startup:', error);
      }

      logger.info('[Music] Music system fully initialized');
    } catch (error) {
      logger.error('[Music] Failed to initialize music system:', error);
    }
  }

  // Start schedulers
  startAnnouncementScheduler(client);
  logger.info('[Core] Announcement scheduler initialized');

  const pollScheduler = startPollScheduler(client.pollsManager);
  client.pollScheduler = pollScheduler;

  const giveawayScheduler = startGiveawayScheduler(client.giveawayManager);
  client.giveawayScheduler = giveawayScheduler;

  // Start social feed scheduler
  startSocialFeedScheduler(client);
  logger.info('[Core] Social feed scheduler initialized');

  // Start streaming schedulers
  startStreamCheckScheduler(client);
  logger.info('[Core] Stream check scheduler initialized');

  // Retry blocked command deployments every 5 min. Without this, a bot whose
  // boot deploy timed out stays without commands until next PM2 restart, even
  // after Discord's rate-limit hold clears.
  setInterval(() => botManager.retryBlockedDeployments(), 5 * 60 * 1000);
  setTimeout(() => botManager.retryBlockedDeployments(), 30 * 1000); // also try 30s after boot
  logger.info('[Core] Blocked-deployment retry scheduler initialized (5 min interval)');

  startTwitchScheduleScheduler(client);
  logger.info('[Core] Twitch schedule scheduler initialized');

  startFreeGamesScheduler(client);
  logger.info('[Core] Free games scheduler initialized');

  startSteamWatchScheduler(client);
  logger.info('[Core] Steam Watch scheduler initialized');

  startQOTDScheduler(client);
  logger.info('[Core] QOTD scheduler initialized');

  startAutoMemeScheduler(client);
  logger.info('[Core] Auto-Meme scheduler initialized');

  startPokerMemeScheduler(client);
  logger.info('[Core] Poker Meme scheduler initialized');

  startAnnouncementUpdater(client);
  logger.info('[Core] Announcement updater initialized');

  startTeamSyncScheduler(client);
  logger.info('[Core] Team sync scheduler initialized');

  // Start birthday scheduler
  startBirthdayScheduler(client.birthdayManager);
  logger.info('[Core] Birthday scheduler initialized');

  // Start reminder scheduler
  initReminderScheduler(client);
  logger.info('[Core] Reminder scheduler initialized');

  // Start grow reminder scheduler
  initGrowReminderScheduler(client);
  logger.info('[Core] Grow reminder scheduler initialized');

  // Start TikTok video checker
  startTikTokVideoChecker(client);
  logger.info('[Core] TikTok video checker initialized');

  // Instagram/Facebook feeds are handled by the social-feed-scheduler alongside Reddit/YouTube/Twitter

  // Start community support monthly rotation
  startCommunityRotation(client);
  logger.info('[Core] Community support rotation scheduler initialized');

  // Start leveling monthly-reset scheduler (opt-in per guild via level_config.monthly_reset_enabled)
  startMonthlyResetScheduler(client);
  logger.info('[Core] Leveling monthly-reset scheduler initialized');

  // Start unverified-reaper (opt-in per guild via verify_config.unverified_kick_days > 0)
  startUnverifiedReaper(client);
  logger.info('[Core] Unverified reaper scheduler initialized');

  // Start affiliate status re-check scheduler
  startAffiliateRecheckScheduler();
  logger.info('[Core] Affiliate re-check scheduler initialized');

  // Start time capsule scheduler
  startTimeCapsuleScheduler(client);
  logger.info('[Core] Time capsule scheduler initialized');

  // Start habit tracker scheduler
  startHabitTrackerScheduler(client);
  logger.info('[Core] Habit tracker scheduler initialized');

  // Start pet stat decay scheduler
  startPetStatDecayScheduler(client);
  logger.info('[Core] Pet stat decay scheduler initialized');

  // Start server stats scheduler
  startServerStatsScheduler(client);
  logger.info('[Core] Server stats scheduler initialized');

  // Start stat display scheduler (voice channel counters)
  startStatDisplayScheduler(client);
  logger.info('[Core] Stat display scheduler initialized');

  // Start game-patch watcher scheduler (cod-blog + fortnite-news)
  startGamePatchScheduler(client);
  logger.info('[Core] Game patch scheduler initialized');

  // Start Twitch VIP/Mod role sync scheduler
  import('./jobs/twitch-role-sync-scheduler.js').then(({ startTwitchRoleSyncScheduler }) => {
    startTwitchRoleSyncScheduler(client);
    logger.info('[Core] Twitch role sync scheduler initialized');
  }).catch(err => logger.error('[Core] Failed to start Twitch role sync scheduler:', err.message));

  // Start scheduled channel purge
  startPurgeScheduler(client);
  logger.info('[Core] Purge scheduler initialized');

  // Start auto-backup scheduler (weekly)
  startBackupScheduler(client);
  logger.info('[Core] Auto-backup scheduler initialized');

  // Start cross-network live notification scheduler
  startCrossNetworkScheduler(client);
  logger.info('[Core] Cross-network scheduler initialized');

  // Start VC sound drop scheduler
  startVCSoundScheduler(client.vcSoundManager);
  logger.info('[Core] VC sound scheduler initialized');

  // Start Throne wishlist notification scheduler
  startThroneScheduler();
  logger.info('[Core] Throne notification scheduler initialized');

  // Start phishing list updater (syncs domain lists every 4 hours)
  startPhishingListUpdater(client);
  logger.info('[Core] Phishing list updater initialized');

  // Start global ban aggregator (processes auto-aggregation every 15 minutes)
  startGlobalBanAggregator(client);
  logger.info('[Core] Global ban aggregator initialized');

  // Start cleanup scheduler (runs daily at 4 AM)
  cleanupScheduler.start();
  logger.info('[Core] Cleanup scheduler initialized');

  // Start Fourthwall orphan webhook cleanup + seen-events pruning
  startFourthwallCleanup();
  logger.info('[Core] Fourthwall cleanup scheduler initialized');

  // Start Fourthwall public shop tracker (scrapes subscribed shops every 10 min)
  startFourthwallTracker();
  logger.info('[Core] Fourthwall shop tracker initialized');

  // Start weather alerts (optional - can be enabled per guild)
  // client.weatherManager.start(300); // Check every 5 minutes

  // Start dashboard
  try {
    const dashboard = await import('./dashboard/server.js');
    dashboard.default.start(client);
    logger.info('[Core] Dashboard started successfully');
  } catch (error) {
    logger.error('[Core] Failed to start dashboard', { error: error.message });
  }

  // Start CertiFriedUtility Twitch/Kick Bot
  try {
    const { certiFriedBot } = await import('./services/certifried-bot/index.js');
    await certiFriedBot.start();
    global.certiFriedBot = certiFriedBot;
    logger.info('[Core] CertiFriedUtility Twitch/Kick bot started successfully');
  } catch (error) {
    logger.error('[Core] Failed to start CertiFriedUtility bot', { error: error.message, stack: error.stack });
  }

  // Start CertiFried Extension Game Server (port 4020)
  try {
    const { certiFriedExtension } = await import('./services/certifried-extension/index.js');
    await certiFriedExtension.start();
    global.certiFriedExtension = certiFriedExtension;
    logger.info('[Core] CertiFried Extension game server started on port 4020');
  } catch (error) {
    logger.error('[Core] Failed to start CertiFried Extension', { error: error.message, stack: error.stack });
  }

}

async function start() {
  try {
    logger.info('═══════════════════════════════════════════════');
    logger.info('  CertiFried Utility Bot - Starting Up');
    logger.info('═══════════════════════════════════════════════');

    // Initialize uptime tracker
    const uptimeTracker = new UptimeTracker('CertiFried Utility Bot');
    await uptimeTracker.logStart('Bot startup');
    uptimeTracker.setupGracefulShutdown();
    global.uptimeTracker = uptimeTracker;
    logger.info('[UptimeTracker] Uptime tracking initialized');

    // Set up bot manager loaders
    botManager.setCommandLoader(loadCommands);
    botManager.setEventLoader(loadEvents);

    // Initialize default bot
    logger.info('[BotManager] Initializing default bot...');
    const client = await botManager.initializeDefaultBot(process.env.DISCORD_TOKEN);

    // Make botManager globally accessible for dashboard
    global.botManager = botManager;

    // Initialize managers for default bot
    await initializeManagers(client);
    logger.info('[BotManager] Default bot managers initialized');

    // Initialize schedulers and dashboard (only for default bot)
    await initializeSchedulersAndDashboard(client);
    logger.info('[BotManager] Default bot schedulers and dashboard initialized');

    // Make pollsManager globally accessible for dashboard as fallback (after initialization)
    global.pollsManager = client.pollsManager;

    // Load custom bots from database
    logger.info('[BotManager] Loading custom bots from database...');
    const [customBots] = await pool.execute(
      'SELECT * FROM custom_bots WHERE enabled = 1'
    );

    logger.info(`[BotManager] Found ${customBots.length} enabled custom bot(s) to load`);

    // Prepare all custom bot configs (DB queries are fast, do them sequentially)
    const botLoadTasks = [];
    for (const botConfig of customBots) {
      const [mappings] = await pool.execute(
        'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
        [botConfig.bot_id]
      );
      const guildIds = mappings.map(m => m.guild_id);

      if (guildIds.length === 0) {
        logger.warn(`[BotManager] Custom bot ${botConfig.bot_name} (${botConfig.bot_id}) has no assigned guilds, skipping`);
        continue;
      }

      let tokenObj;
      try {
        tokenObj = JSON.parse(botConfig.bot_token);
      } catch (parseError) {
        logger.error(`[BotManager] Failed to parse bot token for ${botConfig.bot_name}:`, {
          error: parseError.message,
          bot_id: botConfig.bot_id
        });
        continue;
      }

      botLoadTasks.push({ botConfig, tokenObj, guildIds });
    }

    // Login all custom bots with a small stagger so we don't fire 26 DNS
    // lookups for gateway.discord.gg simultaneously — that race previously
    // caused one bot per startup to fail with ENOTFOUND.
    logger.info(`[BotManager] Logging in ${botLoadTasks.length} custom bot(s) (staggered 150ms)...`);
    const LOGIN_STAGGER_MS = 150;
    // Each bot's manager-init is chained INSIDE its own promise so it runs
    // as soon as that bot is ready, independent of any other bot. Previously,
    // a single hung deploy (e.g. Kitsune's REST rate-limit retry that never
    // exits) blocked Promise.allSettled forever, leaving every custom bot
    // without managers and breaking schedulers fleet-wide.
    const loginResults = await Promise.allSettled(
      botLoadTasks.map(({ botConfig, tokenObj, guildIds }, i) => {
        return (async () => {
          await new Promise(r => setTimeout(r, i * LOGIN_STAGGER_MS));
          logger.info(`[BotManager] Loading custom bot: ${botConfig.bot_name} (${guildIds.length} guild(s))`);
          let customClient;
          try {
            customClient = await botManager.addCustomBot({
              bot_id: botConfig.bot_id,
              bot_name: botConfig.bot_name,
              bot_token: tokenObj,
              guild_ids: guildIds
            });
          } catch (err) {
            err.botName = botConfig.bot_name;
            err.botId = botConfig.bot_id;
            throw err;
          }
          try {
            if (!customClient.player && global.player) {
              customClient.player = global.player;
            }
            await initializeManagers(customClient);
            logger.info(`[BotManager] ✅ Custom bot ${botConfig.bot_name} (${botConfig.bot_id}) fully initialized`);

            // Voice camp: join this custom bot's configured camp channels using ITS
            // own client, so the custom bot (not the default bot) connects. The shared
            // global.player orchestrates the queue; the voice adapter comes from the
            // channel's guild as fetched by customClient.
            try {
              const { joinCampChannels } = await import('./core/voice-camp-manager.js');
              await joinCampChannels(customClient, global.player);
            } catch (campErr) {
              logger.error(`[VoiceCamp] Custom bot ${botConfig.bot_name} camp join failed: ${campErr.message}`);
            }
          } catch (error) {
            logger.error(`[BotManager] ❌ Manager init failed for ${botConfig.bot_name}:`, { error: error.message });
          }
          return { botConfig, customClient };
        })();
      })
    );

    for (const result of loginResults) {
      if (result.status === 'rejected') {
        const r = result.reason;
        logger.error(`[BotManager] ❌ Failed to load custom bot ${r?.botName || 'unknown'} (${r?.botId || '?'}):`, { error: r?.message });
      }
    }

    logger.info(`[BotManager] Custom bot initialization complete. ${botManager.clients.size - 1} custom bot(s) loaded successfully.`);

    // Start the AuditBot watcher (dedicated client for global ban report channels)
    import('./events/globalBanReportWatcher.js').then(({ startAuditWatcher }) => {
      startAuditWatcher().catch(err => {
        logger.error(`[GlobalBanWatcher] Failed to start audit watcher: ${err.message}`);
      });
    });

    // Initialize schedulers for custom bots (needs to be called after bots are loaded)
    if (botManager.clients.size > 1) {
      logger.info('[BotManager] Starting schedulers for custom bots...');
      initReminderScheduler(client); // This will loop through all bots including newly loaded custom bots
      startTwitchScheduleScheduler(client); // Add Twitch schedule managers for custom bots
      startFreeGamesScheduler(client); // Add Free games managers for custom bots
      startSteamWatchScheduler(client); // Add Steam Watch managers for custom bots
      startAutoMemeScheduler(client); // Add Auto-Meme managers for custom bots
      startPokerMemeScheduler(client); // Add Poker Meme generators for custom bots
      startTikTokVideoChecker(client); // Add TikTok video checker for custom bots
      // Start stat display schedulers for each custom bot client
      for (const [botId, botClient] of botManager.clients) {
        if (botClient !== client && botClient.statDisplayManager) {
          startStatDisplayScheduler(botClient);
        }
        if (botClient !== client && botClient.gamePatchWatcherManager) {
          startGamePatchScheduler(botClient);
        }
      }
      logger.info('[BotManager] Schedulers started for custom bots');
    }

    // One-shot repair for Chibi's Channel after the botched server transfer
    // (idempotent — skips if already correct)
    try {
      const { runChibiPanelRepair } = await import('./scripts/fix-chibi-panels.js');
      await runChibiPanelRepair();
    } catch (err) {
      logger.error(`[ChibiRepair] Failed to run: ${err.message}`);
    }

    // Windrose game setup for Chibi's Channel — role, category, news
    // channel, panel button, Steam watcher (idempotent — skips per-step
    // when target state is already correct)
    try {
      const { runWindroseSetup } = await import('./scripts/setup-windrose-chibi.js');
      await runWindroseSetup();
    } catch (err) {
      logger.error(`[WindroseSetup] Failed to run: ${err.message}`);
    }

    // Initialize TTS cleanup scheduler and check yt-dlp version
    try {
      const { startTTSCleanupScheduler, checkYtdlp } = await import('./utils/external-tools.js');

      // Start TTS file cleanup scheduler
      startTTSCleanupScheduler(600000); // Clean every 10 minutes
      logger.info('[Startup] TTS cleanup scheduler started');

      // Check yt-dlp version
      const ytdlpStatus = await checkYtdlp();
      if (ytdlpStatus.available) {
        logger.info('[Startup] yt-dlp version check passed', { version: ytdlpStatus.version });
      } else {
        logger.warn('[Startup] yt-dlp not available or outdated - music features may not work', {
          error: ytdlpStatus.error,
          version: ytdlpStatus.version,
          minimumRequired: ytdlpStatus.minimumRequired
        });
      }
    } catch (externalToolsError) {
      logger.warn('[Startup] Could not initialize external tools utilities', { error: externalToolsError.message });
    }

  } catch (error) {
    logger.error('[Startup] Fatal error during startup', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown() {
  logger.info('[Shutdown] Shutting down gracefully...');

  try {
    // Log shutdown event for uptime tracking
    if (global.uptimeTracker) {
      await global.uptimeTracker.logStop('Graceful shutdown');
      logger.info('[UptimeTracker] Shutdown event logged');
    }

    // Stop TTS cleanup scheduler
    try {
      const { stopTTSCleanupScheduler } = await import('./utils/external-tools.js');
      stopTTSCleanupScheduler();
      logger.info('[Scheduler] TTS cleanup scheduler stopped');
    } catch (e) {
      // Ignore if module not loaded
    }

    // Stop rate limiter
    try {
      const { stopRateLimiter } = await import('./utils/rate-limiter.js');
      stopRateLimiter();
      logger.info('[Scheduler] Rate limiter stopped');
    } catch (e) {
      // Ignore if module not loaded
    }

    // Stop announcement scheduler
    stopAnnouncementScheduler();
    logger.info('[Scheduler] Announcement scheduler stopped');

    // Get default client from botManager (fixes undefined client reference)
    const defaultClient = botManager.getDefaultClient();

    // Stop poll scheduler
    if (defaultClient?.pollScheduler) {
      if (typeof defaultClient.pollScheduler.stop === 'function') {
        defaultClient.pollScheduler.stop();
      }
      logger.info('[Scheduler] Poll scheduler stopped');
    }

    // Stop giveaway scheduler
    if (defaultClient?.giveawayScheduler) {
      clearInterval(defaultClient.giveawayScheduler);
      logger.info('[Scheduler] Giveaway scheduler stopped');
    }

    // Stop social feed scheduler
    stopSocialFeedScheduler();
    logger.info('[Scheduler] Social feed scheduler stopped');

    // Stop streaming schedulers
    stopStreamCheckScheduler();
    logger.info('[Scheduler] Stream check scheduler stopped');

    stopAnnouncementUpdater();
    logger.info('[Scheduler] Announcement updater stopped');

    stopTeamSyncScheduler();
    logger.info('[Scheduler] Team sync scheduler stopped');

    // Stop birthday scheduler
    stopBirthdayScheduler();
    logger.info('[Scheduler] Birthday scheduler stopped');

    // Stop reminder scheduler on default client
    if (defaultClient?.reminderManager) {
      defaultClient.reminderManager.stopScheduler();
      logger.info('[Scheduler] Reminder scheduler stopped');
    }

    // Stop weather alerts on default client
    if (defaultClient?.weatherManager) {
      defaultClient.weatherManager.stop();
      logger.info('[Scheduler] Weather alerts stopped');
    }

    // Stop TikTok video checker
    stopTikTokVideoChecker();
    logger.info('[Scheduler] TikTok video checker stopped');

    // Stop Throne notification scheduler
    stopThroneScheduler();
    logger.info('[Scheduler] Throne notification scheduler stopped');

    // Stop community support schedulers
    stopCommunityRotation();
    logger.info('[Scheduler] Community rotation scheduler stopped');
    stopAffiliateRecheckScheduler();
    logger.info('[Scheduler] Affiliate re-check scheduler stopped');

    // Stop time capsule scheduler
    stopTimeCapsuleScheduler();
    logger.info('[Scheduler] Time capsule scheduler stopped');

    // Stop habit tracker scheduler
    stopHabitTrackerScheduler();
    logger.info('[Scheduler] Habit tracker scheduler stopped');

    // Stop pet stat decay scheduler
    stopPetStatDecayScheduler();
    logger.info('[Scheduler] Pet stat decay scheduler stopped');

    // Stop server stats scheduler
    stopServerStatsScheduler();
    logger.info('[Scheduler] Server stats scheduler stopped');

    // Stop stat display scheduler
    stopStatDisplayScheduler();
    stopGamePatchScheduler();
    logger.info('[Scheduler] Stat display scheduler stopped');

    // Stop purge scheduler
    stopPurgeScheduler();

    // Stop cleanup scheduler
    cleanupScheduler.stop();
    logger.info('[Scheduler] Cleanup scheduler stopped');

    // Stop global ban aggregator
    stopGlobalBanAggregator();
    logger.info('[Scheduler] Global ban aggregator stopped');

    // Stop Fourthwall cleanup scheduler
    stopFourthwallCleanup();
    logger.info('[Scheduler] Fourthwall cleanup stopped');

    // Stop Fourthwall shop tracker
    stopFourthwallTracker();
    logger.info('[Scheduler] Fourthwall shop tracker stopped');

    // Stop QOTD scheduler
    stopQOTDScheduler();
    logger.info('[Scheduler] QOTD scheduler stopped');

    // Stop auto-meme scheduler
    stopAutoMemeScheduler();
    logger.info('[Scheduler] Auto-meme scheduler stopped');

    // Stop poker meme scheduler
    stopPokerMemeScheduler();
    logger.info('[Scheduler] Poker meme scheduler stopped');

    // Stop managers on all clients
    const allClients = botManager.getAllClients();
    for (const botClient of allClients) {
      // Stop manager intervals
      if (botClient.selfbotDetectionManager?.stop) {
        botClient.selfbotDetectionManager.stop();
      }
      if (botClient.antiNukeManager?.stop) {
        botClient.antiNukeManager.stop();
      }
      if (botClient.adaptiveSpamManager?.stop) {
        botClient.adaptiveSpamManager.stop();
      }
      if (botClient.raidDetectionManager?.stop) {
        botClient.raidDetectionManager.stop();
      }
      if (botClient.globalBanManager?.stop) {
        botClient.globalBanManager.stop();
      }
      if (botClient.scheduleManager?.stopTickerUpdates) {
        botClient.scheduleManager.stopTickerUpdates();
      }
      if (botClient.pollsManager?.stopScheduler) {
        botClient.pollsManager.stopScheduler();
      }
      // Destroy bounded maps in leveling manager
      if (botClient.levelingManager?.xpCooldowns?.destroy) {
        botClient.levelingManager.xpCooldowns.destroy();
      }
    }
    logger.info('[Managers] All manager intervals stopped');

    // Destroy all Discord clients
    for (const botClient of allClients) {
      botClient.destroy();
      logger.info(`[Discord] Client ${botClient.botId || 'default'} destroyed`);
    }

    // Close database pool
    await pool.end();
    logger.info('[Database] Connection pool closed');

    logger.info('[Shutdown] Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('[Shutdown] Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

// Handle process termination signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (error) => {
  logger.error('[Process] Unhandled Promise Rejection', { error: error.message, stack: error.stack });
});
process.on('uncaughtException', (error) => {
  // mysql2 pool can cause stack overflow under heavy concurrent load — non-fatal, don't crash
  if (error instanceof RangeError && error.message === 'Maximum call stack size exceeded') {
    logger.warn('[Process] Stack overflow caught (likely mysql2 pool pressure) — suppressed');
    return;
  }
  logger.error('[Process] Uncaught Exception', { error: error.message, stack: error.stack });
  shutdown();
});

// Start the bot
start();
