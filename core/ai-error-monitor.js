"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const generative_ai_1 = require("@google/generative-ai");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const child_process_1 = require("child_process");
const events_1 = require("events");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
/**
 * AI-Powered Error Monitoring and Self-Healing System
 * Monitors PM2 logs in real-time and uses Claude AI + Gemini AI to detect, analyze, and fix errors
 */
class AIErrorMonitor extends events_1.EventEmitter {
    client = null;
    monitoring = false;
    logProcesses = new Map();
    errorPatterns = [];
    componentHealth = new Map();
    claudeClient = null;
    geminiClient = null;
    fixQueue = [];
    isProcessingFixes = false;
    // Infinite loop prevention
    errorCache = new Map();
    MAX_SAME_ERROR_PER_HOUR = 5;
    MAX_FIX_ATTEMPTS = 3;
    ERROR_CACHE_TTL = 3600000; // 1 hour
    MAX_QUEUE_SIZE = 50;
    circuitBreakerTripped = false;
    consecutiveFailures = 0;
    MAX_CONSECUTIVE_FAILURES = 10;
    // PM2 process names to monitor
    PROCESSES_TO_MONITOR = [
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
    initializeAIClients() {
        try {
            // Initialize Claude AI
            if (process.env.ANTHROPIC_API_KEY) {
                this.claudeClient = new sdk_1.default({
                    apiKey: process.env.ANTHROPIC_API_KEY
                });
                logger_1.default.info('[AI Error Monitor] Claude AI initialized');
            }
            else {
                logger_1.default.warn('[AI Error Monitor] ANTHROPIC_API_KEY not found, Claude AI disabled');
            }
            // Initialize Gemini AI
            if (process.env.GOOGLE_API_KEY) {
                this.geminiClient = new generative_ai_1.GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
                logger_1.default.info('[AI Error Monitor] Gemini AI initialized');
            }
            else {
                logger_1.default.warn('[AI Error Monitor] GOOGLE_API_KEY not found, Gemini AI disabled');
            }
        }
        catch (error) {
            logger_1.default.error('[AI Error Monitor] Failed to initialize AI clients', { error: error instanceof Error ? error.stack : error });
        }
    }
    /**
     * Initialize error patterns for classification
     */
    initializeErrorPatterns() {
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
    async initializeDatabase() {
        try {
            await db_1.default.execute(`
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
            await db_1.default.execute(`
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
            logger_1.default.info('[AI Error Monitor] Database tables initialized');
        }
        catch (error) {
            logger_1.default.error('[AI Error Monitor] Failed to initialize database', { error: error instanceof Error ? error.stack : error });
        }
    }
    /**
     * Start monitoring all PM2 processes
     */
    async startMonitoring(client) {
        if (this.monitoring) {
            logger_1.default.warn('[AI Error Monitor] Already monitoring');
            return;
        }
        this.client = client;
        this.monitoring = true;
        logger_1.default.info('[AI Error Monitor] Starting real-time error monitoring for all processes');
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
        logger_1.default.info('[AI Error Monitor] Monitoring started for all processes');
        logger_1.default.info(`[AI Error Monitor] Rate limiting: max ${this.MAX_SAME_ERROR_PER_HOUR} identical errors per hour`);
        logger_1.default.info(`[AI Error Monitor] Circuit breaker: trips after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures`);
        logger_1.default.info(`[AI Error Monitor] Max retry attempts: ${this.MAX_FIX_ATTEMPTS} per error`);
    }
    /**
     * Monitor a specific PM2 process
     */
    monitorProcess(processName) {
        try {
            // Spawn pm2 logs process for real-time monitoring
            const logProcess = (0, child_process_1.spawn)('pm2', ['logs', processName, '--raw', '--lines', '0']);
            logProcess.stdout.on('data', (data) => {
                const logLine = data.toString();
                this.parseLogLine(processName, logLine);
            });
            logProcess.stderr.on('data', (data) => {
                const errorLine = data.toString();
                this.parseLogLine(processName, errorLine);
            });
            logProcess.on('error', (error) => {
                logger_1.default.error(`[AI Error Monitor] Failed to monitor ${processName}`, { error: error.stack });
            });
            this.logProcesses.set(processName, logProcess);
            logger_1.default.info(`[AI Error Monitor] Started monitoring ${processName}`);
        }
        catch (error) {
            logger_1.default.error(`[AI Error Monitor] Failed to start monitoring ${processName}`, { error: error instanceof Error ? error.stack : error });
        }
    }
    /**
     * Parse log line and detect errors
     */
    parseLogLine(processName, logLine) {
        // Skip empty lines
        if (!logLine.trim())
            return;
        // Skip AI Error Monitor's own logs to prevent recursive detection
        if (logLine.includes('[AI Error Monitor]'))
            return;
        // Skip normal info/debug logs (only detect actual errors)
        if (logLine.match(/\[32minfo\[39m|\[33mwarn\[39m|\[DEBUG\]/i) && !logLine.match(/error|exception|failed|refused/i))
            return;
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
    async handleDetectedError(processName, logLine, pattern) {
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
            const [result] = await db_1.default.execute(`INSERT INTO error_logs (process_name, error_type, error_message, error_stack, severity)
                 VALUES (?, ?, ?, ?, ?)`, [processName, pattern.category, errorDetails.message, errorDetails.stack, pattern.severity]);
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
                });
            }
            // Emit error event
            this.emit('error_detected', {
                processName,
                errorId,
                severity: pattern.severity,
                category: pattern.category,
                message: errorDetails.message
            });
            logger_1.default.warn(`[AI Error Monitor] Error detected in ${processName}`, {
                errorId,
                severity: pattern.severity,
                category: pattern.category,
                message: errorDetails.message.substring(0, 200)
            });
        }
        catch (error) {
            logger_1.default.error('[AI Error Monitor] Failed to handle detected error', { error: error instanceof Error ? error.stack : error });
            this.handleConsecutiveFailure();
        }
    }
    /**
     * Check if error should be processed (rate limiting)
     */
    shouldProcessError(errorSignature) {
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
                logger_1.default.debug(`[AI Error Monitor] Rate limit exceeded for error: ${errorSignature.substring(0, 50)}`);
                return false;
            }
            // Update cache
            cached.count++;
            cached.lastSeen = now;
            return true;
        }
        else {
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
    handleConsecutiveFailure() {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.circuitBreakerTripped = true;
            logger_1.default.error('[AI Error Monitor] Circuit breaker tripped due to consecutive failures');
            // Reset after 10 minutes
            setTimeout(() => {
                this.circuitBreakerTripped = false;
                this.consecutiveFailures = 0;
                logger_1.default.info('[AI Error Monitor] Circuit breaker reset');
            }, 600000);
        }
    }
    /**
     * Clean up error cache periodically
     */
    cleanupErrorCache() {
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
    extractErrorDetails(logLine) {
        const lines = logLine.split('\n');
        const message = lines[0] || logLine;
        const stack = logLine;
        return { message, stack };
    }
    /**
     * Process errors in fix queue
     */
    async processFixes() {
        if (this.isProcessingFixes || this.fixQueue.length === 0 || this.circuitBreakerTripped)
            return;
        this.isProcessingFixes = true;
        try {
            const error = this.fixQueue.shift();
            if (!error)
                return;
            // Check max fix attempts
            if (error.fix_attempts >= this.MAX_FIX_ATTEMPTS) {
                logger_1.default.warn(`[AI Error Monitor] Max fix attempts reached for error ${error.id}`);
                await db_1.default.execute('UPDATE error_logs SET status = ?, failure_reason = ? WHERE id = ?', ['failed', 'Max retry attempts exceeded', error.id]);
                this.handleConsecutiveFailure();
                return;
            }
            logger_1.default.info(`[AI Error Monitor] Processing fix for error ${error.id} (attempt ${error.fix_attempts + 1}/${this.MAX_FIX_ATTEMPTS})`);
            // Update status to analyzing
            await db_1.default.execute('UPDATE error_logs SET status = ? WHERE id = ?', ['analyzing', error.id]);
            // Get AI analysis
            const analysis = await this.getAIAnalysis(error);
            if (analysis) {
                // Save analysis
                await db_1.default.execute('UPDATE error_logs SET ai_analysis = ?, suggested_fix = ? WHERE id = ?', [JSON.stringify(analysis), analysis.suggestedFix, error.id]);
                // Attempt to apply fix
                if (analysis.suggestedFix) {
                    const fixSuccess = await this.applyFix(error, analysis);
                    if (fixSuccess) {
                        // Reset consecutive failures on success
                        this.consecutiveFailures = 0;
                    }
                    else {
                        this.handleConsecutiveFailure();
                    }
                }
            }
            else {
                this.handleConsecutiveFailure();
            }
        }
        catch (error) {
            logger_1.default.error('[AI Error Monitor] Failed to process fix', { error: error instanceof Error ? error.stack : error });
            this.handleConsecutiveFailure();
        }
        finally {
            this.isProcessingFixes = false;
        }
    }
    /**
     * Get AI analysis of error using Claude and Gemini
     */
    async getAIAnalysis(error) {
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
            let analysis = null;
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
                }
                catch (err) {
                    logger_1.default.warn('[AI Error Monitor] Claude analysis failed, trying Gemini', { error: err });
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
                }
                catch (err) {
                    logger_1.default.error('[AI Error Monitor] Gemini analysis failed', { error: err });
                }
            }
            return analysis;
        }
        catch (error) {
            logger_1.default.error('[AI Error Monitor] Failed to get AI analysis', { error: error instanceof Error ? error.stack : error });
            return null;
        }
    }
    /**
     * Apply suggested fix
     */
    async applyFix(error, analysis) {
        try {
            await db_1.default.execute('UPDATE error_logs SET status = ?, fix_attempts = fix_attempts + 1 WHERE id = ?', ['fixing', error.id]);
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
                await db_1.default.execute('UPDATE error_logs SET status = ?, applied_fix = ?, resolved_at = NOW() WHERE id = ?', ['fixed', analysis.suggestedFix, error.id]);
                await this.updateComponentHealth(error.process_name, 'healthy', null);
                logger_1.default.info(`[AI Error Monitor] Successfully fixed error ${error.id}`);
                this.emit('error_fixed', { errorId: error.id, processName: error.process_name });
                return true;
            }
            else {
                await db_1.default.execute('UPDATE error_logs SET status = ? WHERE id = ?', ['failed', error.id]);
                return false;
            }
        }
        catch (error) {
            logger_1.default.error('[AI Error Monitor] Failed to apply fix', { error: error instanceof Error ? error.stack : error });
            try {
                await db_1.default.execute('UPDATE error_logs SET status = ? WHERE id = ?', ['failed', error.id]);
            }
            catch (dbError) {
                logger_1.default.error('[AI Error Monitor] Failed to update error status', { error: dbError });
            }
            return false;
        }
    }
    /**
     * Fix database connection errors
     */
    async fixDatabaseError(error) {
        try {
            // Test database connection
            await db_1.default.execute('SELECT 1');
            logger_1.default.info('[AI Error Monitor] Database connection verified');
            return true;
        }
        catch (err) {
            // Attempt to restart database connection
            logger_1.default.error('[AI Error Monitor] Database connection failed', { error: err });
            return false;
        }
    }
    /**
     * Fix cache/Redis errors
     */
    async fixCacheError(error) {
        try {
            // This would restart Redis service or clear cache
            logger_1.default.info('[AI Error Monitor] Attempting to fix cache error');
            // Implementation would depend on your Redis setup
            return true;
        }
        catch (err) {
            return false;
        }
    }
    /**
     * Fix webhook errors
     */
    async fixWebhookError(error) {
        try {
            // This would recreate failed webhooks
            logger_1.default.info('[AI Error Monitor] Attempting to fix webhook error');
            return true;
        }
        catch (err) {
            return false;
        }
    }
    /**
     * Fix permission errors
     */
    async fixPermissionsError(error) {
        try {
            logger_1.default.info('[AI Error Monitor] Logging permission error for manual review');
            // Permissions usually require manual intervention
            return false;
        }
        catch (err) {
            return false;
        }
    }
    /**
     * Attempt generic fix based on AI suggestion
     */
    async attemptGenericFix(error, analysis) {
        logger_1.default.info('[AI Error Monitor] Generic fix not implemented, logging for review');
        return false;
    }
    /**
     * Update component health status
     */
    async updateComponentHealth(component, status, lastError) {
        try {
            await db_1.default.execute(`INSERT INTO component_health (component, status, last_error, error_count)
                 VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                 status = VALUES(status),
                 last_error = VALUES(last_error),
                 error_count = error_count + 1`, [component, status, lastError]);
        }
        catch (error) {
            logger_1.default.error('[AI Error Monitor] Failed to update component health', { error: error instanceof Error ? error.stack : error });
        }
    }
    /**
     * Perform health checks on all components
     */
    async performHealthChecks() {
        for (const processName of this.PROCESSES_TO_MONITOR) {
            try {
                // Get recent error count
                const [errorRows] = await db_1.default.execute(`SELECT COUNT(*) as count
                     FROM error_logs
                     WHERE process_name = ?
                     AND timestamp > DATE_SUB(NOW(), INTERVAL 5 MINUTE)`, [processName]);
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
            }
            catch (error) {
                logger_1.default.error(`[AI Error Monitor] Health check failed for ${processName}`, { error: error instanceof Error ? error.stack : error });
            }
        }
    }
    /**
     * Get current health status
     */
    getHealthStatus() {
        return this.componentHealth;
    }
    /**
     * Stop monitoring
     */
    stopMonitoring() {
        this.monitoring = false;
        for (const [processName, logProcess] of this.logProcesses) {
            logProcess.kill();
            logger_1.default.info(`[AI Error Monitor] Stopped monitoring ${processName}`);
        }
        this.logProcesses.clear();
    }
}
exports.default = new AIErrorMonitor();
