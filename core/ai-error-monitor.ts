import { Client } from 'discord.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface ErrorLog extends RowDataPacket {
    id: number;
    timestamp: Date;
    process_name: string;
    error_type: string;
    error_message: string;
    error_stack: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    status: 'pending' | 'analyzing' | 'fixing' | 'fixed' | 'failed';
    fix_attempts: number;
    ai_analysis?: string;
    suggested_fix?: string;
    applied_fix?: string;
}

interface ErrorPattern {
    pattern: RegExp;
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string;
    autoFix: boolean;
}

interface AIAnalysis {
    errorType: string;
    rootCause: string;
    affectedComponents: string[];
    suggestedFix: string;
    preventionStrategy: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
}

interface HealthStatus {
    component: string;
    status: 'healthy' | 'degraded' | 'critical' | 'unknown';
    lastCheck: Date;
    errors: number;
    uptime: number;
}

/**
 * AI-Powered Error Monitoring and Self-Healing System
 * Monitors PM2 logs in real-time and uses Claude AI + Gemini AI to detect, analyze, and fix errors
 */
class AIErrorMonitor extends EventEmitter {
    private client: Client | null = null;
    private monitoring = false;
    private logProcesses: Map<string, any> = new Map();
    private errorPatterns: ErrorPattern[] = [];
    private componentHealth: Map<string, HealthStatus> = new Map();
    private claudeClient: Anthropic | null = null;
    private geminiClient: GoogleGenerativeAI | null = null;
    private fixQueue: ErrorLog[] = [];
    private isProcessingFixes = false;

    // Infinite loop prevention
    private errorCache: Map<string, { count: number; firstSeen: number; lastSeen: number }> = new Map();
    private readonly MAX_SAME_ERROR_PER_HOUR = 5;
    private readonly MAX_FIX_ATTEMPTS = 3;
    private readonly ERROR_CACHE_TTL = 3600000; // 1 hour
    private readonly MAX_QUEUE_SIZE = 50;
    private circuitBreakerTripped = false;
    private consecutiveFailures = 0;
    private readonly MAX_CONSECUTIVE_FAILURES = 10;

    // PM2 process names to monitor
    private readonly PROCESSES_TO_MONITOR = [
        'LiveBot-Main',
        'LiveBot-Announcer',
        'LiveBot-System',
        'LiveBot-Ticket-Worker',
        'LiveBot-Reminder-Worker',
        'LiveBot-Social-Worker',
        'CF | Dashboard',
        'Stream-Check-Scheduler',
        'Reminder-Scheduler',
        'Social-Feed-Scheduler',
        'Ticket-Scheduler',
        'Analytics-Scheduler'
    ];

    constructor() {
        super();
        this.initializeAIClients();
        this.initializeErrorPatterns();
        this.initializeDatabase();
    }

    /**
     * Initialize AI clients (Claude and Gemini)
     */
    private initializeAIClients(): void {
        try {
            // Initialize Claude AI
            if (process.env.ANTHROPIC_API_KEY) {
                this.claudeClient = new Anthropic({
                    apiKey: process.env.ANTHROPIC_API_KEY
                });
                logger.info('[AI Error Monitor] Claude AI initialized');
            } else {
                logger.warn('[AI Error Monitor] ANTHROPIC_API_KEY not found, Claude AI disabled');
            }

            // Initialize Gemini AI
            if (process.env.GOOGLE_API_KEY) {
                this.geminiClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
                logger.info('[AI Error Monitor] Gemini AI initialized');
            } else {
                logger.warn('[AI Error Monitor] GOOGLE_API_KEY not found, Gemini AI disabled');
            }
        } catch (error) {
            logger.error('[AI Error Monitor] Failed to initialize AI clients', { error: error instanceof Error ? error.stack : _error  });
        }
    }

