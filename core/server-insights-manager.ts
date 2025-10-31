import logger from '../utils/logger';
import db from '../utils/db';
import { Client, Guild } from 'discord.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface CountRow extends RowDataPacket {
    count: number;
}

interface MetricRow extends RowDataPacket {
    minutes: number;
    peak: number;
}

interface DailyMetric extends RowDataPacket {
    metric_date: Date;
    member_count: number;
    member_joins: number;
    member_leaves: number;
    message_count: number;
    voice_minutes: number;
    active_users: number;
    peak_voice_count: number;
}

interface HourlyActivity extends RowDataPacket {
    hour_timestamp: Date;
    messages: number;
    voice_users: number;
    commands: number;
}

interface GrowthMetrics {
    memberGrowth: number;
    messageGrowth: number;
    activityTrend: string;
}

interface SummaryMetrics {
    totalMessages: number;
    totalJoins: number;
    totalLeaves: number;
    totalVoiceHours: number;
    avgActiveUsers: number;
    avgMessagesPerDay: number;
}

interface InsightsData {
    dailyMetrics: DailyMetric[];
    hourlyActivity: HourlyActivity[];
    growth: GrowthMetrics;
    summary: SummaryMetrics;
}

class ServerInsightsManager {
    private client: Client;
    private metricsCollectionInterval: NodeJS.Timeout | null;
    private dailyMetrics: Map<string, any>;

    constructor(client: Client) {
        this.client = client;
        this.metricsCollectionInterval = null;
        this.dailyMetrics = new Map();
        logger.info('[ServerInsightsManager] Server insights manager initialized');
    }

    startMetricsCollection(): void {
        // Collect metrics every hour
        this.metricsCollectionInterval = setInterval(() => {
            this.collectHourlyMetrics();
        }, 60 * 60 * 1000); // Every hour

        // Also collect daily metrics at midnight
        this.scheduleDailyCollection();

        logger.info('[ServerInsightsManager] Metrics collection started');
    }

    stopMetricsCollection(): void {
        if (this.metricsCollectionInterval) {
            clearInterval(this.metricsCollectionInterval);
            logger.info('[ServerInsightsManager] Metrics collection stopped');
        }
    }

    scheduleDailyCollection(): void {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        const msUntilMidnight = tomorrow.getTime() - now.getTime();

        setTimeout(() => {
            this.collectDailyMetrics();
            // Schedule next daily collection
            setInterval(() => this.collectDailyMetrics(), 24 * 60 * 60 * 1000);
        }, msUntilMidnight);

        logger.info(`[ServerInsightsManager] Daily collection scheduled in ${Math.floor(msUntilMidnight / 1000 / 60)} minutes`);
    }

    async collectHourlyMetrics(): Promise<void> {
        try {
            const guilds = this.client.guilds.cache;

            for (const [guildId, guild] of guilds) {
                try {
                    const hourTimestamp = new Date();
                    hourTimestamp.setMinutes(0, 0, 0);

                    // Count messages in the last hour
                    const [[messageCount]] = await db.execute<CountRow[]>(`
                        SELECT COUNT(*) as count FROM audit_logs
                        WHERE guild_id = ? AND event_type = 'MESSAGE_CREATE'
                        AND timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
                    `, [guildId]);

                    // Count voice users currently active
                    const voiceUsers = guild.members.cache.filter(m => m.voice.channelId).size;

                    // Count commands executed in the last hour (if tracked)
                    const [[commandCount]] = await db.execute<CountRow[]>(`
                        SELECT COUNT(*) as count FROM audit_logs
                        WHERE guild_id = ? AND event_type = 'COMMAND_USED'
                        AND timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
                    `, [guildId]);

                    await db.execute<ResultSetHeader>(`
                        INSERT INTO server_activity_hourly
                        (guild_id, hour_timestamp, messages, voice_users, commands)
                        VALUES (?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            messages = VALUES(messages),
                            voice_users = VALUES(voice_users),
                            commands = VALUES(commands)
                    `, [guildId, hourTimestamp, messageCount?.count || 0, voiceUsers, commandCount?.count || 0]);

                } catch (guildError) {
                    const err = guildError as Error;
                    logger.error(`[ServerInsightsManager] Failed to collect hourly metrics for guild ${guildId}: ${err.message}`);
                }
            }

            logger.info(`[ServerInsightsManager] Collected hourly metrics for ${guilds.size} guilds`);
        } catch (error) {
            const err = _error as Error;
            logger.error(`[ServerInsightsManager] Error collecting hourly metrics: ${err.message}`);
        }
    }

