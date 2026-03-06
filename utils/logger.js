import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { EmbedBuilder } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURATION ====================

const logDir = path.join(__dirname, '..', 'logs');
const colours = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'colours.json'), 'utf-8'));

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const defaultConfig = {
  level: process.env.LOG_LEVEL || 'info',
  prettyPrint: process.env.NODE_ENV !== 'production',
  jsonOutput: process.env.LOG_JSON === 'true',
  enableRotation: process.env.LOG_ROTATION !== 'false',
  maxFiles: process.env.LOG_MAX_FILES || '3d',      // Keep 3 days of logs
  maxSize: process.env.LOG_MAX_SIZE || '50m',       // 50MB per file to keep disk usage reasonable
  enablePerformanceMetrics: process.env.LOG_PERFORMANCE === 'true',
  enableRequestLogging: process.env.LOG_REQUESTS !== 'false',
};

// ==================== UTILITIES ====================

let botClient = null;
let db = null;
const performanceMap = new Map();
let correlationIdCounter = 0;

/**
 * Generate a unique correlation ID for request tracking
 * Uses modulo to prevent integer overflow after millions of logs
 */
function generateCorrelationId() {
  const timestamp = Date.now();
  correlationIdCounter = (correlationIdCounter + 1) % 1000000;
  const counter = correlationIdCounter.toString().padStart(6, '0');
  return `${timestamp}-${counter}`;
}

/**
 * Safe JSON stringify that handles circular references and BigInts
 */
const safeStringify = (obj, indent = 2) => {
  const cache = new Set();
  const retVal = JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.has(value)) return '[Circular]';
      cache.add(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...value,
      };
    }
    return value;
  }, indent);
  cache.clear();
  return retVal;
};

/**
 * Format stack trace for better readability
 */
function formatStackTrace(stack) {
  const lines = stack.split('\n');
  const formatted = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('at ')) {
      const match = line.match(/\((.+?):(\d+):(\d+)\)/) || line.match(/at (.+?):(\d+):(\d+)/);
      if (match) {
        const [, file, lineNum, col] = match;
        const shortPath = file.replace(process.cwd(), '.');
        formatted.push(`  ${colours.fg.gray}at${colours.reset} ${colours.fg.cyan}${shortPath}${colours.reset}:${colours.fg.yellow}${lineNum}${colours.reset}:${col}`);
      } else {
        formatted.push(`  ${colours.fg.gray}${line}${colours.reset}`);
      }
    } else {
      formatted.push(`${colours.bright}${colours.fg.red}${line}${colours.reset}`);
    }
  }

  return formatted.join('\n');
}

/**
 * Get colored severity level badge
 */
function getSeverityBadge(level) {
  const badges = {
    error: `${colours.bg.red}${colours.fg.white}${colours.bright} ERROR ${colours.reset}`,
    warn: `${colours.bg.yellow}${colours.fg.black}${colours.bright} WARN  ${colours.reset}`,
    info: `${colours.bg.blue}${colours.fg.white}${colours.bright} INFO  ${colours.reset}`,
    debug: `${colours.bg.magenta}${colours.fg.white}${colours.bright} DEBUG ${colours.reset}`,
    verbose: `${colours.bg.cyan}${colours.fg.black}${colours.bright} VERB  ${colours.reset}`,
    http: `${colours.bg.green}${colours.fg.white}${colours.bright} HTTP  ${colours.reset}`,
  };
  return badges[level] || badges.info;
}

/**
 * Format bytes for memory usage display
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

// ==================== CUSTOM FORMATS ====================

/**
 * Pretty print format for development
 */
