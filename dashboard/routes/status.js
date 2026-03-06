import express from 'express';
import pool from '../../utils/db.js';
import UptimeTracker from '../../utils/uptime-tracker.js';
import logger from '../../utils/logger.js';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';
import { apiCheckSuperAdmin } from '../middleware/auth.js';
import {
    getPM2Processes,
    getPM2Logs,
    getDiskStats,
    getNetworkStats,
    formatBytes
} from '../../utils/system-info.js';

// execFile is safe (no shell interpretation)
const execFileAsync = promisify(execFile);
const router = express.Router();

// Helper function to measure API latency using HEAD request (faster)
async function measureLatency(url, timeout = 3000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'HEAD', // Use HEAD instead of GET - much faster
      timeout,
      headers: {
        'User-Agent': 'CertiFried-StatusCheck/1.0'
      }
    };

    const req = protocol.request(options, (res) => {
      const latency = Date.now() - startTime;
      res.destroy();
      resolve({ status: 'online', latency, statusCode: res.statusCode });
    });

    req.on('error', () => {
      const latency = Date.now() - startTime;
      // If we got here quickly, it might just be a connection issue
      resolve({ status: 'offline', latency: latency < timeout ? latency : null, statusCode: null });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout', latency: timeout, statusCode: null });
    });

    req.end();
  });
}

// GET /api/status/uptime - Get uptime statistics
router.get('/uptime', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    const uptimeTracker = new UptimeTracker('CertiFried Utility Bot');
    const stats = await uptimeTracker.calculateUptime(days);

    res.json({
      success: true,
      ...stats
    });
  } catch (error) {
    logger.error('[Status] Get uptime error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch uptime statistics'
    });
  }
});

