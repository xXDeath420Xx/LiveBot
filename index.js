import { Client, Collection, GatewayIntentBits, Partials, Events } from 'discord.js';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import pool from './utils/db.js';
import botManager from './core/bot-manager.js';
import UptimeTracker from './utils/uptime-tracker.js';
import memoryMonitor from './utils/memoryMonitor.js';
import ReactionRoleManager from './core/reaction-role-manager.js';
import { reconcileStaleJobs } from './core/member-purge.js';
import PollsManager from './core/polls-manager.js';
import GiveawayManager from './core/giveaway-manager.js';
import LevelingManager from './core/leveling-manager.js';
import { withActor, attachPlayLog } from './core/music-play-log.js';
import { manageLeave, noteActivity, scheduleLeave, cancelLeave, leaveIfIdle, sweepIdle, isActivelyPlaying,
    QUEUE_END_GRACE_MS, DJ_REFILL_GRACE_MS, EMPTY_IDLE_MS } from './core/music-leave-policy.js';
import { closeStaleMusicQuizSessions } from './commands/games/arcade-musicquiz-handler.js';
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
import { startKofiExpiry, stopKofiExpiry } from './jobs/kofi-expiry.js';
// Critters (/owo game): stamps critter_meta.live_since, then the lottery draw, escrow sweeper and boss reaper jobs.
import { startCritters, stopCritters } from './core/critters-startup.js';
import { startGrowTreeReaper, stopGrowTreeReaper } from './jobs/growtree-reaper.js';
import { startVaultCleanup, stopVaultCleanup } from './jobs/vault-cleanup.js';
import { startAnnouncementUpdater, stopAnnouncementUpdater } from './jobs/announcement-updater.js';
import { startTeamSyncScheduler, stopTeamSyncScheduler } from './jobs/team-sync-scheduler.js';
import { startBirthdayScheduler, stopBirthdayScheduler } from './jobs/birthday-scheduler.js';
import { startTwitchScheduleScheduler, stopTwitchScheduleScheduler } from './jobs/twitch-schedule-scheduler.js';
import { startFreeGamesScheduler, stopFreeGamesScheduler } from './jobs/free-games-scheduler.js';
import { startSteamWatchScheduler, stopSteamWatchScheduler } from './jobs/steam-watch-scheduler.js';
import { startBuyMeACoffeeScheduler, stopBuyMeACoffeeScheduler } from './jobs/buymeacoffee-scheduler.js';
import { startQOTDScheduler, stopQOTDScheduler } from './jobs/qotd-scheduler.js';
import { startHolidayDayAnnouncer, stopHolidayDayAnnouncer } from './jobs/holiday-day-announcer.js';
import initReminderScheduler from './jobs/reminder-scheduler.js';
import { startTikTokVideoChecker, stopTikTokVideoChecker } from './jobs/tiktok-video-checker.js';
import { startTwitchClipChecker, stopTwitchClipChecker } from './jobs/twitch-clip-checker.js';
import { startFortniteFeedChecker, stopFortniteFeedChecker } from './jobs/fortnite-feed-checker.js';
import { startFishingTournamentScheduler, stopFishingTournamentScheduler } from './jobs/fishing-tournament-scheduler.js';
import { startBgamesScheduler, stopBgamesScheduler } from './jobs/bgames-scheduler.js';
import { startEventScheduleChecker, stopEventScheduleChecker } from './jobs/event-schedule-checker.js';
import { startEventReminderScheduler, stopEventReminderScheduler } from './jobs/event-reminder-scheduler.js';
import { startStatRoleScheduler, stopStatRoleScheduler } from './jobs/statrole-scheduler.js';
import { startPvpTimeoutSweeper, stopPvpTimeoutSweeper } from './jobs/pvp-timeout-sweeper.js';
import { startLfgExpiry } from './jobs/lfg-expiry.js';
import AutoMemeManager from './core/auto-meme-manager.js';
import { startAutoMemeScheduler, stopAutoMemeScheduler } from './jobs/auto-meme-scheduler.js';
import { startPokerMemeScheduler, stopPokerMemeScheduler } from './jobs/poker-meme-scheduler.js';
import { startCommunityRotation, stopCommunityRotation } from './jobs/community-support-rotation.js';
import { startMonthlyResetScheduler, stopMonthlyResetScheduler } from './jobs/leveling-monthly-reset.js';
import { startUnverifiedReaper, stopUnverifiedReaper } from './jobs/unverified-reaper.js';
import { startJoinRequestSync } from './jobs/join-request-sync.js';
import { startHealthDigest } from './jobs/health-digest.js';
import { startSteamLibrarySync } from './jobs/steam-library-sync.js';
import { startTempAccessReaper, stopTempAccessReaper } from './jobs/temp-access-reaper.js';
import { startEconomyEventsScheduler, stopEconomyEventsScheduler } from './jobs/economy-events-scheduler.js';
import { startTimedModerationJob, stopTimedModerationJob } from './jobs/timed-moderation-job.js';
import { startStreamerDepartureSweeper, stopStreamerDepartureSweeper } from './jobs/streamer-departure-sweeper.js';
import { startVoiceCampReconciler, stopVoiceCampReconciler } from './jobs/voice-camp-reconciler.js';
import { startAffiliateRecheckScheduler, stopAffiliateRecheckScheduler } from './jobs/affiliate-recheck-scheduler.js';
import { startTwitchIdentitySync } from './jobs/twitch-identity-sync.js';
import { startKickTokenRefreshScheduler, stopKickTokenRefreshScheduler } from './jobs/kick-token-refresh-scheduler.js';
import { startKickTimerScheduler, stopKickTimerScheduler } from './jobs/kick-timer-scheduler.js';
import { startOrientationRefreshWatcher } from './core/orientation-manager.js';
import { startTimeCapsuleScheduler, stopTimeCapsuleScheduler } from './jobs/time-capsule-scheduler.js';
import { startHabitTrackerScheduler, stopHabitTrackerScheduler } from './jobs/habit-tracker-scheduler.js';
import { startPetStatDecayScheduler, stopPetStatDecayScheduler } from './jobs/pet-stat-decay-scheduler.js';
import { startThroneScheduler, stopThroneScheduler } from './jobs/throne-scheduler.js';
import { startWeeklyRecapScheduler, stopWeeklyRecapScheduler } from './jobs/weekly-recap-scheduler.js';
import { startTwitchAnalyticsAggregator, stopTwitchAnalyticsAggregator } from './jobs/twitch-analytics-aggregator.js';
import { startServerStatsScheduler, stopServerStatsScheduler } from './jobs/server-stats-scheduler.js';
import { startStatDisplayScheduler, stopStatDisplayScheduler } from './jobs/stat-display-scheduler.js';
import { startFourTwentyPanelScheduler, stopFourTwentyPanelScheduler } from './jobs/fourtwenty-panel-scheduler.js';
import { startCannabisScheduler, stopCannabisScheduler } from './jobs/cannabis-scheduler.js';
import { startGamePatchScheduler, stopGamePatchScheduler } from './jobs/game-patch-scheduler.js';
import GamePatchWatcherManager from './core/game-patch-watcher-manager.js';
import { startPurgeScheduler, stopPurgeScheduler } from './jobs/purge-scheduler.js';
import { startPurgeRuleSweeper, stopPurgeRuleSweeper } from './jobs/purge-rule-sweeper.js';
import { startBackupScheduler } from './jobs/backup-scheduler.js';
import { startCrossNetworkScheduler, stopCrossNetworkScheduler } from './jobs/cross-network-scheduler.js';
import initGrowReminderScheduler from './jobs/grow-reminder-scheduler.js';
import cleanupScheduler from './jobs/cleanup-scheduler.js';
import { startRetentionSweeper, stopRetentionSweeper } from './jobs/retention-sweeper.js';
import { startCommandUsageRollup, stopCommandUsageRollup } from './jobs/command-usage-rollup.js';
import { flush as flushCommandUsage } from './core/command-usage.js';
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
import BuyMeACoffeeManager from './core/buymeacoffee-manager.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { loadThemes } from './core/guild-theme.js';
import { reconcileGuildPresence } from './core/guild-presence.js';

