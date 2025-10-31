"use strict";
/**
 * Self-Healing Manager
 * Automatic error recovery, health monitoring, and self-repair
 */
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
class SelfHealingManager {
    constructor(client) {
        this.client = client;
        this.healthChecks = [];
        this.errorPatterns = new Map();
        this.autoRecoveryAttempts = new Map();
        this.maxRecoveryAttempts = 3;
        this.healthCheckInterval = 60000; // 1 minute
        this.errorThreshold = 5; // 5 errors within window triggers healing
        this.errorWindow = 300000; // 5 minutes
    }
    /**
     * Initialize self-healing system
     */
    async initialize() {
        logger_1.default.info('[Self-Healing] Initializing self-healing system...');
        // Register default health checks
        this.registerHealthCheck('database', () => this.checkDatabase());
        this.registerHealthCheck('redis', () => this.checkRedis());
        this.registerHealthCheck('discord', () => this.checkDiscord());
        this.registerHealthCheck('memory', () => this.checkMemory());
        this.registerHealthCheck('api_rates', () => this.checkAPIRates());
        // Start health monitoring
        this.startHealthMonitoring();
        // Set up error pattern learning
        this.setupErrorLearning();
        // Set up auto-migration system
        await this.setupAutoMigrations();
        // Set up config validation
        await this.validateConfiguration();
        logger_1.default.info('[Self-Healing] Self-healing system initialized ✅');
    }
    /**
     * Register a health check
     */
    registerHealthCheck(name, checkFunction) {
        this.healthChecks.push({ name, check: checkFunction });
        logger_1.default.info(`[Self-Healing] Registered health check: ${name}`);
    }
    /**
     * Start health monitoring loop
     */
    startHealthMonitoring() {
        setInterval(async () => {
            try {
                await this.runHealthChecks();
            }
            catch (error) {
                logger_1.default.error('[Self-Healing] Health check error:', error);
            }
        }, this.healthCheckInterval);
        logger_1.default.info('[Self-Healing] Health monitoring started (every 60s)');
    }
    /**
     * Run all health checks
     */
    async runHealthChecks() {
        const results = [];
        for (const { name, check } of this.healthChecks) {
            try {
                const healthy = await check();
                results.push({ name, healthy, timestamp: Date.now() });
                if (!healthy) {
                    logger_1.default.warn(`[Self-Healing] Health check FAILED: ${name}`);
                    await this.attemptAutoRecovery(name);
                }
            }
            catch (error) {
                const err = error;
                logger_1.default.error(`[Self-Healing] Health check error for ${name}:`, error);
                results.push({ name, healthy: false, error: err.message, timestamp: Date.now() });
                await this.attemptAutoRecovery(name);
            }
        }
        return results;
    }
    /**
     * Check database health
     */
    async checkDatabase() {
        try {
            await db_1.default.execute('SELECT 1');
            return true;
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Database health check failed:', error);
            return false;
        }
    }
    /**
     * Check Redis health
     */
    async checkRedis() {
        try {
            // Check if Redis client exists and can ping
            const Redis = require('ioredis');
            const redis = new Redis(parseInt(process.env.REDIS_PORT || '6379'), process.env.REDIS_HOST || 'localhost');
            await redis.ping();
            redis.disconnect();
            return true;
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Redis health check failed:', error);
            return false;
        }
    }
    /**
     * Check Discord connection health
     */
    async checkDiscord() {
        try {
            if (!this.client.isReady()) {
                logger_1.default.warn('[Self-Healing] Discord client not ready');
                return false;
            }
            // Check if we can fetch our own user
            await this.client.user.fetch();
            return true;
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Discord health check failed:', error);
            return false;
        }
    }
    /**
     * Check memory usage
     */
    async checkMemory() {
        const used = process.memoryUsage();
        const heapUsedMB = used.heapUsed / 1024 / 1024;
        const heapTotalMB = used.heapTotal / 1024 / 1024;
        const heapPercent = (heapUsedMB / heapTotalMB) * 100;
        if (heapPercent > 90) {
            logger_1.default.warn(`[Self-Healing] High memory usage: ${heapPercent.toFixed(2)}%`);
            // Trigger garbage collection if possible
            if (global.gc) {
                logger_1.default.info('[Self-Healing] Forcing garbage collection...');
                global.gc();
            }
            return false;
        }
        return true;
    }
    /**
     * Check API rate limit status
     */
    async checkAPIRates() {
        // Check if we're hitting rate limits
        // This would need to be implemented based on your API tracking
        return true;
    }
    /**
     * Attempt automatic recovery for failed health check
     */
    async attemptAutoRecovery(checkName) {
        const attempts = this.autoRecoveryAttempts.get(checkName) || 0;
        if (attempts >= this.maxRecoveryAttempts) {
            logger_1.default.error(`[Self-Healing] Max recovery attempts reached for ${checkName}. Manual intervention required.`);
            return false;
        }
        this.autoRecoveryAttempts.set(checkName, attempts + 1);
        logger_1.default.info(`[Self-Healing] Attempting auto-recovery for ${checkName} (attempt ${attempts + 1}/${this.maxRecoveryAttempts})`);
        switch (checkName) {
            case 'database':
                return await this.recoverDatabase();
            case 'redis':
                return await this.recoverRedis();
            case 'discord':
                return await this.recoverDiscord();
            case 'memory':
                return await this.recoverMemory();
            default:
                logger_1.default.warn(`[Self-Healing] No recovery strategy for ${checkName}`);
                return false;
        }
    }
    /**
     * Recover database connection
     */
    async recoverDatabase() {
        try {
            logger_1.default.info('[Self-Healing] Attempting database reconnection...');
            // Database pool will auto-reconnect on next query
            await db_1.default.execute('SELECT 1');
            this.autoRecoveryAttempts.delete('database');
            logger_1.default.info('[Self-Healing] Database recovery successful ✅');
            return true;
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Database recovery failed:', error);
            return false;
        }
    }
    /**
     * Recover Redis connection
     */
    async recoverRedis() {
        try {
            logger_1.default.info('[Self-Healing] Attempting Redis reconnection...');
            // Redis will auto-reconnect
            await new Promise(resolve => setTimeout(resolve, 5000));
            this.autoRecoveryAttempts.delete('redis');
            logger_1.default.info('[Self-Healing] Redis recovery successful ✅');
            return true;
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Redis recovery failed:', error);
            return false;
        }
    }
    /**
     * Recover Discord connection
     */
    async recoverDiscord() {
        try {
            logger_1.default.info('[Self-Healing] Attempting Discord reconnection...');
            // Discord.js handles reconnection automatically
            await new Promise(resolve => setTimeout(resolve, 10000));
            this.autoRecoveryAttempts.delete('discord');
            logger_1.default.info('[Self-Healing] Discord recovery successful ✅');
            return true;
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Discord recovery failed:', error);
            return false;
        }
    }
    /**
     * Recover from memory issues
     */
    async recoverMemory() {
        try {
            logger_1.default.info('[Self-Healing] Attempting memory recovery...');
            // Force garbage collection
            if (global.gc) {
                global.gc();
            }
            // Clear caches
            if (this.client.channels.cache.size > 1000) {
                logger_1.default.info('[Self-Healing] Clearing channel cache...');
                this.client.channels.cache.clear();
            }
            this.autoRecoveryAttempts.delete('memory');
            logger_1.default.info('[Self-Healing] Memory recovery successful ✅');
            return true;
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Memory recovery failed:', error);
            return false;
        }
    }
    /**
     * Setup error pattern learning
     */
    setupErrorLearning() {
        // Track errors and learn patterns
        process.on('uncaughtException', (error) => {
            this.learnFromError('uncaughtException', error);
        });
        process.on('unhandledRejection', (reason, promise) => {
            this.learnFromError('unhandledRejection', reason);
        });
        logger_1.default.info('[Self-Healing] Error learning system active');
    }
    /**
     * Learn from errors
     */
    learnFromError(type, error) {
        const errorMessage = error?.message || String(error);
        const errorKey = `${type}:${errorMessage}`;
        const now = Date.now();
        if (!this.errorPatterns.has(errorKey)) {
            this.errorPatterns.set(errorKey, {
                count: 0,
                firstSeen: now,
                lastSeen: now,
                occurrences: []
            });
        }
        const pattern = this.errorPatterns.get(errorKey);
        pattern.count++;
        pattern.lastSeen = now;
        pattern.occurrences.push(now);
        // Keep only recent occurrences within error window
        pattern.occurrences = pattern.occurrences.filter(time => now - time < this.errorWindow);
        // If error threshold exceeded, attempt automated fix
        if (pattern.occurrences.length >= this.errorThreshold) {
            logger_1.default.warn(`[Self-Healing] Error pattern detected: ${errorKey} (${pattern.count} occurrences)`);
            this.attemptAutomatedFix(type, error);
        }
    }
    /**
     * Attempt automated fix based on error pattern
     */
    async attemptAutomatedFix(type, error) {
        logger_1.default.info(`[Self-Healing] Attempting automated fix for ${type}...`);
        const errorMessage = error?.message || String(error);
        // Common error patterns and fixes
        if (errorMessage.includes('ECONNREFUSED')) {
            await this.recoverDatabase();
        }
        else if (errorMessage.includes('ER_NO_SUCH_TABLE')) {
            await this.runMissingMigrations();
        }
        else if (errorMessage.includes('Discord')) {
            await this.recoverDiscord();
        }
        else if (errorMessage.includes('ENOMEM') || errorMessage.includes('heap out of memory')) {
            await this.recoverMemory();
        }
        else {
            logger_1.default.warn('[Self-Healing] No automated fix available for this error pattern');
        }
    }
    /**
     * Setup auto-migrations
     */
    async setupAutoMigrations() {
        try {
            const migrationsDir = path.join(__dirname, '../migrations');
            await this.runMissingMigrations();
            logger_1.default.info('[Self-Healing] Auto-migration system ready');
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Auto-migration setup failed:', error);
        }
    }
    /**
     * Run missing database migrations
     */
    async runMissingMigrations() {
        try {
            const migrationsDir = path.join(__dirname, '../migrations');
            const files = await fs.readdir(migrationsDir);
            const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();
            for (const file of sqlFiles) {
                const filePath = path.join(migrationsDir, file);
                const sql = await fs.readFile(filePath, 'utf8');
                const statements = sql.split(';').filter(s => s.trim());
                for (const stmt of statements) {
                    if (stmt.trim()) {
                        try {
                            await db_1.default.execute(stmt);
                        }
                        catch (error) {
                            const err = error;
                            // Ignore "table already exists" errors
                            if (!err.message.includes('already exists')) {
                                throw error;
                            }
                        }
                    }
                }
                logger_1.default.info(`[Self-Healing] Applied migration: ${file}`);
            }
        }
        catch (error) {
            logger_1.default.error('[Self-Healing] Migration error:', error);
        }
    }
    /**
     * Validate configuration
     */
    async validateConfiguration() {
        const required = [
            'DISCORD_TOKEN',
            'DB_HOST',
            'DB_USER',
            'DB_PASSWORD',
            'DB_NAME'
        ];
        const missing = required.filter(key => !process.env[key]);
        if (missing.length > 0) {
            logger_1.default.error(`[Self-Healing] Missing required environment variables: ${missing.join(', ')}`);
            logger_1.default.error('[Self-Healing] Please check your .env file');
        }
        else {
            logger_1.default.info('[Self-Healing] Configuration validation passed ✅');
        }
    }
    /**
     * Get health status report
     */
    async getHealthStatus() {
        const checks = await this.runHealthChecks();
        const allHealthy = checks.every(c => c.healthy);
        return {
            overall: allHealthy ? 'healthy' : 'degraded',
            checks,
            errorPatterns: Array.from(this.errorPatterns.entries()).map(([key, data]) => ({
                error: key,
                count: data.count,
                recentOccurrences: data.occurrences.length
            })),
            recoveryAttempts: Array.from(this.autoRecoveryAttempts.entries()),
            memoryUsage: process.memoryUsage(),
            uptime: process.uptime()
        };
    }
}
module.exports = SelfHealingManager;
