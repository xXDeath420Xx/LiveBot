import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import PokerMemeGenerator from '../core/poker-meme-generator.js';

let scheduledTask = null;
const generators = new Map(); // Map of botId -> generator

// Configuration for poker meme postings
// Guild ID -> { channelId, enabled }
const POKER_MEME_CONFIG = new Map([
  // Flying Sharks - Daily at 10am EST in channel 1307522084406038601
  ['1307517872301670480', {
    channelId: '1307522084406038601',
    enabled: true
  }]
]);

/**
 * Start the poker meme scheduler
 * Posts generated poker memes daily at 10am EST
 * @param {Client} client - Discord client instance (default bot)
 */
export function startPokerMemeScheduler(client) {
  // Initialize generator for default bot
  if (!generators.has('default')) {
    generators.set('default', new PokerMemeGenerator(client));
  }

  // Initialize generators for all custom bots
  if (global.botManager?.clients) {
    for (const [botId, botClient] of global.botManager.clients.entries()) {
      if (botId === 'default') continue;
      if (!generators.has(botId)) {
        generators.set(botId, new PokerMemeGenerator(botClient));
        logger.info(`[PokerMemeScheduler] Added generator for custom bot ${botId}`);
      }
    }
  }

  // Only create the cron task once
  if (scheduledTask) {
    logger.info(`[PokerMemeScheduler] Scheduler already running, managing ${generators.size} bot(s)`);
    return;
  }

  // Schedule for 10:00 AM EST (15:00 UTC during EST, 14:00 UTC during EDT)
  // Using America/New_York timezone to handle DST automatically
  scheduledTask = cron.schedule('0 10 * * *', async () => {
    logger.info('[PokerMemeScheduler] Running daily poker meme posting');
    await postPokerMemes();
    logger.info('[PokerMemeScheduler] Completed daily poker meme posting');
  }, {
    timezone: 'America/New_York'
  });

  logger.info('[PokerMemeScheduler] Scheduler started (runs daily at 10:00 AM EST)');
  scheduledTask.start();
}

/**
 * Post poker memes to all configured guilds
 */
async function postPokerMemes() {
  for (const [guildId, config] of POKER_MEME_CONFIG.entries()) {
    if (!config.enabled) continue;

    try {
      // Find which bot manages this guild
      let generator = null;
      let managingBotId = null;

      if (global.botManager) {
        managingBotId = global.botManager.guildBotMapping.get(guildId);
      }

      if (managingBotId && generators.has(managingBotId)) {
        generator = generators.get(managingBotId);
      } else {
        // Fall back to default bot
        generator = generators.get('default');
      }

      if (!generator) {
        logger.warn(`[PokerMemeScheduler] No generator available for guild ${guildId}`);
        continue;
      }

      const success = await generator.postPokerMeme(guildId, config.channelId);

      if (success) {
        logger.info(`[PokerMemeScheduler] Posted poker meme to guild ${guildId}`);
      } else {
        logger.warn(`[PokerMemeScheduler] Failed to post poker meme to guild ${guildId}`);
      }

    } catch (error) {
      logger.error(`[PokerMemeScheduler] Error posting to guild ${guildId}`, {
        error: error.message,
        stack: error.stack
      });
    }
  }
}

/**
 * Stop the poker meme scheduler
 */
export function stopPokerMemeScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[PokerMemeScheduler] Scheduler stopped');
  }
}

/**
 * Manually trigger a poker meme post (for testing)
 */
export async function triggerPokerMeme(guildId, channelId) {
  let generator = generators.get('default');

  if (global.botManager) {
    const managingBotId = global.botManager.guildBotMapping.get(guildId);
    if (managingBotId && generators.has(managingBotId)) {
      generator = generators.get(managingBotId);
    }
  }

  if (!generator) {
    logger.error('[PokerMemeScheduler] No generator available');
    return false;
  }

  return await generator.postPokerMeme(guildId, channelId);
}

/**
 * Get generator instance for a specific bot
 */
export function getPokerMemeGenerator(botId = 'default') {
  return generators.get(botId);
}

/**
 * Add a guild to the poker meme schedule
 */
export function addGuildToSchedule(guildId, channelId, enabled = true) {
  POKER_MEME_CONFIG.set(guildId, { channelId, enabled });
  logger.info(`[PokerMemeScheduler] Added guild ${guildId} to schedule, channel ${channelId}`);
}

/**
 * Remove a guild from the poker meme schedule
 */
export function removeGuildFromSchedule(guildId) {
  POKER_MEME_CONFIG.delete(guildId);
  logger.info(`[PokerMemeScheduler] Removed guild ${guildId} from schedule`);
}
