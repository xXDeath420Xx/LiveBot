"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeStringify = exports.logger = void 0;
exports.requestLoggerMiddleware = requestLoggerMiddleware;
exports.generateCorrelationId = generateCorrelationId;
exports.formatBytes = formatBytes;
exports.formatDuration = formatDuration;
var winston = __importStar(require("winston"));
var path = __importStar(require("path"));
var fs = __importStar(require("fs"));
var discord_js_1 = require("discord.js");
// Use require for winston-transport to avoid TypeScript compilation issues
var TransportStream = require('winston-transport');
var DailyRotateFile = require('winston-daily-rotate-file');
// ==================== CONFIGURATION ====================
var logDir = path.join(__dirname, '..', 'logs');
var colours = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'colours.json'), 'utf-8'));
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}
var defaultConfig = {
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
var botClient = null;
var db = null;
var performanceMap = new Map();
var correlationIdCounter = 0;
/**
 * Generate a unique correlation ID for request tracking
 */
function generateCorrelationId() {
    var timestamp = Date.now();
    var counter = (++correlationIdCounter).toString().padStart(6, '0');
    return "".concat(timestamp, "-").concat(counter);
}
/**
 * Safe JSON stringify that handles circular references and BigInts
 */
var safeStringify = function (obj, indent) {
    if (indent === void 0) { indent = 2; }
    var cache = new Set();
    var retVal = JSON.stringify(obj, function (_key, value) {
        if (typeof value === 'object' && value !== null) {
            if (cache.has(value))
                return '[Circular]';
            cache.add(value);
        }
        if (typeof value === 'bigint')
            return value.toString();
        if (value instanceof Error) {
            return __assign({ name: value.name, message: value.message, stack: value.stack }, value);
        }
        return value;
    }, indent);
    cache.clear();
    return retVal;
};
exports.safeStringify = safeStringify;
/**
 * Format stack trace for better readability
 */
function formatStackTrace(stack) {
    var lines = stack.split('\n');
    var formatted = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('at ')) {
            // Highlight file paths
            var match = line.match(/\((.+?):(\d+):(\d+)\)/) || line.match(/at (.+?):(\d+):(\d+)/);
            if (match) {
                var file = match[1], lineNum = match[2], col = match[3];
                var shortPath = file.replace(process.cwd(), '.');
                formatted.push("  ".concat(colours.fg.gray, "at").concat(colours.reset, " ").concat(colours.fg.cyan).concat(shortPath).concat(colours.reset, ":").concat(colours.fg.yellow).concat(lineNum).concat(colours.reset, ":").concat(col));
            }
            else {
                formatted.push("  ".concat(colours.fg.gray).concat(line).concat(colours.reset));
            }
        }
        else {
            formatted.push("".concat(colours.bright).concat(colours.fg.red).concat(line).concat(colours.reset));
        }
    }
    return formatted.join('\n');
}
/**
 * Get colored severity level badge
 */
function getSeverityBadge(level) {
    var badges = {
        error: "".concat(colours.bg.red).concat(colours.fg.white).concat(colours.bright, " ERROR ").concat(colours.reset),
        warn: "".concat(colours.bg.yellow).concat(colours.fg.black).concat(colours.bright, " WARN  ").concat(colours.reset),
        info: "".concat(colours.bg.blue).concat(colours.fg.white).concat(colours.bright, " INFO  ").concat(colours.reset),
        debug: "".concat(colours.bg.magenta).concat(colours.fg.white).concat(colours.bright, " DEBUG ").concat(colours.reset),
        verbose: "".concat(colours.bg.cyan).concat(colours.fg.black).concat(colours.bright, " VERB  ").concat(colours.reset),
        http: "".concat(colours.bg.green).concat(colours.fg.white).concat(colours.bright, " HTTP  ").concat(colours.reset),
    };
    return badges[level] || badges.info;
}
/**
 * Format bytes for memory usage display
 */
function formatBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return "".concat(parseFloat((bytes / Math.pow(k, i)).toFixed(2)), " ").concat(sizes[i]);
}
/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms) {
    if (ms < 1000)
        return "".concat(ms.toFixed(2), "ms");
    if (ms < 60000)
        return "".concat((ms / 1000).toFixed(2), "s");
    return "".concat((ms / 60000).toFixed(2), "m");
}
// ==================== CUSTOM FORMATS ====================
/**
 * Pretty print format for development
 */
