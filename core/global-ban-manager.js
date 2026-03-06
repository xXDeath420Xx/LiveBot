import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import configCache from '../utils/configCache.js';

/**
 * Global Ban Manager - Shared cross-guild ban database
 * Maintains an in-memory Map of active entries for O(1) lookups.
 * All bot instances contribute to and enforce the same ban list.
 */
class GlobalBanManager {
    constructor(client) {
        this.client = client;
        // Map<userId, { severity, category, entryId }>
        this.banCache = new Map();
        this.refreshInterval = null;
    }

    /**
     * Load all active global ban entries into memory
     */
    async loadBanCache() {
        try {
            const [rows] = await pool.execute(
                'SELECT id, user_id, severity, category FROM global_ban_entries WHERE active = 1'
            );
            this.banCache.clear();
            for (const row of rows) {
                this.banCache.set(row.user_id, {
                    severity: row.severity,
                    category: row.category,
                    entryId: row.id
                });
            }
            logger.info(`[GlobalBan] Loaded ${this.banCache.size} active entries into memory`);
        } catch (error) {
            logger.error('[GlobalBan] Failed to load ban cache', { error: error.message });
        }
    }

    /**
     * Start periodic cache refresh
     */
    startRefreshInterval(ms = 300000) {
        this.refreshInterval = setInterval(() => this.loadBanCache(), ms);
    }

