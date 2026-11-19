import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import configCache from '../utils/configCache.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import { themeColor } from './guild-theme.js';
import { protectionHold, takeAutomatedAction } from './protection-exempt.js';
import {
    classifyBanSource, computeConfidence, shouldCreateEntry, entryConfidence, decideEnforcement,
    decideMessageEnforcement, guildTrust, isBurst, strongerSource, normaliseMode, normaliseThreshold,
    publicSummary, contextLabel, SOURCE_RANK,
} from './global-ban-confidence.js';
import { whyCannot } from './manual-action.js';

/**
 * Global Ban Manager - Shared cross-guild ban database
 * Maintains an in-memory Map of active entries for O(1) lookups.
 * All bot instances contribute to and enforce the same ban list.
 *
 * Network (migration 329): every ban any participating server makes is a signal — our moderation
 * commands (recordCrossGuildAction from core/moderation-manager.js) and every other ban Discord reports
 * (ingestBan from events/guildBanAdd.js: our protections, staff by hand, other bots). The aggregator
 * (jobs/global-ban-aggregator.js -> processAutoAggregate) turns each user's signals into a 0-100
 * confidence with core/global-ban-confidence.js and creates / updates entries. Each server picks a mode
 * (protect | alert | feed) and a confidence threshold on global_ban_config.
 */
const MESSAGE_THROTTLE_MS = 10 * 60_000;
const SUPPORT_HINT = 'Move my role above theirs and give me the Ban Members / Kick Members permission.';

class GlobalBanManager {
    constructor(client) {
        this.client = client;
        // Map<userId, { severity, category, entryId, confidence, source }>
        this.banCache = new Map();
        this.refreshInterval = null;
        this.recentBans = new Map();      // guildId -> [timestamps] (mass-ban burst detection)
        this.messageActed = new Map();    // `${guildId}:${userId}` -> at (message-time throttle)
    }

    /** A cache record's confidence: stored on the entry, or what its severity stands for. */
    confidenceOf(record) {
        return entryConfidence(record || {});
    }

