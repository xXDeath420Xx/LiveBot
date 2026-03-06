/**
 * Centralized Constants
 * Eliminates magic numbers throughout the codebase
 */

// ==============================================
// AUTHORIZATION
// ==============================================

// Bot owner/super admin - has full access to all features
// IMPORTANT: Loaded from environment variable - no hardcoded fallback for security
export const SUPER_ADMIN_ID = process.env.BOT_OWNER_ID;

// Additional super admins (comma-separated in env, or hardcoded)
const SUPER_ADMIN_IDS = new Set([
    process.env.BOT_OWNER_ID,
    '685127470625980501',
    ...(process.env.SUPER_ADMIN_IDS ? process.env.SUPER_ADMIN_IDS.split(',').map(id => id.trim()) : [])
].filter(Boolean));

/**
 * Check if a user ID is a super admin
 * @param {string} userId - Discord user ID to check
 * @returns {boolean} - True if user is super admin
 */
export function isSuperAdmin(userId) {
    if (!userId) return false;
    return SUPER_ADMIN_IDS.has(userId);
}

// ==============================================
// INPUT VALIDATION LIMITS
// ==============================================

export const INPUT_LIMITS = {
    // Log viewer
    MAX_LOG_LINES: 500,
    MIN_LOG_LINES: 1,
    DEFAULT_LOG_LINES: 100,

    // Date ranges
    MAX_DAYS_QUERY: 365,
    MIN_DAYS_QUERY: 1,
    DEFAULT_DAYS_QUERY: 30,

    // String lengths
    MAX_SEARCH_QUERY: 500,
    MAX_USERNAME_LENGTH: 32,
    MAX_REASON_LENGTH: 512,
    MAX_CUSTOM_MESSAGE: 2000,
    MAX_WELCOME_MESSAGE: 2000,
    MAX_EMBED_TITLE: 256,
    MAX_EMBED_DESCRIPTION: 4096,

    // Pagination
    MAX_PAGE_SIZE: 100,
    DEFAULT_PAGE_SIZE: 20,
    MIN_PAGE_SIZE: 1,

    // Discord IDs (snowflakes are 17-20 digits)
    DISCORD_ID_MIN_LENGTH: 17,
    DISCORD_ID_MAX_LENGTH: 20,
};

// ==============================================
// VALIDATION PATTERNS
// ==============================================

export const VALIDATION = {
    // Discord snowflake ID pattern (17-20 digit number)
    DISCORD_ID: /^\d{17,20}$/,

    // Voice name pattern (alphanumeric, dash, underscore)
    VOICE_NAME: /^[a-zA-Z0-9_-]{1,50}$/,

    // Process name pattern (safe for file system)
    PROCESS_NAME: /^[a-zA-Z0-9_-]+$/,

    // Username pattern (Discord username rules)
    USERNAME: /^[a-zA-Z0-9_.]{2,32}$/,
};

/**
 * Validate a Discord snowflake ID
 * @param {string} id - ID to validate
 * @returns {boolean} - True if valid Discord ID
 */
export function isValidDiscordId(id) {
    if (typeof id !== 'string') return false;
    return VALIDATION.DISCORD_ID.test(id);
}

// ==============================================
// TEXT SANITIZATION
// ==============================================

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text safe for HTML
 */
export function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const htmlEscapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (match) => htmlEscapeMap[match] || match);
}

/**
 * Escape text for safe inclusion in JSON within HTML attributes
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text safe for JSON in HTML
 */
export function escapeJsonHtml(text) {
    if (typeof text !== 'string') return '';
    // Escape forward slashes to prevent </script> attacks in JSON
    return text.replace(/[<>\/]/g, (match) => {
        return { '<': '\\u003c', '>': '\\u003e', '/': '\\/' }[match];
    });
}

// ==============================================
// TIME INTERVALS
// ==============================================

// Time intervals in milliseconds
export const INTERVALS = {
    // Short intervals
    ONE_SECOND: 1000,
    FIVE_SECONDS: 5 * 1000,
    TEN_SECONDS: 10 * 1000,
    THIRTY_SECONDS: 30 * 1000,

    // Minute-based intervals
    ONE_MINUTE: 60 * 1000,
    TWO_MINUTES: 2 * 60 * 1000,
    FIVE_MINUTES: 5 * 60 * 1000,
    TEN_MINUTES: 10 * 60 * 1000,
    FIFTEEN_MINUTES: 15 * 60 * 1000,
    THIRTY_MINUTES: 30 * 60 * 1000,

    // Hour-based intervals
    ONE_HOUR: 60 * 60 * 1000,
    TWO_HOURS: 2 * 60 * 60 * 1000,
    SIX_HOURS: 6 * 60 * 60 * 1000,
    TWELVE_HOURS: 12 * 60 * 60 * 1000,

    // Day-based intervals
    ONE_DAY: 24 * 60 * 60 * 1000,
    ONE_WEEK: 7 * 24 * 60 * 60 * 1000,
    ONE_MONTH: 30 * 24 * 60 * 60 * 1000,
};