const prettyPrintFormat = winston.format.printf((info) => {
  const { timestamp, level, message, stack, correlationId, requestId, duration, method, url, statusCode, userId, ...meta } = info;

  let output = '';

  // Timestamp
  output += `${colours.fg.gray}[${timestamp}]${colours.reset} `;

  // Severity badge
  output += `${getSeverityBadge(level)} `;

  // Correlation ID (if present)
  if (correlationId) {
    output += `${colours.fg.cyan}[${correlationId}]${colours.reset} `;
  }

  // Message
  output += `${message}`;

  // Request details (if present)
  if (method && url) {
    output += `\n  ${colours.fg.blue}→${colours.reset} ${colours.bright}${method}${colours.reset} ${url}`;
    if (statusCode) {
      const statusColor = statusCode >= 500 ? colours.fg.red :
                         statusCode >= 400 ? colours.fg.yellow :
                         statusCode >= 300 ? colours.fg.cyan : colours.fg.green;
      output += ` ${statusColor}${statusCode}${colours.reset}`;
    }
  }

  // Duration (if present)
  if (duration !== undefined) {
    const durationColor = duration > 1000 ? colours.fg.red :
                         duration > 500 ? colours.fg.yellow : colours.fg.green;
    output += ` ${durationColor}${formatDuration(duration)}${colours.reset}`;
  }

  // User ID (if present)
  if (userId) {
    output += `\n  ${colours.fg.gray}User:${colours.reset} ${userId}`;
  }

  // Request ID (if present and different from correlation ID)
  if (requestId && requestId !== correlationId) {
    output += `\n  ${colours.fg.gray}Request:${colours.reset} ${requestId}`;
  }

  // Stack trace
  if (stack) {
    output += `\n${formatStackTrace(stack)}`;
  }

  // Additional metadata
  const metaKeys = Object.keys(meta).filter(key => !String(key).startsWith('Symbol'));
  if (metaKeys.length > 0) {
    const cleanMeta = {};
    metaKeys.forEach(key => { cleanMeta[key] = meta[key]; });

    const cleanKeys = Object.keys(cleanMeta);
    if (cleanKeys.length > 0) {
      output += `\n  ${colours.fg.gray}Context:${colours.reset}`;
      for (const key of cleanKeys) {
        const value = cleanMeta[key];
        if (typeof value === 'object') {
          output += `\n    ${colours.fg.yellow}${key}${colours.reset}: ${safeStringify(value, null)}`;
        } else {
          output += `\n    ${colours.fg.yellow}${key}${colours.reset}: ${value}`;
        }
      }
    }
  }

  return output;
});

/**
 * JSON format for structured logging
 */
const jsonFormat = winston.format.printf((info) => {
  return safeStringify(info, null);
});

/**
 * File format (plain text, no colors)
 */
const fileFormat = winston.format.printf((info) => {
  const { timestamp, level, message, stack, correlationId, requestId, duration, method, url, statusCode, userId, ...meta } = info;

  let output = `[${timestamp}] [${level.toUpperCase()}]`;

  if (correlationId) {
    output += ` [${correlationId}]`;
  }

  output += ` ${message}`;

  if (method && url) {
    output += ` | ${method} ${url}`;
    if (statusCode) {
      output += ` ${statusCode}`;
    }
  }

  if (duration !== undefined) {
    output += ` (${formatDuration(duration)})`;
  }

  if (userId) {
    output += ` | User: ${userId}`;
  }

  if (requestId && requestId !== correlationId) {
    output += ` | Request: ${requestId}`;
  }

  if (stack) {
    output += `\n${stack}`;
  }

  const metaKeys = Object.keys(meta).filter(key => !String(key).startsWith('Symbol'));
  if (metaKeys.length > 0) {
    const cleanMeta = {};
    metaKeys.forEach(key => { cleanMeta[key] = meta[key]; });

    const cleanKeys = Object.keys(cleanMeta);
    if (cleanKeys.length > 0) {
      output += ` | Context: ${safeStringify(cleanMeta, null)}`;
    }
  }

  return output;
});

// ==================== LOGGER CREATION ====================

/**
 * Create the base Winston logger with all transports
 */
