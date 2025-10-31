import * as winston from 'winston';
import { Logger as WinstonLogger } from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import { EmbedBuilder, Client, TextChannel } from 'discord.js';
import { Connection, RowDataPacket } from 'mysql2/promise';
// Use require for winston-transport to avoid TypeScript compilation issues
const TransportStream = require('winston-transport');

const DailyRotateFile = require('winston-daily-rotate-file');

// ==================== TYPES ====================

interface LogConfigRow extends RowDataPacket {
    guild_id: string;
    log_channel_id: string | null;
    enabled_logs: string;
    log_categories: string;
}

interface LogInfo {
    level: string;
    message: string;
    guildId?: string;
    category?: string;
    error?: Error | any;
    stack?: string;
    correlationId?: string;
    requestId?: string;
    userId?: string;
    duration?: number;
    method?: string;
    url?: string;
    statusCode?: number;
    timestamp?: string;
    [key: string]: any;
}

interface LoggerConfig {
    level?: string;
    prettyPrint?: boolean;
    jsonOutput?: boolean;
    enableRotation?: boolean;
    maxFiles?: string;
    maxSize?: string;
    enablePerformanceMetrics?: boolean;
    enableRequestLogging?: boolean;
}

interface PerformanceMetrics {
    startTime: number;
    endTime?: number;
    duration?: number;
    memory?: NodeJS.MemoryUsage;
}

// ==================== CONFIGURATION ====================

const logDir: string = path.join(__dirname, '..', 'logs');
const colours = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'colours.json'), 'utf-8'));

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const defaultConfig: LoggerConfig = {
    level: process.env.LOG_LEVEL || 'info',
    prettyPrint: process.env.NODE_ENV !== 'production',
    jsonOutput: process.env.LOG_JSON === 'true',
    enableRotation: process.env.LOG_ROTATION !== 'false',
    maxFiles: process.env.LOG_MAX_FILES || '14d',
    maxSize: process.env.LOG_MAX_SIZE || '20m',
    enablePerformanceMetrics: process.env.LOG_PERFORMANCE === 'true',
    enableRequestLogging: process.env.LOG_REQUESTS !== 'false',
};

// ==================== UTILITIES ====================

let botClient: Client | null = null;
let db: Connection | null = null;
const performanceMap = new Map<string, PerformanceMetrics>();
let correlationIdCounter = 0;

/**
 * Generate a unique correlation ID for request tracking
 */
function generateCorrelationId(): string {
    const timestamp = Date.now();
    const counter = (++correlationIdCounter).toString().padStart(6, '0');
    return `${timestamp}-${counter}`;
}

/**
 * Safe JSON stringify that handles circular references and BigInts
 */
const safeStringify = (obj: any, indent: number | null = 2): string => {
    const cache = new Set<any>();
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
    }, indent as any);
    cache.clear();
    return retVal;
};

/**
 * Format stack trace for better readability
 */
