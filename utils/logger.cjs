"use strict";
/**
 * CommonJS wrapper for the ESM logger module
 * This allows .cjs files to import the logger without ESM compatibility issues
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// ==================== CONFIGURATION ====================

const logDir = path.join(__dirname, '..', 'logs');
let colours;
try {
  colours = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'colours.json'), 'utf-8'));
} catch {
  // Fallback colours if file not found
  colours = {
    fg: { gray: '\x1b[90m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', blue: '\x1b[34m', magenta: '\x1b[35m', white: '\x1b[37m', black: '\x1b[30m' },
    bg: { red: '\x1b[41m', yellow: '\x1b[43m', blue: '\x1b[44m', magenta: '\x1b[45m', cyan: '\x1b[46m', green: '\x1b[42m', white: '\x1b[47m' },
    bright: '\x1b[1m',
    reset: '\x1b[0m'
  };
}

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const defaultConfig = {
  level: process.env.LOG_LEVEL || 'info',
  prettyPrint: process.env.NODE_ENV !== 'production',
  jsonOutput: process.env.LOG_JSON === 'true',
  enableRotation: process.env.LOG_ROTATION !== 'false',
  maxFiles: process.env.LOG_MAX_FILES || '14d',
  maxSize: process.env.LOG_MAX_SIZE || '20m',
};

// ==================== UTILITIES ====================

let correlationIdCounter = 0;

function generateCorrelationId() {
  const timestamp = Date.now();
  const counter = (++correlationIdCounter).toString().padStart(6, '0');
  return `${timestamp}-${counter}`;
}

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

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

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

// ==================== FORMATS ====================

const prettyPrintFormat = winston.format.printf((info) => {
  const { timestamp, level, message, stack, correlationId, duration, method, url, statusCode, userId, ...meta } = info;

  let output = '';
  output += `${colours.fg.gray}[${timestamp}]${colours.reset} `;
  output += `${getSeverityBadge(level)} `;
  if (correlationId) {
    output += `${colours.fg.cyan}[${correlationId}]${colours.reset} `;
  }
  output += `${message}`;

  if (method && url) {
    output += `\n  ${colours.fg.blue}→${colours.reset} ${colours.bright}${method}${colours.reset} ${url}`;
    if (statusCode) {
      const statusColor = statusCode >= 500 ? colours.fg.red :
                         statusCode >= 400 ? colours.fg.yellow :
                         statusCode >= 300 ? colours.fg.cyan : colours.fg.green;
      output += ` ${statusColor}${statusCode}${colours.reset}`;
    }
  }

  if (duration !== undefined) {
    const durationColor = duration > 1000 ? colours.fg.red :
                         duration > 500 ? colours.fg.yellow : colours.fg.green;
    output += ` ${durationColor}${formatDuration(duration)}${colours.reset}`;
  }

  if (userId) {
    output += `\n  ${colours.fg.gray}User:${colours.reset} ${userId}`;
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

const fileFormat = winston.format.printf((info) => {
  const { timestamp, level, message, stack, correlationId, duration, method, url, statusCode, userId, ...meta } = info;

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

const jsonFormat = winston.format.printf((info) => {
  return safeStringify(info, null);
});

// ==================== LOGGER CREATION ====================

function createBaseLogger(config = defaultConfig) {
  const transports = [];

  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        config.jsonOutput ? jsonFormat : (config.prettyPrint ? prettyPrintFormat : fileFormat)
      )
    })
  );

  if (config.enableRotation) {
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
  }

  return winston.createLogger({
    level: config.level,
    levels: winston.config.npm.levels,
    transports,
    exitOnError: false,
    exceptionHandlers: [
      new winston.transports.File({
        filename: path.join(logDir, 'exceptions.log'),
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
          winston.format.errors({ stack: true }),
          fileFormat
        )
      })
    ],
    rejectionHandlers: [
      new winston.transports.File({
        filename: path.join(logDir, 'rejections.log'),
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

// ==================== PERFORMANCE TRACKING ====================

const performanceMap = new Map();

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

// ==================== LOGGER OBJECT ====================

const logger = {
  init: async (client, database) => {
    baseLogger.info(`${colours.fg.green}✓${colours.reset} Logger initialized`, {
      correlationId: generateCorrelationId()
    });
  },

  info: (message, meta) => baseLogger.info(message, meta),
  warn: (message, meta) => baseLogger.warn(message, meta),
  error: (message, meta) => baseLogger.error(message, meta),
  debug: (message, meta) => baseLogger.debug(message, meta),
  verbose: (message, meta) => baseLogger.verbose(message, meta),
  http: (message, meta) => baseLogger.http(message, meta),

  withContext: (context) => createContextLogger(context),
  withCorrelationId: (correlationId) => {
    const id = correlationId || generateCorrelationId();
    return createContextLogger({ correlationId: id });
  },

  startTimer: (label) => {
    const timerId = `${label}-${generateCorrelationId()}`;
    performanceMap.set(timerId, { startTime: Date.now() });
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

  generateCorrelationId,
  child: (context) => createContextLogger(context),
};

// ==================== EXPORTS ====================

module.exports = logger;
module.exports.default = logger;
module.exports.logger = logger;
module.exports.generateCorrelationId = generateCorrelationId;
module.exports.formatBytes = formatBytes;
module.exports.formatDuration = formatDuration;
module.exports.safeStringify = safeStringify;
