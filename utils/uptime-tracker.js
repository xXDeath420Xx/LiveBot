import pool from './db.js';
import logger from './logger.js';

class UptimeTracker {
  constructor(processName = 'CertiFried Utility Bot') {
    this.processName = processName;
    this.startTime = null;
  }

  /**
   * Log a bot start event
   */
  async logStart(details = null) {
    try {
      await pool.execute(
        `INSERT INTO uptime_events (event_type, process_name, details, timestamp)
         VALUES ('start', ?, ?, NOW())`,
        [this.processName, details]
      );
      this.startTime = new Date();
      logger.info(`[UptimeTracker] Bot start event logged`, {
        category: 'uptime',
        processName: this.processName
      });
    } catch (error) {
      logger.error(`[UptimeTracker] Failed to log start event:`, {
        error: error.message,
        category: 'uptime'
      });
    }
  }

  /**
   * Log a bot stop event
   */
  async logStop(details = null) {
    try {
      await pool.execute(
        `INSERT INTO uptime_events (event_type, process_name, details, timestamp)
         VALUES ('stop', ?, ?, NOW())`,
        [this.processName, details]
      );
      logger.info(`[UptimeTracker] Bot stop event logged`, {
        category: 'uptime',
        processName: this.processName
      });
    } catch (error) {
      logger.error(`[UptimeTracker] Failed to log stop event:`, {
        error: error.message,
        category: 'uptime'
      });
    }
  }

  /**
   * Log a bot crash event
   */
  async logCrash(details = null) {
    try {
      await pool.execute(
        `INSERT INTO uptime_events (event_type, process_name, details, timestamp)
         VALUES ('crash', ?, ?, NOW())`,
        [this.processName, details]
      );
      logger.error(`[UptimeTracker] Bot crash event logged`, {
        category: 'uptime',
        processName: this.processName,
        details
      });
    } catch (error) {
      logger.error(`[UptimeTracker] Failed to log crash event:`, {
        error: error.message,
        category: 'uptime'
      });
    }
  }

  /**
   * Log a bot restart event
   */
  async logRestart(details = null) {
    try {
      await pool.execute(
        `INSERT INTO uptime_events (event_type, process_name, details, timestamp)
         VALUES ('restart', ?, ?, NOW())`,
        [this.processName, details]
      );
      this.startTime = new Date();
      logger.info(`[UptimeTracker] Bot restart event logged`, {
        category: 'uptime',
        processName: this.processName
      });
    } catch (error) {
      logger.error(`[UptimeTracker] Failed to log restart event:`, {
        error: error.message,
        category: 'uptime'
      });
    }
  }

