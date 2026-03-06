import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';

/**
 * Self-Bot Detection Manager - Detects users running unauthorized automation
 * Inspired by Sery Bot's follow bot detection
 */
class SelfbotDetectionManager {
    constructor(client) {
        this.client = client;

        // Track user behavior per guild
        // Format: Map<`${guildId}_${userId}`, {
        //   messages: [{ timestamp, responseTime, channelId }],
        //   suspicionScore: number,
        //   lastChecked: timestamp,
        //   patterns: string[]
        // }>
        this.userBehavior = new Map();

        // Track recent messages for response time calculation
        // Format: Map<channelId, { authorId, timestamp }>
        this.lastMessages = new Map();

        // Store interval references for cleanup
        this.intervals = [];

        // Clean up old behavior data every 5 minutes
        this.intervals.push(setInterval(() => this.cleanupOldData(), 300000));

        // Decay suspicion scores every minute
        this.intervals.push(setInterval(() => this.decaySuspicionScores(), 60000));

        logger.info('[SelfbotDetection] Manager initialized');
    }

    /**
     * Analyze a message for self-bot indicators
     * @param {Message} message - The message to analyze
     * @returns {boolean} - Whether the message was blocked
     */
    async analyzeMessage(message) {
        const { guild, author, channel, member } = message;

        // Skip detection for users with Administrator permission or guild owners
        if (member) {
            const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = member.id === guild.ownerId;
            if (isAdmin || isOwner) return false;
        }

        try {
            // Get config
            const config = await this.getConfig(guild.id);
            if (!config || !config.enabled) return false;

            // Check for exempt roles
            if (config.exempt_roles) {
                const exemptRoles = JSON.parse(config.exempt_roles || '[]');
                if (message.member?.roles.cache.some(role => exemptRoles.includes(role.id))) {
                    return false;
                }
            }

            const key = `${guild.id}_${author.id}`;

            // Initialize behavior tracking
            if (!this.userBehavior.has(key)) {
                this.userBehavior.set(key, {
                    messages: [],
                    suspicionScore: 0,
                    lastChecked: Date.now(),
                    patterns: []
                });
            }

            const behavior = this.userBehavior.get(key);
            const now = Date.now();

            // Calculate response time if this is a reply to another message
            let responseTime = null;
            const lastMsg = this.lastMessages.get(channel.id);
            if (lastMsg && lastMsg.authorId !== author.id) {
                responseTime = now - lastMsg.timestamp;
            }

            // Track this message
            behavior.messages.push({
                timestamp: now,
                responseTime,
                channelId: channel.id,
                contentLength: message.content.length
            });

            // Keep only recent messages (last 60 seconds)
            behavior.messages = behavior.messages.filter(m => now - m.timestamp < 60000);

            // Update last message in channel
            this.lastMessages.set(channel.id, { authorId: author.id, timestamp: now });

            // Run detection checks
            const detections = [];

            // Check 1: Fast response times
            if (responseTime !== null && responseTime < config.min_response_time_ms) {
                const fastResponses = behavior.messages.filter(
                    m => m.responseTime !== null && m.responseTime < config.min_response_time_ms
                );
                if (fastResponses.length >= 3) {
                    detections.push({
                        type: 'fast_response',
                        confidence: Math.min(100, fastResponses.length * 20),
                        evidence: {
                            avgResponseTime: Math.round(
                                fastResponses.reduce((a, b) => a + b.responseTime, 0) / fastResponses.length
                            ),
                            count: fastResponses.length
                        }
                    });
                }
            }

            // Check 2: Message bursts
            const recentMessages = behavior.messages.filter(
                m => now - m.timestamp < config.message_burst_window_ms
            );
            if (recentMessages.length >= config.message_burst_threshold) {
                detections.push({
                    type: 'message_burst',
                    confidence: Math.min(100, (recentMessages.length / config.message_burst_threshold) * 50),
                    evidence: {
                        messageCount: recentMessages.length,
                        windowMs: config.message_burst_window_ms
                    }
                });
            }

            // Check 3: Pattern regularity (messages at exact intervals)
            if (behavior.messages.length >= 5) {
                const intervals = [];
                for (let i = 1; i < behavior.messages.length; i++) {
                    intervals.push(behavior.messages[i].timestamp - behavior.messages[i - 1].timestamp);
                }

                // Check for suspiciously regular intervals
                const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                const variance = intervals.reduce((a, b) => a + Math.pow(b - avgInterval, 2), 0) / intervals.length;
                const stdDev = Math.sqrt(variance);

                // Very low variance (< 50ms) suggests automated posting
                if (stdDev < 50 && avgInterval < 1000) {
                    detections.push({
                        type: 'pattern_match',
                        confidence: Math.min(100, 100 - stdDev),
                        evidence: {
                            avgInterval: Math.round(avgInterval),
                            stdDev: Math.round(stdDev),
                            messageCount: behavior.messages.length
                        }
                    });
                }
            }

            // Check 4: API-like behavior (identical message lengths, no variation)
            if (behavior.messages.length >= 10) {
                const lengths = behavior.messages.map(m => m.contentLength);
                const uniqueLengths = new Set(lengths);
                const uniformityRatio = uniqueLengths.size / lengths.length;

                // Very low variation in message lengths
                if (uniformityRatio < 0.3 && lengths.every(l => l > 0)) {
                    detections.push({
                        type: 'api_behavior',
                        confidence: Math.min(100, (1 - uniformityRatio) * 80),
                        evidence: {
                            uniqueLengths: uniqueLengths.size,
                            totalMessages: lengths.length,
                            uniformityRatio
                        }
                    });
                }
            }

            // Calculate total suspicion increase
            if (detections.length > 0) {
                const maxConfidence = Math.max(...detections.map(d => d.confidence));
                behavior.suspicionScore += maxConfidence / 10;
                behavior.patterns = [...new Set([...behavior.patterns, ...detections.map(d => d.type)])];

                // Check if threshold exceeded
                if (behavior.suspicionScore >= config.pattern_threshold * 10) {
                    await this.triggerDetection(message, config, detections, behavior);
                    behavior.suspicionScore = 0; // Reset after action
                    behavior.patterns = [];
                    return true; // Message was handled
                }
            }

            return false;

        } catch (error) {
            logger.error('[SelfbotDetection] Error analyzing message', {
                error: error.message,
                guildId: guild.id,
                userId: author.id
            });
            return false;
        }
    }