// Cache-specific TTLs
export const CACHE_TTL = {
    CONFIG: INTERVALS.ONE_MINUTE,              // Guild config cache
    USER_DATA: INTERVALS.FIVE_MINUTES,         // User data cache
    WEBHOOK: INTERVALS.FIVE_MINUTES,           // Webhook cache
    STREAM_STATUS: INTERVALS.THIRTY_SECONDS,   // Stream live status
    API_RESPONSE: INTERVALS.TWO_MINUTES,       // External API responses
    LEADERBOARD: INTERVALS.FIVE_MINUTES,       // Leaderboard data
    PERMISSIONS: INTERVALS.ONE_MINUTE,         // Permission checks
};

// Cache size limits
export const CACHE_LIMITS = {
    // Small caches
    GUILD_CONFIG: 5000,
    WEBHOOK: 1000,

    // Medium caches
    USER_ECONOMY: 10000,
    VOICE_SESSIONS: 10000,
    STREAMER_STATUS: 5000,

    // Large caches
    XP_COOLDOWNS: 50000,
    MESSAGE_HASHES: 50000,
    ANTI_SPAM: 50000,
    HEAT_TRACKING: 50000,

    // Very large caches
    ACTIVITY_LOG: 100000,
};

// Rate limiting
export const RATE_LIMITS = {
    // Discord API
    DISCORD_REQUESTS_PER_SECOND: 50,
    DISCORD_GLOBAL_LIMIT: 50,

    // External APIs
    TWITCH_REQUESTS_PER_MINUTE: 800,
    YOUTUBE_REQUESTS_PER_DAY: 10000,
    KICK_REQUESTS_PER_MINUTE: 60,

    // Internal rate limits
    XP_COOLDOWN: INTERVALS.ONE_MINUTE,
    COMMAND_COOLDOWN: INTERVALS.FIVE_SECONDS,
    WELCOME_DEDUP: INTERVALS.THIRTY_SECONDS,
};

// Timeouts for external operations
export const TIMEOUTS = {
    // Process spawns
    YTDLP: 12000,
    FFMPEG: 30000,

    // API calls
    EXTERNAL_API: 5000,      // Reduced from 10s to 5s for faster responses
    EXTERNAL_API_SLOW: 10000, // For APIs known to be slow
    WEBHOOK_SEND: 5000,

    // Database operations
    DB_QUERY: 30000,
    DB_TRANSACTION: 60000,

    // Discord operations
    MESSAGE_SEND: 5000,
    REACTION_ADD: 3000,
};

// Scheduler intervals
export const SCHEDULER = {
    STREAM_CHECK: INTERVALS.ONE_MINUTE,
    FREE_GAMES_CHECK: INTERVALS.SIX_HOURS,
    BIRTHDAY_CHECK: INTERVALS.ONE_HOUR,
    REMINDER_CHECK: INTERVALS.ONE_MINUTE,
    CLEANUP: INTERVALS.TEN_MINUTES,
    STATS_FLUSH: INTERVALS.FIVE_MINUTES,
    MEMORY_LOG: INTERVALS.ONE_MINUTE,
};

// Retry configuration
export const RETRY = {
    MAX_ATTEMPTS: 3,
    INITIAL_DELAY: 1000,
    MAX_DELAY: 30000,
    BACKOFF_MULTIPLIER: 2,
};

// Message limits
export const LIMITS = {
    EMBED_TITLE: 256,
    EMBED_DESCRIPTION: 4096,
    EMBED_FIELD_NAME: 256,
    EMBED_FIELD_VALUE: 1024,
    EMBED_FOOTER: 2048,
    EMBED_AUTHOR: 256,
    EMBED_FIELDS: 25,
    MESSAGE_CONTENT: 2000,
    BULK_DELETE: 100,
    REACTION_USERS: 100,
};

// Default values
export const DEFAULTS = {
    XP_PER_MESSAGE: { min: 15, max: 25 },
    XP_PER_VOICE_MINUTE: 5,
    LEVEL_MULTIPLIER: 100,
    ECONOMY_STARTING_BALANCE: 0,
    LEADERBOARD_PAGE_SIZE: 10,
};

// Error codes
export const ERROR_CODES = {
    // Database errors
    DB_CONNECTION_FAILED: 'DB_CONN_FAIL',
    DB_QUERY_FAILED: 'DB_QUERY_FAIL',
    DB_TIMEOUT: 'DB_TIMEOUT',

    // API errors
    API_RATE_LIMITED: 'API_RATE_LIMIT',
    API_TIMEOUT: 'API_TIMEOUT',
    API_UNAVAILABLE: 'API_UNAVAIL',

    // Discord errors
    DISCORD_PERMISSION: 'DISCORD_PERM',
    DISCORD_NOT_FOUND: 'DISCORD_404',
    DISCORD_RATE_LIMITED: 'DISCORD_RATE',

    // Internal errors
    CACHE_MISS: 'CACHE_MISS',
    VALIDATION_FAILED: 'VALIDATE_FAIL',
    CONFIG_MISSING: 'CONFIG_MISS',
};

export default {
    SUPER_ADMIN_ID,
    isSuperAdmin,
    INPUT_LIMITS,
    VALIDATION,
    isValidDiscordId,
    escapeHtml,
    escapeJsonHtml,
    INTERVALS,
    CACHE_TTL,
    CACHE_LIMITS,
    RATE_LIMITS,
    TIMEOUTS,
    SCHEDULER,
    RETRY,
    LIMITS,
    DEFAULTS,
    ERROR_CODES,
};