var prettyPrintFormat = winston.format.printf(function (info) {
    var timestamp = info.timestamp, level = info.level, message = info.message, stack = info.stack, correlationId = info.correlationId, requestId = info.requestId, duration = info.duration, method = info.method, url = info.url, statusCode = info.statusCode, userId = info.userId, meta = __rest(info, ["timestamp", "level", "message", "stack", "correlationId", "requestId", "duration", "method", "url", "statusCode", "userId"]);
    // Build the log line
    var output = '';
    // Timestamp
    output += "".concat(colours.fg.gray, "[").concat(timestamp, "]").concat(colours.reset, " ");
    // Severity badge
    output += "".concat(getSeverityBadge(level), " ");
    // Correlation ID (if present)
    if (correlationId) {
        output += "".concat(colours.fg.cyan, "[").concat(correlationId, "]").concat(colours.reset, " ");
    }
    // Message
    output += "".concat(message);
    // Request details (if present)
    if (method && url) {
        output += "\n  ".concat(colours.fg.blue, "\u2192").concat(colours.reset, " ").concat(colours.bright).concat(method).concat(colours.reset, " ").concat(url);
        if (statusCode) {
            var statusColor = statusCode >= 500 ? colours.fg.red :
                statusCode >= 400 ? colours.fg.yellow :
                    statusCode >= 300 ? colours.fg.cyan : colours.fg.green;
            output += " ".concat(statusColor).concat(statusCode).concat(colours.reset);
        }
    }
    // Duration (if present)
    if (duration !== undefined) {
        var durationColor = duration > 1000 ? colours.fg.red :
            duration > 500 ? colours.fg.yellow : colours.fg.green;
        output += " ".concat(durationColor).concat(formatDuration(duration)).concat(colours.reset);
    }
    // User ID (if present)
    if (userId) {
        output += "\n  ".concat(colours.fg.gray, "User:").concat(colours.reset, " ").concat(userId);
    }
    // Request ID (if present and different from correlation ID)
    if (requestId && requestId !== correlationId) {
        output += "\n  ".concat(colours.fg.gray, "Request:").concat(colours.reset, " ").concat(requestId);
    }
    // Stack trace
    if (stack) {
        output += "\n".concat(formatStackTrace(stack));
    }
    // Additional metadata
    var metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
        // Remove winston internals
        var cleanMeta = __assign({}, meta);
        delete cleanMeta.Symbol;
        delete cleanMeta[Symbol.for('level')];
        delete cleanMeta[Symbol.for('message')];
        delete cleanMeta[Symbol.for('splat')];
        var cleanKeys = Object.keys(cleanMeta);
        if (cleanKeys.length > 0) {
            output += "\n  ".concat(colours.fg.gray, "Context:").concat(colours.reset);
            for (var _i = 0, cleanKeys_1 = cleanKeys; _i < cleanKeys_1.length; _i++) {
                var key = cleanKeys_1[_i];
                var value = cleanMeta[key];
                if (typeof value === 'object') {
                    output += "\n    ".concat(colours.fg.yellow).concat(key).concat(colours.reset, ": ").concat(safeStringify(value, null));
                }
                else {
                    output += "\n    ".concat(colours.fg.yellow).concat(key).concat(colours.reset, ": ").concat(value);
                }
            }
        }
    }
    return output;
});
/**
 * JSON format for structured logging
 */
var jsonFormat = winston.format.printf(function (info) {
    return safeStringify(info, null);
});
/**
 * File format (plain text, no colors)
 */
var fileFormat = winston.format.printf(function (info) {
    var timestamp = info.timestamp, level = info.level, message = info.message, stack = info.stack, correlationId = info.correlationId, requestId = info.requestId, duration = info.duration, method = info.method, url = info.url, statusCode = info.statusCode, userId = info.userId, meta = __rest(info, ["timestamp", "level", "message", "stack", "correlationId", "requestId", "duration", "method", "url", "statusCode", "userId"]);
    var output = "[".concat(timestamp, "] [").concat(level.toUpperCase(), "]");
    if (correlationId) {
        output += " [".concat(correlationId, "]");
    }
    output += " ".concat(message);
    if (method && url) {
        output += " | ".concat(method, " ").concat(url);
        if (statusCode) {
            output += " ".concat(statusCode);
        }
    }
    if (duration !== undefined) {
        output += " (".concat(formatDuration(duration), ")");
    }
    if (userId) {
        output += " | User: ".concat(userId);
    }
    if (requestId && requestId !== correlationId) {
        output += " | Request: ".concat(requestId);
    }
    if (stack) {
        output += "\n".concat(stack);
    }
    var metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
        var cleanMeta = __assign({}, meta);
        delete cleanMeta[Symbol.for('level')];
        delete cleanMeta[Symbol.for('message')];
        delete cleanMeta[Symbol.for('splat')];
        var cleanKeys = Object.keys(cleanMeta);
        if (cleanKeys.length > 0) {
            output += " | Context: ".concat(safeStringify(cleanMeta, null));
        }
    }
    return output;
});
// ==================== CUSTOM TRANSPORTS ====================
/**
 * Discord transport for sending logs to Discord channels
 */
