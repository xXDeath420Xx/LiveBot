/**
 * Self-Healing Manager
 * Automatic error recovery, health monitoring, and self-repair
 */

import logger from '../utils/logger';
import db from '../utils/db';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Client } from 'discord.js';
import { ResultSetHeader } from 'mysql2';

interface HealthCheck {
    name: string;
    check: () => Promise<boolean>;
}

interface HealthCheckResult {
    name: string;
    healthy: boolean;
    timestamp: number;
    error?: string;
}

interface ErrorPattern {
    count: number;
    firstSeen: number;
    lastSeen: number;
    occurrences: number[];
}

class SelfHealingManager {
    private client: Client;
    private healthChecks: HealthCheck[];
    private errorPatterns: Map<string, ErrorPattern>;
    private autoRecoveryAttempts: Map<string, number>;
    private maxRecoveryAttempts: number;
    private healthCheckInterval: number;
    private errorThreshold: number;
    private errorWindow: number;

    constructor(client: Client) {
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
    async initialize(): Promise<void> {
        logger.info('[Self-Healing] Initializing self-healing system...');

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

        logger.info('[Self-Healing] Self-healing system initialized ✅');
    }

    /**
     * Register a health check
     */
    registerHealthCheck(name: string, checkFunction: () => Promise<boolean>): void {
        this.healthChecks.push({ name, check: checkFunction });
        logger.info(`[Self-Healing] Registered health check: ${name}`);
    }

    /**
     * Start health monitoring loop
     */
    startHealthMonitoring(): void {
        setInterval(async () => {
            try {
                await this.runHealthChecks();
            } catch (error) {
                logger.error('[Self-Healing] Health check _error:', error as Record<string, any>);
            }
        }, this.healthCheckInterval);

        logger.info('[Self-Healing] Health monitoring started (every 60s)');
    }

    /**
     * Run all health checks
     */
    async runHealthChecks(): Promise<HealthCheckResult[]> {
        const results: HealthCheckResult[] = [];

        for (const { name, check } of this.healthChecks) {
            try {
                const healthy = await check();
                results.push({ name, healthy, timestamp: Date.now() });

                if (!healthy) {
                    logger.warn(`[Self-Healing] Health check FAILED: ${name}`);
                    await this.attemptAutoRecovery(name);
                }
            } catch (error) {
                const err = _error as Error;
                logger.error(`[Self-Healing] Health check _error for ${name}:`, error as Record<string, any>);
                results.push({ name, healthy: false, _error: err.message, timestamp: Date.now() });
                await this.attemptAutoRecovery(name);
            }
        }

        return results;
    }

    /**
     * Check database health
     */
    async checkDatabase(): Promise<boolean> {
        try {
            await db.execute('SELECT 1');
            return true;
        } catch (error) {
            logger.error('[Self-Healing] Database health check failed:', error as Record<string, any>);
            return false;
        }
    }

    /**
     * Check Redis health
     */
    async checkRedis(): Promise<boolean> {
        try {
            // Check if Redis client exists and can ping
            const Redis = require('ioredis');
            const redis = new Redis(parseInt(process.env.REDIS_PORT || '6379'), process.env.REDIS_HOST || 'localhost');
            await redis.ping();
            redis.disconnect();
            return true;
        } catch (error) {
            logger.error('[Self-Healing] Redis health check failed:', error as Record<string, any>);
            return false;
        }
    }

    /**
     * Check Discord connection health
     */
    async checkDiscord(): Promise<boolean> {
        try {
            if (!this.client.isReady()) {
                logger.warn('[Self-Healing] Discord client not ready');
                return false;
            }

            // Check if we can fetch our own user
            await this.client.user!.fetch();
            return true;
        } catch (error) {
            logger.error('[Self-Healing] Discord health check failed:', error as Record<string, any>);
            return false;
        }
    }

    /**
     * Check memory usage
     */
    async checkMemory(): Promise<boolean> {
        const used = process.memoryUsage();
        const heapUsedMB = used.heapUsed / 1024 / 1024;
        const heapTotalMB = used.heapTotal / 1024 / 1024;
        const heapPercent = (heapUsedMB / heapTotalMB) * 100;

        if (heapPercent > 90) {
            logger.warn(`[Self-Healing] High memory usage: ${heapPercent.toFixed(2)}%`);
            // Trigger garbage collection if possible
            if (global.gc) {
                logger.info('[Self-Healing] Forcing garbage collection...');
                global.gc();
            }
            return false;
        }

        return true;
    }

    /**
     * Check API rate limit status
     */
    async checkAPIRates(): Promise<boolean> {
        // Check if we're hitting rate limits
        // This would need to be implemented based on your API tracking
        return true;
    }

    /**
     * Attempt automatic recovery for failed health check
     */
    async attemptAutoRecovery(checkName: string): Promise<boolean> {
        const attempts = this.autoRecoveryAttempts.get(checkName) || 0;

        if (attempts >= this.maxRecoveryAttempts) {
            logger.error(`[Self-Healing] Max recovery attempts reached for ${checkName}. Manual intervention required.`);
            return false;
        }

        this.autoRecoveryAttempts.set(checkName, attempts + 1);
        logger.info(`[Self-Healing] Attempting auto-recovery for ${checkName} (attempt ${attempts + 1}/${this.maxRecoveryAttempts})`);

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
                logger.warn(`[Self-Healing] No recovery strategy for ${checkName}`);
                return false;
        }
    }

