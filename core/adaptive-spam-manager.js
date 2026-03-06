import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import configCache from '../utils/configCache.js';

/**
 * Adaptive Spam Manager - Learns from spam patterns and adapts detection over time
 * Inspired by Sery Bot's evolving spam filter
 */
class AdaptiveSpamManager {
    constructor(client) {
        this.client = client;

        // Max sizes to prevent unbounded memory growth
        this.MAX_RECENT_MESSAGES = 5000;  // Max users tracked
        this.MAX_MESSAGE_HASHES = 10000;  // Max hash entries
        this.MAX_PATTERN_HITS = 1000;     // Max patterns tracked

        // Track recent messages per user for baseline calculation
        // Format: Map<`${guildId}_${userId}`, CircularBuffer of { timestamp, channelId, hash }>
        this.recentMessages = new Map();

        // Track message hashes for cross-channel detection
        // Format: Map<`${guildId}_${hash}`, { userId, channels: Set, firstSeen, lastSeen }>
        this.messageHashes = new Map();

        // Track pattern effectiveness
        // Format: Map<patternId, { hits: 0, falsePositives: 0 }>
        this.patternHits = new Map();

        // Store interval IDs for cleanup
        this.intervals = [];

        // Clean up old data every 5 minutes
        this.intervals.push(setInterval(() => this.cleanupOldData(), 300000));

        // Recalculate baselines hourly
        this.intervals.push(setInterval(() => this.recalculateBaselines(), 3600000));

        // Persist pattern stats every 10 minutes
        this.intervals.push(setInterval(() => this.persistPatternStats(), 600000));

        logger.info('[AdaptiveSpam] Manager initialized', {
            maxRecentMessages: this.MAX_RECENT_MESSAGES,
            maxMessageHashes: this.MAX_MESSAGE_HASHES
        });
    }

    /**
     * Stop all intervals (call on shutdown)
     */
    stop() {
        for (const interval of this.intervals) {
            clearInterval(interval);
        }
        this.intervals = [];
        this.recentMessages.clear();
        this.messageHashes.clear();
        this.patternHits.clear();
        logger.info('[AdaptiveSpam] Manager stopped and cleaned up');
    }

    /**
     * Analyze a message for spam indicators
     * This runs AFTER regular automod and provides secondary analysis
     * @param {Message} message - The message to analyze
     * @returns {boolean} - Whether spam was detected
     */
    async analyzeMessage(message) {
        const { guild, author, channel, member } = message;

        // Skip spam detection for users with Administrator permission or guild owners
        if (member) {
            const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = member.id === guild.ownerId;
            if (isAdmin || isOwner) return false;
        }

        try {
            // Get config
            const config = await this.getConfig(guild.id);
            if (!config || !config.enabled) return false;

            // Skip exempt channels (e.g. self-promo / live announcement channels)
            if (config.exempt_channels) {
                try {
                    const exempt = typeof config.exempt_channels === 'string'
                        ? JSON.parse(config.exempt_channels) : config.exempt_channels;
                    if (Array.isArray(exempt) && exempt.includes(channel.id)) return false;
                } catch { /* invalid JSON, ignore */ }
            }

            const key = `${guild.id}_${author.id}`;

            // Track this message
            const messageHash = this.hashMessage(message.content);
            const now = Date.now();

            // Initialize or get user tracking (with max size enforcement)
            if (!this.recentMessages.has(key)) {
                // Enforce max size - evict oldest entry if at limit
                if (this.recentMessages.size >= this.MAX_RECENT_MESSAGES) {
                    const oldestKey = this.recentMessages.keys().next().value;
                    this.recentMessages.delete(oldestKey);
                }
                this.recentMessages.set(key, []);
            }

            const userMessages = this.recentMessages.get(key);
            userMessages.push({
                timestamp: now,
                channelId: channel.id,
                hash: messageHash,
                length: message.content.length
            });

            // Keep only last hour of messages
            const hourAgo = now - 3600000;
            const filtered = userMessages.filter(m => m.timestamp > hourAgo);
            this.recentMessages.set(key, filtered);

            // Track for cross-channel spam
            await this.trackCrossChannelSpam(guild.id, author.id, messageHash, channel.id, message.content);

            // Get user's spam profile
            const profile = await this.getOrCreateProfile(guild.id, author.id);

            // Apply score decay - reduce score by 5 points per minute of inactivity
            const timeSinceLastMsg = filtered.length > 1
                ? now - filtered[filtered.length - 2].timestamp
                : 60000; // Default 1 minute if first tracked message
            const decayMinutes = Math.floor(timeSinceLastMsg / 60000);
            const decayedScore = Math.max(0, profile.spam_score - (decayMinutes * 5));

            // Calculate current spam score
            const spamScore = await this.calculateSpamScore(guild, author, config, profile, filtered);

            // Update profile with decayed score + new score
            const newScore = Math.min(100, decayedScore + spamScore);
            if (newScore !== profile.spam_score) {
                await this.updateProfile(guild.id, author.id, {
                    spam_score: newScore
                });
            }

            // Check if action threshold exceeded (raised from 50 to 75 to reduce false positives)
            const actionThreshold = config.action_threshold || 75;
            if (newScore >= actionThreshold) {
                await this.triggerSpamAction(message, config, newScore);
                return true;
            }

            return false;

        } catch (error) {
            logger.error('[AdaptiveSpam] Error analyzing message', {
                error: error.message,
                guildId: guild.id,
                userId: author.id
            });
            return false;
        }
    }