function createBaseLogger(config = defaultConfig) {
  const transports = [];

  // Console transport
  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        config.jsonOutput ? jsonFormat : (config.prettyPrint ? prettyPrintFormat : fileFormat)
      )
    })
  );

  // File transports with rotation
  if (config.enableRotation) {
    // Combined log
    transports.push(
      new DailyRotateFile({
        dirname: logDir,
        filename: 'combined-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: config.maxSize,
        maxFiles: config.maxFiles,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
          winston.format.errors({ stack: true }),
          fileFormat
        )
      })
    );

    // Error log
    transports.push(
      new DailyRotateFile({
        dirname: logDir,
        filename: 'error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxSize: config.maxSize,
        maxFiles: config.maxFiles,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
          winston.format.errors({ stack: true }),
          fileFormat
        )
      })
    );

    // Performance log (if enabled)
    if (config.enablePerformanceMetrics) {
      transports.push(
        new DailyRotateFile({
          dirname: logDir,
          filename: 'performance-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: config.maxSize,
          maxFiles: config.maxFiles,
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
            jsonFormat
          ),
          filter: (info) => info.duration !== undefined
        })
      );
    }

    // Request log (if enabled)
    if (config.enableRequestLogging) {
      transports.push(
        new DailyRotateFile({
          dirname: logDir,
          filename: 'requests-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: config.maxSize,
          maxFiles: config.maxFiles,
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
            fileFormat
          ),
          filter: (info) => info.method !== undefined
        })
      );
    }
  }

  return winston.createLogger({
    level: config.level,
    levels: winston.config.npm.levels,
    transports,
    exitOnError: false,
    exceptionHandlers: [
      new DailyRotateFile({
        dirname: logDir,
        filename: 'exceptions-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: config.maxSize,
        maxFiles: config.maxFiles,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
          winston.format.errors({ stack: true }),
          fileFormat
        )
      })
    ],
    rejectionHandlers: [
      new DailyRotateFile({
        dirname: logDir,
        filename: 'rejections-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: config.maxSize,
        maxFiles: config.maxFiles,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
          winston.format.errors({ stack: true }),
          fileFormat
        )
      })
    ]
  });
}

const baseLogger = createBaseLogger(defaultConfig);

// ==================== ENHANCED LOGGER INTERFACE ====================

/**
 * Create a context-aware logger
 */
function createContextLogger(context) {
  return {
    info: (message, meta) => baseLogger.info(message, { ...context, ...meta }),
    warn: (message, meta) => baseLogger.warn(message, { ...context, ...meta }),
    error: (message, meta) => baseLogger.error(message, { ...context, ...meta }),
    debug: (message, meta) => baseLogger.debug(message, { ...context, ...meta }),
    verbose: (message, meta) => baseLogger.verbose(message, { ...context, ...meta }),
    http: (message, meta) => baseLogger.http(message, { ...context, ...meta }),
  };
}

/**
 * Enhanced logger implementation
 */