    /**
     * Trigger detection response
     */
    async triggerDetection(message, config, detections, behavior) {
        const { guild, author, member } = message;

        logger.warn('[SelfbotDetection] Self-bot behavior detected!', {
            guildId: guild.id,
            userId: author.id,
            detections: detections.map(d => d.type),
            suspicionScore: behavior.suspicionScore
        });

        // Calculate overall confidence
        const overallConfidence = Math.round(
            detections.reduce((sum, d) => sum + d.confidence, 0) / detections.length
        );

        // Log detection to database
        const detectionId = await this.logDetection(
            guild.id,
            author.id,
            detections[0].type, // Primary detection type
            overallConfidence,
            { detections, patterns: behavior.patterns },
            config.action
        );

        // Execute actions
        const results = { muted: false, purged: 0 };

        // Purge messages if enabled
        if (config.purge_messages) {
            results.purged = await this.purgeUserMessages(guild, author.id, config.purge_limit);
        }

        // Execute configured action
        if (member && member.id !== guild.ownerId) {
            switch (config.action) {
                case 'mute':
                    if (member.moderatable) {
                        await member.timeout(
                            config.mute_duration_minutes * 60 * 1000,
                            'Self-bot Detection: Automated behavior detected'
                        );
                        results.muted = true;
                        await this.logInfractionForSelfbot(guild, author, 'mute', config.mute_duration_minutes);
                    }
                    break;

                case 'kick':
                    if (member.kickable) {
                        await member.kick('Self-bot Detection: Automated behavior detected');
                        await this.logInfractionForSelfbot(guild, author, 'kick');
                    }
                    break;

                case 'ban':
                    if (member.bannable) {
                        await member.ban({
                            reason: 'Self-bot Detection: Automated behavior detected',
                            deleteMessageSeconds: 86400
                        });
                        await this.logInfractionForSelfbot(guild, author, 'ban');
                    }
                    break;
            }
        }

        // Send alert
        await this.sendAlert(guild, config, author, detections, overallConfidence, detectionId, results);
    }