    /**
     * Hash message content for comparison
     */
    hashMessage(content) {
        // Normalize: lowercase, remove extra whitespace, remove URLs
        const normalized = content
            .toLowerCase()
            .replace(/https?:\/\/\S+/g, '[URL]')
            .replace(/\s+/g, ' ')
            .trim();

        return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
    }

    /**
     * Track cross-channel spam
     */
    async trackCrossChannelSpam(guildId, userId, hash, channelId, content) {
        const key = `${guildId}_${hash}`;

        if (!this.messageHashes.has(key)) {
            // Enforce max size - evict oldest entry if at limit
            if (this.messageHashes.size >= this.MAX_MESSAGE_HASHES) {
                const oldestKey = this.messageHashes.keys().next().value;
                this.messageHashes.delete(oldestKey);
            }
            this.messageHashes.set(key, {
                userId,
                channels: new Set([channelId]),
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                preview: content.substring(0, 100)
            });
        } else {
            const entry = this.messageHashes.get(key);
            entry.channels.add(channelId);
            entry.lastSeen = Date.now();

            // Check if cross-channel threshold exceeded
            const config = await this.getConfig(guildId);
            if (entry.channels.size >= (config?.cross_channel_threshold || 3)) {
                // Check timeframe
                const timeframeMs = (config?.cross_channel_timeframe_minutes || 5) * 60 * 1000;
                if (entry.lastSeen - entry.firstSeen <= timeframeMs) {
                    // Log cross-channel spam
                    await this.logCrossChannelSpam(guildId, userId, hash, entry);
                }
            }
        }
    }

    /**
     * Log cross-channel spam to database
     */
    async logCrossChannelSpam(guildId, userId, hash, entry) {
        try {
            await pool.execute(
                `INSERT INTO cross_channel_spam (guild_id, user_id, message_hash, message_preview, channel_ids, channel_count, flagged)
                 VALUES (?, ?, ?, ?, ?, ?, TRUE)
                 ON DUPLICATE KEY UPDATE
                    channel_ids = VALUES(channel_ids),
                    channel_count = VALUES(channel_count),
                    last_seen = NOW(),
                    flagged = TRUE`,
                [
                    guildId,
                    userId,
                    hash,
                    entry.preview,
                    JSON.stringify([...entry.channels]),
                    entry.channels.size
                ]
            );
        } catch (error) {
            logger.error('[AdaptiveSpam] Error logging cross-channel spam', { error: error.message });
        }
    }