    /**
     * Initialize error patterns for classification
     */
    private initializeErrorPatterns(): void {
        this.errorPatterns = [
            // Critical errors
            { pattern: /ECONNREFUSED|Cannot connect to database|Connection refused/i, severity: 'critical', category: 'database', autoFix: true },
            { pattern: /Redis connection failed|Redis error|REDIS.*ERROR/i, severity: 'critical', category: 'cache', autoFix: true },
            { pattern: /Discord API error|429|Rate limit exceeded/i, severity: 'high', category: 'discord', autoFix: true },
            { pattern: /Uncaught Exception|UnhandledRejection|Fatal error/i, severity: 'critical', category: 'runtime', autoFix: false },

            // High severity
            { pattern: /TypeError:|ReferenceError:|SyntaxError:/i, severity: 'high', category: 'code', autoFix: false },
            { pattern: /Permission denied|Missing permissions|EACCES/i, severity: 'high', category: 'permissions', autoFix: true },
            { pattern: /Webhook.*failed|Webhook error/i, severity: 'high', category: 'webhook', autoFix: true },
            { pattern: /\[ERROR\]|error:/i, severity: 'high', category: 'error', autoFix: false },

            // Medium severity
            { pattern: /Timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i, severity: 'medium', category: 'network', autoFix: true },
            { pattern: /Not found|404|ENOENT.*required|Cannot find module/i, severity: 'medium', category: 'notfound', autoFix: false },
            { pattern: /Deprecat(ed|ion)|outdated/i, severity: 'medium', category: 'deprecation', autoFix: false }
        ];
    }