    /**
     * Log detection to database
     */
    async logDetection(guildId, userId, detectionType, confidence, evidence, actionTaken) {
        try {
            const [result] = await pool.execute(
                `INSERT INTO selfbot_detections (guild_id, user_id, detection_type, confidence_score, evidence, action_taken)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [guildId, userId, detectionType, confidence, JSON.stringify(evidence), actionTaken]
            );
            return result.insertId;
        } catch (error) {
            logger.error('[SelfbotDetection] Error logging detection', { error: error.message });
            return null;
        }
    }

    /**
     * Purge recent messages from a user
     */
    async purgeUserMessages(guild, userId, limit) {
        let totalPurged = 0;

        try {
            const textChannels = guild.channels.cache.filter(
                ch => ch.isTextBased() && !ch.isThread() && ch.viewable
            );

            for (const [, channel] of textChannels) {
                try {
                    const messages = await channel.messages.fetch({ limit: 100 });
                    const userMessages = messages.filter(
                        m => m.author.id === userId &&
                        Date.now() - m.createdTimestamp < 86400000
                    );

                    if (userMessages.size > 0) {
                        const toDelete = userMessages.first(Math.min(userMessages.size, limit - totalPurged));
                        if (toDelete.length > 0) {
                            await channel.bulkDelete(toDelete, true).catch(() => {});
                            totalPurged += toDelete.length;
                        }
                    }

                    if (totalPurged >= limit) break;
                } catch {
                    // Skip channels we can't access
                }
            }
        } catch (error) {
            logger.error('[SelfbotDetection] Error purging messages', {
                error: error.message,
                userId,
                guildId: guild.id
            });
        }

        return totalPurged;
    }

    /**
     * Log an infraction for self-bot detection
     */
    async logInfractionForSelfbot(guild, user, actionType, durationMinutes = null) {
        try {
            const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000) : null;

            await pool.execute(
                `INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at)
                 VALUES (?, ?, ?, 'SelfbotDetection', ?, ?, ?)`,
                [
                    guild.id,
                    user.id,
                    this.client.user.id,
                    `Automatic self-bot detection: ${actionType}`,
                    durationMinutes,
                    expiresAt
                ]
            );

            // Trigger escalation check
            const { checkEscalations } = await import('./escalation-manager.js');
            await checkEscalations(guild, user);

        } catch (error) {
            logger.error('[SelfbotDetection] Error logging infraction', {
                error: error.message,
                userId: user.id
            });
        }
    }

    /**
     * Send alert with action buttons
     */
    async sendAlert(guild, config, user, detections, confidence, detectionId, results) {
        if (!config.alert_channel_id) return;

        const channel = await guild.channels.fetch(config.alert_channel_id).catch(() => null);
        if (!channel) return;

        const detectionDescriptions = {
            'fast_response': '⚡ Inhuman Response Times',
            'message_burst': '💨 Message Burst',
            'pattern_match': '📊 Regular Pattern Intervals',
            'api_behavior': '🤖 API-like Behavior',
            'mass_operation': '📢 Mass Operations'
        };

        const evidenceLines = detections.map(d => {
            const desc = detectionDescriptions[d.type] || d.type;
            let details = '';

            switch (d.type) {
                case 'fast_response':
                    details = `Avg: ${d.evidence.avgResponseTime}ms (${d.evidence.count} occurrences)`;
                    break;
                case 'message_burst':
                    details = `${d.evidence.messageCount} messages in ${d.evidence.windowMs}ms`;
                    break;
                case 'pattern_match':
                    details = `Avg interval: ${d.evidence.avgInterval}ms, StdDev: ${d.evidence.stdDev}ms`;
                    break;
                case 'api_behavior':
                    details = `Only ${d.evidence.uniqueLengths} unique message lengths in ${d.evidence.totalMessages} messages`;
                    break;
            }

            return `${desc}\n└ ${details} (${d.confidence}% confidence)`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
            .setColor(0xff6600)
            .setTitle('🤖 SELF-BOT BEHAVIOR DETECTED')
            .setDescription(`Automated/bot-like behavior detected from **${user.tag}**`)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                { name: 'User', value: `<@${user.id}> (${user.id})`, inline: true },
                { name: 'Overall Confidence', value: `${confidence}%`, inline: true },
                { name: 'Action Taken', value: config.action || 'alert', inline: true },
                { name: 'Detection Signals', value: evidenceLines || 'None', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Detection ID: ${detectionId} | Self-Bot Detection System` });

        if (results.muted) {
            embed.addFields({ name: 'Muted', value: `${config.mute_duration_minutes} minutes`, inline: true });
        }
        if (results.purged > 0) {
            embed.addFields({ name: 'Messages Purged', value: `${results.purged}`, inline: true });
        }