var DiscordTransport = /** @class */ (function (_super) {
    __extends(DiscordTransport, _super);
    function DiscordTransport(opts) {
        return _super.call(this, opts) || this;
    }
    DiscordTransport.prototype.log = function (info, callback) {
        var _this = this;
        setImmediate(function () { return _this.emit('logged', info); });
        if (!botClient || !db || !info.guildId) {
            return callback();
        }
        var level = info.level, message = info.message, guildId = info.guildId, _a = info.category, category = _a === void 0 ? 'default' : _a, meta = __rest(info, ["level", "message", "guildId", "category"]);
        // Process Discord logging asynchronously
        (function () { return __awaiter(_this, void 0, void 0, function () {
            var logConfigRows, logConfig, enabledLogs, logCategories, targetChannelId, isCategoryEnabled, channel, embed, errorStack, details, webhooks, webhook, error_1, errorMessage;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 8, , 9]);
                        return [4 /*yield*/, db.execute('SELECT * FROM log_config WHERE guild_id = ?', [guildId])];
                    case 1:
                        logConfigRows = (_b.sent())[0];
                        logConfig = logConfigRows[0];
                        if (!logConfig)
                            return [2 /*return*/];
                        enabledLogs = JSON.parse(logConfig.enabled_logs || '[]');
                        logCategories = JSON.parse(logConfig.log_categories || '{}');
                        targetChannelId = logCategories[category] || logConfig.log_channel_id;
                        isCategoryEnabled = enabledLogs.includes(category) || enabledLogs.includes('all');
                        if (!targetChannelId || !isCategoryEnabled)
                            return [2 /*return*/];
                        return [4 /*yield*/, botClient.channels.fetch(targetChannelId).catch(function () { return null; })];
                    case 2:
                        channel = _b.sent();
                        if (!channel || !(channel instanceof discord_js_1.TextChannel))
                            return [2 /*return*/];
                        embed = new discord_js_1.EmbedBuilder()
                            .setTitle("Log: ".concat(category))
                            .setColor(level === 'error' ? '#FF0000' : level === 'warn' ? '#FFA500' : '#00FF00')
                            .setDescription(message)
                            .setTimestamp();
                        // Add correlation ID if present
                        if (meta.correlationId) {
                            embed.setFooter({ text: "Correlation ID: ".concat(meta.correlationId) });
                        }
                        if (meta && Object.keys(meta).length > 0) {
                            errorStack = ((_a = meta.error) === null || _a === void 0 ? void 0 : _a.stack) || (meta.error ? safeStringify(meta.error) : null);
                            if (errorStack) {
                                embed.addFields({ name: 'Error Stack', value: "```sh\n".concat(errorStack.substring(0, 1020), "\n```") });
                                delete meta.error;
                            }
                            // Add performance metrics if present
                            if (meta.duration !== undefined) {
                                embed.addFields({ name: 'Duration', value: formatDuration(meta.duration), inline: true });
                                delete meta.duration;
                            }
                            details = safeStringify(meta);
                            if (details !== '{}') {
                                embed.addFields({ name: 'Details', value: "```json\n".concat(details.substring(0, 1000), "\n```") });
                            }
                        }
                        return [4 /*yield*/, channel.fetchWebhooks()];
                    case 3:
                        webhooks = _b.sent();
                        webhook = webhooks.find(function (wh) { var _a; return ((_a = wh.owner) === null || _a === void 0 ? void 0 : _a.id) === botClient.user.id; });
                        if (!webhook) return [3 /*break*/, 5];
                        return [4 /*yield*/, webhook.send({ embeds: [embed] })];
                    case 4:
                        _b.sent();
                        return [3 /*break*/, 7];
                    case 5: return [4 /*yield*/, channel.send({ embeds: [embed] })];
                    case 6:
                        _b.sent();
                        _b.label = 7;
                    case 7: return [3 /*break*/, 9];
                    case 8:
                        error_1 = _b.sent();
                        errorMessage = error_1 instanceof Error ? error_1.message : 'Unknown error';
                        console.error('[Logger] CRITICAL: Failed to send log to Discord:', errorMessage);
                        return [3 /*break*/, 9];
                    case 9: return [2 /*return*/];
                }
            });
        }); })();
        callback();
    };
    return DiscordTransport;
}(TransportStream));
// ==================== LOGGER CREATION ====================
/**
 * Create the base Winston logger with all transports
 */