    /**
     * Calculate spam score for a user
     * ONLY triggers on actual spam patterns (repeated messages), NOT message volume
     */
    async calculateSpamScore(guild, author, config, profile, recentMessages) {
        let score = 0;

        // Count repeated message hashes (same/similar content)
        const repeatedHashes = {};
        for (const msg of recentMessages) {
            repeatedHashes[msg.hash] = (repeatedHashes[msg.hash] || 0) + 1;
        }

        // 1. Check for repeated identical/similar messages (actual spam behavior)
        for (const [hash, count] of Object.entries(repeatedHashes)) {
            // Only flag if same message sent 4+ times in the tracking window
            if (count >= 4) {
                // This IS spam - same message repeated multiple times
                score += Math.min(50, (count - 3) * 15);

                logger.debug('[AdaptiveSpam] Repeated message detected', {
                    guildId: guild.id,
                    userId: author.id,
                    repeatCount: count,
                    scoreAdded: Math.min(50, (count - 3) * 15)
                });
            }
        }

        // 2. Check for cross-channel spam (same message in multiple channels)
        for (const [hash, count] of Object.entries(repeatedHashes)) {
            if (count >= 2) {
                const hashData = this.messageHashes.get(`${guild.id}_${hash}`);
                if (hashData && hashData.channels.size >= 3) {
                    // Same message in 3+ different channels = cross-channel spam
                    score += Math.min(40, hashData.channels.size * 12);

                    logger.debug('[AdaptiveSpam] Cross-channel spam detected', {
                        guildId: guild.id,
                        userId: author.id,
                        channelCount: hashData.channels.size,
                        scoreAdded: Math.min(40, hashData.channels.size * 12)
                    });
                }
            }
        }

        // 3. Apply new account multiplier (capped to prevent excessive penalties)
        const accountAgeHours = (Date.now() - author.createdTimestamp) / (1000 * 60 * 60);

        if (accountAgeHours < 24) {
            // Cap at 2.5x even if config is higher to prevent false positive bans
            const multiplier = Math.min(config.new_account_multiplier_24h || 2.0, 2.5);
            score *= multiplier;
        } else if (accountAgeHours < 168) { // 7 days
            // Cap at 1.75x for 7-day accounts
            const multiplier = Math.min(config.new_account_multiplier_7d || 1.5, 1.75);
            score *= multiplier;
        }

        return Math.round(score);
    }

    /**
     * Trigger spam action
     */
    async triggerSpamAction(message, config, spamScore) {
        const { guild, author, member } = message;

        logger.warn('[AdaptiveSpam] Spam threshold exceeded', {
            guildId: guild.id,
            userId: author.id,
            spamScore
        });

        // Update profile violation count
        await pool.execute(
            `UPDATE spam_profiles SET total_violations = total_violations + 1, last_violation_at = NOW(), spam_score = 0
             WHERE guild_id = ? AND user_id = ?`,
            [guild.id, author.id]
        );

        // Log infraction
        await this.logInfractionForSpam(guild, author, config.action);

        // Execute action
        if (member && member.id !== guild.ownerId) {
            try {
                switch (config.action) {
                    case 'mute':
                        if (member.moderatable) {
                            await member.timeout(60 * 60 * 1000, 'Adaptive Spam Detection'); // 1 hour
                        }
                        break;

                    case 'kick':
                        if (member.kickable) {
                            await member.kick('Adaptive Spam Detection');
                        }
                        break;

                    case 'ban':
                        if (member.bannable) {
                            await member.ban({
                                reason: 'Adaptive Spam Detection',
                                deleteMessageSeconds: 86400
                            });
                        }
                        break;
                }
            } catch (error) {
                logger.error('[AdaptiveSpam] Error executing action', { error: error.message });
            }
        }

        // Send alert
        await this.sendSpamAlert(guild, config, author, spamScore);
    }

    /**
     * Log infraction for spam detection
     */
    async logInfractionForSpam(guild, user, actionType) {
        try {
            await pool.execute(
                `INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason)
                 VALUES (?, ?, ?, 'AdaptiveSpam', ?)`,
                [guild.id, user.id, this.client.user.id, `Automatic spam detection: ${actionType}`]
            );

            // Trigger escalation check
            const { checkEscalations } = await import('./escalation-manager.js');
            await checkEscalations(guild, user);

        } catch (error) {
            logger.error('[AdaptiveSpam] Error logging infraction', { error: error.message });
        }
    }