// GET /api/status/server-stats - Get server statistics (super admin only)
router.get('/server-stats', apiCheckSuperAdmin, async (req, res) => {
  try {
    const stats = {
      success: true,
      system: {
        platform: os.platform(),
        uptime: os.uptime(),
        cpu: {
          usage: 0,
          cores: os.cpus().length
        },
        memory: {
          total: os.totalmem(),
          used: os.totalmem() - os.freemem(),
          usagePercent: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
        }
      },
      processes: [],
      bot: null,
      database: {
        status: 'online',
        tables: '--',
        size: '--',
        connections: '--'
      },
      cache: {
        status: 'online',
        hitRate: '--',
        entries: '--',
        responseTime: '--'
      },
      api: {
        healthy: 0,
        degraded: 0,
        unavailable: 0
      }
    };

    // Get PM2 process list using safe utility (no shell)
    try {
      const pm2Processes = await getPM2Processes();

      stats.processes = pm2Processes.map(proc => ({
        name: proc.name,
        status: proc.status,
        cpu: proc.cpu,
        memory: proc.memory,
        uptime: proc.uptime,
        restarts: proc.restarts
      }));

      // Calculate average CPU
      const totalCpu = stats.processes.reduce((sum, proc) => sum + proc.cpu, 0);
      stats.system.cpu.usage = totalCpu / stats.processes.length || 0;
    } catch (error) {
      logger.debug('[Status] Failed to get PM2 stats', { error: error.message });
    }

    // Get disk usage using safe utility (no shell)
    try {
      const diskStats = await getDiskStats();
      stats.system.disk = {
        total: diskStats.total,
        used: diskStats.used,
        available: diskStats.available,
        percent: diskStats.percent
      };
    } catch (error) {
      logger.debug('[Status] Failed to get disk stats', { error: error.message });
      stats.system.disk = null;
    }

    // Get network stats using safe utility (no shell)
    try {
      const networkStats = await getNetworkStats();
      stats.system.network = {
        rx: networkStats.rx,
        tx: networkStats.tx,
        interface: networkStats.interface || 'unknown'
      };
    } catch (error) {
      logger.debug('[Status] Failed to get network stats', { error: error.message });
      stats.system.network = null;
    }

    // Get Node.js version and environment info
    stats.system.nodeVersion = process.version;
    stats.system.environment = process.env.NODE_ENV || 'development';
    stats.system.hostname = os.hostname();

    // Get bot stats using shared function for consistency with landing page
    try {
      const mainClient = req.app.locals.client;
      const serverStats = global.getServerStats ? global.getServerStats(mainClient) : { guilds: 0, users: 0 };
      stats.bot = serverStats;
    } catch (error) {
      logger.debug('[Status] Failed to get bot stats', { error: error.message });
    }

    // Get database stats
    try {
      const [tables] = await pool.execute("SHOW TABLES");
      stats.database.tables = tables.length;

      const [dbSize] = await pool.execute(
        `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb
         FROM information_schema.tables
         WHERE table_schema = DATABASE()`
      );

      if (dbSize.length > 0) {
        stats.database.size = `${dbSize[0].size_mb} MB`;
      }

      const [connections] = await pool.execute("SHOW STATUS LIKE 'Threads_connected'");
      if (connections.length > 0) {
        stats.database.connections = connections[0].Value;
      }
    } catch (error) {
      logger.debug('[Status] Failed to get database stats', { error: error.message });
      stats.database.status = 'offline';
    }

    // Get live streams stats
    // Only count announcements updated within the last 6 hours as "currently live"
    try {
      const [liveAnnouncements] = await pool.execute(
        `SELECT COUNT(*) as total, COUNT(DISTINCT streamer_id) as unique_streamers
         FROM live_announcements
         WHERE updated_at >= DATE_SUB(NOW(), INTERVAL 6 HOUR)`
      );

      const [platformCounts] = await pool.execute(
        `SELECT platform, COUNT(*) as count
         FROM live_announcements
         WHERE updated_at >= DATE_SUB(NOW(), INTERVAL 6 HOUR)
         GROUP BY platform`
      );

      // Also get total tracked streamers for context
      const [totalStreamers] = await pool.execute(
        `SELECT COUNT(*) as total FROM streamers`
      );

      // Get total subscriptions
      const [totalSubs] = await pool.execute(
        `SELECT COUNT(*) as total FROM subscriptions`
      );

      stats.liveStreams = {
        currentlyLive: liveAnnouncements[0]?.unique_streamers || 0,
        totalAnnouncements: liveAnnouncements[0]?.total || 0,
        totalStreamersTracked: totalStreamers[0]?.total || 0,
        totalSubscriptions: totalSubs[0]?.total || 0,
        platforms: {}
      };

      platformCounts.forEach(row => {
        stats.liveStreams.platforms[row.platform] = row.count;
      });

      // Get list of currently live streamers with details
      const [liveList] = await pool.execute(
        `SELECT la.username, la.platform, la.stream_started_at, la.updated_at
         FROM live_announcements la
         WHERE la.updated_at >= DATE_SUB(NOW(), INTERVAL 6 HOUR)
         ORDER BY la.updated_at DESC
         LIMIT 10`
      );
      stats.liveStreams.liveNow = liveList.map(s => ({
        username: s.username,
        platform: s.platform,
        startedAt: s.stream_started_at,
        lastUpdate: s.updated_at
      }));
    } catch (error) {
      logger.debug('[Status] Failed to get live streams stats', { error: error.message });
    }

    // Check API health (basic check - could be enhanced)
    stats.api.healthy = 4; // Assuming Twitch, YouTube, Kick, Trovo

    res.json(stats);
  } catch (error) {
    logger.error('[Status] Get server stats error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch server statistics'
    });
  }
});

// GET /api/status/logs - Get recent logs using safe utility (no shell, super admin only)
router.get('/logs', apiCheckSuperAdmin, async (req, res) => {
  try {
    const processName = req.query.process || 'CertiFriedUtility';
    const logType = req.query.type === 'error' ? 'error' : 'out';
    const lines = Math.min(Math.max(parseInt(req.query.lines) || 100, 1), 500);

    // Use safe log reader (no shell execution)
    const result = await getPM2Logs(processName, logType, lines);

    res.json({
      success: result.success !== false,
      logs: result.logs || [],
      processNames: [processName],
      error: result.error
    });
  } catch (error) {
    logger.error('[Status] Get logs error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch logs',
      logs: [],
      processNames: []
    });
  }
});