    async collectDailyMetrics(): Promise<void> {
        try {
            const guilds = this.client.guilds.cache;
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            for (const [guildId, guild] of guilds) {
                try {
                    // Member count
                    const memberCount = guild.memberCount;

                    // Member joins today
                    const [[joins]] = await db.execute<CountRow[]>(`
                        SELECT COUNT(*) as count FROM audit_logs
                        WHERE guild_id = ? AND event_type = 'GUILD_MEMBER_ADD'
                        AND DATE(timestamp) = CURDATE()
                    `, [guildId]);

                    // Member leaves today
                    const [[leaves]] = await db.execute<CountRow[]>(`
                        SELECT COUNT(*) as count FROM audit_logs
                        WHERE guild_id = ? AND event_type IN ('GUILD_MEMBER_REMOVE', 'GUILD_MEMBER_KICK')
                        AND DATE(timestamp) = CURDATE()
                    `, [guildId]);

                    // Message count today
                    const [[messages]] = await db.execute<CountRow[]>(`
                        SELECT COUNT(*) as count FROM audit_logs
                        WHERE guild_id = ? AND event_type = 'MESSAGE_CREATE'
                        AND DATE(timestamp) = CURDATE()
                    `, [guildId]);

                    // Voice minutes today
                    const [[voiceMinutes]] = await db.execute<MetricRow[]>(`
                        SELECT SUM(duration) / 60 as minutes FROM voice_activity
                        WHERE guild_id = ? AND DATE(joined_at) = CURDATE()
                    `, [guildId]);

                    // Active users (sent at least one message)
                    const [[activeUsers]] = await db.execute<CountRow[]>(`
                        SELECT COUNT(DISTINCT user_id) as count FROM audit_logs
                        WHERE guild_id = ? AND event_type = 'MESSAGE_CREATE'
                        AND DATE(timestamp) = CURDATE()
                    `, [guildId]);

                    // Peak voice count
                    const [[peakVoice]] = await db.execute<MetricRow[]>(`
                        SELECT MAX(voice_users) as peak FROM server_activity_hourly
                        WHERE guild_id = ? AND DATE(hour_timestamp) = CURDATE()
                    `, [guildId]);

                    await db.execute<ResultSetHeader>(`
                        INSERT INTO server_metrics
                        (guild_id, metric_date, member_count, member_joins, member_leaves,
                         message_count, voice_minutes, active_users, peak_voice_count)
                        VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            member_count = VALUES(member_count),
                            member_joins = VALUES(member_joins),
                            member_leaves = VALUES(member_leaves),
                            message_count = VALUES(message_count),
                            voice_minutes = VALUES(voice_minutes),
                            active_users = VALUES(active_users),
                            peak_voice_count = VALUES(peak_voice_count)
                    `, [
                        guildId,
                        memberCount,
                        joins?.count || 0,
                        leaves?.count || 0,
                        messages?.count || 0,
                        Math.floor(voiceMinutes?.minutes || 0),
                        activeUsers?.count || 0,
                        peakVoice?.peak || 0
                    ]);

                } catch (guildError) {
                    const err = guildError as Error;
                    logger.error(`[ServerInsightsManager] Failed to collect daily metrics for guild ${guildId}: ${err.message}`);
                }
            }

            logger.info(`[ServerInsightsManager] Collected daily metrics for ${guilds.size} guilds`);
        } catch (error) {
            const err = _error as Error;
            logger.error(`[ServerInsightsManager] Error collecting daily metrics: ${err.message}`);
        }
    }