// Import discord-player (NOTE: Requires npm install discord-player + yt-dlp binary)
let Player;
let useMainPlayer;
let discordPlayerModule = null;
try {
  const discordPlayer = await import('discord-player');
  discordPlayerModule = discordPlayer;
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
          // The public command catalog scans this file for `showModal` to decide whether a
          // command can be reached from chat. Nothing else reads it.
          command.default.__filePath = filePath;
          client.commands.set(command.default.data.name, command.default);
          loadedCount++;
          logger.debug(`[Commands] Loaded ${folder}/${file}`);
        } else if (/-handlers?\.js$/.test(file)) {
          // Subcommand logic split out of a command file and imported by it — not a command itself.
          logger.debug(`[Commands] Skipped ${folder}/${file} (handler module)`);
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

  // One listener per event FILE, and features deliberately get their own file rather than a line in
  // messageCreate.js (whose early returns would skip them) — so 11 messageCreate listeners is by
  // design, not a leak. Node's default cap of 10 turned that into a warning per client on every boot.
  client.setMaxListeners(Math.max(client.getMaxListeners(), eventFiles.length));

  for (const file of eventFiles) {
    try {
      const filePath = join(eventsPath, file);
      const event = await import(`file://${filePath}`);

      if (event.default && event.default.name && event.default.execute) {
        // discord.js renamed 'ready' to 'clientReady' to distinguish it from the
        // raw gateway READY packet; 14.25 warns on the old name and v15 stops
        // emitting it entirely. Six event files still declare 'ready', so alias
        // it here rather than in each of them — Events.ClientReady resolves to
        // whatever the installed version actually emits, which keeps this
        // correct across the v15 upgrade without another sweep.
        const eventName = event.default.name === 'ready' ? Events.ClientReady : event.default.name;

        if (event.default.once) {
          client.once(eventName, (...args) => withActor(eventName, args, () => event.default.execute(...args)));
        } else {
          client.on(eventName, (...args) => withActor(eventName, args, () => event.default.execute(...args)));
        }
        loadedCount++;
        logger.debug(`[Events] Loaded ${file}`);
      } else if (event.default?.notAnEvent) {
        // A helper module that lives in events/ but is started elsewhere (e.g. globalBanReportWatcher).
        logger.debug(`[Events] Skipped ${file} (not an event handler)`);
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
/**
 * Managers are attached to the client AFTER client.login() has already opened the gateway
 * (bot-manager.js logs in at step 5; this runs afterwards — for custom bots, after the
 * command deploys too). That leaves a window, seconds to tens of seconds wide, where Discord
 * is delivering interactions to a client whose managers are still undefined and whose role /
 * channel / member caches are empty.
 *
 * Handlers that reach for `client.someManager?.x()` or `guild.roles.cache.get(id)` in that
 * window silently do nothing, while their DB write succeeds and their success message goes
 * out anyway — the user is told an operation completed that never happened.
 *
 * `client.managersReady` closes that window: events/interactionCreate.js refuses work until
 * it is set. It is set in a `finally` on purpose — if one manager fails to construct we still
 * open for business, because the flag exists to guard the startup window, not to assert that
 * everything is perfect. A flag stuck false would refuse every interaction forever.
 */
async function initializeManagers(client) {
  // Idempotent: bot-manager calls this as step 8 for custom bots, and the startup path used to
  // call it again afterwards. Constructing every manager twice on one client means two of every
  // event listener — double XP, double logs, and the MaxListeners warnings that come with it.
  if (client.managersReady === true) {
    logger.debug(`[Core] Managers already initialized for ${client.user?.tag ?? 'client'} — skipping`);
    return;
  }
  try {
    // Once per process (the function guards itself): a job left 'running' by a restart is not
    // running, and reporting it as such makes somebody wait for something that will never move.
    await reconcileStaleJobs().catch(err =>
      logger.warn(`[Core] purge job reconcile failed: ${err.message}`));
    await attachManagers(client);
  } finally {
    client.managersReady = true;
  }
}

async function attachManagers(client) {
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

  // Guild embed themes. Held in memory because setColor() sits inside builder
  // chains with no await point — see core/guild-theme.js. Loading is idempotent
  // and cheap (82 guilds x 6 colours), so running it per bot is harmless; the
  // cache is module-level and shared across every client in the process.
  await loadThemes();
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

  client.buymeacoffeeManager = new BuyMeACoffeeManager(client);
  logger.info('[Core] Buy Me a Coffee manager initialized');

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

  // Word games — load dictionary, register engines, rehydrate active sessions (default bot only)
  try {
    const wordBank = await import('./core/word-bank.js');
    wordBank.load();
    await import('./core/games/last-letter-runtime.js'); // self-registers the 'last_letter' engine
    await import('./core/games/one-word-story-runtime.js'); // self-registers the 'one_word_story' engine
    await import('./core/games/coordle-runtime.js'); // self-registers the 'coordle' engine
    await import('./core/games/wordseek-runtime.js'); // self-registers the 'wordseek' engine
    if (client.isDefaultBot) {
      const { rehydrateWordGames } = await import('./core/word-game-manager.js');
      await rehydrateWordGames();
    }
    logger.info('[Core] Word games ready');
  } catch (err) {
    logger.error(`[Core] Word games init failed: ${err.message}`);
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

      // Every queue streams Spotify tracks through go-librespot — not just ones /music play made.
      // Panel, DJ, voice-camp and /music search queues used to be created without the hook, so
      // their Spotify tracks skipped the account entirely and went straight to YouTube.
      // One row per play in music_play_log (super-admin "Music activity" page) — core/music-play-log.js
      attachPlayLog(player);

      // Queue restore across restarts: snapshot each guild's queue into music_queues as it changes.
      try {
        const { attachQueuePersistence } = await import('./core/music-queue-persistence.js');
        attachQueuePersistence(player);
      } catch (error) {
        logger.error('[MusicRestore] Could not attach queue persistence:', error);
      }

      // What leaving voice has to tidy up, whether discord-player disconnected or core/music-leave-policy.js left.
      const afterMusicLeave = (guildId) => {
        client.musicPanelManager?.get(guildId)?.updatePanel();
        // Free any go-librespot (Spotify-direct) account this guild was holding.
        import('./core/spotify-connect-manager.js').then(m => m.releaseGuild(guildId)).catch(() => {});
      };
      // Every way a session ends deletes its queue (/music stop, the leave policy, the reader's idle leave,
      // discord-player when the bot is pulled out), so the tidy-up hangs off queueDelete. It is idempotent.
      player.events.on('queueDelete', (queue) => {
        cancelLeave(queue.guild.id);
        afterMusicLeave(queue.guild.id);
      });
      const leaveOpts = (reason, extra = {}) => ({ reason, player, ...extra });

      // Leaving is decided by core/music-leave-policy.js (owner's rules), not discord-player's timers.
      // The sweep catches whatever the events below miss (a transcription that outlived the music, a stalled DJ).
      setInterval(() => {
        sweepIdle(player).catch(err => logger.error(`[MusicLeave] Sweep failed: ${err.message}`));
      }, 60_000).unref();

      player.events.on('emptyChannel', (queue) => {
        // Fires EMPTY_IDLE_MS after the last listener left; playing to an empty room is fine, paused/idle is not.
        if (!isActivelyPlaying(queue)) {
          leaveIfIdle(queue, leaveOpts('nobody listening and nothing playing', { requireEmpty: true }))
            .catch(err => logger.error(`[MusicLeave] ${err.message}`));
        }
      });

      player.events.on('audioTrackAdd', (queue) => noteActivity(queue.guild.id));
      player.events.on('audioTracksAdd', (queue) => noteActivity(queue.guild.id));

      player.events.on('queueCreate', (queue) => {
        manageLeave(queue);
        noteActivity(queue.guild.id);
        // These JS DSP stages run per 20ms packet on the MAIN thread — the same thread that paces
        // voice packets for 41 bots. Nothing uses them (/music filter + /music eq are ffmpeg
        // filters, which run in ffmpeg's own process), so they only cost stutter. Volume stays on.
        Object.assign(queue.options, { disableBiquad: true, disableEqualizer: true, disableResampler: true, disableFilterer: true });
        import('./handlers/music/player.js')
          .then(({ spotifyConnectStream }) => { queue.onBeforeCreateStream = spotifyConnectStream; })
          .catch(e => logger.warn(`[Music] could not attach Spotify hook: ${e.message}`));
      });

      // Opus defaults to a speech-oriented mode. Tell the encoder this is MUSIC at 128 kbps.
      // (discord-player's own setBitrate() can't do it: it calls `applyEncoderCTL`, but mediaplex
      // names the method `applyEncoderCtl`, so it throws.)
      player.events.on('playerStart', (queue) => {
        try {
          const enc = queue.dispatcher?.audioResource?.encoder?.encoder;
          if (!enc?.applyEncoderCtl) return;
          enc.applyEncoderCtl(4024, 3002);   // OPUS_SET_SIGNAL = OPUS_SIGNAL_MUSIC
          enc.applyEncoderCtl(4008, 1105);   // OPUS_SET_BANDWIDTH = FULLBAND (20 kHz)
          enc.setBitrate(128000);
        } catch (e) { logger.debug(`[Music] encoder tuning skipped: ${e.message}`); }
      });

      // Choppy/robotic audio = the main thread missing its 20ms packet deadlines. Log how late the
      // event loop runs while anything is playing, so stutter reports can be matched to numbers.
      {
        const { monitorEventLoopDelay } = await import('perf_hooks');
        const loopDelay = monitorEventLoopDelay({ resolution: 10 });
        loopDelay.enable();
        setInterval(() => {
          const playing = [...player.nodes.cache.values()].filter(q => q.isPlaying()).length;
          if (playing > 0) {
            const ms = (ns) => (ns / 1e6).toFixed(1);
            logger.info(`[Music] event-loop delay while ${playing} queue(s) playing: p50=${ms(loopDelay.percentile(50))}ms p99=${ms(loopDelay.percentile(99))}ms max=${ms(loopDelay.max)}ms`);
          }
          loopDelay.reset();
        }, 30000).unref();
      }

      // discord-player decides "start playing" with isPlaying(), which is FALSE while the next
      // track is still loading (1-15s for Spotify/yt-dlp). A /music play or panel add in that
      // window started a second track over the top of the loading one — on Spotify both hit the
      // same account, so the first was cut off and skipped. While a load is in flight, a bare
      // play() (= "play next from the queue") is a no-op: the added track simply waits its turn.
      if (discordPlayerModule?.GuildQueuePlayerNode && !discordPlayerModule.GuildQueuePlayerNode.prototype.__certifriedGuard) {
        const proto = discordPlayerModule.GuildQueuePlayerNode.prototype;
        const originalPlay = proto.play;
        proto.play = async function (res, options) {
          if (!res && this.__loadingTrack) {
            this.queue.debug?.('[CertiFried] play() ignored — a track is already loading; it stays queued');
            return;
          }
          this.__loadingTrack = true;
          try { return await originalPlay.call(this, res, options); }
          finally { this.__loadingTrack = false; }
        };
        proto.__certifriedGuard = true;
      }
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

      // 4. SoundCloudExtractor — the final failsafe. Registered last so it is only reached
      // when a Spotify track cannot be streamed through go-librespot AND yt-dlp fails to
      // bridge it (YouTube bot-wall, geo-block, removed video).
      try {
        // DISABLED by owner's decision: as the last-resort extractor it turned failed Spotify/YouTube
        // tracks into SoundCloud covers/remixes. discord-player's bridge and fallback-search loops
        // walk EVERY registered extractor, so it must not be registered at all.
        if (process.env.MUSIC_ENABLE_SOUNDCLOUD === 'true') {
          const { SoundCloudExtractor } = await import('@discord-player/extractor');
          await player.extractors.register(SoundCloudExtractor, {});
          logger.info('[Music] SoundCloudExtractor registered (MUSIC_ENABLE_SOUNDCLOUD=true)');
        } else {
          logger.info('[Music] SoundCloudExtractor NOT registered (Spotify + YouTube only)');
        }
      } catch (error) {
        logger.warn('[Music] Could not register SoundCloudExtractor:', error.message);
      }

      // Resolve the NEXT track's YouTube audio URL while the current one plays, so the track change
      // doesn't wait 2-4s on a lookup. No-op for Spotify tracks (go-librespot starts in <0.5s).
      const prefetchNext = (queue) => {
        if (!queue.isPlaying()) return;
        const next = queue.tracks.at(0);
        if (next) import('./core/ytdlp-extractor.js').then(m => m.prefetchStream(next)).catch(() => {});
      };

      // Queue mutations — refresh the panel so queue size / "Up Next" stay accurate
      // when tracks are added while something is already playing. playerStart only
      // fires on the first track, not on subsequent enqueues.
      player.events.on('audioTrackAdd', (queue, track) => {
        logger.info(`[Music Debug] Track added: ${track.title}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
        prefetchNext(queue);
      });

      player.events.on('audioTracksAdd', (queue, tracks) => {
        logger.info(`[Music Debug] ${tracks?.length || 0} tracks added in batch`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
        prefetchNext(queue);
      });

      // Set up player event handlers
      player.events.on('playerStart', (queue, track) => {
        // Re-applied on every start: a queue the voice tools, camp or DJ created keeps its own options otherwise.
        manageLeave(queue);
        cancelLeave(queue.guild.id);
        noteActivity(queue.guild.id);
        logger.info(`[Music] Started playing: ${track.title} in guild ${queue.guild.id}`);
        logger.info(`[Music Debug] Track URL: ${track.url}`);
        logger.info(`[Music Debug] Track Source: ${track.source}`);
        logger.info(`[Music Debug] Track Duration: ${track.duration}`);
        logger.info(`[Music Debug] Queue node paused: ${queue.node.isPaused()}`);
        logger.info(`[Music Debug] Voice connection state: ${queue.connection?.state?.status || 'unknown'}`);
        logger.info(`[Music Debug] DJ Mode: ${queue.metadata?.djMode ? 'ENABLED' : 'DISABLED'}`);
        logger.info(`[Music Debug] DJ Voice: ${queue.metadata?.djVoice || 'not set'}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
        prefetchNext(queue);
        // AI DJ page "Announce each track": one line per song in the announcement channel (never throws).
        if (queue.metadata?.djMode) import('./core/dj-track-announcer.js').then(m => m.announceDjTrack(queue, track)).catch(() => {});
      });

      player.events.on('playerPause', (queue) => {
        logger.info(`[Music] Player paused in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
        // Paused with nobody in the channel isn't "playing": leave if that's still true in EMPTY_IDLE_MS.
        if (queue.channel && !queue.channel.members.some(m => !m.user.bot)) {
          scheduleLeave(queue, EMPTY_IDLE_MS, leaveOpts('paused with nobody listening', { requireEmpty: true }));
        }
      });

      player.events.on('playerResume', (queue) => {
        cancelLeave(queue.guild.id);
        noteActivity(queue.guild.id);
        logger.info(`[Music] Player resumed in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('playerSkip', (queue, track) => {
        logger.info(`[Music] Skipped track in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('disconnect', async (queue) => {
        logger.info(`[Music] Disconnected from voice in guild ${queue.guild.id}`);
        // discord-player deletes the queue before emitting this, so queueDelete already tidied up.

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
        // Must run before the first await: discord-player reads options.leaveOnEnd right after emitting this
        // event, and a toggle (/music 247) may have switched it back on mid-session.
        manageLeave(queue);
        noteActivity(queue.guild.id);
        logger.info(`[Music] Queue is empty in guild ${queue.guild.id}`);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel();
        // Free any go-librespot (Spotify-direct) account this guild was holding.
        import('./core/spotify-connect-manager.js').then(m => m.releaseGuild(queue.guild.id)).catch(() => {});

        // If DJ mode is enabled, the DJ manager handles this via its own queueEnd listener
        // Don't duplicate the call here to prevent race conditions
        if (queue.metadata?.djMode) {
          logger.info(`[DJ Mode] Queue empty - DJ manager will handle playlist generation via queueEnd event`);
          // The DJ ends its own session when it runs dry; this only catches one that stalls without saying so.
          scheduleLeave(queue, DJ_REFILL_GRACE_MS, leaveOpts('AI DJ did not continue'));
          return; // Don't also trigger autoplay
        }

        // Autoplay: Fetch and queue similar tracks when queue ends
        try {
          const { isAutoplayEnabled, getAutoplaySource, is247Enabled } = await import('./utils/music_helpers.js');
          const autoplayEnabled = await isAutoplayEnabled(queue.guild.id);

          // A VC sound drop / soundboard clip is not a song to find "similar tracks" for.
          const soundEffect = queue.metadata?.isVCSoundDrop || queue.metadata?.soundboard;
          if (autoplayEnabled && queue.history.previousTrack && !soundEffect) {
            logger.info(`[Autoplay] Queue empty, fetching similar tracks for guild ${queue.guild.id}`);
            const source = await getAutoplaySource(queue.guild.id);
            const previousTrack = queue.history.previousTrack;

            try {
              // Pick similar songs, resolve each to the REAL Spotify track, and queue those — the
              // queue's Spotify hook then plays them through the linked account (go-librespot).
              // The old path searched YouTube for "<title> <artist> similar", which with YouTube
              // walled fell through to SoundCloud and queued random covers.
              const playedTitles = new Set([previousTrack, ...(queue.history.tracks?.toArray?.() || [])]
                .map(t => String(t?.title || '').toLowerCase()));
              let candidates = [];
              if (source === 'ai') {
                const { generatePlaylistRecommendations } = await import('./utils/gemini-api.js');
                const recs = await generatePlaylistRecommendations(previousTrack.title, previousTrack.author, null, [], null).catch(() => []);
                candidates = (recs || []).map(r => ({ title: r.title, artist: r.artist }));
              }
              if (candidates.length === 0) {
                const { default: LastFMAPIService } = await import('./utils/services/lastfm-api.js');
                const similar = await new LastFMAPIService().getSimilarTracks(previousTrack.author, previousTrack.title, 25);
                // Shuffle the top 15 so autoplay doesn't loop the same three songs.
                candidates = similar.slice(0, 15).sort(() => Math.random() - 0.5);
                // Small/new artists often have no similar-TRACK data — use similar ARTISTS instead
                // (Spotify search by artist name returns their most popular track).
                if (candidates.length === 0) {
                  const artists = await new LastFMAPIService().getSimilarArtists(previousTrack.author, 10);
                  candidates = artists.sort(() => Math.random() - 0.5).map(a => ({ title: '', artist: a }));
                }
              }
              // "Spyro <3 PS2" is not a new song after "Spyro": skip anything whose normalized title
              // contains (or is contained in) something already played.
              const norm = (t) => String(t || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
              const playedNorm = [...playedTitles].map(norm).filter(Boolean);
              const isRepeat = (title) => { const n = norm(title); return !!n && playedNorm.some(p => n.includes(p) || p.includes(n)); };

              const { searchSpotifyTrack } = await import('./core/spotify-resolver.js');
              const newTracks = [];
              for (const c of candidates) {
                if (newTracks.length >= 3) break;
                if (c.title && isRepeat(c.title)) continue;
                const hit = await searchSpotifyTrack(`${c.title} ${c.artist}`.trim());
                if (!hit?.url) continue;
                const r = await player.search(hit.url, { requestedBy: client.user }).catch(() => null);
                const t = r?.tracks?.[0];
                if (t && !isRepeat(t.title)) {
                  newTracks.push(t);
                  playedNorm.push(norm(t.title));
                }
              }

              // Last resort (no Last.fm/Spotify match): the old free-text search.
              if (newTracks.length === 0) {
                const searchQuery = `${previousTrack.title} ${previousTrack.author || ''} similar`.trim();
                logger.info(`[Autoplay] No Spotify matches — falling back to search: ${searchQuery}`);
                const result = await player.search(searchQuery, {
                  requestedBy: client.user,
                  searchEngine: 'ext:com.certifried.ytdlp-universal'
                });
                newTracks.push(...result.tracks.filter(t =>
                  t.url !== previousTrack.url && !isRepeat(t.title)
                ).slice(0, 3));
              }

              if (newTracks.length > 0) {
                for (const track of newTracks) {
                  queue.addTrack(track);
                }
                logger.info(`[Autoplay] Added ${newTracks.length} similar tracks to queue: ${newTracks.map(t => `${t.author} - ${t.title}`).join(' | ')}`);

                // Start playing if not already
                if (!queue.isPlaying()) {
                  await queue.node.play();
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
        // Autoplay has had its go. Nothing playing now → leave (24/7, camp and voice tools keep the bot in).
        // Sound drops keep the delay they were created with (VC sounds' admin-set leave_after_seconds).
        const fx = queue.metadata?.isVCSoundDrop || queue.metadata?.soundboard;
        scheduleLeave(queue, fx ? (queue.options.leaveOnEndCooldown ?? QUEUE_END_GRACE_MS) : QUEUE_END_GRACE_MS,
          leaveOpts(fx ? 'sound drop finished' : 'queue ended'));
      });

      player.events.on('error', (queue, error) => {
        logger.error(`[Music] Player error in guild ${queue.guild.id}:`, { error: error.message });
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('playerError', async (queue, error, failedTrack) => {
        logger.error(`[Music] Track error in guild ${queue.guild.id}: ${error.message}`, {
          errorMessage: error.message,
          errorCode: error.code,
          track: queue.currentTrack?.title || 'none',
          url: queue.currentTrack?.url || 'none',
          voiceStatus: queue.connection?.state?.status || 'unknown'
        });

        // If voice connection aborted, destroy queue — skipping won't help
        if (error.code === 'ABORT_ERR' || error.message?.includes('operation was aborted')) {
          const gid = queue.guild.id;
          logger.warn(`[Music] Voice connection aborted in guild ${gid} — destroying queue`);
          try {
            queue.delete();
          } catch (e) {
            logger.error(`[Music] Could not delete queue:`, { error: e.message });
          }
          client.musicPanelManager?.get(gid)?.updatePanel();
          // A failed track must NOT leave a 24/7 bot out of voice — rejoin the camp
          // (no-op if this guild isn't camped).
          import('./core/voice-camp-manager.js').then(({ rejoinCamp, CAMP_REJOIN_DELAY_MS }) =>
            setTimeout(() => rejoinCamp(client, player, gid).catch(() => {}), CAMP_REJOIN_DELAY_MS || 3000)
          ).catch(() => {});
          return;
        }

        // Send user-friendly error message (only for non-DJ guilds; DJManager handles its own)
        if (!queue.metadata?.djMode) {
          try {
            // queue.guild belongs to the bot that owns this queue; the MAIN client's cache
            // has no channels for custom-bot guilds.
            const channel = queue.guild.channels.cache.get(queue.metadata?.channelId);
            if (channel?.isTextBased()) {
              const reason = getPlayerErrorReason(error.message);
              channel.send(`\u23ED\uFE0F | Skipped unavailable track: ${reason}`).catch(() => {});
            }
          } catch (msgErr) {
            logger.warn(`[Music] Failed to send error message to channel: ${msgErr.message}`);
          }
        }

        // Auto-recovery: wait 3s then skip to next track (prevents YouTube rate-limit cascade)
        logger.warn(`[Music] Waiting 3s before auto-recovery skip (rate-limit protection)...`);
        await new Promise(r => setTimeout(r, 3000));
        // discord-player already advances past a track whose stream failed (and a mid-play
        // FFmpeg error ends the stream, which advances too). Only intervene if the failed
        // track is STILL current — otherwise we'd skip the healthy next song, or stop it.
        if (failedTrack && queue.currentTrack?.id !== failedTrack.id) {
          logger.info(`[Music] Auto-recovery: player already moved past the failed track`);
          client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
          return;
        }
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
          const gid = queue.guild.id;
          try {
            queue.delete();
            logger.warn(`[Music] Deleted queue as last resort recovery`);
          } catch (deleteError) {
            logger.error(`[Music] Could not delete queue:`, { error: deleteError.message });
          }
          // Same guard: don't strand a camped bot outside its 24/7 channel.
          import('./core/voice-camp-manager.js').then(({ rejoinCamp, CAMP_REJOIN_DELAY_MS }) =>
            setTimeout(() => rejoinCamp(client, player, gid).catch(() => {}), CAMP_REJOIN_DELAY_MS || 3000)
          ).catch(() => {});
        }

        // Update the music panel to reflect the new state
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel(queue);
      });

      player.events.on('debug', (queue, message) => {
        logger.info(`[Music Debug] ${message}`);
      });

      // Initialize music managers
      logger.info('[Music] Music status manager initialized');

      // Global too: custom-bot clients share the one player, so their handlers reach it via global.djManager.
      client.djManager = global.djManager = new DJManager(client);
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
            // Always register the panel. Custom-bot guilds aren't visible to the MAIN client (and
            // custom bots may not be ready yet), so a missing message is recovered from the DB by
            // updatePanel() on the first player event — via the guild's owning client.
            const panel = new MusicPanel(client, panelData.guild_id);
            client.musicPanelManager.set(panelData.guild_id, panel);
            const channel = await client.channels.fetch(panelData.channel_id).catch(() => null);
            panel.message = channel ? await channel.messages.fetch(panelData.message_id).catch(() => null) : null;
            if (panel.message) {
              logger.info(`[Music] Loaded music panel for guild ${panelData.guild_id}`);
            } else {
              logger.debug(`[Music] Panel for guild ${panelData.guild_id} not reachable from main client yet (recovers on first update)`);
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

      // Queue restore: bring back queues a deploy/crash interrupted (custom-bot guilds as their bots
      // come online; rows older than 30 min are discarded).
      try {
        const { startMusicQueueRestore } = await import('./core/music-queue-persistence.js');
        await startMusicQueueRestore({ player, client });
      } catch (error) {
        logger.error('[MusicRestore] Could not start the queue restore:', error);
      }

      // Leftover headless-Chrome profiles filled the root disk on 2026-09-17 and took MariaDB down
      // with it. Sweep the ones no running browser is using.
      try {
        const { startChromeProfileJanitor } = await import('./utils/chrome-profile-janitor.js');
        startChromeProfileJanitor();
      } catch (error) {
        logger.error('[ChromeJanitor] Could not start:', error);
      }

      // Voice transcription: load opt-outs, close sessions a restart orphaned, start the
      // transcript retention sweep. Once per process — sessions live in one shared map.
      try {
        const { initTranscription } = await import('./core/voice-transcription-manager.js');
        await initTranscription();
      } catch (error) {
        logger.error('[Transcribe] Error initialising transcription:', error);
      }

      // Voice recording: deliver recordings a restart interrupted, restore the "🔴 REC" nickname,
      // sweep undelivered files older than 7 days.
      try {
        const { initVoiceRecorder } = await import('./core/voice-recorder.js');
        initVoiceRecorder({ client });
      } catch (error) {
        logger.error('[Recorder] Could not initialise voice recording:', error);
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
  startKofiExpiry(client);
  startCritters(client).catch(err => logger.warn('[Core] Critters startup failed', { error: err.message }));
  startGrowTreeReaper();
  startVaultCleanup();
  logger.info('[Core] Stream check scheduler initialized');

  // Cat Bot: re-arm per-channel spawn timers and revive any that came due while we
  // were down. Safe to call once with the default client — it resolves the owning
  // bot per guild via botManager.
  import('./core/catbot/spawn-manager.js')
    .then(({ startSpawnEngine }) => startSpawnEngine())
    .catch(err => logger.error(`[CatBot] engine start failed: ${err.message}`));

  // Index every slash command so `!play`, `?ban`, `@bot play …` reach them. Built
  // eagerly here so the first user doesn't pay for it; shared across custom bots.
  import('./core/universal-commands.js')
    .then(({ buildIndex }) => buildIndex(client))
    .catch(err => logger.error(`[UniversalCmd] index failed: ${err.message}`));

  // Cinema panel reaper: edit a dangling control panel to "ended" when a movie
  // finishes unattended (state cleared by the cinema service, no Stop pressed).
  (await import('./jobs/cinema-panel-reaper.js')).startCinemaPanelReaper(client);
  logger.info('[Core] Cinema panel reaper initialized');

  // Retry blocked command deployments every 5 min. Without this, a bot whose
  // boot deploy timed out stays without commands until next PM2 restart, even
  // after Discord's rate-limit hold clears.
  setInterval(() => botManager.retryBlockedDeployments(), 5 * 60 * 1000);
  setTimeout(() => botManager.retryBlockedDeployments(), 30 * 1000); // also try 30s after boot
  logger.info('[Core] Blocked-deployment retry scheduler initialized (5 min interval)');

  // Per-server top-level shortcuts (/confess for /fun confess …), checked every 5 min.
  (await import('./core/guild-shortcuts.js')).startGuildShortcuts(botManager);
  logger.info('[Core] Guild shortcut commands initialized (5 min interval)');

  startTwitchScheduleScheduler(client);
  logger.info('[Core] Twitch schedule scheduler initialized');

  startFreeGamesScheduler(client);
  logger.info('[Core] Free games scheduler initialized');

  startSteamWatchScheduler(client);
  logger.info('[Core] Steam Watch scheduler initialized');

  startBuyMeACoffeeScheduler(client);
  logger.info('[Core] Buy Me a Coffee scheduler initialized');

  startQOTDScheduler(client);
  startHolidayDayAnnouncer(client);
  logger.info('[Core] Holiday day announcer initialized');
  logger.info('[Core] QOTD scheduler initialized');

  startFishingTournamentScheduler(client);
  logger.info('[Core] Fishing tournament scheduler initialized');
  // Emoji hunts, bracket tournaments, community goals, loyalty points (persisted state; resolves each guild's bot itself)
  startBgamesScheduler(client);

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
  startTwitchClipChecker(client);
  startFortniteFeedChecker(client);
  startEventScheduleChecker(client);
  startEventReminderScheduler(client); // Discord event reminders, start posts, recurring events (once per process)
  startStatRoleScheduler(client);      // stat roles sweep, every 15 min
  startPvpTimeoutSweeper();
  startLfgExpiry();                    // close LFG posts past their auto-close time, every 5 min
  logger.info('[Core] TikTok video checker initialized');

  // Social feeds (Reddit/YouTube/Bluesky/Twitter) are handled by the social-feed-scheduler

  // Start community support monthly rotation
  startCommunityRotation(client);
  logger.info('[Core] Community support rotation scheduler initialized');

  // Start leveling monthly-reset scheduler (opt-in per guild via level_config.monthly_reset_enabled)
  startMonthlyResetScheduler(client);
  logger.info('[Core] Leveling monthly-reset scheduler initialized');

  // Start unverified-reaper (opt-in per guild via verify_config.unverified_kick_days > 0)
  startUnverifiedReaper(client);
  logger.info('[Core] Unverified reaper scheduler initialized');

  // Apply-to-join guilds — logs who approved/rejected each application (not in the audit log).
  startJoinRequestSync();
  startHealthDigest();
  startSteamLibrarySync();

  // Temporary guest access — closes out trials whose deadline has passed.
  // Opt-in per guild via temp_access_config; only ever touches members with a
  // trial row, never the guild at large.
  startTempAccessReaper();
  // Resume 'give autoroles to existing members' runs a restart interrupted (core/autoroles.js).
  setTimeout(() => { import('./core/autoroles.js').then((m) => m.resumeBackfills()).catch((e) => logger.warn(`[Core] autorole resume failed: ${e.message}`)); }, 120000);
  logger.info('[Core] Temporary-access reaper scheduler initialized');

  // Heists resolve when their join window closes (resuming half-settled ones after a restart); trade offers expire after 24h.
  startEconomyEventsScheduler();
  logger.info('[Core] Economy events scheduler initialized');

  // Temporary bans / temporary roles expire here (every minute, restart-safe — due rows are read
  // from timed_moderation / temp_roles), plus hourly sticky-role expiry, modmail channel cleanup
  // and stale lock records.
  startTimedModerationJob();
  logger.info('[Core] Timed moderation job initialized');

  // Reconciles streamer subscriptions against live guild membership, and retires the ones whose
  // member has been gone 30 days. The gateway events cover departures that happen while we're up;
  // this is what catches the ones that happen while we're not.
  startStreamerDepartureSweeper();
  logger.info('[Core] Streamer departure sweeper initialized');

  // Camped bots fall out of voice silently — no 'disconnect' event, no error. This is the only
  // thing that notices; without it camp stays broken until the next process restart.
  startVoiceCampReconciler(global.player);

  // Start affiliate status re-check scheduler
  startAffiliateRecheckScheduler();
  // Keeps tracked Twitch usernames in step with renames, resolving by the stable numeric id.
  startTwitchIdentitySync();
  logger.info('[Core] Affiliate re-check scheduler initialized');

  // Start Kick token-refresh scheduler (keeps defender OAuth tokens alive)
  startKickTokenRefreshScheduler();
  logger.info('[Core] Kick token-refresh scheduler initialized');

  // Start Kick timer scheduler (posts scheduled chat messages)
  startKickTimerScheduler();
  logger.info('[Core] Kick timer scheduler initialized');
  startOrientationRefreshWatcher(); // owner-triggered bulk guide refresh (data/requests/orientation-refresh-all.request)

  // Hourly validation of every stored Twitch user token, as Twitch asks (H-751; core/twitch-token-validator.js).
  import('./core/twitch-token-validator.js')
    .then((m) => m.startTwitchTokenValidation())
    .catch((err) => logger.warn('[Core] Twitch token validation did not start', { error: err.message }));

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

  // Self-updating 4:20 world clock panels (/cannabis clock post)
  startFourTwentyPanelScheduler(client);

  // Smoke circle turn timeouts and the toke leaderboard channel (Cannabis Community page)
  startCannabisScheduler(client);

  // Start game-news / patch-note watcher scheduler
  // (rss, steam-news, twitter-rss, cod-blog, fortnite-news — see core/game-news-presets.js)
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

  // Content-aware per-message purge rules (channel_purge_rules)
  startPurgeRuleSweeper(client);
  logger.info('[Core] Purge rule sweeper initialized');

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
  startWeeklyRecapScheduler();
  startTwitchAnalyticsAggregator();
  logger.info('[Core] Throne notification scheduler initialized');

  // Start phishing list updater (syncs domain lists every 4 hours)
  startPhishingListUpdater(client);
  logger.info('[Core] Phishing list updater initialized');

  // Start global ban aggregator (processes auto-aggregation every 15 minutes)
  startGlobalBanAggregator(client);
  logger.info('[Core] Global ban aggregator initialized');

  // Start cleanup scheduler (runs daily at 4 AM)
  cleanupScheduler.start();
  // Enforces data_retention_policy nightly. Batched and capped per table so it
  // cannot lock a large table against the 41 live bots sharing this database.
  startRetentionSweeper();
  // command_usage -> command_usage_daily (nightly 00:15 + today hourly), jobs/command-usage-rollup.js.
  startCommandUsageRollup();
  logger.info('[Core] Cleanup scheduler initialized');

  // Start Fourthwall orphan webhook cleanup + seen-events pruning
  startFourthwallCleanup();
  logger.info('[Core] Fourthwall cleanup scheduler initialized');

  // Start Fourthwall public shop tracker (scrapes subscribed shops every 10 min)
  startFourthwallTracker();
  logger.info('[Core] Fourthwall shop tracker initialized');

  // Weather alerts: DMs members whose saved location an NWS alert covers, for servers with alerts on.
  // Off until 2026-11-18 because the old sender spammed every alert nationwide; see core/weather-manager.js.
  client.weatherManager.start(180).catch(e => logger.error(`[WeatherManager] start failed: ${e.message}`));

  // Start dashboard
  try {
    const dashboard = await import('./dashboard/server.js');
    dashboard.default.start(client);
    logger.info('[Core] Dashboard started successfully');
  } catch (error) {
    logger.error('[Core] Failed to start dashboard', { error: error.message });
  }

  // Twitch EventSub — push "went live" notifications (instant announcements). Reconcile our
  // subscription set against the tracker list shortly after boot (the dashboard callback must be
  // publicly reachable first — creating a subscription makes Twitch immediately POST a verification
  // challenge to it), then keep it in sync on a slow timer. The minute poll cron stays on as the
  // fallback/reconciler for anything a webhook misses.
  try {
    const { reconcile, isConfigured, ensureConduit } = await import('./core/twitch-eventsub-manager.js');
    if (isConfigured()) {
      // Ensure the conduit exists + shard 0 is registered BEFORE the first reconcile uses it to
      // create new conduit-transport subs. Non-blocking: errors logged, startup proceeds.
      setTimeout(() => {
        ensureConduit()
          .then(id => logger.info(`[Core] Twitch EventSub conduit ready: ${id}`))
          .catch(err => logger.warn('[Core] Twitch EventSub conduit init failed, falling back to webhook', { error: err.message }));
      }, 15_000).unref();
      setTimeout(() => {
        reconcile().catch(err => logger.error('[Core] Initial Twitch EventSub reconcile failed', { error: err.message }));
      }, 25_000).unref();
      const everyThirtyMin = setInterval(() => {
        reconcile().catch(err => logger.error('[Core] Periodic Twitch EventSub reconcile failed', { error: err.message }));
      }, 30 * 60 * 1000);
      everyThirtyMin.unref();
      logger.info('[Core] Twitch EventSub scheduled (initial reconcile in 25s, then every 30min)');
    } else {
      logger.warn('[Core] Twitch EventSub not configured (missing TWITCH_EVENTSUB_SECRET or non-https DASHBOARD_URL) — staying on poll-only');
    }
  } catch (error) {
    logger.error('[Core] Failed to initialize Twitch EventSub', { error: error.message, stack: error.stack });
  }

  // Stream live-post editor — refreshes active go-live embeds every 5 minutes with
  // current viewer count + uptime (P2.4 — Sapphire parity).
  try {
    const { startStreamLiveEditor } = await import('./jobs/stream-live-editor.js');
    startStreamLiveEditor();
  } catch (err) {
    logger.warn('[Core] Failed to start stream live editor', { err: err.message });
  }

  // Daily DM-disable renewer — re-sets incident-actions dmsDisabledUntil for guilds that opted in.
  try {
    const { startDMDisableRenewer } = await import('./jobs/dm-disable-renewer.js');
    startDMDisableRenewer();
  } catch (err) {
    logger.warn('[Core] Failed to start DM-disable renewer', { err: err.message });
  }

  // Daily refresher for Linked Role metadata — walks user_linked_role_tokens.
  try {
    const { startLinkedRolesRefresher } = await import('./jobs/linked-roles-refresh.js');
    startLinkedRolesRefresher();
  } catch (err) {
    logger.warn('[Core] Failed to start Linked Roles refresher', { err: err.message });
  }

  // Register Discord Linked Roles metadata schema. Idempotent — PUT replaces the whole schema.
  // Doesn't block startup; errors are logged.
  try {
    const { registerSchema } = await import('./core/discord-linked-roles.js');
    registerSchema()
      .then(result => { if (result) logger.info('[Core] Discord Linked Roles schema registered'); })
      .catch(err => logger.warn('[Core] Discord Linked Roles schema register failed', { err: err.message }));
  } catch (error) {
    logger.warn('[Core] Failed to import Discord Linked Roles', { error: error.message });
  }

  // Preload application-scope emoji (CertiFried-branded palette; used across
  // embeds + Components V2 so every bot message gets the same icons). Also
  // non-blocking — the mention() helper falls back to the raw name when the
  // cache isn't populated yet.
  //
  // The load needs `client.application` populated, which only happens after
  // `clientReady`. If the default client is already ready at this point we
  // load immediately; otherwise we attach a one-shot listener.
  try {
    const appEmojis = await import('./core/application-emojis.js');
    const defaultClient = global.botManager?.getDefaultClient?.();
    const kickoff = (c) => appEmojis.loadAll(c)
      .catch(err => logger.warn('[Core] Application emoji preload failed', { err: err.message }));
    if (defaultClient?.application) {
      kickoff(defaultClient);
    } else if (defaultClient) {
      defaultClient.once('clientReady', () => kickoff(defaultClient));
    }
  } catch (error) {
    logger.warn('[Core] Failed to import application-emojis', { error: error.message });
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

  // Start CertiFried Extension Game Server (port 4020). Not once Greenhouse Tycoon is live (GREENHOUSE_LIVE=1,
  // docs/greenhouse-cutover.md): then neither the old game server nor any of its jobs start.
  try {
    const { isGreenhouseLive } = await import('./services/cfx/integrations/cutover.js');
    if (isGreenhouseLive()) {
      logger.info('[Core] Greenhouse Tycoon is live (GREENHOUSE_LIVE=1): the old game server (port 4020) and its jobs are not started');
    } else {
      const { certiFriedExtension } = await import('./services/certifried-extension/index.js');
      await certiFriedExtension.start();
      global.certiFriedExtension = certiFriedExtension;
      logger.info('[Core] CertiFried Extension game server started on port 4020');
    }
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
    // So every addCustomBot() path attaches managers — including the dashboard's runtime
    // "add bot" routes, which previously left a new bot with none until the next restart.
    botManager.setManagerInitializer(initializeManagers);

    // Initialize default bot
    logger.info('[BotManager] Initializing default bot...');
    const client = await botManager.initializeDefaultBot(process.env.DISCORD_TOKEN);

    // Music quizzes interrupted by a restart would otherwise stay 'active' and block their channel
    closeStaleMusicQuizSessions()
      .catch(err => logger.warn('[Startup] Music quiz stale-session sweep failed', { error: err.message }));

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
    // The dashboard stops treating a missing guild as "still starting" 30 s after this.
    botManager.markStartupComplete();

    // Record servers we were removed from while offline. Delayed so every client has its
    // guild cache, and only after ALL bots have had their login attempt.
    setTimeout(() => {
      reconcileGuildPresence(botManager)
        .catch(err => logger.error('[GuildPresence] reconcile failed', { error: err.message }));
    }, 60_000);

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
    // Music first, while voice is still up: final queue snapshots for the restore (and the client
    // teardown below can no longer delete those rows); close recordings (delivered on next boot).
    try {
      const { freezeQueuePersistence } = await import('./core/music-queue-persistence.js');
      await freezeQueuePersistence(4000);
    } catch (e) { logger.warn(`[MusicRestore] Final queue snapshot failed: ${e.message}`); }
    try {
      const { shutdownRecordings } = await import('./core/voice-recorder.js');
      await shutdownRecordings(4000);
    } catch (e) { logger.warn(`[Recorder] Closing recordings on shutdown failed: ${e.message}`); }

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
    stopCritters();
    logger.info('[Scheduler] Stream check scheduler stopped');

    stopAnnouncementUpdater();
    logger.info('[Scheduler] Announcement updater stopped');

    stopTeamSyncScheduler();
    logger.info('[Scheduler] Team sync scheduler stopped');

    stopTempAccessReaper();
    logger.info('[Scheduler] Temporary-access reaper stopped');
    stopEconomyEventsScheduler();
    logger.info('[Scheduler] Economy events scheduler stopped');
    stopTimedModerationJob();
    logger.info('[Scheduler] Timed moderation job stopped');

    stopStreamerDepartureSweeper();
    logger.info('[Scheduler] Streamer departure sweeper stopped');

    stopVoiceCampReconciler();
    logger.info('[Scheduler] Voice camp reconciler stopped');

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
    stopEventScheduleChecker();
    stopEventReminderScheduler();
    stopStatRoleScheduler();
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
    stopFourTwentyPanelScheduler();
    stopCannabisScheduler();
    logger.info('[Scheduler] Stat display scheduler stopped');

    // Stop purge scheduler
    stopPurgeScheduler();
    stopPurgeRuleSweeper();

    // Stop cleanup scheduler
    cleanupScheduler.stop();
    stopRetentionSweeper();
    stopCommandUsageRollup();
    // Write any command uses still buffered (core/command-usage.js); never rejects.
    await flushCommandUsage();
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
    stopHolidayDayAnnouncer();
    logger.info('[Scheduler] QOTD scheduler stopped');

    // Stop fishing tournament scheduler
    stopFishingTournamentScheduler();
    logger.info('[Scheduler] Fishing tournament scheduler stopped');
    stopBgamesScheduler();

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