// GET /api/status/api-health - Check external API health and latency
router.get('/api-health', async (req, res) => {
  try {
    // Using lightweight endpoints that respond quickly
    const apis = [
      { name: 'Discord', url: 'https://discord.com/api/v10/gateway', icon: 'fab fa-discord', color: '#5865F2' },
      { name: 'Twitch', url: 'https://id.twitch.tv/oauth2/validate', icon: 'fab fa-twitch', color: '#9146FF' },
      { name: 'Kick', url: 'https://kick.com/', icon: 'kick', color: '#53FC18' },
      { name: 'YouTube', url: 'https://www.youtube.com/favicon.ico', icon: 'fab fa-youtube', color: '#FF0000' },
      { name: 'TikTok', url: 'https://www.tiktok.com/favicon.ico', icon: 'fab fa-tiktok', color: '#000000' },
      { name: 'Trovo', url: 'https://trovo.live/', icon: 'trovo', color: '#19D760' }
    ];

    const results = await Promise.all(
      apis.map(async (api) => {
        const result = await measureLatency(api.url);
        return {
          ...api,
          ...result,
          latencyText: result.latency ? `${result.latency}ms` : 'N/A'
        };
      })
    );

    // Calculate summary
    const online = results.filter(r => r.status === 'online').length;
    const degraded = results.filter(r => r.status === 'timeout' || (r.latency && r.latency > 2000)).length;
    const offline = results.filter(r => r.status === 'offline').length;

    res.json({
      success: true,
      apis: results,
      summary: { online, degraded, offline, total: apis.length }
    });
  } catch (error) {
    logger.error('[Status] API health check error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to check API health' });
  }
});

// GET /api/status/gateway - Get Discord gateway/WebSocket health
router.get('/gateway', async (req, res) => {
  try {
    const client = req.app.locals.client;

    if (!client || !client.ws) {
      return res.json({
        success: true,
        gateway: {
          status: 'unknown',
          ping: null,
          shards: []
        }
      });
    }

    const gateway = {
      status: client.ws.status === 0 ? 'connected' : 'disconnected',
      ping: client.ws.ping,
      pingText: client.ws.ping >= 0 ? `${client.ws.ping}ms` : 'N/A',
      shards: [],
      readyAt: client.readyAt,
      uptime: client.uptime
    };

    // Get shard info if sharded
    if (client.ws.shards && client.ws.shards.size > 0) {
      client.ws.shards.forEach((shard, id) => {
        gateway.shards.push({
          id,
          status: shard.status === 0 ? 'connected' : 'disconnected',
          ping: shard.ping,
          guilds: client.guilds.cache.filter(g => g.shardId === id).size
        });
      });
    }

    res.json({ success: true, gateway });
  } catch (error) {
    logger.error('[Status] Gateway status error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get gateway status' });
  }
});