        // Create action buttons
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`selfbot_kick_${user.id}_${detectionId}`)
                    .setLabel('Kick')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('👢'),
                new ButtonBuilder()
                    .setCustomId(`selfbot_ban_${user.id}_${detectionId}`)
                    .setLabel('Ban')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔨'),
                new ButtonBuilder()
                    .setCustomId(`selfbot_false_${user.id}_${detectionId}`)
                    .setLabel('False Positive')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('↩️'),
                new ButtonBuilder()
                    .setCustomId(`selfbot_history_${user.id}`)
                    .setLabel('View History')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📜')
            );

        await channel.send({ embeds: [embed], components: [buttons] }).catch(err =>
            logger.error('[SelfbotDetection] Error sending alert', { error: err.message })
        );
    }

    /**
     * Handle button interactions
     */
    async handleButtonInteraction(interaction) {
        const parts = interaction.customId.split('_');
        const action = parts[1];
        const userId = parts[2];
        const detectionId = parts[3];

        // Check permissions
        if (!interaction.member.permissions.has('ModerateMembers')) {
            return interaction.reply({
                content: 'You need the Moderate Members permission to use these controls.',
                ephemeral: true
            });
        }

        switch (action) {
            case 'kick':
                await this.handleKickAction(interaction, userId, detectionId);
                break;

            case 'ban':
                await this.handleBanAction(interaction, userId, detectionId);
                break;

            case 'false':
                await this.handleFalsePositive(interaction, userId, detectionId);
                break;

            case 'history':
                await this.showUserHistory(interaction, userId);
                break;
        }
    }

    /**
     * Handle kick action from button
     */
    async handleKickAction(interaction, userId, detectionId) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            if (!member) {
                return interaction.editReply('User not found in this server.');
            }

            if (!member.kickable) {
                return interaction.editReply('Unable to kick this user.');
            }

            await member.kick(`Self-bot detection escalation by ${interaction.user.tag}`);

            // Update embed
            const message = interaction.message;
            const embed = EmbedBuilder.from(message.embeds[0])
                .setColor(0xff0000)
                .addFields({ name: 'Escalated', value: `Kicked by ${interaction.user.tag}` });

            await message.edit({ embeds: [embed], components: [] });
            await interaction.editReply(`Successfully kicked <@${userId}>.`);

        } catch (error) {
            logger.error('[SelfbotDetection] Error kicking user', { error: error.message });
            await interaction.editReply('Failed to kick user.');
        }
    }

    /**
     * Handle ban action from button
     */
    async handleBanAction(interaction, userId, detectionId) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            if (!member) {
                // User may have left, try to ban by ID
                await interaction.guild.bans.create(userId, {
                    reason: `Self-bot detection escalation by ${interaction.user.tag}`,
                    deleteMessageSeconds: 86400
                });
            } else {
                if (!member.bannable) {
                    return interaction.editReply('Unable to ban this user.');
                }
                await member.ban({
                    reason: `Self-bot detection escalation by ${interaction.user.tag}`,
                    deleteMessageSeconds: 86400
                });
            }

            // Update embed
            const message = interaction.message;
            const embed = EmbedBuilder.from(message.embeds[0])
                .setColor(0x8b0000)
                .addFields({ name: 'Escalated', value: `Banned by ${interaction.user.tag}` });

            await message.edit({ embeds: [embed], components: [] });
            await interaction.editReply(`Successfully banned <@${userId}>.`);

        } catch (error) {
            logger.error('[SelfbotDetection] Error banning user', { error: error.message });
            await interaction.editReply('Failed to ban user.');
        }
    }

    /**
     * Handle false positive
     */
    async handleFalsePositive(interaction, userId, detectionId) {
        await interaction.deferReply({ ephemeral: true });

        try {
            // Remove timeout if present
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            if (member?.communicationDisabledUntil) {
                await member.timeout(null, `False positive - cleared by ${interaction.user.tag}`);
            }

            // Clear behavior tracking
            const key = `${interaction.guild.id}_${userId}`;
            this.userBehavior.delete(key);

            // Update embed
            const message = interaction.message;
            const embed = EmbedBuilder.from(message.embeds[0])
                .setColor(0xffff00)
                .setTitle('⚠️ SELF-BOT DETECTION - FALSE POSITIVE')
                .addFields({ name: 'Resolution', value: `Marked as false positive by ${interaction.user.tag}` });

            await message.edit({ embeds: [embed], components: [] });
            await interaction.editReply('Marked as false positive. User unmuted and tracking cleared.');

        } catch (error) {
            logger.error('[SelfbotDetection] Error handling false positive', { error: error.message });
            await interaction.editReply('Error processing false positive.');
        }
    }

    /**
     * Show user's detection history
     */
    async showUserHistory(interaction, userId) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const [detections] = await pool.execute(
                `SELECT * FROM selfbot_detections WHERE guild_id = ? AND user_id = ? ORDER BY detected_at DESC LIMIT 10`,
                [interaction.guild.id, userId]
            );

            if (detections.length === 0) {
                return interaction.editReply('No detection history found for this user.');
            }

            const historyLines = detections.map(d => {
                const date = new Date(d.detected_at).toLocaleString();
                return `**${d.detection_type}** - ${d.confidence_score}% confidence\n└ ${date} | Action: ${d.action_taken}`;
            }).join('\n\n');

            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(`Detection History for <@${userId}>`)
                .setDescription(historyLines)
                .setFooter({ text: `Showing last ${detections.length} detections` });

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error('[SelfbotDetection] Error fetching history', { error: error.message });
            await interaction.editReply('Error fetching history.');
        }
    }

    /**
     * Clean up old behavior data
     */
    cleanupOldData() {
        const maxAge = 10 * 60 * 1000; // 10 minutes
        const now = Date.now();

        for (const [key, behavior] of this.userBehavior.entries()) {
            if (now - behavior.lastChecked > maxAge) {
                this.userBehavior.delete(key);
            }
        }

        // Clean up old last messages
        for (const [channelId, data] of this.lastMessages.entries()) {
            if (now - data.timestamp > 60000) {
                this.lastMessages.delete(channelId);
            }
        }
    }

    /**
     * Decay suspicion scores over time
     */
    decaySuspicionScores() {
        for (const [, behavior] of this.userBehavior.entries()) {
            if (behavior.suspicionScore > 0) {
                behavior.suspicionScore = Math.max(0, behavior.suspicionScore - 5);
            }
        }
    }

    /**
     * Get self-bot detection configuration
     */
    async getConfig(guildId) {
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM selfbot_detection_config WHERE guild_id = ?`,
                [guildId]
            );
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            logger.error('[SelfbotDetection] Error fetching config', { error: error.message, guildId });
            return null;
        }
    }

    /**
     * Update self-bot detection configuration
     */
    async updateConfig(guildId, config) {
        try {
            await pool.execute(
                `INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold,
                    message_burst_window_ms, pattern_threshold, action, alert_channel_id, mute_duration_minutes,
                    purge_messages, purge_limit, exempt_roles)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    min_response_time_ms = VALUES(min_response_time_ms),
                    message_burst_threshold = VALUES(message_burst_threshold),
                    message_burst_window_ms = VALUES(message_burst_window_ms),
                    pattern_threshold = VALUES(pattern_threshold),
                    action = VALUES(action),
                    alert_channel_id = VALUES(alert_channel_id),
                    mute_duration_minutes = VALUES(mute_duration_minutes),
                    purge_messages = VALUES(purge_messages),
                    purge_limit = VALUES(purge_limit),
                    exempt_roles = VALUES(exempt_roles)`,
                [
                    guildId,
                    config.enabled ?? false,
                    config.min_response_time_ms ?? 50,
                    config.message_burst_threshold ?? 20,
                    config.message_burst_window_ms ?? 1000,
                    config.pattern_threshold ?? 3,
                    config.action ?? 'mute',
                    config.alert_channel_id ?? null,
                    config.mute_duration_minutes ?? 60,
                    config.purge_messages ?? true,
                    config.purge_limit ?? 100,
                    config.exempt_roles ? JSON.stringify(config.exempt_roles) : null
                ]
            );
            return true;
        } catch (error) {
            logger.error('[SelfbotDetection] Error updating config', { error: error.message, guildId });
            return false;
        }
    }

    /**
     * Manually check a user for self-bot behavior
     */
    async manualCheck(guildId, userId) {
        const key = `${guildId}_${userId}`;
        const behavior = this.userBehavior.get(key);

        if (!behavior || behavior.messages.length < 5) {
            return {
                suspicious: false,
                reason: 'Insufficient data for analysis',
                messageCount: behavior?.messages.length || 0
            };
        }

        return {
            suspicious: behavior.suspicionScore > 10,
            suspicionScore: behavior.suspicionScore,
            patterns: behavior.patterns,
            messageCount: behavior.messages.length
        };
    }

    /**
     * Stop the manager and clean up intervals
     */
    stop() {
        for (const interval of this.intervals) {
            clearInterval(interval);
        }
        this.intervals = [];
        this.userBehavior.clear();
        this.lastMessages.clear();
        logger.info('[SelfbotDetection] Manager stopped');
    }
}

export default SelfbotDetectionManager;