    async getInsights(guildId: string, days: number = 30): Promise<InsightsData | null> {
        try {
            // Get daily metrics for the past N days
            const [dailyMetrics] = await db.execute<DailyMetric[]>(`
                SELECT * FROM server_metrics
                WHERE guild_id = ? AND metric_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
                ORDER BY metric_date ASC
            `, [guildId, days]);

            // Get hourly activity for heatmap (past 7 days)
            const [hourlyActivity] = await db.execute<HourlyActivity[]>(`
                SELECT * FROM server_activity_hourly
                WHERE guild_id = ? AND hour_timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                ORDER BY hour_timestamp ASC
            `, [guildId]);

            // Calculate growth trends
            const growth = this.calculateGrowth(dailyMetrics);

            return {
                dailyMetrics,
                hourlyActivity,
                growth,
                summary: this.calculateSummary(dailyMetrics)
            };
        } catch (error) {
            const err = _error as Error;
            logger.error(`[ServerInsightsManager] Failed to get insights: ${err.message}`, { guildId });
            return null;
        }
    }

    calculateGrowth(metrics: DailyMetric[]): GrowthMetrics {
        if (metrics.length < 2) return { memberGrowth: 0, messageGrowth: 0, activityTrend: 'stable' };

        const latest = metrics[metrics.length - 1];
        const earliest = metrics[0];

        const memberGrowth = latest.member_count - earliest.member_count;
        const avgMessages = metrics.reduce((sum, m) => sum + m.message_count, 0) / metrics.length;
        const messageGrowth = latest.message_count - avgMessages;

        return {
            memberGrowth,
            messageGrowth: Math.round(messageGrowth),
            activityTrend: latest.active_users > (earliest.active_users || 1) ? 'increasing' : 'decreasing'
        };
    }

    calculateSummary(metrics: DailyMetric[]): SummaryMetrics {
        if (metrics.length === 0) return {
            totalMessages: 0,
            totalJoins: 0,
            totalLeaves: 0,
            totalVoiceHours: 0,
            avgActiveUsers: 0,
            avgMessagesPerDay: 0
        };

        const totalMessages = metrics.reduce((sum, m) => sum + m.message_count, 0);
        const totalJoins = metrics.reduce((sum, m) => sum + m.member_joins, 0);
        const totalLeaves = metrics.reduce((sum, m) => sum + m.member_leaves, 0);
        const totalVoiceMinutes = metrics.reduce((sum, m) => sum + m.voice_minutes, 0);
        const avgActiveUsers = Math.round(metrics.reduce((sum, m) => sum + m.active_users, 0) / metrics.length);

        return {
            totalMessages,
            totalJoins,
            totalLeaves,
            totalVoiceHours: Math.round(totalVoiceMinutes / 60),
            avgActiveUsers,
            avgMessagesPerDay: Math.round(totalMessages / metrics.length)
        };
    }

    async trackMemberJoin(guildId: string, userId: string): Promise<void> {
        // Update today's metrics
        await db.execute<ResultSetHeader>(`
            INSERT INTO server_metrics (guild_id, metric_date, member_joins)
            VALUES (?, CURDATE(), 1)
            ON DUPLICATE KEY UPDATE member_joins = member_joins + 1
        `, [guildId]);
    }

    async trackMemberLeave(guildId: string, userId: string): Promise<void> {
        // Update today's metrics
        await db.execute<ResultSetHeader>(`
            INSERT INTO server_metrics (guild_id, metric_date, member_leaves)
            VALUES (?, CURDATE(), 1)
            ON DUPLICATE KEY UPDATE member_leaves = member_leaves + 1
        `, [guildId]);
    }
}

export = ServerInsightsManager;