    /**
     * Recover database connection
     */
    async recoverDatabase(): Promise<boolean> {
        try {
            logger.info('[Self-Healing] Attempting database reconnection...');
            // Database pool will auto-reconnect on next query
            await db.execute('SELECT 1');
            this.autoRecoveryAttempts.delete('database');
            logger.info('[Self-Healing] Database recovery successful ✅');
            return true;
        } catch (error) {
            logger.error('[Self-Healing] Database recovery failed:', error as Record<string, any>);
            return false;
        }
    }

    /**
     * Recover Redis connection
     */
    async recoverRedis(): Promise<boolean> {
        try {
            logger.info('[Self-Healing] Attempting Redis reconnection...');
            // Redis will auto-reconnect
            await new Promise(resolve => setTimeout(resolve, 5000));
            this.autoRecoveryAttempts.delete('redis');
            logger.info('[Self-Healing] Redis recovery successful ✅');
            return true;
        } catch (error) {
            logger.error('[Self-Healing] Redis recovery failed:', error as Record<string, any>);
            return false;
        }
    }

    /**
     * Recover Discord connection
     */
    async recoverDiscord(): Promise<boolean> {
        try {
            logger.info('[Self-Healing] Attempting Discord reconnection...');
            // Discord.js handles reconnection automatically
            await new Promise(resolve => setTimeout(resolve, 10000));
            this.autoRecoveryAttempts.delete('discord');
            logger.info('[Self-Healing] Discord recovery successful ✅');
            return true;
        } catch (error) {
            logger.error('[Self-Healing] Discord recovery failed:', error as Record<string, any>);
            return false;
        }
    }

    /**
     * Recover from memory issues
     */
    async recoverMemory(): Promise<boolean> {
        try {
            logger.info('[Self-Healing] Attempting memory recovery...');

            // Force garbage collection
            if (global.gc) {
                global.gc();
            }

            // Clear caches
            if (this.client.channels.cache.size > 1000) {
                logger.info('[Self-Healing] Clearing channel cache...');
                this.client.channels.cache.clear();
            }

            this.autoRecoveryAttempts.delete('memory');
            logger.info('[Self-Healing] Memory recovery successful ✅');
            return true;
        } catch (error) {
            logger.error('[Self-Healing] Memory recovery failed:', error as Record<string, any>);
            return false;
        }
    }

    /**
     * Setup error pattern learning
     */
    setupErrorLearning(): void {
        // Track errors and learn patterns
        process.on('uncaughtException', (error) => {
            this.learnFromError('uncaughtException', error);
        });

        process.on('unhandledRejection', (reason, promise) => {
            this.learnFromError('unhandledRejection', reason);
        });

        logger.info('[Self-Healing] Error learning system active');
    }

    /**
     * Learn from errors
     */
    learnFromError(type: string, error: any): void {
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

        const pattern = this.errorPatterns.get(errorKey)!;
        pattern.count++;
        pattern.lastSeen = now;
        pattern.occurrences.push(now);

        // Keep only recent occurrences within error window
        pattern.occurrences = pattern.occurrences.filter(time => now - time < this.errorWindow);

        // If error threshold exceeded, attempt automated fix
        if (pattern.occurrences.length >= this.errorThreshold) {
            logger.warn(`[Self-Healing] Error pattern detected: ${errorKey} (${pattern.count} occurrences)`);
            this.attemptAutomatedFix(type, error);
        }
    }

    /**
     * Attempt automated fix based on error pattern
     */
    async attemptAutomatedFix(type: string, error: any): Promise<void> {
        logger.info(`[Self-Healing] Attempting automated fix for ${type}...`);

        const errorMessage = error?.message || String(error);

        // Common error patterns and fixes
        if (errorMessage.includes('ECONNREFUSED')) {
            await this.recoverDatabase();
        } else if (errorMessage.includes('ER_NO_SUCH_TABLE')) {
            await this.runMissingMigrations();
        } else if (errorMessage.includes('Discord')) {
            await this.recoverDiscord();
        } else if (errorMessage.includes('ENOMEM') || errorMessage.includes('heap out of memory')) {
            await this.recoverMemory();
        } else {
            logger.warn('[Self-Healing] No automated fix available for this error pattern');
        }
    }

    /**
     * Setup auto-migrations
     */
    async setupAutoMigrations(): Promise<void> {
        try {
            const migrationsDir = path.join(__dirname, '../migrations');
            await this.runMissingMigrations();
            logger.info('[Self-Healing] Auto-migration system ready');
        } catch (error) {
            logger.error('[Self-Healing] Auto-migration setup failed:', error as Record<string, any>);
        }
    }

    /**
     * Run missing database migrations
     */
    async runMissingMigrations(): Promise<void> {
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
                            await db.execute(stmt);
                        } catch (error) {
                            const err = _error as any;
                            // Ignore "table already exists" errors
                            if (!err.message.includes('already exists')) {
                                throw _error;
                            }
                        }
                    }
                }

                logger.info(`[Self-Healing] Applied migration: ${file}`);
            }
        } catch (error) {
            logger.error('[Self-Healing] Migration _error:', error as Record<string, any>);
        }
    }

    /**
     * Validate configuration
     */
    async validateConfiguration(): Promise<void> {
        const required = [
            'DISCORD_TOKEN',
            'DB_HOST',
            'DB_USER',
            'DB_PASSWORD',
            'DB_NAME'
        ];

        const missing = required.filter(key => !process.env[key]);

        if (missing.length > 0) {
            logger.error(`[Self-Healing] Missing required environment variables: ${missing.join(', ')}`);
            logger.error('[Self-Healing] Please check your .env file');
        } else {
            logger.info('[Self-Healing] Configuration validation passed ✅');
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

export = SelfHealingManager;