    /**
     * Send spam alert
     */
    async sendSpamAlert(guild, config, user, spamScore) {
        if (!config.alert_channel_id) return;

        const channel = await guild.channels.fetch(config.alert_channel_id).catch(() => null);
        if (!channel) return;

        const profile = await this.getOrCreateProfile(guild.id, user.id);

        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('📊 ADAPTIVE SPAM DETECTED')
            .setDescription(`Unusual spam behavior detected from **${user.tag}**`)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                { name: 'User', value: `<@${user.id}>`, inline: true },
                { name: 'Spam Score', value: `${spamScore}/100`, inline: true },
                { name: 'Total Violations', value: `${profile.total_violations + 1}`, inline: true },
                { name: 'Action Taken', value: config.action || 'alert', inline: true },
                { name: 'Baseline Rate', value: `${Math.round(profile.baseline_msg_rate)} msg/hr`, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Adaptive Spam Detection System' });

        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`adaptivespam_false_${user.id}`)
                    .setLabel('False Positive')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('↩️'),
                new ButtonBuilder()
                    .setCustomId(`adaptivespam_reset_${user.id}`)
                    .setLabel('Reset Profile')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🔄')
            );

        await channel.send({ embeds: [embed], components: [buttons] }).catch(err =>
            logger.error('[AdaptiveSpam] Error sending alert', { error: err.message })
        );
    }

    /**
     * Get or create user spam profile
     */
    async getOrCreateProfile(guildId, userId) {
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM spam_profiles WHERE guild_id = ? AND user_id = ?`,
                [guildId, userId]
            );

            if (rows.length > 0) return rows[0];

            // Create new profile
            await pool.execute(
                `INSERT INTO spam_profiles (guild_id, user_id) VALUES (?, ?)`,
                [guildId, userId]
            );

            return {
                guild_id: guildId,
                user_id: userId,
                baseline_msg_rate: 0,
                baseline_deviation: 0,
                spam_score: 0,
                total_violations: 0,
                messages_analyzed: 0
            };

        } catch (error) {
            logger.error('[AdaptiveSpam] Error getting profile', { error: error.message });
            return {
                baseline_msg_rate: 0,
                baseline_deviation: 0,
                spam_score: 0,
                total_violations: 0
            };
        }
    }

    /**
     * Update user spam profile
     */
    async updateProfile(guildId, userId, updates) {
        try {
            const setClause = Object.keys(updates)
                .map(key => `${key} = ?`)
                .join(', ');

            await pool.execute(
                `UPDATE spam_profiles SET ${setClause} WHERE guild_id = ? AND user_id = ?`,
                [...Object.values(updates), guildId, userId]
            );
        } catch (error) {
            logger.error('[AdaptiveSpam] Error updating profile', { error: error.message });
        }
    }

    /**
     * Record pattern hit for effectiveness tracking
     */
    recordPatternHit(patternId, wasSpam) {
        if (!this.patternHits.has(patternId)) {
            // Enforce max size
            if (this.patternHits.size >= this.MAX_PATTERN_HITS) {
                const oldestKey = this.patternHits.keys().next().value;
                this.patternHits.delete(oldestKey);
            }
            this.patternHits.set(patternId, { hits: 0, falsePositives: 0 });
        }

        const stats = this.patternHits.get(patternId);
        stats.hits++;
        if (!wasSpam) stats.falsePositives++;
    }

    /**
     * Mark pattern detection as false positive
     */
    async markFalsePositive(patternId, guildId) {
        this.recordPatternHit(patternId, false);

        try {
            await pool.execute(
                `INSERT INTO spam_patterns_stats (guild_id, pattern_id, false_positives)
                 VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                    false_positives = false_positives + 1,
                    effectiveness_score = (true_positives / (true_positives + false_positives + 1)) * 100`,
                [guildId, patternId]
            );
        } catch (error) {
            logger.error('[AdaptiveSpam] Error marking false positive', { error: error.message });
        }
    }

    /**
     * Handle button interactions
     */
    async handleButtonInteraction(interaction) {
        const parts = interaction.customId.split('_');
        const action = parts[1];
        const userId = parts[2];

        // Check permissions
        if (!interaction.member.permissions.has('ModerateMembers')) {
            return interaction.reply({
                content: 'You need the Moderate Members permission to use these controls.',
                ephemeral: true
            });
        }

        switch (action) {
            case 'false':
                await this.handleFalsePositive(interaction, userId);
                break;

            case 'reset':
                await this.handleResetProfile(interaction, userId);
                break;
        }
    }

    /**
     * Handle false positive
     */
    async handleFalsePositive(interaction, userId) {
        await interaction.deferReply({ ephemeral: true });

        try {
            // Remove timeout if present
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            if (member?.communicationDisabledUntil) {
                await member.timeout(null, `False positive - cleared by ${interaction.user.tag}`);
            }

            // Reduce spam score
            await pool.execute(
                `UPDATE spam_profiles SET spam_score = GREATEST(0, spam_score - 25) WHERE guild_id = ? AND user_id = ?`,
                [interaction.guild.id, userId]
            );

            // Update embed
            const message = interaction.message;
            const embed = EmbedBuilder.from(message.embeds[0])
                .setColor(0xffff00)
                .addFields({ name: 'Resolution', value: `Marked as false positive by ${interaction.user.tag}` });

            await message.edit({ embeds: [embed], components: [] });
            await interaction.editReply('Marked as false positive. Spam score reduced.');

        } catch (error) {
            logger.error('[AdaptiveSpam] Error handling false positive', { error: error.message });
            await interaction.editReply('Error processing false positive.');
        }
    }

    /**
     * Handle profile reset
     */
    async handleResetProfile(interaction, userId) {
        await interaction.deferReply({ ephemeral: true });

        try {
            await pool.execute(
                `UPDATE spam_profiles SET spam_score = 0, total_violations = 0, baseline_msg_rate = 0, baseline_deviation = 0
                 WHERE guild_id = ? AND user_id = ?`,
                [interaction.guild.id, userId]
            );

            // Clear in-memory tracking
            this.recentMessages.delete(`${interaction.guild.id}_${userId}`);

            await interaction.editReply(`Profile reset for <@${userId}>.`);

        } catch (error) {
            logger.error('[AdaptiveSpam] Error resetting profile', { error: error.message });
            await interaction.editReply('Error resetting profile.');
        }
    }

    /**
     * Recalculate baselines for all users
     */
    async recalculateBaselines() {
        logger.debug('[AdaptiveSpam] Recalculating baselines...');

        try {
            // Get all users with recent activity from activity_logs
            const [rows] = await pool.execute(
                `SELECT guild_id, user_id, AVG(count) as avg_rate, STDDEV(count) as std_dev
                 FROM activity_logs
                 WHERE type = 'message' AND log_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
                 GROUP BY guild_id, user_id`
            );

            for (const row of rows) {
                await pool.execute(
                    `INSERT INTO spam_profiles (guild_id, user_id, baseline_msg_rate, baseline_deviation)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        baseline_msg_rate = VALUES(baseline_msg_rate),
                        baseline_deviation = VALUES(baseline_deviation)`,
                    [
                        row.guild_id,
                        row.user_id,
                        row.avg_rate || 0,
                        row.std_dev || 0
                    ]
                );
            }

            logger.info('[AdaptiveSpam] Baselines recalculated', { userCount: rows.length });

        } catch (error) {
            logger.error('[AdaptiveSpam] Error recalculating baselines', { error: error.message });
        }
    }

    /**
     * Persist pattern stats to database
     */
    async persistPatternStats() {
        if (this.patternHits.size === 0) return;

        try {
            for (const [patternId, stats] of this.patternHits.entries()) {
                await pool.execute(
                    `UPDATE spam_patterns_stats
                     SET true_positives = true_positives + ?,
                         false_positives = false_positives + ?,
                         last_hit_at = NOW(),
                         effectiveness_score = ((true_positives + ?) / (true_positives + ? + false_positives + ? + 1)) * 100
                     WHERE pattern_id = ?`,
                    [
                        stats.hits - stats.falsePositives,
                        stats.falsePositives,
                        stats.hits - stats.falsePositives,
                        stats.hits - stats.falsePositives,
                        stats.falsePositives,
                        patternId
                    ]
                );
            }

            // Clear after persisting
            this.patternHits.clear();

        } catch (error) {
            logger.error('[AdaptiveSpam] Error persisting pattern stats', { error: error.message });
        }
    }

    /**
     * Clean up old data
     */
    cleanupOldData() {
        const now = Date.now();
        const maxAge = 3600000; // 1 hour

        // Clean recent messages
        for (const [key, messages] of this.recentMessages.entries()) {
            const filtered = messages.filter(m => now - m.timestamp < maxAge);
            if (filtered.length === 0) {
                this.recentMessages.delete(key);
            } else {
                this.recentMessages.set(key, filtered);
            }
        }

        // Clean message hashes (keep for 5 minutes)
        const hashMaxAge = 300000;
        for (const [key, data] of this.messageHashes.entries()) {
            if (now - data.lastSeen > hashMaxAge) {
                this.messageHashes.delete(key);
            }
        }
    }

    /**
     * Get adaptive spam configuration (cached - 60s TTL)
     */
    async getConfig(guildId) {
        try {
            return await configCache.get('adaptive_spam_config', guildId, async () => {
                const [rows] = await pool.execute(
                    `SELECT * FROM adaptive_spam_config WHERE guild_id = ?`,
                    [guildId]
                );
                return rows.length > 0 ? rows[0] : null;
            });
        } catch (error) {
            logger.error('[AdaptiveSpam] Error fetching config', { error: error.message, guildId });
            return null;
        }
    }

    /**
     * Update adaptive spam configuration
     */
    async updateConfig(guildId, config) {
        try {
            await pool.execute(
                `INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
                    deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, baseline_recalc_hours,
                    action, alert_channel_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    cross_channel_threshold = VALUES(cross_channel_threshold),
                    cross_channel_timeframe_minutes = VALUES(cross_channel_timeframe_minutes),
                    deviation_multiplier = VALUES(deviation_multiplier),
                    new_account_multiplier_7d = VALUES(new_account_multiplier_7d),
                    new_account_multiplier_24h = VALUES(new_account_multiplier_24h),
                    baseline_recalc_hours = VALUES(baseline_recalc_hours),
                    action = VALUES(action),
                    alert_channel_id = VALUES(alert_channel_id)`,
                [
                    guildId,
                    config.enabled ?? true,
                    config.cross_channel_threshold ?? 3,
                    config.cross_channel_timeframe_minutes ?? 5,
                    config.deviation_multiplier ?? 2.0,
                    config.new_account_multiplier_7d ?? 1.5,
                    config.new_account_multiplier_24h ?? 2.0,
                    config.baseline_recalc_hours ?? 24,
                    config.action ?? 'mute',
                    config.alert_channel_id ?? null
                ]
            );
            // Invalidate cache so next read gets fresh data
            configCache.invalidate('adaptive_spam_config', guildId);
            return true;
        } catch (error) {
            logger.error('[AdaptiveSpam] Error updating config', { error: error.message, guildId });
            return false;
        }
    }

    /**
     * Get pattern effectiveness rankings
     */
    async getPatternEffectiveness(guildId, limit = 10) {
        try {
            const [rows] = await pool.execute(
                `SELECT s.*, p.pattern, p.pattern_type
                 FROM spam_patterns_stats s
                 JOIN automod_patterns p ON s.pattern_id = p.id
                 WHERE s.guild_id = ?
                 ORDER BY s.effectiveness_score DESC
                 LIMIT ?`,
                [guildId, limit]
            );
            return rows;
        } catch (error) {
            logger.error('[AdaptiveSpam] Error fetching pattern effectiveness', { error: error.message });
            return [];
        }
    }

    /**
     * Get user spam profile with details
     */
    async getUserProfile(guildId, userId) {
        try {
            const profile = await this.getOrCreateProfile(guildId, userId);

            // Get cross-channel spam history
            const [crossChannel] = await pool.execute(
                `SELECT * FROM cross_channel_spam
                 WHERE guild_id = ? AND user_id = ? AND flagged = TRUE
                 ORDER BY last_seen DESC LIMIT 5`,
                [guildId, userId]
            );

            return {
                ...profile,
                crossChannelSpam: crossChannel
            };

        } catch (error) {
            logger.error('[AdaptiveSpam] Error getting user profile', { error: error.message });
            return null;
        }
    }
}

export default AdaptiveSpamManager;
