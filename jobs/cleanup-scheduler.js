/**
 * Cleanup Scheduler
 * Periodically cleans up stale data from the database
 * Runs daily at 4 AM to minimize impact on users
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

class CleanupScheduler {
  constructor() {
    this.isRunning = false;
    this.timeout = null;
    this.interval = null;
    this.lastRun = null;
    this.stats = {
      totalCleaned: 0,
      lastRunDuration: 0,
      errors: 0
    };
  }

  /**
   * Start the cleanup scheduler
   */
  start() {
    if (this.isRunning) {
      logger.warn('[CleanupScheduler] Already running');
      return;
    }

    // Calculate time until 4 AM
    const now = new Date();
    const next4AM = new Date(now);
    next4AM.setHours(4, 0, 0, 0);

    // If it's already past 4 AM today, schedule for tomorrow
    if (now >= next4AM) {
      next4AM.setDate(next4AM.getDate() + 1);
    }

    const msUntil4AM = next4AM.getTime() - now.getTime();

    logger.info(`[CleanupScheduler] Scheduling first cleanup in ${Math.round(msUntil4AM / 1000 / 60)} minutes`);

    // Schedule first run
    this.timeout = setTimeout(() => {
      this.runCleanup();

      // Then run daily
      this.interval = setInterval(() => this.runCleanup(), 24 * 60 * 60 * 1000);
    }, msUntil4AM);

    this.isRunning = true;
  }

  /**
   * Run all cleanup tasks
   */
  async runCleanup() {
    const startTime = Date.now();
    logger.info('[CleanupScheduler] Starting scheduled cleanup');

    let totalCleaned = 0;

    try {
      // Clean up old AFK statuses (older than 7 days)
      totalCleaned += await this.cleanupTable(
        'afk_statuses',
        'timestamp < DATE_SUB(NOW(), INTERVAL 7 DAY)',
        'AFK statuses'
      );

      // Clean up old infractions (older than 1 year, only warnings)
      totalCleaned += await this.cleanupTable(
        'infractions',
        "created_at < DATE_SUB(NOW(), INTERVAL 1 YEAR) AND type = 'warn'",
        'old warnings'
      );

      // Clean up expired giveaways (ended more than 30 days ago)
      totalCleaned += await this.cleanupTable(
        'giveaways',
        'ends_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND is_active = 0',
        'expired giveaways'
      );

      // Clean up old message activity (older than 90 days)
      totalCleaned += await this.cleanupTable(
        'message_activity',
        'date < DATE_SUB(NOW(), INTERVAL 90 DAY)',
        'old message activity'
      );

      // Clean up old voice activity (older than 90 days)
      totalCleaned += await this.cleanupTable(
        'voice_activity',
        'date < DATE_SUB(NOW(), INTERVAL 90 DAY)',
        'old voice activity'
      );

      // Clean up orphaned live announcements (older than 24 hours)
      totalCleaned += await this.cleanupTable(
        'live_announcements',
        'created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)',
        'orphaned live announcements'
      );

      // Clean up old auto-meme history (keep last 500 per guild)
      totalCleaned += await this.cleanupMemeHistory();

      // Clean up old music statistics (older than 30 days)
      totalCleaned += await this.cleanupTable(
        'music_statistics',
        'played_at < DATE_SUB(NOW(), INTERVAL 30 DAY)',
        'old music statistics'
      );

      // Clean up completed trades older than 90 days
      totalCleaned += await this.cleanupTable(
        'trade_escrow',
        "status = 'completed' AND updated_at < DATE_SUB(NOW(), INTERVAL 90 DAY)",
        'old completed trades'
      );

      // Clean up old command usage logs (older than 30 days)
      totalCleaned += await this.cleanupTable(
        'command_usage',
        'used_at < DATE_SUB(NOW(), INTERVAL 30 DAY)',
        'old command usage logs'
      );

      // Clean up old message logs (older than 30 days)
      totalCleaned += await this.cleanupTable(
        'message_logs',
        'created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)',
        'old message logs'
      );

      // Optimize tables that had significant deletions
      await this.optimizeTables();

    } catch (error) {
      logger.error('[CleanupScheduler] Cleanup error', { error: error.message });
      this.stats.errors++;
    }

    const duration = Date.now() - startTime;
    this.stats.totalCleaned += totalCleaned;
    this.stats.lastRunDuration = duration;
    this.lastRun = new Date();

    logger.info(`[CleanupScheduler] Cleanup completed`, {
      totalCleaned,
      duration: `${duration}ms`
    });
  }

  /**
   * Clean up a specific table
   * @private
   */
  async cleanupTable(table, condition, description) {
    try {
      const [result] = await pool.execute(
        `DELETE FROM ${table} WHERE ${condition} LIMIT 10000`
      );

      if (result.affectedRows > 0) {
        logger.info(`[CleanupScheduler] Cleaned ${result.affectedRows} ${description}`);
      }

      return result.affectedRows;
    } catch (error) {
      // Table might not exist - that's okay
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return 0;
      }
      logger.error(`[CleanupScheduler] Failed to clean ${description}`, { error: error.message });
      return 0;
    }
  }

  /**
   * Clean up old meme history, keeping only recent entries per guild
   * @private
   */
  async cleanupMemeHistory() {
    try {
      // Delete entries older than 30 days
      const [result] = await pool.execute(
        `DELETE FROM auto_meme_history WHERE posted_at < DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 5000`
      );

      if (result.affectedRows > 0) {
        logger.info(`[CleanupScheduler] Cleaned ${result.affectedRows} old meme history entries`);
      }

      return result.affectedRows;
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return 0;
      }
      logger.error('[CleanupScheduler] Failed to clean meme history', { error: error.message });
      return 0;
    }
  }

  /**
   * Optimize tables after cleanup
   * @private
   */
  async optimizeTables() {
    const tables = [
      'afk_statuses',
      'infractions',
      'giveaways',
      'message_activity',
      'voice_activity',
      'live_announcements',
      'message_logs'
    ];

    for (const table of tables) {
      try {
        await pool.execute(`OPTIMIZE TABLE ${table}`);
      } catch (error) {
        // Ignore errors - table might not exist
      }
    }

    logger.info('[CleanupScheduler] Table optimization completed');
  }

  /**
   * Get cleanup statistics
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      stats: { ...this.stats }
    };
  }

  /**
   * Stop the cleanup scheduler
   */
  stop() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    logger.info('[CleanupScheduler] Stopped');
  }

  /**
   * Run cleanup manually (for testing or admin command)
   */
  async runManual() {
    logger.info('[CleanupScheduler] Manual cleanup triggered');
    await this.runCleanup();
  }
}

// Singleton instance
const cleanupScheduler = new CleanupScheduler();

export default cleanupScheduler;
export { CleanupScheduler };