  /**
   * Calculate uptime percentage for the last N days
   * @param {number} days - Number of days to calculate uptime for (default: 30)
   * @returns {Promise<Object>} Uptime statistics
   */
  async calculateUptime(days = 30) {
    try {
      // Get all events for the last N days
      const [events] = await pool.execute(
        `SELECT event_type, timestamp
         FROM uptime_events
         WHERE process_name = ? AND timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY timestamp ASC`,
        [this.processName, days]
      );

      if (events.length === 0) {
        // No events found - assume 100% uptime if bot is currently running
        return {
          uptimePercentage: 100,
          totalMinutes: days * 24 * 60,
          uptimeMinutes: days * 24 * 60,
          downtimeMinutes: 0,
          dailyStats: this._generateDailyStats(days, [])
        };
      }

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const now = new Date();

      let totalUptime = 0;
      let lastStartTime = null;

      // Check if there was a start event before the time window
      const [eventsBeforeWindow] = await pool.execute(
        `SELECT event_type, timestamp
         FROM uptime_events
         WHERE process_name = ? AND timestamp < DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY timestamp DESC
         LIMIT 1`,
        [this.processName, days]
      );

      // If bot was already running before the time window, count from startDate
      if (eventsBeforeWindow.length > 0) {
        const lastEventBeforeWindow = eventsBeforeWindow[0];
        if (lastEventBeforeWindow.event_type === 'start' || lastEventBeforeWindow.event_type === 'restart') {
          lastStartTime = startDate;
        }
      }

      // Process events to calculate uptime
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        // Ensure timestamp is treated as UTC by appending 'Z' if not already there
        const timestamp = event.timestamp.toString().endsWith('Z') ? event.timestamp : event.timestamp + 'Z';
        const eventTime = new Date(timestamp);

        if (event.event_type === 'start' || event.event_type === 'restart') {
          // If already running (restart), count uptime until this restart
          if (lastStartTime) {
            totalUptime += (eventTime - lastStartTime);
          }
          lastStartTime = eventTime;
        } else if (event.event_type === 'stop' || event.event_type === 'crash') {
          if (lastStartTime) {
            // Add uptime from last start to this stop/crash
            totalUptime += (eventTime - lastStartTime);
            lastStartTime = null;
          }
        }
      }

      // If bot is currently running (last event was a start), add time until now
      if (lastStartTime) {
        totalUptime += (now - lastStartTime);
      }

      const totalMinutes = days * 24 * 60;
      const uptimeMinutes = totalUptime / 1000 / 60;
      const downtimeMinutes = totalMinutes - uptimeMinutes;
      const uptimePercentage = (uptimeMinutes / totalMinutes) * 100;

      return {
        uptimePercentage: Math.max(0, Math.min(100, uptimePercentage)),
        totalMinutes,
        uptimeMinutes,
        downtimeMinutes,
        dailyStats: this._generateDailyStats(days, events)
      };
    } catch (error) {
      logger.error(`[UptimeTracker] Failed to calculate uptime:`, {
        error: error.message,
        category: 'uptime'
      });
      return {
        uptimePercentage: 0,
        totalMinutes: 0,
        uptimeMinutes: 0,
        downtimeMinutes: 0,
        dailyStats: []
      };
    }
  }

  /**
   * Generate daily uptime statistics
   * @private
   */
  _generateDailyStats(days, events) {
    const dailyStats = [];
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setDate(dayStart.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      // Filter events for this day (with UTC timezone handling)
      const dayEvents = events.filter(e => {
        const timestamp = e.timestamp.toString().endsWith('Z') ? e.timestamp : e.timestamp + 'Z';
        const eventTime = new Date(timestamp);
        return eventTime >= dayStart && eventTime <= dayEnd;
      });

      let dayUptime = 0;
      let lastStartTime = null;

      // Check if bot was running at start of day
      const eventsBeforeDay = events.filter(e => {
        const timestamp = e.timestamp.toString().endsWith('Z') ? e.timestamp : e.timestamp + 'Z';
        return new Date(timestamp) < dayStart;
      });
      if (eventsBeforeDay.length > 0) {
        const lastEventBeforeDay = eventsBeforeDay[eventsBeforeDay.length - 1];
        if (lastEventBeforeDay.event_type === 'start' || lastEventBeforeDay.event_type === 'restart') {
          lastStartTime = dayStart;
        }
      }

      // Process events for this day
      for (const event of dayEvents) {
        const timestamp = event.timestamp.toString().endsWith('Z') ? event.timestamp : event.timestamp + 'Z';
        const eventTime = new Date(timestamp);

        if (event.event_type === 'start' || event.event_type === 'restart') {
          // If already running (restart), count uptime until this restart
          if (lastStartTime) {
            dayUptime += (eventTime - lastStartTime);
          }
          lastStartTime = eventTime;
        } else if (event.event_type === 'stop' || event.event_type === 'crash') {
          if (lastStartTime) {
            dayUptime += (eventTime - lastStartTime);
            lastStartTime = null;
          }
        }
      }

      // If bot was still running at end of day, add remaining time
      if (lastStartTime) {
        const endTime = dayEnd > now ? now : dayEnd;
        dayUptime += (endTime - lastStartTime);
      }

      const dayTotalMinutes = 24 * 60;
      const dayUptimeMinutes = dayUptime / 1000 / 60;
      const dayUptimePercentage = (dayUptimeMinutes / dayTotalMinutes) * 100;

      let status = 'up';
      if (dayUptimePercentage < 95) {
        status = 'down';
      } else if (dayUptimePercentage < 99) {
        status = 'partial';
      }

      dailyStats.push({
        date: dayStart.toISOString().split('T')[0],
        uptimePercentage: Math.max(0, Math.min(100, dayUptimePercentage)),
        status
      });
    }

    return dailyStats;
  }

  /**
   * Setup graceful shutdown handlers
   * NOTE: This method no longer sets up SIGINT/SIGTERM handlers directly.
   * The main index.js shutdown() function handles signals and calls uptimeTracker.logStop()
   * This prevents duplicate handlers that can cause race conditions and unexpected exit codes.
   */
  setupGracefulShutdown() {
    // Only set up crash logging - signal handling is done in index.js
    // to prevent duplicate handlers that cause exit code conflicts

    // Log crashes - but don't exit, let the main handler decide
    process.on('uncaughtException', async (error) => {
      logger.error(`[UptimeTracker] Uncaught exception:`, { error: error.message });
      try {
        await this.logCrash(`Uncaught exception: ${error.message}`);
      } catch (logError) {
        // Ignore logging errors during crash
      }
      // Don't call process.exit here - main handler in index.js will do it
    });

    process.on('unhandledRejection', async (reason, promise) => {
      logger.error(`[UptimeTracker] Unhandled rejection:`, { reason });
      try {
        await this.logCrash(`Unhandled rejection: ${reason}`);
      } catch (logError) {
        // Ignore logging errors during rejection
      }
    });

    logger.info('[UptimeTracker] Crash logging handlers registered (signal handlers in index.js)');
  }
}

export default UptimeTracker;
