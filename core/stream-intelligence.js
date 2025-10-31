"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const intelligent_cache_manager_1 = require("../utils/intelligent-cache-manager");
class StreamerProfile {
    constructor(streamerId, data = {}) {
        this.streamerId = streamerId;
        this.username = data.username;
        this.platform = data.platform;
        // Historical data
        this.streamHistory = data.streamHistory || [];
        this.avgStreamDuration = data.avgStreamDuration || 0;
        this.avgViewerCount = data.avgViewerCount || 0;
        this.peakViewerCount = data.peakViewerCount || 0;
        // Schedule patterns
        this.schedulePattern = data.schedulePattern || this.analyzeSchedulePattern();
        this.consistency = data.consistency || 0;
        // Behavioral metrics
        this.streamFrequency = data.streamFrequency || 0;
        this.preferredDays = data.preferredDays || [];
        this.preferredHours = data.preferredHours || [];
        // Engagement metrics
        this.growthRate = data.growthRate || 0;
        this.retentionRate = data.retentionRate || 0;
        // Last updated
        this.lastUpdated = data.lastUpdated || Date.now();
    }
    analyzeSchedulePattern() {
        if (this.streamHistory.length < 5) {
            return {
                type: 'insufficient_data',
                confidence: 0
            };
        }
        // Extract day of week and hour patterns
        const dayOfWeekCounts = new Array(7).fill(0);
        const hourCounts = new Array(24).fill(0);
        const intervals = [];
        for (let i = 0; i < this.streamHistory.length; i++) {
            const stream = this.streamHistory[i];
            const date = new Date(stream.startTime);
            dayOfWeekCounts[date.getDay()]++;
            hourCounts[date.getHours()]++;
            if (i > 0) {
                const prevStream = this.streamHistory[i - 1];
                const interval = new Date(stream.startTime).getTime() - new Date(prevStream.startTime).getTime();
                intervals.push(interval / (1000 * 60 * 60)); // hours
            }
        }
        // Determine pattern type
        const avgInterval = intervals.length > 0
            ? intervals.reduce((a, b) => a + b, 0) / intervals.length
            : 0;
        let patternType;
        if (avgInterval <= 26)
            patternType = 'daily';
        else if (avgInterval <= 52)
            patternType = 'every_other_day';
        else if (avgInterval <= 200)
            patternType = 'weekly';
        else
            patternType = 'irregular';
        // Calculate consistency (lower std dev = higher consistency)
        const stdDev = this.calculateStdDev(intervals);
        const consistency = Math.max(0, Math.min(100, 100 - (stdDev / avgInterval * 100)));
        // Find preferred days and hours
        const maxDayCount = Math.max(...dayOfWeekCounts);
        const maxHourCount = Math.max(...hourCounts);
        this.preferredDays = dayOfWeekCounts
            .map((count, day) => ({ day, count }))
            .filter(d => d.count >= maxDayCount * 0.5)
            .map(d => d.day);
        this.preferredHours = hourCounts
            .map((count, hour) => ({ hour, count }))
            .filter(h => h.count >= maxHourCount * 0.5)
            .map(h => h.hour);
        return {
            type: patternType,
            confidence: consistency,
            avgIntervalHours: avgInterval,
            preferredDays: this.preferredDays,
            preferredHours: this.preferredHours
        };
    }
    predictNextStream() {
        if (this.streamHistory.length === 0) {
            return {
                predictedTime: null,
                confidence: 0,
                reason: 'no_history'
            };
        }
        const lastStream = this.streamHistory[0]; // Assuming sorted by most recent
        const lastStreamTime = new Date(lastStream.startTime);
        if (this.schedulePattern.type === 'insufficient_data') {
            return {
                predictedTime: null,
                confidence: 0,
                reason: 'insufficient_data'
            };
        }
        // Predict based on pattern
        let predictedTime;
        switch (this.schedulePattern.type) {
            case 'daily':
                predictedTime = new Date(lastStreamTime.getTime() + 24 * 60 * 60 * 1000);
                break;
            case 'every_other_day':
                predictedTime = new Date(lastStreamTime.getTime() + 48 * 60 * 60 * 1000);
                break;
            case 'weekly':
                predictedTime = new Date(lastStreamTime.getTime() + 7 * 24 * 60 * 60 * 1000);
                break;
            default:
                predictedTime = new Date(lastStreamTime.getTime() + (this.schedulePattern.avgIntervalHours || 0) * 60 * 60 * 1000);
        }
        // Adjust to preferred hours if available
        if (this.preferredHours.length > 0) {
            const closestHour = this.findClosestValue(predictedTime.getHours(), this.preferredHours);
            predictedTime.setHours(closestHour, 0, 0, 0);
        }
        return {
            predictedTime: predictedTime.toISOString(),
            confidence: this.schedulePattern.confidence,
            pattern: this.schedulePattern.type,
            reason: 'pattern_based'
        };
    }
    getOptimalCheckInterval() {
        const prediction = this.predictNextStream();
        if (!prediction.predictedTime) {
            // No pattern, check frequently
            return 60; // 1 minute
        }
        const now = Date.now();
        const predictedTime = new Date(prediction.predictedTime).getTime();
        const timeUntilStream = predictedTime - now;
        // Adaptive intervals based on time until predicted stream
        if (timeUntilStream < 0) {
            // Past predicted time, check frequently
            return 60; // 1 minute
        }
        else if (timeUntilStream < 15 * 60 * 1000) {
            // Within 15 minutes
            return 60; // 1 minute
        }
        else if (timeUntilStream < 60 * 60 * 1000) {
            // Within 1 hour
            return 5 * 60; // 5 minutes
        }
        else if (timeUntilStream < 3 * 60 * 60 * 1000) {
            // Within 3 hours
            return 15 * 60; // 15 minutes
        }
        else {
            // More than 3 hours away
            return 30 * 60; // 30 minutes
        }
    }
    predictViewerCount(minutesIntoStream) {
        if (this.streamHistory.length === 0) {
            return {
                predicted: this.avgViewerCount || 0,
                confidence: 0
            };
        }
        // Simple prediction: avg viewer count with growth rate applied
        const baseViewers = this.avgViewerCount;
        const growth = 1 + (this.growthRate / 100);
        const predicted = Math.round(baseViewers * growth);
        // Adjust based on time into stream (viewers typically peak 30-60 mins in)
        let timeMultiplier = 1.0;
        if (minutesIntoStream < 30) {
            timeMultiplier = 0.6 + (minutesIntoStream / 30) * 0.4;
        }
        else if (minutesIntoStream < 60) {
            timeMultiplier = 1.0 + ((minutesIntoStream - 30) / 30) * 0.2;
        }
        else if (minutesIntoStream < 120) {
            timeMultiplier = 1.2 - ((minutesIntoStream - 60) / 60) * 0.1;
        }
        else {
            timeMultiplier = 1.1 - Math.min(0.3, (minutesIntoStream - 120) / 600);
        }
        return {
            predicted: Math.round(predicted * timeMultiplier),
            confidence: Math.min(80, this.streamHistory.length * 10),
            baseline: baseViewers,
            growthRate: this.growthRate
        };
    }
    detectAnomaly(currentData) {
        const anomalies = [];
        // Check if streaming at unusual time
        if (this.preferredHours.length > 0) {
            const currentHour = new Date().getHours();
            if (!this.preferredHours.includes(currentHour)) {
                anomalies.push({
                    type: 'unusual_time',
                    severity: 'low',
                    message: `Streaming outside usual hours (${this.preferredHours.join(', ')})`
                });
            }
        }
        // Check for viewer count spike
        if (currentData.viewerCount) {
            const expectedViewers = this.avgViewerCount;
            const deviation = Math.abs(currentData.viewerCount - expectedViewers) / expectedViewers;
            if (deviation > 2.0) {
                anomalies.push({
                    type: 'viewer_spike',
                    severity: currentData.viewerCount > expectedViewers ? 'positive' : 'negative',
                    message: `Unusual viewer count: ${currentData.viewerCount} (avg: ${expectedViewers})`
                });
            }
        }
        return anomalies;
    }
    updateFromStream(streamData) {
        // Add to history
        this.streamHistory.unshift({
            startTime: streamData.startedAt,
            endTime: streamData.endedAt || null,
            duration: streamData.duration || null,
            peakViewers: streamData.peakViewers || 0,
            avgViewers: streamData.avgViewers || 0,
            game: streamData.game || null
        });
        // Keep only last 50 streams
        if (this.streamHistory.length > 50) {
            this.streamHistory = this.streamHistory.slice(0, 50);
        }
        // Recalculate metrics
        this.calculateMetrics();
        this.schedulePattern = this.analyzeSchedulePattern();
        this.lastUpdated = Date.now();
    }
    calculateMetrics() {
        if (this.streamHistory.length === 0)
            return;
        // Average stream duration
        const durations = this.streamHistory
            .filter(s => s.duration)
            .map(s => s.duration);
        this.avgStreamDuration = durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : 0;
        // Average viewers
        const avgViewers = this.streamHistory
            .filter(s => s.avgViewers)
            .map(s => s.avgViewers);
        this.avgViewerCount = avgViewers.length > 0
            ? Math.round(avgViewers.reduce((a, b) => a + b, 0) / avgViewers.length)
            : 0;
        // Peak viewers
        this.peakViewerCount = Math.max(...this.streamHistory.map(s => s.peakViewers || 0));
        // Stream frequency (streams per week)
        if (this.streamHistory.length >= 2) {
            const oldestStream = this.streamHistory[this.streamHistory.length - 1];
            const newestStream = this.streamHistory[0];
            const daySpan = (new Date(newestStream.startTime).getTime() - new Date(oldestStream.startTime).getTime()) / (1000 * 60 * 60 * 24);
            this.streamFrequency = (this.streamHistory.length / daySpan) * 7;
        }
        // Growth rate (recent 10 streams vs previous 10)
        if (this.streamHistory.length >= 20) {
            const recent = this.streamHistory.slice(0, 10);
            const previous = this.streamHistory.slice(10, 20);
            const recentAvg = recent.reduce((sum, s) => sum + (s.avgViewers || 0), 0) / recent.length;
            const previousAvg = previous.reduce((sum, s) => sum + (s.avgViewers || 0), 0) / previous.length;
            this.growthRate = previousAvg > 0 ? ((recentAvg - previousAvg) / previousAvg * 100) : 0;
        }
    }
    // Utility methods
    calculateStdDev(values) {
        if (values.length === 0)
            return 0;
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const squareDiffs = values.map(value => Math.pow(value - avg, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
        return Math.sqrt(avgSquareDiff);
    }
    findClosestValue(target, array) {
        return array.reduce((prev, curr) => Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev);
    }
    toJSON() {
        return {
            username: this.username,
            platform: this.platform,
            streamHistory: this.streamHistory,
            avgStreamDuration: this.avgStreamDuration,
            avgViewerCount: this.avgViewerCount,
            peakViewerCount: this.peakViewerCount,
            schedulePattern: this.schedulePattern,
            consistency: this.schedulePattern.confidence,
            streamFrequency: this.streamFrequency,
            preferredDays: this.preferredDays,
            preferredHours: this.preferredHours,
            growthRate: this.growthRate,
            retentionRate: this.retentionRate,
            lastUpdated: this.lastUpdated
        };
    }
}
class StreamIntelligence {
    constructor() {
        this.profiles = new Map();
        this.cache = (0, intelligent_cache_manager_1.getCacheManager)('stream-intelligence', {
            defaultTTL: 3600,
            maxTTL: 7200,
            minTTL: 600
        });
        // Load profiles from database on init
        this.loadProfiles();
    }
    async loadProfiles() {
        try {
            const [rows] = await db_1.default.execute(`
                SELECT
                    s.streamer_id,
                    s.username,
                    s.platform,
                    sp.profile_data,
                    sp.last_updated
                FROM streamers s
                LEFT JOIN streamer_profiles sp ON s.streamer_id = sp.streamer_id
                WHERE sp.profile_data IS NOT NULL
            `);
            for (const row of rows) {
                const profileData = JSON.parse(row.profile_data);
                this.profiles.set(row.streamer_id, new StreamerProfile(row.streamer_id, profileData));
            }
            logger_1.default.info(`Loaded ${this.profiles.size} streamer profiles`, { category: 'stream-intelligence' });
        }
        catch (error) {
            const err = error;
            logger_1.default.error('Failed to load streamer profiles:', {
                category: 'stream-intelligence',
                error: err.message
            });
        }
    }
    async getProfile(streamerId) {
        // Check memory cache first
        if (this.profiles.has(streamerId)) {
            return this.profiles.get(streamerId);
        }
        // Load from database
        try {
            const [rows] = await db_1.default.execute(`
                SELECT
                    s.streamer_id,
                    s.username,
                    s.platform,
                    sp.profile_data
                FROM streamers s
                LEFT JOIN streamer_profiles sp ON s.streamer_id = sp.streamer_id
                WHERE s.streamer_id = ?
            `, [streamerId]);
            if (rows.length > 0 && rows[0].profile_data) {
                const profileData = JSON.parse(rows[0].profile_data);
                const profile = new StreamerProfile(streamerId, profileData);
                this.profiles.set(streamerId, profile);
                return profile;
            }
            // Create new profile
            const profile = new StreamerProfile(streamerId, {
                username: rows[0]?.username,
                platform: rows[0]?.platform
            });
            this.profiles.set(streamerId, profile);
            return profile;
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`Failed to get profile for streamer ${streamerId}:`, {
                category: 'stream-intelligence',
                error: err.message
            });
            return null;
        }
    }
    async saveProfile(streamerId) {
        const profile = this.profiles.get(streamerId);
        if (!profile)
            return;
        try {
            await db_1.default.execute(`
                INSERT INTO streamer_profiles (streamer_id, profile_data, last_updated)
                VALUES (?, ?, NOW())
                ON DUPLICATE KEY UPDATE profile_data = VALUES(profile_data), last_updated = NOW()
            `, [streamerId, JSON.stringify(profile.toJSON())]);
            logger_1.default.debug(`Saved profile for streamer ${streamerId}`, { category: 'stream-intelligence' });
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`Failed to save profile for streamer ${streamerId}:`, {
                category: 'stream-intelligence',
                error: err.message
            });
        }
    }
    async getOptimalCheckInterval(streamerId) {
        const profile = await this.getProfile(streamerId);
        if (!profile)
            return 60;
        return profile.getOptimalCheckInterval();
    }
    async predictNextStream(streamerId) {
        const profile = await this.getProfile(streamerId);
        if (!profile)
            return null;
        return profile.predictNextStream();
    }
    async predictViewerCount(streamerId, minutesIntoStream) {
        const profile = await this.getProfile(streamerId);
        if (!profile)
            return null;
        return profile.predictViewerCount(minutesIntoStream);
    }
    async detectAnomalies(streamerId, currentData) {
        const profile = await this.getProfile(streamerId);
        if (!profile)
            return [];
        return profile.detectAnomaly(currentData);
    }
    async recordStreamEnd(streamerId, streamData) {
        const profile = await this.getProfile(streamerId);
        if (!profile)
            return;
        profile.updateFromStream(streamData);
        await this.saveProfile(streamerId);
        logger_1.default.info(`Updated profile for streamer ${streamerId} after stream end`, {
            category: 'stream-intelligence',
            metrics: {
                avgDuration: profile.avgStreamDuration,
                avgViewers: profile.avgViewerCount,
                pattern: profile.schedulePattern.type
            }
        });
    }
    async getAnalytics(streamerId) {
        const profile = await this.getProfile(streamerId);
        if (!profile)
            return null;
        const prediction = profile.predictNextStream();
        const optimalInterval = profile.getOptimalCheckInterval();
        return {
            streamerId,
            username: profile.username,
            platform: profile.platform,
            metrics: {
                avgStreamDuration: profile.avgStreamDuration,
                avgViewerCount: profile.avgViewerCount,
                peakViewerCount: profile.peakViewerCount,
                streamFrequency: profile.streamFrequency.toFixed(2),
                growthRate: profile.growthRate.toFixed(2) + '%',
                consistency: profile.schedulePattern.confidence.toFixed(2) + '%'
            },
            schedule: {
                pattern: profile.schedulePattern.type,
                preferredDays: profile.preferredDays.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]),
                preferredHours: profile.preferredHours,
                nextPredicted: prediction.predictedTime,
                predictionConfidence: prediction.confidence.toFixed(2) + '%'
            },
            optimization: {
                optimalCheckIntervalSeconds: optimalInterval,
                recentStreams: profile.streamHistory.length
            }
        };
    }
}
// Singleton instance
const streamIntelligence = new StreamIntelligence();
module.exports = {
    streamIntelligence,
    StreamerProfile,
    StreamIntelligence
};