function createBaseLogger(config) {
    if (config === void 0) { config = defaultConfig; }
    var transports = [];
    // Console transport
    transports.push(new winston.transports.Console({
        format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston.format.errors({ stack: true }), config.jsonOutput ? jsonFormat : (config.prettyPrint ? prettyPrintFormat : fileFormat))
    }));
    // File transports with rotation
    if (config.enableRotation) {
        // Combined log with rotation
        transports.push(new DailyRotateFile({
            dirname: logDir,
            filename: 'combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: config.maxSize,
            maxFiles: config.maxFiles,
            format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston.format.errors({ stack: true }), fileFormat)
        }));
        // Error log with rotation
        transports.push(new DailyRotateFile({
            dirname: logDir,
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxSize: config.maxSize,
            maxFiles: config.maxFiles,
            format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston.format.errors({ stack: true }), fileFormat)
        }));
        // Performance log with rotation (if enabled)
        if (config.enablePerformanceMetrics) {
            transports.push(new DailyRotateFile({
                dirname: logDir,
                filename: 'performance-%DATE%.log',
                datePattern: 'YYYY-MM-DD',
                maxSize: config.maxSize,
                maxFiles: config.maxFiles,
                format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), jsonFormat),
                // Only log entries with duration field
                filter: function (info) { return info.duration !== undefined; }
            }));
        }
        // Request log with rotation (if enabled)
        if (config.enableRequestLogging) {
            transports.push(new DailyRotateFile({
                dirname: logDir,
                filename: 'requests-%DATE%.log',
                datePattern: 'YYYY-MM-DD',
                maxSize: config.maxSize,
                maxFiles: config.maxFiles,
                format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), fileFormat),
                // Only log entries with method field
                filter: function (info) { return info.method !== undefined; }
            }));
        }
    }
    else {
        // Static file without rotation
        transports.push(new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston.format.errors({ stack: true }), fileFormat)
        }));
        transports.push(new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston.format.errors({ stack: true }), fileFormat)
        }));
    }
    return winston.createLogger({
        level: config.level,
        levels: winston.config.npm.levels,
        transports: transports,
        // Prevent crashes from logger errors
        exitOnError: false,
        // Handle uncaught exceptions
        exceptionHandlers: [
            new winston.transports.File({
                filename: path.join(logDir, 'exceptions.log'),
                format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston.format.errors({ stack: true }), fileFormat)
            })
        ],
        // Handle unhandled promise rejections
        rejectionHandlers: [
            new winston.transports.File({
                filename: path.join(logDir, 'rejections.log'),
                format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston.format.errors({ stack: true }), fileFormat)
            })
        ]
    });
}
var baseLogger = createBaseLogger(defaultConfig);
/**
 * Create a context-aware logger
 */
function createContextLogger(context) {
    return {
        info: function (message, meta) {
            return baseLogger.info(message, __assign(__assign({}, context), meta));
        },
        warn: function (message, meta) {
            return baseLogger.warn(message, __assign(__assign({}, context), meta));
        },
        error: function (message, meta) {
            return baseLogger.error(message, __assign(__assign({}, context), meta));
        },
        debug: function (message, meta) {
            return baseLogger.debug(message, __assign(__assign({}, context), meta));
        },
        verbose: function (message, meta) {
            return baseLogger.verbose(message, __assign(__assign({}, context), meta));
        },
        http: function (message, meta) {
            return baseLogger.http(message, __assign(__assign({}, context), meta));
        },
    };
}
/**
 * Enhanced logger implementation
 */