const logger = {
  // Initialize Discord transport
  init: async (client, database) => {
    if (botClient && db) return;
    botClient = client;
    db = database;
    baseLogger.info(`${colours.fg.green}✓${colours.reset} Logger initialized with Discord support`, {
      correlationId: generateCorrelationId()
    });
  },

  // Standard logging methods
  info: (message, meta) => baseLogger.info(message, meta),
  warn: (message, meta) => baseLogger.warn(message, meta),
  error: (message, meta) => baseLogger.error(message, meta),
  debug: (message, meta) => baseLogger.debug(message, meta),
  verbose: (message, meta) => baseLogger.verbose(message, meta),
  http: (message, meta) => baseLogger.http(message, meta),

  /**
   * Log an error with full stack trace preserved
   * Use this instead of logger.error when you have an Error object
   * @param {string} message - Log message
   * @param {Error} error - The Error object (stack trace will be preserved)
   * @param {object} meta - Additional metadata
   */
  logError: (message, error, meta = {}) => {
    if (error instanceof Error) {
      baseLogger.error(message, {
        ...meta,
        error: error.message,
        stack: error.stack,
        errorName: error.name,
        ...(error.code && { errorCode: error.code }),
      });
    } else {
      // Fallback if not an Error object
      baseLogger.error(message, { ...meta, error: String(error) });
    }
  },

  // Context-aware logging
  withContext: (context) => createContextLogger(context),

  withCorrelationId: (correlationId) => {
    const id = correlationId || generateCorrelationId();
    return createContextLogger({ correlationId: id });
  },

  // Performance tracking
  startTimer: (label) => {
    const timerId = `${label}-${generateCorrelationId()}`;
    performanceMap.set(timerId, {
      startTime: Date.now(),
    });
    return timerId;
  },

  endTimer: (timerId, message, meta) => {
    const metrics = performanceMap.get(timerId);
    if (!metrics) {
      baseLogger.warn(`Timer not found: ${timerId}`);
      return;
    }

    metrics.endTime = Date.now();
    metrics.duration = metrics.endTime - metrics.startTime;
    metrics.memory = process.memoryUsage();

    const logMessage = message || `Timer completed: ${timerId}`;
    baseLogger.info(logMessage, {
      ...meta,
      duration: metrics.duration,
      memoryUsage: {
        heapUsed: formatBytes(metrics.memory.heapUsed),
        heapTotal: formatBytes(metrics.memory.heapTotal),
        rss: formatBytes(metrics.memory.rss),
      }
    });

    performanceMap.delete(timerId);
  },

  // Request/Response logging
  logRequest: (method, url, meta) => {
    const requestId = generateCorrelationId();
    const timerId = logger.startTimer(`request-${requestId}`);

    baseLogger.http(`Incoming request`, {
      ...meta,
      method,
      url,
      requestId,
      correlationId: requestId,
      timerId,
    });

    return timerId;
  },

  logResponse: (timerId, statusCode, meta) => {
    const metrics = performanceMap.get(timerId);
    if (!metrics) {
      baseLogger.warn(`Request timer not found: ${timerId}`);
      return;
    }

    metrics.endTime = Date.now();
    metrics.duration = metrics.endTime - metrics.startTime;

    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'http';

    baseLogger.log(level, `Request completed`, {
      ...meta,
      statusCode,
      duration: metrics.duration,
    });

    performanceMap.delete(timerId);
  },

  // Memory metrics
  logMemoryUsage: (label = 'Memory usage') => {
    const usage = process.memoryUsage();
    baseLogger.info(label, {
      heapUsed: formatBytes(usage.heapUsed),
      heapTotal: formatBytes(usage.heapTotal),
      rss: formatBytes(usage.rss),
      external: formatBytes(usage.external),
      arrayBuffers: formatBytes(usage.arrayBuffers),
    });
  },

  // Utilities
  generateCorrelationId,
  child: (context) => createContextLogger(context),
};

// ==================== EXPRESS MIDDLEWARE ====================

/**
 * Express middleware for automatic request/response logging
 */
export function requestLoggerMiddleware(req, res, next) {
  const timerId = logger.logRequest(req.method, req.url, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    correlationId: req.headers['x-correlation-id'] || generateCorrelationId(),
  });

  res.locals.timerId = timerId;
  res.locals.correlationId = req.headers['x-correlation-id'];

  // Override res.json to log response
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    logger.logResponse(res.locals.timerId, res.statusCode, {
      correlationId: res.locals.correlationId,
    });
    return originalJson(body);
  };

  // Override res.send to log response
  const originalSend = res.send.bind(res);
  res.send = function(body) {
    logger.logResponse(res.locals.timerId, res.statusCode, {
      correlationId: res.locals.correlationId,
    });
    return originalSend(body);
  };

  next();
}

// ==================== EXPORTS ====================

export default logger;
export {
  logger,
  generateCorrelationId,
  formatBytes,
  formatDuration,
  safeStringify,
};