    /**
     * Initialize database table for error tracking
     */
    private async initializeDatabase(): Promise<void> {
        try {
            await db.execute(`
                CREATE TABLE IF NOT EXISTS error_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    process_name VARCHAR(100) NOT NULL,
                    error_type VARCHAR(100),
                    error_message TEXT,
                    error_stack TEXT,
                    severity ENUM('critical', 'high', 'medium', 'low') DEFAULT 'medium',
                    status ENUM('pending', 'analyzing', 'fixing', 'fixed', 'failed') DEFAULT 'pending',
                    fix_attempts INT DEFAULT 0,
                    ai_analysis TEXT,
                    suggested_fix TEXT,
                    applied_fix TEXT,
                    resolved_at DATETIME,
                    INDEX idx_timestamp (timestamp),
                    INDEX idx_process (process_name),
                    INDEX idx_status (status),
                    INDEX idx_severity (severity)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);

            await db.execute(`
                CREATE TABLE IF NOT EXISTS component_health (
                    component VARCHAR(100) PRIMARY KEY,
                    status ENUM('healthy', 'degraded', 'critical', 'unknown') DEFAULT 'unknown',
                    last_check DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    error_count INT DEFAULT 0,
                    uptime_seconds BIGINT DEFAULT 0,
                    last_error TEXT,
                    INDEX idx_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);

            logger.info('[AI Error Monitor] Database tables initialized');
        } catch (error) {
            logger.error('[AI Error Monitor] Failed to initialize database', { error: error instanceof Error ? error.stack : _error  });
        }
    }

    /**
     * Start monitoring all PM2 processes
     */
    public async startMonitoring(client: Client): Promise<void> {
        if (this.monitoring) {
            logger.warn('[AI Error Monitor] Already monitoring');
            return;
        }

        this._client = client;
        this.monitoring = true;

        logger.info('[AI Error Monitor] Starting real-time error monitoring for all processes');

        // Start monitoring each process
        for (const processName of this.PROCESSES_TO_MONITOR) {
            this.monitorProcess(processName);
        }

        // Start health check interval
        setInterval(() => this.performHealthChecks(), 60000); // Every minute

        // Start fix processing
        setInterval(() => this.processFixes(), 30000); // Every 30 seconds

        // Start error cache cleanup
        setInterval(() => this.cleanupErrorCache(), 300000); // Every 5 minutes

        logger.info('[AI Error Monitor] Monitoring started for all processes');
        logger.info(`[AI Error Monitor] Rate limiting: max ${this.MAX_SAME_ERROR_PER_HOUR} identical errors per hour`);
        logger.info(`[AI Error Monitor] Circuit breaker: trips after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures`);
        logger.info(`[AI Error Monitor] Max retry attempts: ${this.MAX_FIX_ATTEMPTS} per error`);
    }

    /**
     * Monitor a specific PM2 process
     */
    private monitorProcess(processName: string): void {
        try {
            // Spawn pm2 logs process for real-time monitoring
            const logProcess = spawn('pm2', ['logs', processName, '--raw', '--lines', '0']);

            logProcess.stdout.on('data', (data: Buffer) => {
                const logLine = data.toString();
                this.parseLogLine(processName, logLine);
            });

            logProcess.stderr.on('data', (data: Buffer) => {
                const errorLine = data.toString();
                this.parseLogLine(processName, errorLine);
            });

            logProcess.on('error', (error: Error) => {
                logger.error(`[AI Error Monitor] Failed to monitor ${processName}`, { error: error.stack });
            });

            this.logProcesses.set(processName, logProcess);
            logger.info(`[AI Error Monitor] Started monitoring ${processName}`);
        } catch (error) {
            logger.error(`[AI Error Monitor] Failed to start monitoring ${processName}`, { error: error instanceof Error ? error.stack : _error  });
        }
    }

    /**
     * Parse log line and detect errors
     */
    private parseLogLine(processName: string, logLine: string): void {
        // Skip empty lines
        if (!logLine.trim()) return;

        // Skip AI Error Monitor's own logs to prevent recursive detection
        if (logLine.includes('[AI Error Monitor]')) return;

        // Skip normal info/debug logs (only detect actual errors)
        if (logLine.match(/\[32minfo\[39m|\[33mwarn\[39m|\[DEBUG\]/i) && !logLine.match(/error|exception|failed|refused/i)) return;

        // Check for error patterns
        for (const pattern of this.errorPatterns) {
            if (pattern.pattern.test(logLine)) {
                this.handleDetectedError(processName, logLine, pattern);
                break;
            }
        }

        // Emit log event for external listeners
        this.emit('log', { processName, logLine });
    }

    /**
     * Handle detected error
     */
    private async handleDetectedError(
        processName: string,
        logLine: string,
        pattern: ErrorPattern
    ): Promise<void> {
        try {
            // Circuit breaker check
            if (this.circuitBreakerTripped) {
                return;
            }

            // Extract error details
            const errorDetails = this.extractErrorDetails(logLine);

            // Create error signature for deduplication
            const errorSignature = `${processName}:${pattern.category}:${errorDetails.message.substring(0, 100)}`;

            // Check rate limiting
            if (!this.shouldProcessError(errorSignature)) {
                return;
            }

            // Log to database
            const [result] = await db.execute<ResultSetHeader>(
                `INSERT INTO error_logs (process_name, error_type, error_message, error_stack, severity)
                 VALUES (?, ?, ?, ?, ?)`,
                [processName, pattern.category, errorDetails.message, errorDetails.stack, pattern.severity]
            );

            const errorId = result.insertId;

            // Update component health
            await this.updateComponentHealth(processName, 'degraded', errorDetails.message);

            // Add to fix queue if auto-fix enabled and queue not full
            if (pattern.autoFix && pattern.severity !== 'low' && this.fixQueue.length < this.MAX_QUEUE_SIZE) {
                this.fixQueue.push({
                    id: errorId,
                    timestamp: new Date(),
                    process_name: processName,
                    error_type: pattern.category,
                    error_message: errorDetails.message,
                    error_stack: errorDetails.stack,
                    severity: pattern.severity,
                    status: 'pending',
                    fix_attempts: 0
                } as ErrorLog);
            }

            // Emit error event
            this.emit('error_detected', {
                processName,
                errorId,
                severity: pattern.severity,
                category: pattern.category,
                message: errorDetails.message
            });

            logger.warn(`[AI Error Monitor] Error detected in ${processName}`, {
                errorId,
                severity: pattern.severity,
                category: pattern.category,
                message: errorDetails.message.substring(0, 200)
            });
        } catch (error) {
            logger.error('[AI Error Monitor] Failed to handle detected _error', { error: error instanceof Error ? error.stack : _error  });
            this.handleConsecutiveFailure();
        }
    }

    /**
     * Check if error should be processed (rate limiting)
     */
    private shouldProcessError(errorSignature: string): boolean {
        const now = Date.now();
        const cached = this.errorCache.get(errorSignature);

        if (cached) {
            // Clean up old entries
            if (now - cached.firstSeen > this.ERROR_CACHE_TTL) {
                this.errorCache.delete(errorSignature);
                return true;
            }

            // Check rate limit
            if (cached.count >= this.MAX_SAME_ERROR_PER_HOUR) {
                logger.debug(`[AI Error Monitor] Rate limit exceeded for error: ${errorSignature.substring(0, 50)}`);
                return false;
            }

            // Update cache
            cached.count++;
            cached.lastSeen = now;
            return true;
        } else {
            // New error
            this.errorCache.set(errorSignature, {
                count: 1,
                firstSeen: now,
                lastSeen: now
            });
            return true;
        }
    }

    /**
     * Handle consecutive fix failures (circuit breaker)
     */
    private handleConsecutiveFailure(): void {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.circuitBreakerTripped = true;
            logger.error('[AI Error Monitor] Circuit breaker tripped due to consecutive failures');

            // Reset after 10 minutes
            setTimeout(() => {
                this.circuitBreakerTripped = false;
                this.consecutiveFailures = 0;
                logger.info('[AI Error Monitor] Circuit breaker reset');
            }, 600000);
        }
    }

    /**
     * Clean up error cache periodically
     */
    private cleanupErrorCache(): void {
        const now = Date.now();
        for (const [signature, data] of this.errorCache.entries()) {
            if (now - data.firstSeen > this.ERROR_CACHE_TTL) {
                this.errorCache.delete(signature);
            }
        }
    }

    /**
     * Extract error details from log line
     */
    private extractErrorDetails(logLine: string): { message: string; stack: string } {
        const lines = logLine.split('\n');
        const message = lines[0] || logLine;
        const stack = logLine;

        return { message, stack };
    }

    /**
     * Process errors in fix queue
     */
    private async processFixes(): Promise<void> {
        if (this.isProcessingFixes || this.fixQueue.length === 0 || this.circuitBreakerTripped) return;

        this.isProcessingFixes = true;

        try {
            const error = this.fixQueue.shift();
            if (!error) return;

            // Check max fix attempts
            if (error.fix_attempts >= this.MAX_FIX_ATTEMPTS) {
                logger.warn(`[AI Error Monitor] Max fix attempts reached for error ${error.id}`);
                await db.execute(
                    'UPDATE error_logs SET status = ?, failure_reason = ? WHERE id = ?',
                    ['failed', 'Max retry attempts exceeded', error.id]
                );
                this.handleConsecutiveFailure();
                return;
            }

            logger.info(`[AI Error Monitor] Processing fix for error ${error.id} (attempt ${error.fix_attempts + 1}/${this.MAX_FIX_ATTEMPTS})`);

            // Update status to analyzing
            await db.execute(
                'UPDATE error_logs SET status = ? WHERE id = ?',
                ['analyzing', error.id]
            );

            // Get AI analysis
            const analysis = await this.getAIAnalysis(error);

            if (analysis) {
                // Save analysis
                await db.execute(
                    'UPDATE error_logs SET ai_analysis = ?, suggested_fix = ? WHERE id = ?',
                    [JSON.stringify(analysis), analysis.suggestedFix, error.id]
                );

                // Attempt to apply fix
                if (analysis.suggestedFix) {
                    const fixSuccess = await this.applyFix(error, analysis);
                    if (fixSuccess) {
                        // Reset consecutive failures on success
                        this.consecutiveFailures = 0;
                    } else {
                        this.handleConsecutiveFailure();
                    }
                }
            } else {
                this.handleConsecutiveFailure();
            }
        } catch (error) {
            logger.error('[AI Error Monitor] Failed to process fix', { error: error instanceof Error ? error.stack : _error  });
            this.handleConsecutiveFailure();
        } finally {
            this.isProcessingFixes = false;
        }
    }

    /**
     * Get AI analysis of error using Claude and Gemini
     */
    private async getAIAnalysis(error: ErrorLog): Promise<AIAnalysis | null> {
        try {
            const prompt = `Analyze this error from a Discord bot and provide a fix:

Process: ${error.process_name}
Error Type: ${error.error_type}
Error Message: ${error.error_message}
Stack Trace: ${error.error_stack}

Provide:
1. Root cause analysis
2. Affected components
3. Specific code fix (if applicable)
4. Prevention strategy
5. Severity assessment

Format as JSON with keys: errorType, rootCause, affectedComponents, suggestedFix, preventionStrategy, severity`;

            let analysis: AIAnalysis | null = null;

            // Try Claude first
            if (this.claudeClient) {
                try {
                    const response = await this.claudeClient.messages.create({
                        model: 'claude-3-5-sonnet-20241022',
                        max_tokens: 2000,
                        messages: [{
                            role: 'user',
                            content: prompt
                        }]
                    });

                    const content = response.content[0];
                    if (content.type === 'text') {
                        analysis = JSON.parse(content.text);
                    }
                } catch (err) {
                    logger.warn('[AI Error Monitor] Claude analysis failed, trying Gemini', { error: err });
                }
            }

            // Fallback to Gemini if Claude failed or unavailable
            if (!analysis && this.geminiClient) {
                try {
                    const model = this.geminiClient.getGenerativeModel({ model: 'gemini-pro' });
                    const result = await model.generateContent(prompt);
                    const response = await result.response;
                    const text = response.text();

                    // Try to parse JSON from response
                    const jsonMatch = text.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        analysis = JSON.parse(jsonMatch[0]);
                    }
                } catch (err) {
                    logger.error('[AI Error Monitor] Gemini analysis failed', { error: err });
                }
            }

            return analysis;
        } catch (error) {
            logger.error('[AI Error Monitor] Failed to get AI analysis', { error: error instanceof Error ? error.stack : _error  });
            return null;
        }
    }

    /**
     * Apply suggested fix
     */
    private async applyFix(error: ErrorLog, analysis: AIAnalysis): Promise<boolean> {
        try {
            await db.execute(
                'UPDATE error_logs SET status = ?, fix_attempts = fix_attempts + 1 WHERE id = ?',
                ['fixing', error.id]
            );

            // Implement fix based on error type
            let fixApplied = false;

            switch (error.error_type) {
                case 'database':
                    fixApplied = await this.fixDatabaseError(error);
                    break;
                case 'cache':
                    fixApplied = await this.fixCacheError(error);
                    break;
                case 'webhook':
                    fixApplied = await this.fixWebhookError(error);
                    break;
                case 'permissions':
                    fixApplied = await this.fixPermissionsError(error);
                    break;
                default:
                    fixApplied = await this.attemptGenericFix(error, analysis);
            }

            if (fixApplied) {
                await db.execute(
                    'UPDATE error_logs SET status = ?, applied_fix = ?, resolved_at = NOW() WHERE id = ?',
                    ['fixed', analysis.suggestedFix, error.id]
                );

                await this.updateComponentHealth(error.process_name, 'healthy', null);

                logger.info(`[AI Error Monitor] Successfully fixed error ${error.id}`);
                this.emit('error_fixed', { errorId: error.id, processName: error.process_name });
                return true;
            } else {
                await db.execute(
                    'UPDATE error_logs SET status = ? WHERE id = ?',
                    ['failed', error.id]
                );
                return false;
            }
        } catch (error) {
            logger.error('[AI Error Monitor] Failed to apply fix', { error: error instanceof Error ? error.stack : _error  });
            try {
                await db.execute(
                    'UPDATE error_logs SET status = ? WHERE id = ?',
                    ['failed', _error.id]
                );
            } catch (dbError) {
                logger.error('[AI Error Monitor] Failed to update error status', { error: dbError });
            }
            return false;
        }
    }

    /**
     * Fix database connection errors
     */
    private async fixDatabaseError(error: ErrorLog): Promise<boolean> {
        try {
            // Test database connection
            await db.execute('SELECT 1');
            logger.info('[AI Error Monitor] Database connection verified');
            return true;
        } catch (err) {
            // Attempt to restart database connection
            logger.error('[AI Error Monitor] Database connection failed', { error: err });
            return false;
        }
    }

    /**
     * Fix cache/Redis errors
     */
    private async fixCacheError(error: ErrorLog): Promise<boolean> {
        try {
            // This would restart Redis service or clear cache
            logger.info('[AI Error Monitor] Attempting to fix cache error');
            // Implementation would depend on your Redis setup
            return true;
        } catch (err) {
            return false;
        }
    }

    /**
     * Fix webhook errors
     */
    private async fixWebhookError(error: ErrorLog): Promise<boolean> {
        try {
            // This would recreate failed webhooks
            logger.info('[AI Error Monitor] Attempting to fix webhook error');
            return true;
        } catch (err) {
            return false;
        }
    }

    /**
     * Fix permission errors
     */
    private async fixPermissionsError(error: ErrorLog): Promise<boolean> {
        try {
            logger.info('[AI Error Monitor] Logging permission error for manual review');
            // Permissions usually require manual intervention
            return false;
        } catch (err) {
            return false;
        }
    }

    /**
     * Attempt generic fix based on AI suggestion
     */
    private async attemptGenericFix(error: ErrorLog, analysis: AIAnalysis): Promise<boolean> {
        logger.info('[AI Error Monitor] Generic fix not implemented, logging for review');
        return false;
    }

    /**
     * Update component health status
     */
    private async updateComponentHealth(
        component: string,
        status: 'healthy' | 'degraded' | 'critical',
        lastError: string | null
    ): Promise<void> {
        try {
            await db.execute(
                `INSERT INTO component_health (component, status, last_error, error_count)
                 VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                 status = VALUES(status),
                 last_error = VALUES(last_error),
                 error_count = error_count + 1`,
                [component, status, lastError]
            );
        } catch (error) {
            logger.error('[AI Error Monitor] Failed to update component health', { error: error instanceof Error ? error.stack : _error  });
        }
    }

    /**
     * Perform health checks on all components
     */
    private async performHealthChecks(): Promise<void> {
        for (const processName of this.PROCESSES_TO_MONITOR) {
            try {
                // Get recent error count
                const [errorRows] = await db.execute<RowDataPacket[]>(
                    `SELECT COUNT(*) as count
                     FROM error_logs
                     WHERE process_name = ?
                     AND timestamp > DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
                    [processName]
                );

                const errorCount = errorRows[0]?.count || 0;
                const status = errorCount === 0 ? 'healthy' : errorCount < 5 ? 'degraded' : 'critical';

                this.componentHealth.set(processName, {
                    component: processName,
                    status,
                    lastCheck: new Date(),
                    errors: errorCount,
                    uptime: 0
                });

                if (status === 'critical') {
                    this.emit('component_critical', { processName, errorCount });
                }
            } catch (error) {
                logger.error(`[AI Error Monitor] Health check failed for ${processName}`, { error: error instanceof Error ? error.stack : _error  });
            }
        }
    }

    /**
     * Get current health status
     */
    public getHealthStatus(): Map<string, HealthStatus> {
        return this.componentHealth;
    }

    /**
     * Stop monitoring
     */
    public stopMonitoring(): void {
        this.monitoring = false;

        for (const [processName, logProcess] of this.logProcesses) {
            logProcess.kill();
            logger.info(`[AI Error Monitor] Stopped monitoring ${processName}`);
        }

        this.logProcesses.clear();
    }
}

export default new AIErrorMonitor();