    /**
     * Stop the manager and cleanup
     */
    stop() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.banCache.clear();
        logger.info('[GlobalBan] Manager stopped and cleaned up');
    }

    /**
     * Get guild config (cached - 60s TTL)
     */
    async getConfig(guildId) {
        try {
            return await configCache.get('global_ban_config', guildId, async () => {
                const [rows] = await pool.execute(
                    'SELECT * FROM global_ban_config WHERE guild_id = ? AND enabled = 1',
                    [guildId]
                );
                return rows[0] || null;
            });
        } catch (error) {
            logger.error('[GlobalBan] Error fetching config', { error: error.message, guildId });
            return null;
        }
    }

    /**
     * Check a member on join against the global ban cache
     */
    async checkMember(member) {
        try {
            const record = this.banCache.get(member.id);
            if (!record) return false;

            const config = await this.getConfig(member.guild.id);
            if (!config || !config.check_on_join) return false;

            // Check exempt roles
            if (this.isExempt(member, config)) return false;

            const action = this.getActionForSeverity(record.severity, config);
            if (action === 'none') return false;

            await this.executeAction(member, record, action, config);
            return true;
        } catch (error) {
            logger.error('[GlobalBan] Error checking member', {
                error: error.message,
                userId: member.id,
                guildId: member.guild.id
            });
            return false;
        }
    }

    /**
     * Optional message-time check (critical/high only for performance)
     */
    async checkMessage(message) {
        if (message.author.bot || !message.guild) return false;

        const record = this.banCache.get(message.author.id);
        if (!record) return false;

        // Only check critical and high severity at message time
        if (record.severity !== 'critical' && record.severity !== 'high') return false;

        const config = await this.getConfig(message.guild.id);
        if (!config || !config.check_on_message) return false;

        if (this.isExempt(message.member, config)) return false;

        const action = this.getActionForSeverity(record.severity, config);
        if (action === 'none') return false;

        await this.executeAction(message.member, record, action, config);
        return true;
    }

    /**
     * Check if a member has an exempt role
     */
    isExempt(member, config) {
        if (!config.exempt_roles || !member) return false;
        try {
            const exemptRoles = JSON.parse(config.exempt_roles);
            if (!Array.isArray(exemptRoles)) return false;
            return member.roles.cache.some(role => exemptRoles.includes(role.id));
        } catch {
            return false;
        }
    }

    /**
     * Get the configured action for a severity level
     */
    getActionForSeverity(severity, config) {
        switch (severity) {
            case 'critical': return config.action_critical || 'ban';
            case 'high': return config.action_high || 'ban';
            case 'medium': return config.action_medium || 'kick';
            case 'low': return config.action_low || 'alert';
            default: return 'alert';
        }
    }

    /**
     * Execute an enforcement action on a member
     */
    async executeAction(member, record, action, config) {
        const { guild, user } = member;

        // DM the user before action (best effort)
        try {
            const actionText = action === 'ban' ? 'banned from' : action === 'kick' ? 'kicked from' : 'flagged in';
            await user.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xE74C3C)
                        .setTitle('Global Ban System')
                        .setDescription(
                            `You have been ${actionText} **${guild.name}** due to a global ban record.\n\n` +
                            `**Category:** ${record.category}\n` +
                            `**Severity:** ${record.severity}\n\n` +
                            `If you believe this is a mistake, you can appeal:\n` +
                            `• **Website:** [Submit an Appeal](https://certifriedmultitool.com/appeal)\n` +
                            `• **DM:** Reply to this bot with your appeal reason (min 20 characters)`
                        )
                        .setTimestamp()
                ]
            }).catch(() => {});
        } catch {
            // DMs may be closed
        }

        // Execute the action
        try {
            switch (action) {
                case 'ban':
                    if (member.bannable) {
                        await member.ban({ reason: `Global Ban: ${record.category} (${record.severity})`, deleteMessageSeconds: 86400 });
                    }
                    break;
                case 'kick':
                    if (member.kickable) {
                        await member.kick(`Global Ban: ${record.category} (${record.severity})`);
                    }
                    break;
                case 'alert':
                    // No direct action on user, just send alert
                    break;
            }
        } catch (error) {
            logger.error('[GlobalBan] Failed to execute action', {
                action,
                error: error.message,
                userId: user.id,
                guildId: guild.id
            });
        }

        // Send alert embed to configured channel
        await this.sendAlert(guild, user, record, action, config);

        // Log the action
        await this.logAction(record.entryId, guild.id, user.id, action, this.client.user.id, `Auto-enforced: ${record.category} (${record.severity})`);

        logger.warn('[GlobalBan] Action executed', {
            action,
            userId: user.id,
            guildId: guild.id,
            severity: record.severity,
            category: record.category
        });
    }

    /**
     * Send an alert embed to the configured alert channel
     */
    async sendAlert(guild, user, record, action, config) {
        if (!config.alert_channel_id) return;

        try {
            const channel = guild.channels.cache.get(config.alert_channel_id);
            if (!channel) return;

            const actionLabels = { ban: 'Banned', kick: 'Kicked', alert: 'Alert Only' };
            const severityColors = { critical: 0xC0392B, high: 0xE74C3C, medium: 0xE67E22, low: 0xF1C40F };

            const embed = new EmbedBuilder()
                .setColor(severityColors[record.severity] || 0xE74C3C)
                .setTitle('Global Ban Alert')
                .setDescription(`A user with an active global ban record has been detected.`)
                .addFields(
                    { name: 'User', value: `${user.tag} (<@${user.id}>)`, inline: true },
                    { name: 'Severity', value: record.severity.toUpperCase(), inline: true },
                    { name: 'Category', value: record.category, inline: true },
                    { name: 'Action Taken', value: actionLabels[action] || action, inline: true },
                    { name: 'Entry ID', value: `#${record.entryId}`, inline: true }
                )
                .setFooter({ text: `User ID: ${user.id}` })
                .setTimestamp();

            const buttons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`globalban_view_${user.id}`)
                        .setLabel('View Full Record')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`globalban_dismiss_${user.id}`)
                        .setLabel('Dismiss')
                        .setStyle(ButtonStyle.Secondary)
                );

            await channel.send({ embeds: [embed], components: [buttons] });
        } catch (error) {
            logger.error('[GlobalBan] Failed to send alert', { error: error.message, guildId: guild.id });
        }
    }

    /**
     * Submit a manual report
     */
    async reportUser(reporterId, reporterGuildId, targetUserId, category, severity, evidence, reason) {
        try {
            // Check for existing pending report for same user
            const [existing] = await pool.execute(
                'SELECT id FROM global_ban_reports WHERE target_user_id = ? AND status = "pending" LIMIT 1',
                [targetUserId]
            );
            if (existing.length > 0) {
                return { success: false, message: `A pending report already exists for this user (Report #${existing[0].id}).` };
            }

            const evidenceJson = JSON.stringify(Array.isArray(evidence) ? evidence : [evidence]);

            const [result] = await pool.execute(
                `INSERT INTO global_ban_reports (reporter_id, reporter_guild_id, target_user_id, category, severity, evidence, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [reporterId, reporterGuildId, targetUserId, category, severity, evidenceJson, reason]
            );

            await this.logAction(null, reporterGuildId, targetUserId, 'report_created', reporterId, `Report #${result.insertId}: ${category} (${severity})`);

            return { success: true, reportId: result.insertId };
        } catch (error) {
            logger.error('[GlobalBan] Failed to create report', { error: error.message });
            return { success: false, message: 'Database error while creating report.' };
        }
    }

    /**
     * Vote on a pending report
     * Auto-promotes to global ban entry when threshold reached (3+ votes from 2+ guilds)
     */
    async voteOnReport(reportId, voterId, voterGuildId, vote, reason = null) {
        try {
            // Get the report
            const [reports] = await pool.execute('SELECT * FROM global_ban_reports WHERE id = ? AND status = "pending"', [reportId]);
            if (reports.length === 0) {
                return { success: false, message: 'Report not found or already resolved.' };
            }
            const report = reports[0];

            // Can't vote on own report
            if (report.reporter_id === voterId) {
                return { success: false, message: 'You cannot vote on your own report.' };
            }

            // Insert vote (unique constraint will prevent duplicate votes)
            try {
                await pool.execute(
                    `INSERT INTO global_ban_votes (report_id, voter_id, voter_guild_id, vote, reason)
                     VALUES (?, ?, ?, ?, ?)`,
                    [reportId, voterId, voterGuildId, vote, reason]
                );
            } catch (error) {
                if (error.code === 'ER_DUP_ENTRY') {
                    return { success: false, message: 'You have already voted on this report.' };
                }
                throw error;
            }

            // Update vote counts
            const column = vote === 'approve' ? 'votes_approve' : 'votes_deny';
            await pool.execute(`UPDATE global_ban_reports SET ${column} = ${column} + 1 WHERE id = ?`, [reportId]);

            // Check threshold: 3+ approve votes from 2+ distinct guilds
            const [voteStats] = await pool.execute(
                `SELECT COUNT(*) as total_approve, COUNT(DISTINCT voter_guild_id) as guild_count
                 FROM global_ban_votes WHERE report_id = ? AND vote = 'approve'`,
                [reportId]
            );

            const stats = voteStats[0];
            if (stats.total_approve >= report.votes_required && stats.guild_count >= 2) {
                await this.promoteReport(reportId, report);
                return { success: true, promoted: true, message: 'Vote recorded. Report has been approved and promoted to a global ban entry.' };
            }

            // Check if denied by majority
            const [denyStats] = await pool.execute(
                `SELECT COUNT(*) as total_deny FROM global_ban_votes WHERE report_id = ? AND vote = 'deny'`,
                [reportId]
            );
            if (denyStats[0].total_deny >= report.votes_required) {
                await pool.execute(`UPDATE global_ban_reports SET status = 'denied', reviewed_at = NOW() WHERE id = ?`, [reportId]);
                return { success: true, denied: true, message: 'Vote recorded. Report has been denied by community votes.' };
            }

            return { success: true, message: `Vote recorded. Current: ${stats.total_approve} approve, ${denyStats[0].total_deny} deny (need ${report.votes_required} from 2+ guilds).` };
        } catch (error) {
            logger.error('[GlobalBan] Failed to record vote', { error: error.message });
            return { success: false, message: 'Database error while recording vote.' };
        }
    }

    /**
     * Promote an approved report to a global ban entry
     */
    async promoteReport(reportId, report) {
        try {
            const [result] = await pool.execute(
                `INSERT INTO global_ban_entries (user_id, severity, category, reason, evidence, source, reporter_id, source_guild_id, verified, verification_votes)
                 VALUES (?, ?, ?, ?, ?, 'manual_report', ?, ?, 1, ?)`,
                [report.target_user_id, report.severity, report.category, report.reason, report.evidence, report.reporter_id, report.reporter_guild_id, report.votes_approve || 0]
            );

            const entryId = result.insertId;

            // Update the report
            await pool.execute(
                `UPDATE global_ban_reports SET status = 'approved', global_ban_entry_id = ?, reviewed_at = NOW() WHERE id = ?`,
                [entryId, reportId]
            );

            // Update cache
            this.banCache.set(report.target_user_id, {
                severity: report.severity,
                category: report.category,
                entryId
            });

            await this.logAction(entryId, report.reporter_guild_id, report.target_user_id, 'entry_created', null, `Promoted from report #${reportId}`);

            logger.info('[GlobalBan] Report promoted to global ban entry', { reportId, entryId, userId: report.target_user_id });
        } catch (error) {
            logger.error('[GlobalBan] Failed to promote report', { error: error.message, reportId });
        }
    }

    /**
     * Record a cross-guild moderation action for auto-aggregation
     */
    async recordCrossGuildAction(userId, guildId, actionType, reason, moderatorId) {
        try {
            // Check if guild has opted in to auto-aggregation
            const config = await this.getConfig(guildId);
            if (config && !config.auto_aggregate_opt_in) return;

            await pool.execute(
                `INSERT INTO global_ban_auto_aggregate (user_id, guild_id, action_type, infraction_reason, moderator_id)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE infraction_reason = VALUES(infraction_reason)`,
                [userId, guildId, actionType, reason, moderatorId]
            );
        } catch (error) {
            logger.error('[GlobalBan] Failed to record cross-guild action', { error: error.message, userId, guildId });
        }
    }

    /**
     * Process auto-aggregation: scan for users crossing thresholds
     * Weighted scoring: ban=3, kick=2, mute=1, warn=0.5
     */
    async processAutoAggregate() {
        try {
            // Get unprocessed records grouped by user
            const [users] = await pool.execute(`
                SELECT user_id,
                    COUNT(DISTINCT CASE WHEN action_type = 'ban' THEN guild_id END) as ban_guilds,
                    COUNT(DISTINCT guild_id) as total_guilds,
                    SUM(CASE action_type
                        WHEN 'ban' THEN 3
                        WHEN 'kick' THEN 2
                        WHEN 'mute' THEN 1
                        WHEN 'warn' THEN 0.5
                        ELSE 0
                    END) as weighted_score,
                    GROUP_CONCAT(DISTINCT action_type) as action_types
                FROM global_ban_auto_aggregate
                WHERE processed = 0
                GROUP BY user_id
                HAVING total_guilds >= 2
            `);

            let created = 0;

            for (const user of users) {
                // Skip if already has an active entry
                if (this.banCache.has(user.user_id)) {
                    await pool.execute(
                        'UPDATE global_ban_auto_aggregate SET processed = 1 WHERE user_id = ? AND processed = 0',
                        [user.user_id]
                    );
                    continue;
                }

                let severity = null;

                // High: 5+ guild bans OR weighted score >= 15
                if (user.ban_guilds >= 5 || user.weighted_score >= 15) {
                    severity = 'high';
                }
                // Medium: 3+ guild bans OR weighted score >= 8
                else if (user.ban_guilds >= 3 || user.weighted_score >= 8) {
                    severity = 'medium';
                }
                // Low: 2+ guild bans AND weighted score >= 4
                else if (user.ban_guilds >= 2 && user.weighted_score >= 4) {
                    severity = 'low';
                }

                if (severity) {
                    // Create global ban entry
                    const reason = `Auto-aggregated: ${user.ban_guilds} guild bans, score ${user.weighted_score} across ${user.total_guilds} guilds`;
                    const [result] = await pool.execute(
                        `INSERT INTO global_ban_entries (user_id, severity, category, reason, source, ban_count)
                         VALUES (?, ?, 'other', ?, 'auto_aggregate', ?)`,
                        [user.user_id, severity, reason, user.ban_guilds]
                    );

                    this.banCache.set(user.user_id, {
                        severity,
                        category: 'other',
                        entryId: result.insertId
                    });

                    await this.logAction(result.insertId, 'system', user.user_id, 'entry_created', null, reason);
                    created++;

                    logger.info('[GlobalBan] Auto-aggregated entry created', {
                        userId: user.user_id,
                        severity,
                        banGuilds: user.ban_guilds,
                        score: user.weighted_score
                    });
                }

                // Mark records as processed
                await pool.execute(
                    'UPDATE global_ban_auto_aggregate SET processed = 1 WHERE user_id = ? AND processed = 0',
                    [user.user_id]
                );
            }

            if (created > 0) {
                logger.info(`[GlobalBan] Auto-aggregation: created ${created} new entries`);
            }

            return created;
        } catch (error) {
            logger.error('[GlobalBan] Auto-aggregation error', { error: error.message });
            return 0;
        }
    }

    /**
     * Submit an appeal for a global ban
     */
    async submitAppeal(userId, reason, evidence = null) {
        try {
            // Find active entry for this user
            const [entries] = await pool.execute(
                'SELECT id FROM global_ban_entries WHERE user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1',
                [userId]
            );
            if (entries.length === 0) {
                return { success: false, message: 'No active global ban found for your account.' };
            }

            const entryId = entries[0].id;

            // Check for existing pending appeal
            const [existing] = await pool.execute(
                'SELECT id FROM global_ban_appeals WHERE global_ban_entry_id = ? AND status IN ("pending","under_review") LIMIT 1',
                [entryId]
            );
            if (existing.length > 0) {
                return { success: false, message: `You already have a pending appeal (#${existing[0].id}).` };
            }

            const evidenceJson = evidence ? JSON.stringify(Array.isArray(evidence) ? evidence : [evidence]) : null;

            const [result] = await pool.execute(
                `INSERT INTO global_ban_appeals (global_ban_entry_id, user_id, reason, evidence)
                 VALUES (?, ?, ?, ?)`,
                [entryId, userId, reason, evidenceJson]
            );

            // Mark entry as appealed
            await pool.execute('UPDATE global_ban_entries SET appealed = 1 WHERE id = ?', [entryId]);

            await this.logAction(entryId, 'system', userId, 'appeal_submitted', userId, `Appeal #${result.insertId}`);

            return { success: true, appealId: result.insertId };
        } catch (error) {
            logger.error('[GlobalBan] Failed to submit appeal', { error: error.message });
            return { success: false, message: 'Database error while submitting appeal.' };
        }
    }

    /**
     * Review an appeal (approve/deny)
     */
    async reviewAppeal(reviewerId, appealId, approved, response) {
        try {
            const [appeals] = await pool.execute(
                'SELECT * FROM global_ban_appeals WHERE id = ? AND status IN ("pending","under_review")',
                [appealId]
            );
            if (appeals.length === 0) {
                return { success: false, message: 'Appeal not found or already resolved.' };
            }

            const appeal = appeals[0];
            const status = approved ? 'approved' : 'denied';

            await pool.execute(
                `UPDATE global_ban_appeals SET status = ?, reviewer_id = ?, reviewer_response = ?, reviewed_at = NOW() WHERE id = ?`,
                [status, reviewerId, response, appealId]
            );

            if (approved) {
                // Deactivate the global ban entry
                await pool.execute('UPDATE global_ban_entries SET active = 0, appeal_approved = 1 WHERE id = ?', [appeal.global_ban_entry_id]);
                // Remove from cache
                this.banCache.delete(appeal.user_id);

                await this.logAction(appeal.global_ban_entry_id, 'system', appeal.user_id, 'appeal_approved', reviewerId, response);
            } else {
                await this.logAction(appeal.global_ban_entry_id, 'system', appeal.user_id, 'appeal_denied', reviewerId, response);
            }

            return { success: true, status, userId: appeal.user_id };
        } catch (error) {
            logger.error('[GlobalBan] Failed to review appeal', { error: error.message });
            return { success: false, message: 'Database error while reviewing appeal.' };
        }
    }

    /**
     * Get full user record
     */
    async getUserRecord(userId) {
        try {
            const [entries] = await pool.execute(
                'SELECT * FROM global_ban_entries WHERE user_id = ? ORDER BY created_at DESC',
                [userId]
            );

            const [reports] = await pool.execute(
                'SELECT * FROM global_ban_reports WHERE target_user_id = ? ORDER BY created_at DESC LIMIT 10',
                [userId]
            );

            const [appeals] = await pool.execute(
                'SELECT * FROM global_ban_appeals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
                [userId]
            );

            const [aggregateData] = await pool.execute(
                `SELECT action_type, COUNT(DISTINCT guild_id) as guild_count, COUNT(*) as total
                 FROM global_ban_auto_aggregate WHERE user_id = ?
                 GROUP BY action_type`,
                [userId]
            );

            const [actionLog] = await pool.execute(
                'SELECT * FROM global_ban_action_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
                [userId]
            );

            return {
                entries,
                reports,
                appeals,
                aggregateData,
                actionLog,
                cachedEntry: this.banCache.get(userId) || null
            };
        } catch (error) {
            logger.error('[GlobalBan] Failed to get user record', { error: error.message });
            return null;
        }
    }

    /**
     * Handle button interactions from alert embeds
     */
    async handleButtonInteraction(interaction) {
        const parts = interaction.customId.split('_');
        // Format: globalban_action_userId
        const action = parts[1];
        const targetUserId = parts[2];

        if (!interaction.member.permissions.has('ModerateMembers')) {
            return interaction.reply({
                content: 'You need the Moderate Members permission to use these controls.',
                ephemeral: true
            });
        }

        switch (action) {
            case 'view': {
                await interaction.deferReply({ ephemeral: true });
                const record = await this.getUserRecord(targetUserId);
                if (!record) {
                    return interaction.editReply('Failed to fetch user record.');
                }

                const activeEntry = record.entries.find(e => e.active);
                const embed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setTitle(`Global Ban Record: ${targetUserId}`)
                    .addFields(
                        { name: 'Active Entry', value: activeEntry ? `#${activeEntry.id} — ${activeEntry.severity.toUpperCase()} (${activeEntry.category})` : 'None', inline: false },
                        { name: 'Total Entries', value: `${record.entries.length}`, inline: true },
                        { name: 'Reports', value: `${record.reports.length}`, inline: true },
                        { name: 'Appeals', value: `${record.appeals.length}`, inline: true }
                    );

                if (activeEntry?.reason) {
                    embed.addFields({ name: 'Reason', value: activeEntry.reason.substring(0, 1024) });
                }

                if (record.aggregateData.length > 0) {
                    const aggText = record.aggregateData.map(a => `${a.action_type}: ${a.total} (${a.guild_count} guilds)`).join('\n');
                    embed.addFields({ name: 'Cross-Guild Actions', value: aggText });
                }

                if (record.actionLog.length > 0) {
                    const logText = record.actionLog.slice(0, 5).map(l => {
                        const ts = Math.floor(new Date(l.created_at).getTime() / 1000);
                        return `<t:${ts}:R> ${l.action}${l.details ? ` — ${l.details.substring(0, 50)}` : ''}`;
                    }).join('\n');
                    embed.addFields({ name: 'Recent Activity', value: logText });
                }

                return interaction.editReply({ embeds: [embed] });
            }
            case 'dismiss': {
                const message = interaction.message;
                const embed = EmbedBuilder.from(message.embeds[0])
                    .setColor(0x95A5A6)
                    .setFooter({ text: `Dismissed by ${interaction.user.tag}` });
                await message.edit({ embeds: [embed], components: [] });
                return interaction.reply({ content: 'Alert dismissed.', ephemeral: true });
            }
        }
    }

    /**
     * Handle a DM appeal from a user
     */
    async handleDMAppeal(message) {
        const userId = message.author.id;
        const content = message.content.trim();

        // Check if user has an active ban
        const record = this.banCache.get(userId);
        if (!record) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x3498DB)
                        .setTitle('Global Ban Appeal')
                        .setDescription('You don\'t have an active global ban. No appeal is needed.')
                        .setTimestamp()
                ]
            }).catch(() => {});
        }

        // Check for existing pending appeal
        const [existing] = await pool.execute(
            'SELECT id FROM global_ban_appeals WHERE user_id = ? AND status IN ("pending","under_review") LIMIT 1',
            [userId]
        );
        if (existing.length > 0) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xF1C40F)
                        .setTitle('Appeal Already Pending')
                        .setDescription(`You already have a pending appeal (**#${existing[0].id}**). Please wait for it to be reviewed.\n\nYou can also check your appeal status at: https://certifriedmultitool.com/appeal`)
                        .setTimestamp()
                ]
            }).catch(() => {});
        }

        // Check message length
        if (content.length < 20) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xE67E22)
                        .setTitle('How to Appeal')
                        .setDescription(
                            'To submit a global ban appeal via DM, send a message with your appeal reason.\n\n' +
                            '**Requirements:**\n' +
                            '• Minimum 20 characters\n' +
                            '• Explain why you believe the ban should be reversed\n' +
                            '• Be honest and specific\n\n' +
                            'Or visit: https://certifriedmultitool.com/appeal'
                        )
                        .setTimestamp()
                ]
            }).catch(() => {});
        }

        // Submit the appeal
        const result = await this.submitAppeal(userId, content);

        if (result.success) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x2ECC71)
                        .setTitle('Appeal Submitted')
                        .setDescription(`Your appeal (**#${result.appealId}**) has been submitted and is awaiting review.\n\nYou can check the status at: https://certifriedmultitool.com/appeal`)
                        .addFields(
                            { name: 'Your Appeal', value: content.length > 1024 ? content.substring(0, 1021) + '...' : content }
                        )
                        .setTimestamp()
                ]
            }).catch(() => {});
        } else {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xE74C3C)
                        .setTitle('Appeal Failed')
                        .setDescription(result.message || 'Failed to submit your appeal. Please try again later or visit https://certifriedmultitool.com/appeal')
                        .setTimestamp()
                ]
            }).catch(() => {});
        }
    }

    /**
     * Get global statistics
     */
    async getStats() {
        try {
            const [[totalEntries]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_entries WHERE active = 1');
            const [[totalReports]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_reports WHERE status = "pending"');
            const [[totalAppeals]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_appeals WHERE status IN ("pending","under_review")');
            const [[totalGuilds]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_config WHERE enabled = 1');

            const [bySeverity] = await pool.execute(
                'SELECT severity, COUNT(*) as count FROM global_ban_entries WHERE active = 1 GROUP BY severity'
            );

            const [byCategory] = await pool.execute(
                'SELECT category, COUNT(*) as count FROM global_ban_entries WHERE active = 1 GROUP BY category ORDER BY count DESC LIMIT 5'
            );

            const [recentActions] = await pool.execute(
                'SELECT action, COUNT(*) as count FROM global_ban_action_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) GROUP BY action'
            );

            return {
                activeEntries: totalEntries.count,
                pendingReports: totalReports.count,
                pendingAppeals: totalAppeals.count,
                enabledGuilds: totalGuilds.count,
                bySeverity,
                byCategory,
                recentActions,
                cacheSize: this.banCache.size
            };
        } catch (error) {
            logger.error('[GlobalBan] Failed to get stats', { error: error.message });
            return null;
        }
    }

    /**
     * Log an action to the audit trail
     */
    async logAction(entryId, guildId, userId, action, performedBy = null, details = null) {
        try {
            await pool.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [entryId, guildId, userId, action, performedBy, details]
            );
        } catch (error) {
            logger.error('[GlobalBan] Failed to log action', { error: error.message, action });
        }
    }
}

export default GlobalBanManager;