function formatStackTrace(stack: string): string {
    const lines = stack.split('\n');
    const formatted: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('at ')) {
            // Highlight file paths
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
function getSeverityBadge(level: string): string {
    const badges: Record<string, string> = {
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
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}m`;
}

// ==================== CUSTOM FORMATS ====================

/**
 * Pretty print format for development
 */
const prettyPrintFormat = winston.format.printf((info: any) => {
    const { timestamp, level, message, stack, correlationId, requestId, duration, method, url, statusCode, userId, ...meta } = info;

    // Build the log line
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
    const metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
        // Remove winston internals
        const cleanMeta = { ...meta };
        delete cleanMeta.Symbol;
        delete cleanMeta[Symbol.for('level')];
        delete cleanMeta[Symbol.for('message')];
        delete cleanMeta[Symbol.for('splat')];

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
const jsonFormat = winston.format.printf((info: any) => {
    return safeStringify(info, null);
});

/**
 * File format (plain text, no colors)
 */
const fileFormat = winston.format.printf((info: any) => {
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

    const metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
        const cleanMeta = { ...meta };
        delete cleanMeta[Symbol.for('level')];
        delete cleanMeta[Symbol.for('message')];
        delete cleanMeta[Symbol.for('splat')];

        const cleanKeys = Object.keys(cleanMeta);
        if (cleanKeys.length > 0) {
            output += ` | Context: ${safeStringify(cleanMeta, null)}`;
        }
    }

    return output;
});

// ==================== CUSTOM TRANSPORTS ====================

/**
 * Discord transport for sending logs to Discord channels
 */
class DiscordTransport extends TransportStream {
    constructor(opts: any) {
        super(opts);
    }

    log(info: LogInfo, callback: () => void): void {
        setImmediate(() => this.emit('logged', info));

        if (!botClient || !db || !info.guildId) {
            return callback();
        }

        const { level, message, guildId, category = 'default', ...meta } = info;

        // Process Discord logging asynchronously
        (async () => {
            try {
                const [logConfigRows] = await db!.execute<LogConfigRow[]>(
                    'SELECT * FROM log_config WHERE guild_id = ?',
                    [guildId]
                );
                const logConfig = logConfigRows[0];

                if (!logConfig) return;

                const enabledLogs: string[] = JSON.parse(logConfig.enabled_logs || '[]');
                const logCategories: Record<string, string> = JSON.parse(logConfig.log_categories || '{}');
                const targetChannelId: string | null = logCategories[category] || logConfig.log_channel_id;
                const isCategoryEnabled: boolean = enabledLogs.includes(category) || enabledLogs.includes('all');

                if (!targetChannelId || !isCategoryEnabled) return;

                const channel = await botClient!.channels.fetch(targetChannelId).catch(() => null);
                if (!channel || !(channel instanceof TextChannel)) return;

                const embed = new EmbedBuilder()
                    .setTitle(`Log: ${category}`)
                    .setColor(level === 'error' ? '#FF0000' : level === 'warn' ? '#FFA500' : '#00FF00')
                    .setDescription(message)
                    .setTimestamp();

                // Add correlation ID if present
                if (meta.correlationId) {
                    embed.setFooter({ text: `Correlation ID: ${meta.correlationId}` });
                }

                if (meta && Object.keys(meta).length > 0) {
                    const errorStack: string | null = meta.error?.stack || (meta.error ? safeStringify(meta.error) : null);
                    if (errorStack) {
                        embed.addFields({ name: 'Error Stack', value: `\`\`\`sh\n${errorStack.substring(0, 1020)}\n\`\`\`` });
                        delete meta.error;
                    }

                    // Add performance metrics if present
                    if (meta.duration !== undefined) {
                        embed.addFields({ name: 'Duration', value: formatDuration(meta.duration), inline: true });
                        delete meta.duration;
                    }

                    const details = safeStringify(meta);
                    if (details !== '{}') {
                        embed.addFields({ name: 'Details', value: `\`\`\`json\n${details.substring(0, 1000)}\n\`\`\`` });
                    }
                }

                const webhooks = await channel.fetchWebhooks();
                const webhook = webhooks.find(wh => wh.owner?.id === botClient!.user!.id);

                if (webhook) {
                    await webhook.send({ embeds: [embed] });
                } else {
                    await channel.send({ embeds: [embed] });
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.error('[Logger] CRITICAL: Failed to send log to Discord:', errorMessage);
            }
        })();

        callback();
    }
}

// ==================== LOGGER CREATION ====================

/**
 * Create the base Winston logger with all transports
 */
