import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import configCache from '../utils/configCache.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import { themeColor } from './guild-theme.js';
import { protectionHold } from './protection-exempt.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import { getActive as getActiveLockdown, enforceJoin as enforceLockdown, startLockdown, actOnGroup } from './raid-lockdown.js';
import { lockdownSettings, autoTrigger, sameNameGroups, memberNameKeys, raidStillHot } from './raid-lockdown-logic.js';

/**
 * Timeout length for the 'mute' and 'lockdown' actions when raid_detection_config.mute_duration_minutes
 * is NULL/0 (it is nullable). Same as the column's default.
 */
const DEFAULT_RAID_MUTE_MINUTES = 60;

/** Discord refuses timeouts longer than 28 days. */
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

/**
 * Most messages purged per raider when purge_messages is on. raid_detection_config has no
 * purge_limit column; reading one gave `undefined`, which made every purge delete nothing.
 */
const RAID_PURGE_LIMIT = 100;

/** Outcomes that take a joiner out of the normal join pipeline (no welcome, no roles). */
const STOPPING = new Set(['banned', 'kicked', 'timed_out', 'quarantined']);

/** The configured raid timeout, in minutes — always a usable positive number. */
function raidMuteMinutes(config) {
    const minutes = Number(config.mute_duration_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_RAID_MUTE_MINUTES;
    return Math.min(Math.round(minutes), MAX_TIMEOUT_MINUTES);
}

/**
 * Raid Detection Manager - Detects and responds to coordinated mass-join attacks
 * Inspired by Sery Bot's hate raid protection
 *
 * One join tracker feeds three rules, each switched on separately on the raid_detection_config row:
 *   raid detection   N joins in S seconds, enough of them new accounts -> the configured action on
 *                    the batch, an alert with Kick All / Ban All / False Positive buttons. While the
 *                    raid is "hot" (raidStillHot) every further join is part of it and is actioned
 *                    too — before 2026-10-12 they were only added to the incident and left alone.
 *   auto lockdown    N joins in S seconds -> a join lockdown (core/raid-lockdown.js) that acts on
 *                    every join until it ends, starting with the burst that set it off.
 *   same-name flood  N joins whose names fold to the same text -> the configured action on the group.
 * A running lockdown is checked first and takes precedence (events/guildMemberAdd.js also checks it
 * before the stale-event guard, so joins replayed after a restart are caught).
 */
class RaidDetectionManager {
    constructor(client) {
        this.client = client;

        // Max sizes to prevent unbounded growth
        this.MAX_GUILDS_TRACKED = 500;
        this.MAX_JOINS_PER_GUILD = 1000;

        // Track joins per guild
        // Format: Map<guildId, Array<{ userId, timestamp, accountAge, accountCreated }>>
        this.joinTracker = new Map();

        // Track active raids
        // Format: Map<guildId, { startTime, lastJoinAt, incidentId, affectedUsers: [], status: 'active'|'resolved' }>
        this.activeRaids = new Map();

        // Joins before these times (ms) no longer count towards a new raid / a new auto-lockdown:
        // they were the last one's. (The tracker used to be wiped instead, which also lost them for
        // the same-name check.)
        this.raidCutoff = new Map();
        this.lockdownCutoff = new Map();

        // guildId -> Map(userId -> acted at): same-name members already acted on, so a growing group
        // is only acted on for its newcomers.
        this.sameNameActed = new Map();

        // Clean up old join entries every 30 seconds
        this.cleanupInterval = setInterval(() => this.cleanupOldJoins(), 30000);

        logger.info('[RaidDetection] Manager initialized');
    }

    /**
     * Stop the manager and cleanup (call on shutdown)
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.joinTracker.clear();
        this.activeRaids.clear();
        this.raidCutoff.clear();
        this.lockdownCutoff.clear();
        this.sameNameActed.clear();
        logger.info('[RaidDetection] Manager stopped and cleaned up');
    }

    /**
     * Track a member join and check for raid conditions.
     * @param {GuildMember} member - The member who joined
     * @returns {Promise<'stop'|null>} 'stop' when a lockdown or flood rule removed, timed out or
     *          quarantined them and the rest of the join pipeline should not run for them
     */
    async trackJoin(member) {
        const { guild, user } = member;

        try {
            // A lockdown started while this join was on its way (the guildMemberAdd check ran first).
            const lock = await getActiveLockdown(guild.id);
            if (lock) {
                const out = await enforceLockdown(member, lock);
                return out?.stop ? 'stop' : null;
            }

            // Get config
            const config = await this.getConfig(guild.id);
            if (!config) return null;
            const settings = lockdownSettings(config);
            const raidOn = !!config.enabled;
            if (!raidOn && !settings.autoEnabled && !settings.sameNameEnabled) return null;

            // Check if user has whitelisted role (returning member with role)
            if (config.whitelist_roles) {
                const whitelistRoles = JSON.parse(config.whitelist_roles || '[]');
                if (member.roles.cache.some(role => whitelistRoles.includes(role.id))) {
                    return null;
                }
            }

            // Calculate account age in hours
            const accountAgeMs = Date.now() - user.createdTimestamp;
            const accountAgeHours = accountAgeMs / (1000 * 60 * 60);

            // Track this join
            this.addJoin(guild.id, {
                userId: user.id,
                timestamp: Date.now(),
                accountAgeHours,
                accountCreated: user.createdTimestamp,
                nameKeys: memberNameKeys({ username: user.username, globalName: user.globalName, displayName: member.displayName }),
            });

            // Join-rate spike -> lockdown. When it fires, this member was part of the burst and has been handled.
            if (settings.autoEnabled) {
                const verdict = await this.checkAutoLockdown(guild, settings, member.id);
                if (verdict !== undefined) return verdict;
            }

            if (settings.sameNameEnabled) {
                const verdict = await this.checkSameName(guild, config, settings, member.id);
                if (verdict) return verdict;
            }

            // Check for raid conditions
            if (raidOn) await this.checkRaidConditions(guild, config, member.id);
            return null;

        } catch (error) {
            logger.error('[RaidDetection] Error tracking join', {
                error: error.message,
                guildId: guild.id,
                userId: user.id
            });
            return null;
        }
    }

    /**
     * Auto-trigger: enough joins inside the window starts a join lockdown, which then acts on the burst.
     * @returns {Promise<'stop'|null|undefined>} undefined = did not fire (carry on with the other rules)
     */
    async checkAutoLockdown(guild, settings, currentUserId) {
        const joins = this.joinTracker.get(guild.id) || [];
        const now = Date.now();
        const hit = autoTrigger(joins, now, settings, this.lockdownCutoff.get(guild.id) || 0);
        if (!hit.fire) return undefined;
        this.lockdownCutoff.set(guild.id, now);
        const started = await startLockdown(guild, {
            trigger: 'auto',
            triggerDetail: `${hit.count} joins in ${settings.autoWindowSeconds}s (trigger: ${settings.autoJoins})`,
            burstUserIds: hit.userIds,
        });
        if (!started.ok) {
            // Already running (another join got there first): this member is that lockdown's business.
            if (started.row) {
                const member = guild.members.cache.get(currentUserId);
                const out = member ? await enforceLockdown(member, started.row) : null;
                return out?.stop ? 'stop' : null;
            }
            logger.error('[RaidDetection] auto-lockdown did not start', { guildId: guild.id, error: started.error });
            return undefined;
        }
        return STOPPING.has(started.burst.get(currentUserId)) ? 'stop' : null;
    }

    /**
     * Same-name flood: N or more recent joins whose names fold to the same text are acted on as a group.
     * @returns {Promise<'stop'|null>}
     */
    async checkSameName(guild, config, settings, currentUserId) {
        const joins = this.joinTracker.get(guild.id) || [];
        const groups = sameNameGroups(joins, Date.now(), settings);
        if (!groups.length) return null;
        let acted = this.sameNameActed.get(guild.id);
        if (!acted) { acted = new Map(); this.sameNameActed.set(guild.id, acted); }
        // Forget members acted on longer ago than the window: they are gone or were let back in.
        for (const [id, at] of acted) if (Date.now() - at > settings.sameNameWindowSeconds * 1000) acted.delete(id);
        const already = new Set(acted.keys());
        let mine = null;
        for (const group of groups) {
            const { results } = await actOnGroup(guild, config, group, already);
            for (const r of results) {
                acted.set(r.id, Date.now());
                if (r.id === currentUserId) mine = r.outcome;
            }
        }
        return STOPPING.has(mine) ? 'stop' : null;
    }

    /**
     * Add a join to the tracker (with max size enforcement)
     */
    addJoin(guildId, joinData) {
        if (!this.joinTracker.has(guildId)) {
            // Enforce max guilds tracked
            if (this.joinTracker.size >= this.MAX_GUILDS_TRACKED) {
                const oldestKey = this.joinTracker.keys().next().value;
                this.joinTracker.delete(oldestKey);
            }
            this.joinTracker.set(guildId, []);
        }
        const joins = this.joinTracker.get(guildId);
        joins.push(joinData);
        // Enforce max joins per guild
        if (joins.length > this.MAX_JOINS_PER_GUILD) {
            joins.shift();
        }
    }

    /**
     * Get recent joins within the configured timeframe
     */
    getRecentJoins(guildId, timeframeSec) {
        const joins = this.joinTracker.get(guildId) || [];
        const cutoff = Math.max(Date.now() - (timeframeSec * 1000), this.raidCutoff.get(guildId) || 0);
        return joins.filter(join => join.timestamp >= cutoff);
    }

    /**
     * Check if raid conditions are met
     */
    async checkRaidConditions(guild, config, joinedUserId = null) {
        // A raid in progress: this join is part of it and gets the raid's action now. (It used to be
        // added to the incident's list and left in the server.)
        const activeRaid = this.activeRaids.get(guild.id);
        if (joinedUserId && raidStillHot(activeRaid, Date.now(), config.join_timeframe_seconds)) {
            activeRaid.lastJoinAt = Date.now();
            if (!activeRaid.affectedUsers.includes(joinedUserId)) {
                activeRaid.affectedUsers.push(joinedUserId);
                await this.updateIncidentUsers(activeRaid.incidentId, activeRaid.affectedUsers);
                if (config.action !== 'alert' || config.purge_messages) {
                    const results = await this.executeRaidActions(guild, config, [joinedUserId]);
                    logger.info('[RaidDetection] Join during an active raid actioned', {
                        guildId: guild.id, userId: joinedUserId, action: config.action, results
                    });
                }
            }
            return;
        }

        const recentJoins = this.getRecentJoins(guild.id, config.join_timeframe_seconds);

        // Not enough joins to trigger
        if (recentJoins.length < config.join_threshold) return;

        // Calculate ratio of new accounts
        const newAccountCount = recentJoins.filter(
            join => join.accountAgeHours < config.new_account_age_hours
        ).length;
        const newAccountRatio = newAccountCount / recentJoins.length;

        // Check if ratio exceeds threshold
        if (newAccountRatio < config.new_account_ratio) return;

        // An older raid that has gone quiet stays open for its alert's buttons; a new spike is a new raid.
        // Trigger raid response
        await this.triggerRaidResponse(guild, config, recentJoins, newAccountCount);
    }

    /**
     * Trigger raid response actions
     */
    async triggerRaidResponse(guild, config, recentJoins, newAccountCount) {
        const affectedUserIds = recentJoins.map(j => j.userId);

        logger.warn('[RaidDetection] Raid detected!', {
            guildId: guild.id,
            joinCount: recentJoins.length,
            newAccountCount,
            affectedUsers: affectedUserIds
        });

        // Create incident record
        const incidentId = await this.createIncident(guild.id, recentJoins.length, newAccountCount, config.action, affectedUserIds);

        // Track active raid
        this.activeRaids.set(guild.id, {
            startTime: Date.now(),
            lastJoinAt: Date.now(),
            incidentId,
            affectedUsers: affectedUserIds,
            status: 'active'
        });

        // Execute actions on affected users
        const actionResults = await this.executeRaidActions(guild, config, affectedUserIds);

        // Send alert with action buttons
        await this.sendRaidAlert(guild, config, recentJoins, newAccountCount, incidentId, actionResults);

        // These joins were this raid's: they must not count towards another one. (Clearing the tracker
        // did that too, but also blinded the same-name and auto-lockdown rules.)
        this.raidCutoff.set(guild.id, Date.now());
    }

    /**
     * Execute raid response actions on affected users
     */
    async executeRaidActions(guild, config, userIds) {
        const results = {
            muted: 0,
            kicked: 0,
            banned: 0,
            purged: 0,
            failed: 0,
            held: 0
        };

        for (const userId of userIds) {
            try {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (!member) {
                    results.failed++;
                    continue;
                }

                // Skip guild owner
                if (member.id === guild.ownerId) continue;

                // Never act on the bot owner / super admin
                if (isProtectedFromBanCommands(member.id)) continue;

                // Unified allowlist / global pause: no purge and no action (core/protection-exempt.js logs it).
                if (config.action !== 'alert' || config.purge_messages) {
                    const doing = config.action === 'alert' ? 'purge' : ['mute', 'timeout'].includes(config.action) ? 'timeout' : config.action;
                    if (await protectionHold(member, doing, 'Raid detection')) {
                        results.held++;
                        continue;
                    }
                }

                // Purge messages if enabled
                if (config.purge_messages) {
                    const purged = await this.purgeUserMessages(guild, userId, RAID_PURGE_LIMIT);
                    results.purged += purged;
                }

                // The bot cannot do it (permission or role order): say exactly why instead of skipping
                // silently (core/manual-action.js, one alert per server per cause).
                const verb = { mute: 'timeout', lockdown: 'timeout', kick: 'kick', ban: 'ban' }[config.action];
                const cannot = verb ? whyCannot(guild, verb, { member }) : null;
                if (cannot) {
                    results.failed++;
                    await reportManualAction(guild, { action: verb, member, source: 'Raid detection', problem: cannot, count: userIds.length });
                    continue;
                }

                // Execute configured action
                switch (config.action) {
                    case 'timeout': // older value; same as mute (H-676)
                    case 'mute':
                        if (member.moderatable) {
                            const muteMinutes = raidMuteMinutes(config);
                            await member.timeout(
                                muteMinutes * 60 * 1000,
                                'Raid Detection: Suspicious join pattern'
                            );
                            results.muted++;
                            await this.logInfractionForRaid(guild, member.user, 'mute', muteMinutes);
                        }
                        break;

                    case 'kick':
                        if (member.kickable) {
                            await member.kick('Raid Detection: Suspicious join pattern');
                            results.kicked++;
                            await this.logInfractionForRaid(guild, member.user, 'kick');
                        }
                        break;

                    case 'ban':
                        if (member.bannable) {
                            await member.ban({
                                reason: 'Raid Detection: Suspicious join pattern',
                                deleteMessageSeconds: 86400
                            });
                            results.banned++;
                            await this.logInfractionForRaid(guild, member.user, 'ban');
                        }
                        break;

                    case 'lockdown':
                        // Retired choice (H-660): it never started a lockdown, only timed the raiders out like
                        // 'mute', so migration 447 moved its rows to 'mute' and neither /protection nor the
                        // dashboard offers it. Kept so a stray row still acts. (There is no
                        // lockdown_duration_minutes column — reading it gave NaN and every timeout threw.)
                        if (member.moderatable) {
                            const lockdownMinutes = raidMuteMinutes(config);
                            await member.timeout(
                                lockdownMinutes * 60 * 1000,
                                'Raid Detection: Server lockdown'
                            );
                            results.muted++;
                            await this.logInfractionForRaid(guild, member.user, 'lockdown', lockdownMinutes);
                        }
                        break;

                    case 'alert':
                        // Alert only, no action on users
                        break;
                }

            } catch (error) {
                logger.error('[RaidDetection] Error executing action on user', {
                    error: error.message,
                    userId,
                    guildId: guild.id
                });
                results.failed++;
                const verb = { mute: 'timeout', lockdown: 'timeout', kick: 'kick', ban: 'ban' }[config.action];
                const cause = verb ? whyFailed(error, guild, verb, { member: guild.members.cache.get(userId) ?? null }) : null;
                if (cause) await reportManualAction(guild, { action: verb, userId, source: 'Raid detection', problem: cause, count: userIds.length });
            }
        }

        return results;
    }

    /**
     * Purge recent messages from a user across all channels
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
                        Date.now() - m.createdTimestamp < 86400000 // Within 24 hours
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
            logger.error('[RaidDetection] Error purging messages', {
                error: error.message,
                userId,
                guildId: guild.id
            });
        }

        return totalPurged;
    }

    /**
     * Log an infraction for raid-related actions
     */
    async logInfractionForRaid(guild, user, actionType, durationMinutes = null) {
        try {
            const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000) : null;

            await pool.execute(
                `INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at)
                 VALUES (?, ?, ?, 'RaidDetection', ?, ?, ?)`,
                [
                    guild.id,
                    user.id,
                    this.client.user.id,
                    `Automatic raid detection: ${actionType}`,
                    durationMinutes,
                    expiresAt
                ]
            );

            // Trigger escalation check
            const { checkEscalations } = await import('./escalation-manager.js');
            await checkEscalations(guild, user);

        } catch (error) {
            logger.error('[RaidDetection] Error logging infraction', {
                error: error.message,
                userId: user.id
            });
        }
    }

    /**
     * Create a raid incident record
     */
    async createIncident(guildId, joinCount, newAccountCount, actionTaken, affectedUserIds = []) {
        try {
            const [result] = await pool.execute(
                `INSERT INTO raid_incidents (guild_id, join_count, new_account_count, action_taken, affected_users)
                 VALUES (?, ?, ?, ?, ?)`,
                [guildId, joinCount, newAccountCount, actionTaken, JSON.stringify(affectedUserIds)]
            );
            return result.insertId;
        } catch (error) {
            logger.error('[RaidDetection] Error creating incident', { error: error.message, guildId });
            return null;
        }
    }

    /**
     * The users a raid alert's buttons act on: the in-memory list while the raid is active, otherwise
     * the list saved on raid_incidents.affected_users (a restart empties activeRaids, which used to
     * leave every alert's Kick All / Ban All / False Positive answering "No active raid found").
     * @returns {Promise<string[]|null>} null when there is no unresolved incident to act on
     */
    async getIncidentUsers(guildId, incidentId) {
        const activeRaid = this.activeRaids.get(guildId);
        if (activeRaid && String(activeRaid.incidentId) === String(incidentId)) {
            return activeRaid.affectedUsers;
        }

        try {
            const [rows] = await pool.execute(
                'SELECT affected_users FROM raid_incidents WHERE id = ? AND guild_id = ? AND resolved_at IS NULL',
                [incidentId, guildId]
            );
            if (rows.length === 0) return activeRaid ? activeRaid.affectedUsers : null;
            const ids = JSON.parse(rows[0].affected_users || '[]');
            return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
        } catch (error) {
            logger.error('[RaidDetection] Error loading incident users', { error: error.message, guildId, incidentId });
            return activeRaid ? activeRaid.affectedUsers : null;
        }
    }

    /**
     * Forget the in-memory raid once its incident is handled — but only if the button belongs to it,
     * so acting on an older alert does not end a newer raid that is still in progress.
     */
    clearActiveRaid(guildId, incidentId) {
        const activeRaid = this.activeRaids.get(guildId);
        if (activeRaid && String(activeRaid.incidentId) === String(incidentId)) {
            this.activeRaids.delete(guildId);
        }
    }

    /**
     * Keep raid_incidents.affected_users in step with users who join while the raid is active.
     */
    async updateIncidentUsers(incidentId, affectedUserIds) {
        if (!incidentId) return;
        try {
            await pool.execute(
                'UPDATE raid_incidents SET affected_users = ? WHERE id = ?',
                [JSON.stringify(affectedUserIds), incidentId]
            );
        } catch (error) {
            logger.error('[RaidDetection] Error updating incident affected users', { error: error.message, incidentId });
        }
    }

    /**
     * Send raid alert with action buttons
     */
    async sendRaidAlert(guild, config, recentJoins, newAccountCount, incidentId, actionResults) {
        if (!config.alert_channel_id) return;

        const channel = await guild.channels.fetch(config.alert_channel_id).catch(() => null);
        if (!channel) return;

        const actionDescriptions = {
            'alert': 'Alert Only (No automatic action)',
            'mute': `Muted ${actionResults.muted} users`,
            'kick': `Kicked ${actionResults.kicked} users`,
            'ban': `Banned ${actionResults.banned} users`,
            'lockdown': `Lockdown: Muted ${actionResults.muted} users`
        };

        // List affected users (limit to first 10)
        const affectedList = recentJoins
            .slice(0, 10)
            .map(j => {
                const ageStr = j.accountAgeHours < 1
                    ? `${Math.round(j.accountAgeHours * 60)}m`
                    : j.accountAgeHours < 24
                        ? `${Math.round(j.accountAgeHours)}h`
                        : `${Math.round(j.accountAgeHours / 24)}d`;
                return `<@${j.userId}> (Account: ${ageStr} old)`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setColor(themeColor(guild?.id, 'danger'))
            .setTitle('🚨 RAID DETECTED')
            .setDescription(`A coordinated join raid has been detected and automatic actions have been taken.`)
            .addFields(
                { name: 'Joins Detected', value: `${recentJoins.length}`, inline: true },
                { name: 'New Accounts', value: `${newAccountCount} (${Math.round(newAccountCount / recentJoins.length * 100)}%)`, inline: true },
                { name: 'Timeframe', value: `${config.join_timeframe_seconds}s`, inline: true },
                { name: 'Action Taken', value: actionDescriptions[config.action] || config.action, inline: false },
                { name: 'Messages Purged', value: `${actionResults.purged}`, inline: true },
                { name: 'Failed Actions', value: `${actionResults.failed}`, inline: true },
                ...(actionResults.held ? [{ name: 'Held (exempt or paused)', value: `${actionResults.held}`, inline: true }] : []),
                { name: 'Affected Users', value: affectedList || 'None', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Incident ID: ${incidentId} | Raid Detection System` });

        if (recentJoins.length > 10) {
            embed.addFields({
                name: '\u200b',
                value: `*...and ${recentJoins.length - 10} more users*`
            });
        }

        // Create action buttons
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`raid_kick_all_${incidentId}`)
                    .setLabel('Kick All')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('👢'),
                new ButtonBuilder()
                    .setCustomId(`raid_ban_all_${incidentId}`)
                    .setLabel('Ban All')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔨'),
                new ButtonBuilder()
                    .setCustomId(`raid_false_positive_${incidentId}`)
                    .setLabel('False Positive')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('↩️'),
                new ButtonBuilder()
                    .setCustomId(`raid_resolve_${incidentId}`)
                    .setLabel('Resolve')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅')
            );

        await channel.send({ embeds: [embed], components: [buttons] }).catch(err =>
            logger.error('[RaidDetection] Error sending alert', { error: err.message })
        );
    }

    /**
     * Handle button interactions for raid alerts
     */
    async handleButtonInteraction(interaction) {
        const [action, ...rest] = interaction.customId.split('_').slice(1);
        const incidentId = rest.pop();

        // Check permissions
        if (!interaction.member.permissions.has('ModerateMembers')) {
            return interaction.reply({
                content: 'You need the Moderate Members permission to use these controls.',
                ephemeral: true
            });
        }

        const activeRaid = this.activeRaids.get(interaction.guild.id);

        switch (action) {
            case 'kick':
                await this.escalateRaidAction(interaction, incidentId, 'kick');
                break;

            case 'ban':
                await this.escalateRaidAction(interaction, incidentId, 'ban');
                break;

            case 'false':
                await this.handleFalsePositive(interaction, incidentId);
                break;

            case 'resolve':
                await this.resolveRaid(interaction, incidentId);
                break;
        }
    }

    /**
     * Escalate raid action to kick/ban all affected users
     */
    async escalateRaidAction(interaction, incidentId, actionType) {
        await interaction.deferReply({ ephemeral: true });

        const affectedUsers = await this.getIncidentUsers(interaction.guild.id, incidentId);
        if (!affectedUsers) {
            return interaction.editReply('No active raid found for this server.');
        }

        let count = 0;
        for (const userId of affectedUsers) {
            try {
                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                if (!member || member.id === interaction.guild.ownerId) continue;
                if (isProtectedFromBanCommands(member.id)) continue;

                if (actionType === 'kick' && member.kickable) {
                    await member.kick(`Raid escalation by ${interaction.user.tag}`);
                    count++;
                } else if (actionType === 'ban' && member.bannable) {
                    await member.ban({
                        reason: `Raid escalation by ${interaction.user.tag}`,
                        deleteMessageSeconds: 86400
                    });
                    count++;
                }
            } catch {
                // Continue with next user
            }
        }

        // Update incident
        await pool.execute(
            `UPDATE raid_incidents SET action_taken = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
            [`Escalated to ${actionType}: ${count} users`, interaction.user.id, incidentId]
        );

        // Update embed
        const message = interaction.message;
        const embed = EmbedBuilder.from(message.embeds[0])
            .setColor(themeColor(interaction.guildId, 'success'))
            .addFields({ name: 'Escalated Action', value: `${actionType.toUpperCase()}: ${count} users by ${interaction.user.tag}` });

        await message.edit({ embeds: [embed], components: [] });
        await interaction.editReply(`Successfully ${actionType}ed ${count} users.`);

        // Clear active raid
        this.clearActiveRaid(interaction.guild.id, incidentId);
    }

    /**
     * Handle false positive - unmute all affected users
     */
    async handleFalsePositive(interaction, incidentId) {
        await interaction.deferReply({ ephemeral: true });

        const affectedUsers = await this.getIncidentUsers(interaction.guild.id, incidentId);
        if (!affectedUsers) {
            return interaction.editReply('No active raid found for this server.');
        }

        let count = 0;
        for (const userId of affectedUsers) {
            try {
                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                if (!member) continue;

                // Remove timeout
                if (member.communicationDisabledUntil) {
                    await member.timeout(null, `False positive - cleared by ${interaction.user.tag}`);
                    count++;
                }
            } catch {
                // Continue with next user
            }
        }

        // Update incident
        await pool.execute(
            `UPDATE raid_incidents SET action_taken = 'False Positive', notes = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
            [`Marked as false positive by ${interaction.user.tag}. Unmuted ${count} users.`, interaction.user.id, incidentId]
        );

        // Update embed
        const message = interaction.message;
        const embed = EmbedBuilder.from(message.embeds[0])
            .setColor(0xffff00)
            .setTitle('⚠️ RAID - FALSE POSITIVE')
            .addFields({ name: 'Resolution', value: `Marked as false positive by ${interaction.user.tag}. Unmuted ${count} users.` });

        await message.edit({ embeds: [embed], components: [] });
        await interaction.editReply(`Marked as false positive. Unmuted ${count} users.`);

        // Clear active raid
        this.clearActiveRaid(interaction.guild.id, incidentId);
    }

    /**
     * Resolve the raid incident
     */
    async resolveRaid(interaction, incidentId) {
        await interaction.deferReply({ ephemeral: true });

        // Update incident
        await pool.execute(
            `UPDATE raid_incidents SET resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
            [interaction.user.id, incidentId]
        );

        // Update embed
        const message = interaction.message;
        const embed = EmbedBuilder.from(message.embeds[0])
            .setColor(themeColor(interaction.guildId, 'success'))
            .addFields({ name: 'Resolved', value: `Incident resolved by ${interaction.user.tag}` });

        await message.edit({ embeds: [embed], components: [] });
        await interaction.editReply('Raid incident marked as resolved.');

        // Clear active raid
        this.clearActiveRaid(interaction.guild.id, incidentId);
    }

    /**
     * Clean up old join entries
     */
    cleanupOldJoins() {
        const maxAge = 10 * 60 * 1000; // 10 minutes: the longest same-name window
        const now = Date.now();

        for (const [guildId, joins] of this.joinTracker.entries()) {
            const filtered = joins.filter(join => now - join.timestamp < maxAge);
            if (filtered.length === 0) {
                this.joinTracker.delete(guildId);
            } else {
                this.joinTracker.set(guildId, filtered);
            }
        }
    }

    /**
     * Get raid detection configuration (cached - 60s TTL)
     */
    async getConfig(guildId) {
        try {
            return await configCache.get('raid_detection_config', guildId, async () => {
                const [rows] = await pool.execute(
                    `SELECT * FROM raid_detection_config WHERE guild_id = ?`,
                    [guildId]
                );
                return rows.length > 0 ? rows[0] : null;
            });
        } catch (error) {
            logger.error('[RaidDetection] Error fetching config', { error: error.message, guildId });
            return null;
        }
    }

    /**
     * Check if raid detection is enabled for a guild
     */
    async isEnabled(guildId) {
        const config = await this.getConfig(guildId);
        return config?.enabled ?? false;
    }

    /**
     * Get raid incident history
     */
    async getIncidentHistory(guildId, limit = 10) {
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM raid_incidents WHERE guild_id = ? ORDER BY detected_at DESC LIMIT ?`,
                [guildId, limit]
            );
            return rows;
        } catch (error) {
            logger.error('[RaidDetection] Error fetching incident history', { error: error.message });
            return [];
        }
    }
}

export default RaidDetectionManager;