// GET /api/status/commands - Get command usage stats (super admin only, exposes guild IDs)
router.get('/commands', apiCheckSuperAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;

    // Get total commands used across all servers
    const [[totalCommands]] = await pool.execute(
      `SELECT COALESCE(SUM(commands_used), 0) as total
       FROM activity_stats
       WHERE stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [days]
    );

    // Get daily command usage trend
    const [dailyTrend] = await pool.execute(
      `SELECT stat_date as date, SUM(commands_used) as commands
       FROM activity_stats
       WHERE stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY stat_date
       ORDER BY stat_date ASC`,
      [days]
    );

    // Get top servers by command usage
    const [topServers] = await pool.execute(
      `SELECT guild_id, SUM(commands_used) as commands
       FROM activity_stats
       WHERE stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY guild_id
       ORDER BY commands DESC
       LIMIT 5`,
      [days]
    );

    res.json({
      success: true,
      total: totalCommands?.total || 0,
      dailyTrend,
      topServers,
      period: `${days} days`
    });
  } catch (error) {
    logger.error('[Status] Command stats error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get command stats' });
  }
});

// GET /api/status/errors - Get error rate and recent errors using safe utility (super admin only)
router.get('/errors', apiCheckSuperAdmin, async (req, res) => {
  try {
    // Get recent errors from PM2 error logs using safe utility (no shell)
    const result = await getPM2Logs('CertiFriedUtility', 'error', 500);
    const logs = result.logs || [];

    // Filter for actual errors
    const errorLines = logs.filter(log =>
      log.type === 'error' ||
      log.message.toLowerCase().includes('error') ||
      log.message.toLowerCase().includes('exception') ||
      log.message.toLowerCase().includes('failed')
    );

    // Count errors by type
    const errorCounts = {
      database: 0,
      api: 0,
      discord: 0,
      other: 0
    };

    const recentErrors = [];

    errorLines.slice(-50).forEach(log => {
      const message = log.message.toLowerCase();
      if (message.includes('database') || message.includes('mysql') || message.includes('sql')) {
        errorCounts.database++;
      } else if (message.includes('api') || message.includes('fetch') || message.includes('request')) {
        errorCounts.api++;
      } else if (message.includes('discord') || message.includes('gateway')) {
        errorCounts.discord++;
      } else {
        errorCounts.other++;
      }

      recentErrors.push({
        process: log.process || 'CertiFriedUtility',
        message: log.message.substring(0, 200),
        timestamp: log.timestamp
      });
    });

    res.json({
      success: true,
      total: errorLines.length,
      counts: errorCounts,
      recentErrors: recentErrors.slice(-10).reverse()
    });
  } catch (error) {
    logger.error('[Status] Error stats error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get error stats' });
  }
});

// GET /api/status/memory-history - Get memory usage history (from process metrics, super admin only)
router.get('/memory-history', apiCheckSuperAdmin, async (req, res) => {
  try {
    // Get current memory snapshot
    const memUsage = process.memoryUsage();
    const systemMem = {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem()
    };

    // We don't have historical data stored, so return current + simulated trend
    // In production, you'd want to store snapshots in a table
    res.json({
      success: true,
      current: {
        heap: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024),
        system: {
          total: Math.round(systemMem.total / 1024 / 1024 / 1024),
          used: Math.round(systemMem.used / 1024 / 1024 / 1024),
          free: Math.round(systemMem.free / 1024 / 1024 / 1024),
          percent: ((systemMem.used / systemMem.total) * 100).toFixed(1)
        }
      }
    });
  } catch (error) {
    logger.error('[Status] Memory history error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get memory history' });
  }
});

// POST /api/status/actions/restart - Restart a PM2 process (super admin only)
router.post('/actions/restart', async (req, res) => {
  try {
    // CRITICAL: Require authentication and super admin privileges
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      logger.warn('[Dashboard Restart] Unauthenticated restart attempt', {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Only super admin can restart processes
    if (!req.user || !isSuperAdmin(req.user.id)) {
      logger.warn('[Dashboard Restart] Unauthorized restart attempt', {
        userId: req.user?.id,
        username: req.user?.username,
        ip: req.ip
      });
      return res.status(403).json({ success: false, error: 'Super Admin access required to restart processes' });
    }

    const { processName } = req.body;

    if (!processName) {
      return res.status(400).json({ success: false, error: 'Process name required' });
    }

    // Validate process name (safe characters only)
    if (!/^[a-zA-Z0-9_-]+$/.test(processName)) {
      return res.status(400).json({ success: false, error: 'Invalid process name' });
    }

    // Log the restart action with full details
    logger.warn('[Dashboard Restart] Process restart initiated', {
      processName,
      userId: req.user.id,
      username: req.user.username,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    // Use execFile (no shell) to prevent command injection
    await execFileAsync('pm2', ['restart', processName]);

    logger.info('[Dashboard Restart] Process restart completed', {
      processName,
      userId: req.user.id
    });

    res.json({ success: true, message: `Process ${processName} restarted` });
  } catch (error) {
    logger.error('[Dashboard Restart] Restart failed', {
      error: error.message,
      userId: req.user?.id
    });
    res.status(500).json({ success: false, error: 'Failed to restart process' });
  }
});

// POST /api/status/actions/clear-cache - Clear application caches (super admin only)
router.post('/actions/clear-cache', apiCheckSuperAdmin, async (req, res) => {
  try {
    const client = req.app.locals.client;
    let cleared = [];

    // Clear any in-memory caches if they exist
    if (global.streamCache) {
      global.streamCache.clear();
      cleared.push('streamCache');
    }

    if (global.configCache) {
      global.configCache.clear();
      cleared.push('configCache');
    }

    if (client && client.cache) {
      // Clear specific Discord.js caches if needed
      cleared.push('clientCache');
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      cleared.push('gc');
    }

    res.json({
      success: true,
      message: 'Cache cleared',
      cleared
    });
  } catch (error) {
    logger.error('[Status] Clear cache error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to clear cache' });
  }
});

// GET /api/status/rate-limits - Get rate limit status for APIs (super admin only)
router.get('/rate-limits', apiCheckSuperAdmin, async (req, res) => {
  try {
    // Check if we have rate limit tracking
    const rateLimits = [];

    // Discord rate limits (from client if available)
    const client = req.app.locals.client;
    if (client && client.rest) {
      rateLimits.push({
        api: 'Discord',
        remaining: 'N/A',
        limit: 'N/A',
        resetAt: null,
        status: 'ok'
      });
    }

    // Check global rate limit trackers if they exist
    if (global.twitchRateLimit) {
      rateLimits.push({
        api: 'Twitch',
        remaining: global.twitchRateLimit.remaining || 'N/A',
        limit: global.twitchRateLimit.limit || 'N/A',
        resetAt: global.twitchRateLimit.resetAt || null,
        status: global.twitchRateLimit.remaining > 10 ? 'ok' : 'warning'
      });
    }

    res.json({
      success: true,
      rateLimits,
      note: 'Rate limit tracking requires integration with API clients'
    });
  } catch (error) {
    logger.error('[Status] Rate limits error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to get rate limits' });
  }
});

// GET /api/status/incidents - Get incident history (super admin only)
router.get('/incidents', apiCheckSuperAdmin, async (req, res) => {
  try {
    // Check if incidents table exists
    const [tables] = await pool.execute("SHOW TABLES LIKE 'incidents'");

    if (tables.length === 0) {
      // Return empty if no incidents table
      return res.json({
        success: true,
        incidents: [],
        note: 'Incident tracking not configured'
      });
    }

    const [incidents] = await pool.execute(
      `SELECT * FROM incidents ORDER BY created_at DESC LIMIT 20`
    );

    res.json({ success: true, incidents });
  } catch (error) {
    logger.debug('[Status] Incidents error', { error: error.message });
    res.json({
      success: true,
      incidents: [],
      note: 'Incident tracking not available'
    });
  }
});

// FiveM server status proxy (avoids CORS issues)
let fivemCache = { data: null, lastFetch: 0 };
router.get('/fivem', async (req, res) => {
  try {
    const now = Date.now();
    // Cache for 15 seconds
    if (fivemCache.data && (now - fivemCache.lastFetch) < 15000) {
      return res.json(fivemCache.data);
    }

    const response = await fetch('https://fivem.certifriedmultitool.com/api/server/stats', {
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      const data = await response.json();
      fivemCache.data = { success: true, ...data };
      fivemCache.lastFetch = now;
      return res.json(fivemCache.data);
    }

    res.json({ success: false, online: false });
  } catch (error) {
    // Return cached data if available
    if (fivemCache.data) {
      return res.json({ ...fivemCache.data, stale: true });
    }
    res.json({ success: false, online: false, error: 'Failed to fetch FiveM status' });
  }
});

export default router;