var logger = {
    // Initialize Discord transport
    init: function (client, database) {
        if (botClient && db)
            return;
        botClient = client;
        db = database;
        baseLogger.add(new DiscordTransport({}));
        baseLogger.info("".concat(colours.fg.green, "\u2713").concat(colours.reset, " Discord transport initialized"), {
            correlationId: generateCorrelationId()
        });
    },
    // Standard logging methods
    info: function (message, meta) { return baseLogger.info(message, meta); },
    warn: function (message, meta) { return baseLogger.warn(message, meta); },
    error: function (message, meta) { return baseLogger.error(message, meta); },
    debug: function (message, meta) { return baseLogger.debug(message, meta); },
    verbose: function (message, meta) { return baseLogger.verbose(message, meta); },
    http: function (message, meta) { return baseLogger.http(message, meta); },
    // Context-aware logging
    withContext: function (context) { return createContextLogger(context); },
    withCorrelationId: function (correlationId) {
        var id = correlationId || generateCorrelationId();
        return createContextLogger({ correlationId: id });
    },
    // Performance tracking
    startTimer: function (label) {
        var timerId = "".concat(label, "-").concat(generateCorrelationId());
        performanceMap.set(timerId, {
            startTime: Date.now(),
        });
        return timerId;
    },
    endTimer: function (timerId, message, meta) {
        var metrics = performanceMap.get(timerId);
        if (!metrics) {
            baseLogger.warn("Timer not found: ".concat(timerId));
            return;
        }
        metrics.endTime = Date.now();
        metrics.duration = metrics.endTime - metrics.startTime;
        metrics.memory = process.memoryUsage();
        var logMessage = message || "Timer completed: ".concat(timerId);
        baseLogger.info(logMessage, __assign(__assign({}, meta), { duration: metrics.duration, memoryUsage: {
                heapUsed: formatBytes(metrics.memory.heapUsed),
                heapTotal: formatBytes(metrics.memory.heapTotal),
                rss: formatBytes(metrics.memory.rss),
            } }));
        performanceMap.delete(timerId);
    },
    // Request/Response logging
    logRequest: function (method, url, meta) {
        var requestId = generateCorrelationId();
        var timerId = logger.startTimer("request-".concat(requestId));
        baseLogger.http("Incoming request", __assign(__assign({}, meta), { method: method, url: url, requestId: requestId, correlationId: requestId, timerId: timerId }));
        return timerId;
    },
    logResponse: function (timerId, statusCode, meta) {
        var metrics = performanceMap.get(timerId);
        if (!metrics) {
            baseLogger.warn("Request timer not found: ".concat(timerId));
            return;
        }
        metrics.endTime = Date.now();
        metrics.duration = metrics.endTime - metrics.startTime;
        var level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'http';
        baseLogger.log(level, "Request completed", __assign(__assign({}, meta), { statusCode: statusCode, duration: metrics.duration }));
        performanceMap.delete(timerId);
    },
    // Memory metrics
    logMemoryUsage: function (label) {
        if (label === void 0) { label = 'Memory usage'; }
        var usage = process.memoryUsage();
        baseLogger.info(label, {
            heapUsed: formatBytes(usage.heapUsed),
            heapTotal: formatBytes(usage.heapTotal),
            rss: formatBytes(usage.rss),
            external: formatBytes(usage.external),
            arrayBuffers: formatBytes(usage.arrayBuffers),
        });
    },
    // Utilities
    generateCorrelationId: generateCorrelationId,
    child: function (context) { return createContextLogger(context); },
};
exports.logger = logger;
// ==================== EXPRESS MIDDLEWARE ====================
/**
 * Express middleware for automatic request/response logging
 */
function requestLoggerMiddleware(req, res, next) {
    var timerId = logger.logRequest(req.method, req.url, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        correlationId: req.headers['x-correlation-id'] || generateCorrelationId(),
    });
    // Store timer ID on response object
    res.locals.timerId = timerId;
    res.locals.correlationId = req.headers['x-correlation-id'];
    // Override res.json to log response
    var originalJson = res.json.bind(res);
    res.json = function (body) {
        logger.logResponse(res.locals.timerId, res.statusCode, {
            correlationId: res.locals.correlationId,
        });
        return originalJson(body);
    };
    // Override res.send to log response
    var originalSend = res.send.bind(res);
    res.send = function (body) {
        logger.logResponse(res.locals.timerId, res.statusCode, {
            correlationId: res.locals.correlationId,
        });
        return originalSend(body);
    };
    n