    /**
     * Load all active global ban entries into memory
     */
    async loadBanCache() {
        try {
            let rows;
            try {
                [rows] = await pool.execute(
                    'SELECT id, user_id, severity, category, source, confidence FROM global_ban_entries WHERE active = 1'
                );
            } catch {
                // Before migration 329 there is no confidence column.
                [rows] = await pool.execute(
                    'SELECT id, user_id, severity, category, source FROM global_ban_entries WHERE active = 1'
                );
            }
            this.banCache.clear();
            for (const row of rows) {
                this.banCache.set(row.user_id, {
                    severity: row.severity,
                    category: row.category,
                    entryId: row.id,
                    source: row.source,
                    confidence: row.confidence ?? null
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
     * This server's row whether or not enforcement is on (the opt-in and the mode apply to servers
     * that only feed the network). Cached 60s like getConfig.
     */
    async getSettings(guildId) {
        try {
            return await configCache.get('global_ban_config_any', guildId, async () => {
                const [rows] = await pool.execute('SELECT * FROM global_ban_config WHERE guild_id = ?', [guildId]);
                return rows[0] || null;
            });
        } catch (error) {
            logger.error('[GlobalBan] Error fetching settings', { error: error.message, guildId });
            return null;
        }
    }

    /** What this server does about a record: its mode, threshold and the severity's action. */
    decide(record, config, { atMessage = false } = {}) {
        const p = {
            mode: config.mode,
            threshold: config.confidence_threshold,
            confidence: this.confidenceOf(record),
            severityAction: this.getActionForSeverity(record.severity, config),
        };
        return { ...(atMessage ? decideMessageEnforcement(p) : decideEnforcement(p)), confidence: p.confidence };
    }

    /**
     * Check a member on join against the global ban cache
     */
    async checkMember(member) {
        try {
            if (isProtectedFromBanCommands(member.id)) return false;

            const record = this.banCache.get(member.id);
            if (!record) return false;

            const config = await this.getConfig(member.guild.id);
            if (!config || !config.check_on_join) return false;

            // Check exempt roles
            if (this.isExempt(member, config)) return false;

            // Mode + confidence threshold (protect / alert / feed) pick the action.
            const decision = this.decide(record, config);
            if (decision.action === 'none') return false;

            await this.executeAction(member, record, decision.action, config, decision);
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
        if (isProtectedFromBanCommands(message.author.id)) return false;

        const record = this.banCache.get(message.author.id);
        if (!record) return false;

        const config = await this.getConfig(message.guild.id);
        if (!config || !config.check_on_message) return false;

        if (!message.member || this.isExempt(message.member, config)) return false;

        // Only a real ban/kick in Protect mode at or above the threshold — never an alert per message.
        const decision = this.decide(record, config, { atMessage: true });
        if (decision.action === 'none') return false;

        // One attempt per member per 10 minutes: if the bot cannot remove them, do not retry on every message.
        const key = `${message.guild.id}:${message.author.id}`;
        const last = this.messageActed.get(key);
        if (last && Date.now() - last < MESSAGE_THROTTLE_MS) return false;
        if (this.messageActed.size > 2000) this.messageActed.clear();
        this.messageActed.set(key, Date.now());

        await this.executeAction(message.member, record, decision.action, config, decision);
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
    async executeAction(member, record, action, config, decision = null) {
        const { guild, user } = member;

        if (isProtectedFromBanCommands(user.id)) {
            logger.warn('[GlobalBan] Refusing to apply enforcement to protected bot owner', {
                userId: user.id,
                guildId: guild.id,
                action,
                category: record?.category,
                severity: record?.severity
            });
            return;
        }

        // Unified allowlist / global pause: still alerted and logged, but nothing done to them and
        // no DM telling them they were removed (core/protection-exempt.js logs the skip).
        let held = null;
        if (action === 'ban' || action === 'kick') {
            held = await protectionHold(member, action, 'Global ban');
            if (held) action = 'alert';
        }

        // DM the user before action (best effort). Only when they really are about to be removed: an
        // alert (Alert-only mode, or below the threshold) must not tip them off, and a removal the bot
        // cannot carry out must not claim it happened.
        const removable = action === 'ban' ? member.bannable : action === 'kick' ? member.kickable : false;
        if (!held && removable) try {
            const actionText = action === 'ban' ? 'banned from' : 'kicked from';
            await user.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(themeColor(member.guild?.id, 'danger'))
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

        // Execute the action. When the bot cannot (hierarchy / permission) the alert says exactly what to
        // fix instead of the old silent skip ("Manual action needed").
        let problem = null;
        try {
            switch (action) {
                case 'ban':
                    if (member.bannable) {
                        await member.ban({ reason: `Global Ban: ${record.category} (${record.severity})`, deleteMessageSeconds: 86400 });
                    } else {
                        problem = (whyCannot(member.guild, 'ban', { member })?.text || 'I could not ban this member: my highest role is not above theirs, or I lack Ban Members.').replace(/\*\*/g, '');
                    }
                    break;
                case 'kick':
                    if (member.kickable) {
                        await member.kick(`Global Ban: ${record.category} (${record.severity})`);
                    } else {
                        problem = (whyCannot(member.guild, 'kick', { member })?.text || 'I could not kick this member: my highest role is not above theirs, or I lack Kick Members.').replace(/\*\*/g, '');
                    }
                    break;
                case 'alert':
                    // No direct action on user, just send alert
                    break;
            }
        } catch (error) {
            problem = `Discord refused the ${action}: ${error.message}`;
            logger.error('[GlobalBan] Failed to execute action', {
                action,
                error: error.message,
                userId: user.id,
                guildId: guild.id
            });
        }

        // Send alert embed to configured channel
        await this.sendAlert(guild, user, record, action, config, { decision, problem, held });

        // Log the action
        const conf = decision?.confidence ?? this.confidenceOf(record);
        await this.logAction(record.entryId, guild.id, user.id, problem ? 'alert' : action, this.client.user.id,
            `Auto-enforced: ${record.category} (${record.severity}), confidence ${conf}${problem ? ` - manual action needed: ${problem}` : ''}`);

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
    async sendAlert(guild, user, record, action, config, { decision = null, problem = null, held = null } = {}) {
        if (!config.alert_channel_id) return;

        try {
            const channel = guild.channels.cache.get(config.alert_channel_id);
            if (!channel) return;

            const actionLabels = { ban: 'Banned', kick: 'Kicked', alert: 'Alert Only' };
            const severityColors = { critical: 0xC0392B, high: 0xE74C3C, medium: 0xE67E22, low: 0xF1C40F };
            const conf = decision?.confidence ?? this.confidenceOf(record);

            const embed = new EmbedBuilder()
                .setColor(problem ? 0xE67E22 : (severityColors[record.severity] || 0xE74C3C))
                .setTitle(problem ? 'Global Ban Alert — Manual Action Needed' : 'Global Ban Alert')
                .setDescription(`A user with an active global ban record has been detected.`)
                .addFields(
                    { name: 'User', value: `${user.tag} (<@${user.id}>)`, inline: true },
                    { name: 'Severity', value: record.severity.toUpperCase(), inline: true },
                    { name: 'Category', value: record.category, inline: true },
                    { name: 'Confidence', value: `${conf}/100`, inline: true },
                    { name: 'Action Taken', value: problem ? 'None (failed)' : (actionLabels[action] || action), inline: true },
                    { name: 'Entry ID', value: `#${record.entryId}`, inline: true }
                )
                .setFooter({ text: `User ID: ${user.id}` })
                .setTimestamp();
            if (decision?.why) embed.addFields({ name: 'Why', value: `${normaliseMode(config.mode)} mode: ${decision.why}`.slice(0, 1024) });
            if (held) embed.addFields({ name: 'Held', value: String(held.text || 'Member is exempt or protections are paused').slice(0, 1024) });
            if (problem) embed.addFields({ name: 'Manual action needed', value: `${problem}\n${SUPPORT_HINT}`.slice(0, 1024) });

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
     * Resolve a Discord user's current global username via the bot client.
     * Returns null if unfetchable (deleted account, rate-limited, no client).
     */
    async resolveUsername(userId) {
        if (!userId || !this.client?.users?.fetch) return null;
        try {
            const u = await this.client.users.fetch(userId);
            return u?.username || u?.tag || null;
        } catch {
            return null;
        }
    }

    /**
     * Promote an approved report to a global ban entry
     */
    async promoteReport(reportId, report) {
        try {
            const [targetName, reporterName] = await Promise.all([
                this.resolveUsername(report.target_user_id),
                this.resolveUsername(report.reporter_id)
            ]);

            const [result] = await pool.execute(
                `INSERT INTO global_ban_entries (user_id, username, severity, category, reason, evidence, source, reporter_id, reporter_name, source_guild_id, verified, verification_votes)
                 VALUES (?, ?, ?, ?, ?, ?, 'manual_report', ?, ?, ?, 1, ?)`,
                [report.target_user_id, targetName, report.severity, report.category, report.reason, report.evidence, report.reporter_id, reporterName, report.reporter_guild_id, report.votes_approve || 0]
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
     * Record a cross-guild moderation action for auto-aggregation (a network signal).
     *
     * The same ban reaches here twice when our /ban command made it (moderation-manager, then the
     * guildBanAdd event): within a day one server's signal for one user and action is ONE row, kept at
     * the stronger source, so nothing is counted twice. Servers that opted out (in any state, enabled
     * or not) contribute nothing.
     *
     * @param {object} meta  { source: protection|moderator|trusted_bot|bot|unknown, context, trust, burst, ownerId }
     */
    async recordCrossGuildAction(userId, guildId, actionType, reason, moderatorId, meta = {}) {
        try {
            if (isProtectedFromBanCommands(userId)) return false;
            const settings = await this.getSettings(guildId);
            if (settings && !settings.auto_aggregate_opt_in) return false;

            const source = meta.source || 'moderator';
            const context = meta.context || null;
            const trust = meta.trust ?? null;
            const burst = meta.burst ? 1 : 0;
            const ownerId = meta.ownerId || null;
            const why = reason == null ? null : String(reason).slice(0, 2000);

            let existing = null;
            try {
                const [rows] = await pool.execute(
                    `SELECT id, source_kind FROM global_ban_auto_aggregate
                      WHERE user_id = ? AND guild_id = ? AND action_type = ? AND occurred_at > DATE_SUB(NOW(), INTERVAL 1 DAY)
                      ORDER BY id DESC LIMIT 1`, [userId, guildId, actionType]);
                existing = rows[0] || null;
            } catch {
                // Before migration 329 (no source_kind column): the plain insert, as it always was.
                await pool.execute(
                    `INSERT INTO global_ban_auto_aggregate (user_id, guild_id, action_type, infraction_reason, moderator_id)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE infraction_reason = VALUES(infraction_reason)`,
                    [userId, guildId, actionType, why, moderatorId]
                );
                return true;
            }

            if (existing) {
                const keep = strongerSource(existing.source_kind || 'unknown', source);
                const upgraded = (SOURCE_RANK[keep] ?? 0) > (SOURCE_RANK[existing.source_kind] ?? 0);
                await pool.execute(
                    `UPDATE global_ban_auto_aggregate
                        SET source_kind = ?, context = COALESCE(?, context), guild_trust = COALESCE(?, guild_trust),
                            guild_owner_id = COALESCE(?, guild_owner_id), burst = LEAST(burst, ?),
                            infraction_reason = COALESCE(infraction_reason, ?), processed = IF(?, 0, processed)
                      WHERE id = ?`,
                    [keep, context, trust, ownerId, burst, why, upgraded ? 1 : 0, existing.id]);
                return true;
            }

            await pool.execute(
                `INSERT INTO global_ban_auto_aggregate
                    (user_id, guild_id, action_type, infraction_reason, moderator_id, source_kind, context, guild_trust, burst, guild_owner_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE infraction_reason = VALUES(infraction_reason)`,
                [userId, guildId, actionType, why, moderatorId, source, context, trust, burst, ownerId]
            );
            return true;
        } catch (error) {
            logger.error('[GlobalBan] Failed to record cross-guild action', { error: error.message, userId, guildId });
            return false;
        }
    }

    /** Our own bots' user ids (every client in this process). */
    fleetIds() {
        const ids = new Set();
        if (this.client?.user?.id) ids.add(this.client.user.id);
        const clients = global.botManager?.clients;
        if (clients?.values) for (const c of clients.values()) if (c?.user?.id) ids.add(c.user.id);
        return ids;
    }

    /**
     * Feed one ban Discord reported (events/guildBanAdd.js) into the network: who did it (our protection,
     * a person, a known bot, an unknown bot) and why, from the audit-log entry and the protection that was
     * cleared to act just before (core/protection-exempt.js takeAutomatedAction).
     * @param auditEntry  { executor, reason } from the MemberBanAdd audit log, or null
     * @param opts.pending  the takeAutomatedAction() result when the caller already consumed it
     * @returns {Promise<object|null>} the classification (also recorded on the ban log), or null
     */
    async ingestBan(guild, user, auditEntry = null, { pending = undefined } = {}) {
        try {
            if (!guild || !user || user.bot || isProtectedFromBanCommands(user.id)) return null;
            const executor = auditEntry?.executor || null;
            const ours = executor ? this.fleetIds().has(executor.id) : false;
            const automated = pending === undefined ? takeAutomatedAction(guild.id, user.id) : pending;
            const cls = classifyBanSource({
                executorId: executor?.id ?? null,
                executorBot: !!executor?.bot,
                executorName: executor?.username ?? null,
                ourBot: ours,
                reason: auditEntry?.reason ?? null,
                pendingLabel: automated?.source ?? null,
            });
            if (cls.excluded) return { ...cls, recorded: false };

            const now = Date.now();
            const list = (this.recentBans.get(guild.id) || []).filter(t => now - t < 10 * 60_000);
            list.push(now);
            this.recentBans.set(guild.id, list);
            if (this.recentBans.size > 5000) this.recentBans.clear();
            const burst = isBurst(list, now);
            const trust = guildTrust({ createdAt: guild.createdTimestamp, memberCount: guild.memberCount, now });

            const recorded = await this.recordCrossGuildAction(user.id, guild.id, 'ban', auditEntry?.reason ?? null, executor?.id ?? null, {
                source: cls.source, context: cls.context, trust, burst, ownerId: guild.ownerId || null,
            });
            return { ...cls, recorded, burst, trust };
        } catch (error) {
            logger.error('[GlobalBan] Failed to ingest ban', { error: error.message, guildId: guild?.id, userId: user?.id });
            return null;
        }
    }

    /**
     * Process auto-aggregation: every user with a new signal gets their confidence recomputed from ALL
     * their signals (core/global-ban-confidence.js). Two independent servers (by owner) and enough
     * confidence create an entry; an existing automatic entry follows its confidence up or down; a
     * curated entry keeps at least the confidence its severity implies. The old weighted score
     * (ban 3 / kick 2 / mute 1 / warn 0.5) is the action part of each signal's strength.
     */
    async processAutoAggregate() {
        try {
            const [users] = await pool.execute(
                'SELECT DISTINCT user_id FROM global_ban_auto_aggregate WHERE processed = 0 LIMIT 1000'
            );

            let created = 0;
            let updated = 0;

            for (const { user_id: userId } of users) {
                if (isProtectedFromBanCommands(userId)) {
                    await pool.execute('UPDATE global_ban_auto_aggregate SET processed = 1 WHERE user_id = ? AND processed = 0', [userId]);
                    continue;
                }
                const [signals] = await pool.execute(
                    `SELECT guild_id, action_type, source_kind, context, guild_trust, burst, guild_owner_id
                       FROM global_ban_auto_aggregate WHERE user_id = ?`, [userId]);
                const cached = this.banCache.get(userId);
                const curated = cached && cached.source !== 'auto_aggregate' ? cached : null;
                const result = computeConfidence(signals, { curated });

                if (cached) {
                    const newConf = curated ? result.confidence : result.computed;
                    const newSeverity = curated ? cached.severity : (result.severity || 'low');
                    if (newConf !== cached.confidence || newSeverity !== cached.severity) {
                        await pool.execute(
                            'UPDATE global_ban_entries SET confidence = ?, severity = ?, signal_guilds = ?, ban_count = GREATEST(ban_count, ?) WHERE id = ?',
                            [newConf, newSeverity, result.groups, result.guilds, cached.entryId]);
                        if (newSeverity !== cached.severity) {
                            await this.logAction(cached.entryId, 'system', userId, 'entry_updated', null,
                                `Confidence ${cached.confidence ?? '-'} -> ${newConf} from ${result.groups} independent servers; severity ${cached.severity} -> ${newSeverity}`);
                        }
                        this.banCache.set(userId, { ...cached, confidence: newConf, severity: newSeverity });
                        updated++;
                    }
                } else if (shouldCreateEntry(result)) {
                    const reasons = result.contexts.slice(0, 3).map(contextLabel).join(', ');
                    const reason = `Auto-aggregated: confidence ${result.computed} from ${result.groups} independent servers`
                        + ` (${Object.entries(result.bySource).map(([k, n]) => `${n} ${k}`).join(', ')})${reasons ? `; ${reasons}` : ''}`;
                    const [ins] = await pool.execute(
                        `INSERT INTO global_ban_entries (user_id, severity, category, reason, source, ban_count, confidence, signal_guilds)
                         VALUES (?, ?, ?, ?, 'auto_aggregate', ?, ?, ?)`,
                        [userId, result.severity, result.category, reason, result.guilds, result.computed, result.groups]);
                    this.banCache.set(userId, {
                        severity: result.severity, category: result.category, entryId: ins.insertId,
                        source: 'auto_aggregate', confidence: result.computed,
                    });
                    await this.logAction(ins.insertId, 'system', userId, 'entry_created', null, reason);
                    created++;
                    logger.info('[GlobalBan] Auto-aggregated entry created', {
                        userId, severity: result.severity, confidence: result.computed, groups: result.groups
                    });
                }

                await pool.execute('UPDATE global_ban_auto_aggregate SET processed = 1 WHERE user_id = ? AND processed = 0', [userId]);
            }

            if (created > 0 || updated > 0) {
                logger.info(`[GlobalBan] Auto-aggregation: created ${created}, updated ${updated} entries`);
            }

            return created;
        } catch (error) {
            logger.error('[GlobalBan] Auto-aggregation error', { error: error.message });
            return 0;
        }
    }

    /**
     * One user's network standing for `/globalban check` and the dashboard: confidence, how many
     * independent servers and what kinds of source reported them — never which servers or who.
     */
    async getNetworkCheck(userId, guildId = null) {
        const [signals] = await pool.execute(
            `SELECT guild_id, action_type, source_kind, context, guild_trust, burst, guild_owner_id, occurred_at
               FROM global_ban_auto_aggregate WHERE user_id = ?`, [userId]);
        const [[entry]] = await pool.execute(
            `SELECT id, severity, category, source, confidence, created_at FROM global_ban_entries
              WHERE user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1`, [userId]);
        const [[reports]] = await pool.execute(
            "SELECT COUNT(*) AS n FROM global_ban_reports WHERE target_user_id = ? AND status = 'pending'", [userId]);
        const curated = entry && entry.source !== 'auto_aggregate' ? entry : null;
        const result = computeConfidence(signals, { curated });
        if (entry && !curated) result.confidence = Math.max(result.confidence, entryConfidence(entry));
        const times = signals.map(s => new Date(s.occurred_at).getTime()).filter(Number.isFinite);
        const summary = publicSummary(result, {
            entry, ownSignal: !!guildId && signals.some(s => String(s.guild_id) === String(guildId)), reports: Number(reports?.n) || 0,
        });
        let decision = null;
        if (guildId) {
            const cfg = await this.getSettings(guildId);
            const base = { enabled: !!cfg?.enabled, mode: normaliseMode(cfg?.mode), threshold: normaliseThreshold(cfg?.confidence_threshold) };
            if (!cfg?.enabled) {
                decision = { ...base, action: 'none', why: 'global ban protection is off in this server' };
            } else if (!entry) {
                decision = { ...base, action: 'none', why: 'not listed in the network, so nothing happens on join' };
            } else {
                decision = {
                    ...base,
                    ...decideEnforcement({
                        mode: cfg.mode, threshold: cfg.confidence_threshold, confidence: summary.confidence,
                        severityAction: this.getActionForSeverity(entry.severity, cfg),
                    }),
                };
            }
        }
        return {
            ...summary,
            entryId: entry?.id ?? null,
            listedAt: entry?.created_at ?? null,
            firstSeen: times.length ? new Date(Math.min(...times)) : null,
            lastSeen: times.length ? new Date(Math.max(...times)) : null,
            decision,
        };
    }

    /** Network size and recent additions, for `/globalban stats` and the dashboard. */
    async getNetworkStats(guildId = null) {
        const one = async (sql, params = []) => {
            try { const [[r]] = await pool.execute(sql, params); return r || {}; } catch { return {}; }
        };
        const active = await one("SELECT COUNT(*) AS n, SUM(source = 'auto_aggregate') AS auto FROM global_ban_entries WHERE active = 1");
        const tracked = await one('SELECT COUNT(DISTINCT user_id) AS n, COUNT(DISTINCT guild_id) AS g FROM global_ban_auto_aggregate WHERE occurred_at > DATE_SUB(NOW(), INTERVAL 90 DAY)');
        const week = await one('SELECT COUNT(*) AS n FROM global_ban_entries WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)');
        const signals7 = await one('SELECT COUNT(*) AS n FROM global_ban_auto_aggregate WHERE occurred_at > DATE_SUB(NOW(), INTERVAL 7 DAY)');
        const participating = await one('SELECT COUNT(*) AS n FROM global_ban_config WHERE enabled = 1');
        const modes = {};
        try {
            const [rows] = await pool.execute('SELECT mode, COUNT(*) AS n FROM global_ban_config WHERE enabled = 1 GROUP BY mode');
            for (const r of rows) modes[r.mode || 'protect'] = Number(r.n);
        } catch { /* before migration 329 */ }
        let recent = [];
        try {
            const [rows] = await pool.execute(
                `SELECT id, user_id, severity, category, source, confidence, created_at FROM global_ban_entries
                  WHERE active = 1 ORDER BY created_at DESC LIMIT 10`);
            recent = rows.map(r => ({ ...r, confidence: entryConfidence(r) }));
        } catch { /* before migration 329 */ }
        let mine = null;
        if (guildId) {
            const n = async (sql) => Number((await one(sql, [guildId])).n) || 0;
            mine = {
                contributed90d: await n('SELECT COUNT(*) AS n FROM global_ban_auto_aggregate WHERE guild_id = ? AND occurred_at > DATE_SUB(NOW(), INTERVAL 90 DAY)'),
                actions30d: await n("SELECT COUNT(*) AS n FROM global_ban_action_log WHERE guild_id = ? AND action IN ('ban','kick') AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)"),
                alerts30d: await n("SELECT COUNT(*) AS n FROM global_ban_action_log WHERE guild_id = ? AND action = 'alert' AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)"),
            };
        }
        return {
            activeEntries: Number(active.n) || 0,
            automaticEntries: Number(active.auto) || 0,
            trackedUsers: Number(tracked.n) || 0,
            contributingServers: Number(tracked.g) || 0,
            participatingServers: Number(participating.n) || 0,
            addedThisWeek: Number(week.n) || 0,
            signalsThisWeek: Number(signals7.n) || 0,
            enabledByMode: modes,
            recent,
            mine,
        };
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

            // Tell the person (H-646: /appeal promises a notification). Best effort: closed DMs or a missing user
            // never undo the decision, which also shows on the /appeal page.
            await this.notifyAppealDecision(appeal.user_id, approved, response);

            return { success: true, status, userId: appeal.user_id };
        } catch (error) {
            logger.error('[GlobalBan] Failed to review appeal', { error: error.message });
            return { success: false, message: 'Database error while reviewing appeal.' };
        }
    }

    /** DM the outcome of a global ban appeal to the person who made it. Never throws. */
    async notifyAppealDecision(userId, approved, response) {
        if (!userId || !this.client?.users?.fetch) return false;
        try {
            const user = await this.client.users.fetch(String(userId));
            const note = String(response || '').trim().slice(0, 1500);
            const lines = approved
                ? ['Your appeal against the CertiFried shared ban list was approved. The ban is lifted, and servers that use the list will no longer act on it.']
                : ['Your appeal against the CertiFried shared ban list was reviewed and denied. The ban stays in place.'];
            if (note) lines.push('', 'Reviewer\'s note:', note);
            lines.push('', 'Details: https://certifriedmultitool.com/appeal');
            await user.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
            return true;
        } catch (error) {
            logger.info('[GlobalBan] Could not DM the appeal decision', { userId: String(userId), error: error.message });
            return false;
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
                    .setColor(themeColor(interaction.guildId, 'primary'))
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
                        .setColor(themeColor(message.guild?.id, 'primary'))
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
                        .setColor(themeColor(message.guild?.id, 'warning'))
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
                        .setColor(themeColor(message.guild?.id, 'warning'))
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
                        .setColor(themeColor(message.guild?.id, 'success'))
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
                        .setColor(themeColor(message.guild?.id, 'danger'))
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
