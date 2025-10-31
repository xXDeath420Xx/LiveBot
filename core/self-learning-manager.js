"use strict";
/**
 * Self-Learning Manager
 * Uses Gemini AI to analyze usage patterns, learn from user interactions,
 * and continuously improve bot responses and features
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const generative_ai_1 = require("@google/generative-ai");
class SelfLearningManager {
    constructor(client) {
        this.client = client;
        this.genAI = process.env.GEMINI_API_KEY ? new generative_ai_1.GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
        this.model = this.genAI ? this.genAI.getGenerativeModel({ model: 'gemini-pro' }) : null;
        this.learningEnabled = !!process.env.GEMINI_API_KEY;
        this.analysisInterval = 3600000; // 1 hour
        this.insights = [];
    }
    /**
     * Initialize self-learning system
     */
    async initialize() {
        if (!this.learningEnabled) {
            logger_1.default.warn('[Self-Learning] Gemini API key not found. Self-learning disabled.');
            return;
        }
        logger_1.default.info('[Self-Learning] Initializing AI-powered self-learning system...');
        // Start periodic analysis
        this.startPeriodicAnalysis();
        // Analyze command usage patterns
        setInterval(() => this.analyzeCommandPatterns(), this.analysisInterval);
        // Analyze error patterns
        setInterval(() => this.analyzeErrorPatterns(), this.analysisInterval);
        // Analyze user engagement
        setInterval(() => this.analyzeUserEngagement(), this.analysisInterval);
        logger_1.default.info('[Self-Learning] Self-learning system initialized ✅');
    }
    /**
     * Start periodic analysis
     */
    startPeriodicAnalysis() {
        // Run initial analysis after 5 minutes
        setTimeout(() => this.runFullAnalysis(), 300000);
        // Then run every 6 hours
        setInterval(() => this.runFullAnalysis(), 21600000);
    }
    /**
     * Run full AI analysis of bot performance
     */
    async runFullAnalysis() {
        try {
            logger_1.default.info('[Self-Learning] Running full AI analysis...');
            const [commandStats, errorStats, engagementStats] = await Promise.all([
                this.getCommandStats(),
                this.getErrorStats(),
                this.getEngagementStats()
            ]);
            const prompt = `You are analyzing a Discord bot's performance data. Based on the following statistics, provide actionable insights and recommendations:

COMMAND STATISTICS:
${JSON.stringify(commandStats, null, 2)}

ERROR STATISTICS:
${JSON.stringify(errorStats, null, 2)}

ENGAGEMENT STATISTICS:
${JSON.stringify(engagementStats, null, 2)}

Please provide:
1. Top 3 most critical issues or opportunities
2. Specific recommendations for improvement
3. Features that appear underutilized
4. Potential performance optimizations
5. User experience improvements

Format your response as JSON with this structure:
{
  "criticalIssues": ["issue1", "issue2", "issue3"],
  "recommendations": ["rec1", "rec2", "rec3"],
  "underutilizedFeatures": ["feature1", "feature2"],
  "optimizations": ["opt1", "opt2"],
  "uxImprovements": ["ux1", "ux2"]
}`;
            const result = await this.model.generateContent(prompt);
            const response = result.response.text();
            // Parse AI response
            const insights = this.parseAIResponse(response);
            this.insights.push({
                timestamp: new Date(),
                insights
            });
            logger_1.default.info('[Self-Learning] AI analysis complete', { insights });
            // Store insights in database
            await this.storeInsights(insights);
            // Apply automatic improvements if safe
            await this.applyAutomatedImprovements(insights);
            return insights;
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Analysis error:', error);
        }
    }
    /**
     * Analyze command usage patterns
     */
    async analyzeCommandPatterns() {
        try {
            const stats = await this.getCommandStats();
            const prompt = `Analyze these Discord bot command usage statistics and identify patterns:
${JSON.stringify(stats, null, 2)}

What patterns do you see? What commands are:
1. Most popular
2. Underutilized
3. Causing errors
4. Taking too long to execute

Provide brief insights (3-5 bullet points).`;
            const result = await this.model.generateContent(prompt);
            const insights = result.response.text();
            logger_1.default.info('[Self-Learning] Command pattern insights:', { insights });
            return insights;
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Command pattern analysis error:', error);
        }
    }
    /**
     * Analyze error patterns
     */
    async analyzeErrorPatterns() {
        try {
            const stats = await this.getErrorStats();
            if (stats.totalErrors === 0) {
                logger_1.default.info('[Self-Learning] No errors to analyze ✅');
                return null;
            }
            const prompt = `Analyze these error patterns from a Discord bot and suggest fixes:
${JSON.stringify(stats, null, 2)}

For each error category:
1. Identify root cause
2. Suggest automated fix if possible
3. Recommend preventive measures

Format as JSON with error type as key and analysis as value.`;
            const result = await this.model.generateContent(prompt);
            const analysis = this.parseAIResponse(result.response.text());
            logger_1.default.info('[Self-Learning] Error pattern analysis:', { analysis });
            return analysis;
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Error pattern analysis failed:', error);
        }
    }
    /**
     * Analyze user engagement
     */
    async analyzeUserEngagement() {
        try {
            const stats = await this.getEngagementStats();
            const prompt = `Analyze user engagement metrics for a Discord bot:
${JSON.stringify(stats, null, 2)}

Identify:
1. Peak activity times
2. Most engaging features
3. Drop-off points
4. Opportunities to increase engagement

Provide actionable recommendations.`;
            const result = await this.model.generateContent(prompt);
            const insights = result.response.text();
            logger_1.default.info('[Self-Learning] Engagement insights:', { insights });
            return insights;
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Engagement analysis error:', error);
        }
    }
    /**
     * Get command statistics from database
     */
    async getCommandStats() {
        try {
            // This would query your command usage tracking table
            // For now, return sample structure
            return {
                totalCommands: 0,
                commandsByCategory: {},
                topCommands: [],
                errorRate: 0,
                avgExecutionTime: 0
            };
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Failed to get command stats:', error);
            return {
                totalCommands: 0,
                commandsByCategory: {},
                topCommands: [],
                errorRate: 0,
                avgExecutionTime: 0
            };
        }
    }
    /**
     * Get error statistics
     */
    async getErrorStats() {
        try {
            return {
                totalErrors: 0,
                errorsByType: {},
                errorsByCommand: {},
                recentErrors: []
            };
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Failed to get error stats:', error);
            return {
                totalErrors: 0,
                errorsByType: {},
                errorsByCommand: {},
                recentErrors: []
            };
        }
    }
    /**
     * Get engagement statistics
     */
    async getEngagementStats() {
        try {
            const [guilds] = await db_1.default.execute('SELECT COUNT(*) as count FROM (SELECT DISTINCT guild_id FROM subscriptions) AS unique_guilds');
            const [streamers] = await db_1.default.execute('SELECT COUNT(*) as count FROM streamers WHERE is_live = 1');
            return {
                totalGuilds: guilds[0]?.count || 0,
                liveStreamers: streamers[0]?.count || 0,
                activeFeatures: []
            };
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Failed to get engagement stats:', error);
            return {
                totalGuilds: 0,
                liveStreamers: 0,
                activeFeatures: []
            };
        }
    }
    /**
     * Parse AI response (attempt JSON parse, fallback to text)
     */
    parseAIResponse(response) {
        try {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1]);
            }
            // Try direct JSON parse
            return JSON.parse(response);
        }
        catch {
            // Return raw text if not JSON
            return { raw: response };
        }
    }
    /**
     * Store insights in database
     */
    async storeInsights(insights) {
        try {
            await db_1.default.execute(`CREATE TABLE IF NOT EXISTS ai_insights (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    insights_data JSON NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )`);
            await db_1.default.execute('INSERT INTO ai_insights (insights_data) VALUES (?)', [JSON.stringify(insights)]);
            logger_1.default.info('[Self-Learning] Insights stored in database');
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Failed to store insights:', error);
        }
    }
    /**
     * Apply automated improvements based on AI insights
     */
    async applyAutomatedImprovements(insights) {
        try {
            // Only apply safe, non-breaking improvements
            logger_1.default.info('[Self-Learning] Evaluating automated improvements...');
            // Example: If AI detects high memory usage, trigger cleanup
            if (insights.optimizations?.some(opt => opt.toLowerCase().includes('memory'))) {
                logger_1.default.info('[Self-Learning] Applying memory optimization...');
                if (global.gc)
                    global.gc();
            }
            // More automated improvements can be added here
            // But should be carefully reviewed to avoid breaking changes
        }
        catch (error) {
            logger_1.default.error('[Self-Learning] Failed to apply improvements:', error);
        }
    }
    /**
     * Get latest insights
     */
    getLatestInsights() {
        return this.insights.slice(-5); // Last 5 insights
    }
    /**
     * Get learning status
     */
    getStatus() {
        return {
            enabled: this.learningEnabled,
            insightsGenerated: this.insights.length,
            lastAnalysis: this.insights.length > 0 ? this.insights[this.insights.length - 1].timestamp : null
        };
    }
}
module.exports = SelfLearningManager;