function createBaseLogger(config: LoggerConfig = defaultConfig): WinstonLogger {
    const transports: any[] = [];

    // Console transport
    transports.push(
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
                winston.format.errors({ stack: true }),
                config.jsonOutput ? jsonFormat : (config.prettyPrint ? prettyPrintFormat : fileFormat)
            )
        })
    );

    // File transports with rotation
    if (config.enableRotation) {
        // Combined log with rotation
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

        // Error log with rotation
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

        // Performance log with rotation (if enabled)
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
                    // Only log entries with duration field
                    filter: (info: any) => info.duration !== undefined
                })
            );
        }

        // Request log with rotation (if enabled)
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
                    // Only log entries with method field
                    filter: (info: any) => info.method !== undefined
                })
            );
        }
    } else {
        // Static file without rotation
        transports.push(
            new winston.transports.File({
                filename: path.join(logDir, 'combined.log'),
                format: winston.format.combine(
                    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
                    winston.format.errors({ stack: true }),
                    fileFormat
                )
            })
        );

        transports.push(
            new winston.transports.File({
                filename: path.join(logDir, 'error.log'),
                level: 'error',
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
        // Prevent crashes from logger errors
        exitOnError: false,
        // Handle uncaught exceptions
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
        // Handle unhandled promise rejections
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

// ==================== ENHANCED LOGGER INTERFACE ====================

interface EnhancedLogger {
    // Initialization
    init: (client: Client, database: Connection) => void;

    // Standard logging methods
    info: (message: string, meta?: Record<string, any>) => void;
    warn: (message: string, meta?: Record<string, any>) => void;
    error: (message: string, meta?: Record<string, any>) => void;
    debug: (message: string, meta?: Record<string, any>) => void;
    verbose: (message: string, meta?: Record<string, any>) => void;
    http: (message: string, meta?: Record<string, any>) => void;

    // Context-aware logging
    withContext: (context: Record<string, any>) => ContextLogger;
    withCorrelationId: (correlationId?: string) => ContextLogger;

    // Performance tracking
    startTimer: (label: string) => string;
    endTimer: (timerId: string, message?: string, meta?: Record<string, any>) => void;

    // Request/Response logging
    logRequest: (method: string, url: string, meta?: Record<string, any>) => string;
    logResponse: (requestId: string, statusCode: number, meta?: Record<string, any>) => void;

    // Memory metrics
    logMemoryUsage: (label?: string) => void;

    // Utilities
    generateCorrelationId: () => string;
    child: (context: Record<string, any>) => ContextLogger;
}

interface ContextLogger {
    info: (message: string, meta?: Record<string, any>) => void;
    warn: (message: string, meta?: Record<string, any>) => void;
    error: (message: string, meta?: Record<string, any>) => void;
    debug: (message: string, meta?: Record<string, any>) => void;
    verbose: (message: string, meta?: Record<string, any>) => void;
    http: (message: string, meta?: Record<string, any>) => void;
}

/**
 * Create a context-aware logger
 */
function createContextLogger(context: Record<string, any>): ContextLogger {
    return {
        info: (message: string, meta?: Record<string, any>) =>
            baseLogger.info(message, { ...context, ...meta }),
        warn: (message: string, meta?: Record<string, any>) =>
            baseLogger.warn(message, { ...context, ...meta }),
        error: (message: string, meta?: Record<string, any>) =>
            baseLogger.error(message, { ...context, ...meta }),
        debug: (message: string, meta?: Record<string, any>) =>
            baseLogger.debug(message, { ...context, ...meta }),
        verbose: (message: string, meta?: Record<string, any>) =>
            baseLogger.verbose(message, { ...context, ...meta }),
        http: (message: string, meta?: Record<string, any>) =>
            baseLogger.http(message, { ...context, ...meta }),
    };
}

/**
 * Enhanced logger implementation
 */
const logger: EnhancedLogger = {
    // Initialize Discord transport
    init: (client: Client, database: Connection) => {
        if (botClient && db) return;
        botClient = client;
        db = database;
        baseLogger.add(new DiscordTransport({}) as any);
        baseLogger.info(`${colours.fg.green}✓${colours.reset} Discord transport initialized`, {
            correlationId: generateCorrelationId()
        });
    },

    // Standard logging methods
    info: (message: string, meta?: Record<string, any>) => baseLogger.info(message, meta),
    warn: (message: string, meta?: Record<string, any>) => baseLogger.warn(message, meta),
    error: (message: string, meta?: Record<string, any>) => baseLogger.error(message, meta),
    debug: (message: string, meta?: Record<string, any>) => baseLogger.debug(message, meta),
    verbose: (message: string, meta?: Record<string, any>) => baseLogger.verbose(message, meta),
    http: (message: string, meta?: Record<string, any>) => baseLogger.http(message, meta),

    // Context-aware logging
    withContext: (context: Record<string, any>) => createContextLogger(context),

    withCorrelationId: (correlationId?: string) => {
        const id = correlationId || generateCorrelationId();
        return createContextLogger({ correlationId: id });
    },

    // Performance tracking
    startTimer: (label: string): string => {
        const timerId = `${label}-${generateCorrelationId()}`;
        performanceMap.set(timerId, {
            startTime: Date.now(),
        });
        return timerId;
    },

    endTimer: (timerId: string, message?: string, meta?: Record<string, any>) => {
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
    logRequest: (method: string, url: string, meta?: Record<string, any>): string => {
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

    logResponse: (timerId: string, statusCode: number, meta?: Record<string, any>) => {
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
    logMemoryUsage: (label: string = 'Memory usage') => {
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

    child: (context: Record<string, any>) => createContextLogger(context),
};

// ==================== EXPRESS MIDDLEWARE ====================

/**
 * Express middleware for automatic request/response logging
 */
export function requestLoggerMiddleware(req: any, res: any, next: any) {
    const timerId = logger.logRequest(req.method, req.url, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        correlationId: req.headers['x-correlation-id'] || generateCorrelationId(),
    });

    // Store timer ID on response object
    res.locals.timerId = timerId;
    res.locals.correlationId = req.headers['x-correlation-id'];

    // Override res.json to log response
    const originalJson = res.json.bind(res);
    res.json = function(body: any) {
        logger.logResponse(res.locals.timerId, res.statusCode, {
            correlationId: res.locals.correlationId,
        });
        return originalJson(body);
    };

    // Override res.send to log response
    const originalSend = res.send.bind(res);
    res.send = function(body: any) {
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
    EnhancedLogger,
    ContextLogger,
    LoggerConfig,
    generateCorrelationId,
    formatBytes,
    formatDuration,
    safeStringify,
};
