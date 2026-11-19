import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import configCache from '../utils/configCache.js';
import { isWhitelisted } from '../utils/automod-whitelist.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import { themeColor } from './guild-theme.js';
import { CrossChannelTracker, attachmentKey } from './spam-similarity.js';
import { isTicketChannel } from './ticket-channels.js';
import { protectionHold } from './protection-exempt.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';

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
        // Near-duplicate cross-channel clustering, bounded per user and pruned on the window.
        this.crossChannel = new CrossChannelTracker();
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
        this.crossChannel.users.clear();
        this.patternHits.clear();
        logger.info('[AdaptiveSpam] Manager stopped and cleaned up');
    }

    /**
     * Analyze a message for spam indicators
     * This runs AFTER regular automod and provides secondary analysis
     * @param {Message} message - The message to analyze
     * @returns {boolean} - Whether spam was detected
     */
    /**
     * Is this channel a support ticket?
     *
     * Checked three ways because a ticket can be any of them: a row in `tickets`, a channel sitting
     * under the guild's configured ticket category, or a thread whose parent is that category. A
     * name check alone would miss a renamed ticket and catch a channel merely called "support".
     */
    async isTicketChannel(channel) {
        return isTicketChannel(channel);
    }

    async analyzeMessage(message) {
        const { guild, author, channel, member } = message;

        // Skip spam detection for admins, guild owners, and whitelisted users
        if (member) {
            const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = member.id === guild.ownerId;
            if (isAdmin || isOwner) return false;
        }
        if (await isWhitelisted(guild.id, author.id)) return false;

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

            // A support ticket is never spam.
            //
            // A ticket is a private channel between one member and staff, opened BY that member to
            // describe a problem. Long messages, repeated detail and follow-ups are the whole point
            // of one — and every static exemption list is useless here, because ticket channels are
            // created on demand and cannot be listed in advance.
            //
            // This is not hypothetical: a user answering their own open ticket with
            // "Putting manually the dll file does have work, the server don't automatically close
            // and do not require steam running thanks" had it deleted and was muted for spam.
            if (await isTicketChannel(channel)) return false;

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

            // Track for cross-channel spam. The returned cluster feeds the score directly — it used
            // to be re-derived from this.messageHashes, which near-duplicate grouping no longer fills.
            //
            // Wordless posts fall back to an attachment fingerprint (see attachmentKey) instead of
            // being skipped, and are always grouped EXACTLY. They must never go through the
            // near-duplicate path: with no text, normalisation leaves nothing to compare, so every
            // image-only post would look like every other one.
            const attachmentHash = messageHash ? null : this.attachmentKey(message);
            const duplicateKey = messageHash || attachmentHash;
            const cluster = duplicateKey
                ? await this.trackCrossChannelSpam(
                    guild.id, author.id, duplicateKey, channel.id, message.content,
                    { exact: Boolean(attachmentHash), preview: attachmentHash ? this.attachmentPreview(message) : null }
                  )
                : { channels: [channel.id], count: 1, similarity: 0, matches: 0 };

            // Get user's spam profile
            const profile = await this.getOrCreateProfile(guild.id, author.id);

            // A wide spread is decisive on its own.
            //
            // Deliberately placed AFTER getOrCreateProfile: triggerSpamAction updates spam_profiles and
            // logs an infraction against that row, so acting first would update nothing and drop the
            // violation from the member's history.
            //
            // The cluster otherwise only contributes `min(40, channels * 10)` to a score that needs
            // `action_threshold` (80) to act, so a 4-channel spread and a 10-channel spread are
            // worth exactly the same and neither is enough by itself. That cap is why every one of
            // the 89 cross_channel_spam rows ever recorded carried action_taken = NULL, including a
            // member who posted the same four images into ten channels in twenty-three seconds.
            //
            // The floor keeps "acted" from ever meaning less than "flagged": a guild can tighten
            // decisive_channel_count but never set it below the threshold at which a human is
            // already being alerted. The default of 6 is well clear of ordinary behaviour — sharing
            // something in two or three channels is normal, six inside the window is not.
            const decisiveSpread = Math.max(
                config.cross_channel_threshold || 3,
                config.decisive_channel_count || 6
            );
            if (cluster.count >= decisiveSpread) {
                logger.warn('[AdaptiveSpam] decisive cross-channel spread', {
                    guildId: guild.id, userId: author.id, channels: cluster.count, decisiveSpread,
                    keyedOn: attachmentHash ? 'attachments' : 'text',
                });
                await this.triggerSpamAction(message, config, 100);
                await this.recordCrossChannelAction(guild.id, author.id, duplicateKey, config.action || 'mute');
                return true;
            }


            // Calculate spam score based ONLY on current message window (not cumulative)
            const spamScore = await this.calculateSpamScore(guild, author, config, profile, filtered, cluster);

            // Update profile score — use the CURRENT window score, not cumulative
            // Decay the stored score aggressively (10 pts/min) then take the MAX of decayed vs current
            const timeSinceLastMsg = filtered.length > 1
                ? now - filtered[filtered.length - 2].timestamp
                : 60000;
            const decayMinutes = Math.floor(timeSinceLastMsg / 60000);
            const decayedStored = Math.max(0, profile.spam_score - (decayMinutes * 10));
            const newScore = Math.max(decayedStored, spamScore);

            if (newScore !== profile.spam_score) {
                await this.updateProfile(guild.id, author.id, { spam_score: newScore });
            }

            // Action threshold — only trigger on genuinely high scores
            const actionThreshold = config.action_threshold || 80;
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

    /** @see attachmentKey in core/spam-similarity.js — pure, and unit-tested there. */
    attachmentKey(message) {
        return attachmentKey(message.attachments.values());
    }

    /**
     * Hash message content for comparison
     */
    hashMessage(content) {
        // Normalize: lowercase, remove extra whitespace, remove URLs
        const normalized = String(content ?? '')
            .toLowerCase()
            .replace(/https?:\/\/\S+/g, '[URL]')
            .replace(/\s+/g, ' ')
            .trim();

        // An empty message has no content to be duplicated.
        //
        // Every image-only, sticker-only or embed-only post normalises to '' and therefore to the
        // SHA-256 of the empty string — `e3b0c442…`. The cross-channel tracker then sees one member
        // posting "identical content" in every channel they shared a picture in, and flags them.
        // The recorded rows show exactly that: hash e3b0c442, preview "", four channels.
        //
        // Null means "nothing to compare", and callers skip duplicate tracking rather than bucket
        // every wordless message together.
        if (!normalized) return null;

        return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
    }

    /** Human-readable stand-in for the empty content of an image-only post, for the evidence row. */
    attachmentPreview(message) {
        const names = [...message.attachments.values()].map(a => a.name || 'file').slice(0, 4);
        return `[${message.attachments.size} attachment(s): ${names.join(', ')}]`.substring(0, 100);
    }

    /**
     * Track cross-channel spam
     */
    async trackCrossChannelSpam(guildId, userId, hash, channelId, content, options = {}) {
        // Grouped by NEAR-duplicate, not by exact hash. The old bucketing keyed on a SHA-256 of the
        // message (URLs normalised), so a spammer who added an emoji, tagged a role or swapped one
        // word put every copy in its own bucket and nothing ever looked repeated. See
        // core/spam-similarity.js for why containment beats Jaccard on these short messages.
        const config = await this.getConfig(guildId);
        const timeframeMs = (config?.cross_channel_timeframe_minutes || 5) * 60 * 1000;
        const threshold = config?.cross_channel_threshold || 3;

        // Opt-in per guild. Near-duplicate grouping fires more often than exact-hash grouping by
        // design, and most guilds run a threshold of 3, so switching them over without being asked
        // would raise enforcement in servers that never requested it.
        //
        // options.exact forces the exact path regardless of the guild setting. Attachment-keyed
        // posts have no text, so the near-duplicate comparison has nothing to work with and would
        // group every image-only post together — the precise false positive that made wordless
        // posts get skipped in the first place.
        if (options.exact || !config?.near_duplicate_matching) {
            return this.trackCrossChannelExact(guildId, userId, hash, channelId, content, config, threshold, timeframeMs, options);
        }

        if (this.crossChannel.windowMs !== timeframeMs) this.crossChannel.windowMs = timeframeMs;
        const cluster = this.crossChannel.add(guildId, userId, channelId, content);
        if (cluster.count < threshold) return cluster;

        await this.logCrossChannelSpam(guildId, userId, hash, {
            channels: new Set(cluster.channels),
            preview: String(content || '').substring(0, 100)
        });
        logger.info(`[AdaptiveSpam] cross-channel cluster: ${userId} posted near-identical content in ${cluster.count} channels (similarity ${cluster.similarity.toFixed(2)})`, {
            guildId, userId, channels: cluster.count, similarity: cluster.similarity
        });
        return cluster;
    }

    /**
     * Original exact-hash grouping — the default until a guild opts into near-duplicate matching.
     * Only groups byte-identical messages (URLs normalised), so a spammer who varies a single word
     * defeats it; kept as-is so unopted guilds see no behaviour change.
     */
    async trackCrossChannelExact(guildId, userId, hash, channelId, content, config, threshold, timeframeMs, options = {}) {
        // Keyed per USER, not per guild+hash. The bucket used to be shared across everyone in the
        // guild while recording only the first poster's id, so two members happening to post the
        // same thing in two channels merged into one 2-channel "cluster" credited to whoever
        // arrived second. Cross-posting is a property of one account's behaviour; the near-
        // duplicate tracker has always keyed it `guild:user` and this now matches.
        const key = `${guildId}_${userId}_${hash}`;
        if (!this.messageHashes.has(key)) {
            if (this.messageHashes.size >= this.MAX_MESSAGE_HASHES) {
                this.messageHashes.delete(this.messageHashes.keys().next().value);
            }
            this.messageHashes.set(key, {
                userId,
                channels: new Set([channelId]),
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                preview: options.preview || String(content || '').substring(0, 100)
            });
            return { channels: [channelId], count: 1, similarity: 0, matches: 0 };
        }
        const entry = this.messageHashes.get(key);
        entry.channels.add(channelId);
        entry.lastSeen = Date.now();
        if (entry.channels.size >= threshold && entry.lastSeen - entry.firstSeen <= timeframeMs) {
            await this.logCrossChannelSpam(guildId, userId, hash, entry);
        }
        return { channels: [...entry.channels], count: entry.channels.size, similarity: 1, matches: entry.channels.size - 1 };
    }

    /**
     * Note on the evidence row what was actually done about it. Nothing ever wrote this column, so
     * cross_channel_spam read as 89 flags and zero consequences — indistinguishable from a detector
     * that had never fired.
     */
    async recordCrossChannelAction(guildId, userId, hash, action) {
        try {
            await pool.execute(
                `UPDATE cross_channel_spam SET action_taken = ?
                 WHERE guild_id = ? AND user_id = ? AND message_hash = ?`,
                [action, guildId, userId, hash]
            );
        } catch (error) {
            logger.error('[AdaptiveSpam] Error recording cross-channel action', { error: error.message });
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
    async calculateSpamScore(guild, author, config, profile, recentMessages, cluster = null) {
        let score = 0;

        // Count repeated message hashes (same/similar content).
        //
        // Wordless messages carry a null hash and are skipped: an image-only post has no content to
        // repeat, and bucketing them together made somebody who shared five pictures look like
        // somebody who sent the same sentence five times.
        const repeatedHashes = {};
        const lengthByHash = {};
        for (const msg of recentMessages) {
            if (!msg.hash) continue;
            repeatedHashes[msg.hash] = (repeatedHashes[msg.hash] || 0) + 1;
            lengthByHash[msg.hash] = Math.max(lengthByHash[msg.hash] ?? 0, msg.length ?? 0);
        }

        // 1. Repeated identical/similar messages.
        //
        // The length guard is the one this comment always claimed and the code never had: "only flag
        // if the message is non-trivial (>5 chars)". Without it, five "ok"s or "thanks" in an hour —
        // ordinary conversation, and especially ordinary in a support exchange — scored 40 points
        // toward a mute.
        const TRIVIAL_LENGTH = 5;
        for (const [hash, count] of Object.entries(repeatedHashes)) {
            if (count >= 5 && (lengthByHash[hash] ?? 0) > TRIVIAL_LENGTH) {
                score += Math.min(40, (count - 4) * 10);
            }
        }

        // 2. Cross-channel spam — the same message, or a lightly-edited copy of it, in several
        // channels. Read straight off the near-duplicate cluster for THIS message rather than
        // looking up exact hashes, which no longer groups anything a real spammer sends.
        const threshold = config.cross_channel_threshold || 3;
        if (cluster && cluster.count >= threshold) {
            score += Math.min(40, cluster.count * 10);
        }

        // 3. Apply new account multiplier (capped)
        const accountAgeHours = (Date.now() - author.createdTimestamp) / (1000 * 60 * 60);
        if (accountAgeHours < 24) {
            score *= Math.min(config.new_account_multiplier_24h || 2.0, 2.0);
        } else if (accountAgeHours < 168) {
            score *= Math.min(config.new_account_multiplier_7d || 1.5, 1.5);
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

        // Unified allowlist / global pause: detected and alerted, but no infraction and no action.
        const holdAs = { mute: 'timeout', kick: 'kick', ban: 'ban', 'delete+warn': 'warn' }[config.action];
        const held = member && holdAs
            ? await protectionHold(member, holdAs, 'Adaptive spam')
            : null;

        // Log infraction
        if (!held) await this.logInfractionForSpam(guild, author, config.action);

        // Execute action
        const verb = { mute: 'timeout', kick: 'kick', ban: 'ban' }[config.action];
        const cannot = member && verb && !held ? whyCannot(guild, verb, { member }) : null;
        if (cannot && member.id !== guild.ownerId && !isProtectedFromBanCommands(member.id)) {
            // The bot cannot do it: say exactly why (core/manual-action.js) rather than skip silently.
            await reportManualAction(guild, { action: verb, member, source: 'Adaptive spam detection', problem: cannot });
        } else if (member && !held && member.id !== guild.ownerId && !isProtectedFromBanCommands(member.id)) {
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

                    case 'delete+warn':
                        await this.deleteAndWarn(message);
                        break;
                }
            } catch (error) {
                logger.error('[AdaptiveSpam] Error executing action', { error: error.message });
                const cause = verb ? whyFailed(error, guild, verb, { member }) : null;
                if (cause) await reportManualAction(guild, { action: verb, member, source: 'Adaptive spam detection', problem: cause });
            }
        }

        // Optional per-deployment hook, set by whoever constructed this manager. AuditBot uses it to
        // file the spammer into the global ban tracker. It is undefined on every other client, so no
        // other guild's behaviour changes — and a throw in here must never swallow the alert below.
        if (!held && typeof this.onSpamConfirmed === 'function') {
            try {
                await this.onSpamConfirmed(message, config, spamScore);
            } catch (error) {
                logger.error('[AdaptiveSpam] onSpamConfirmed hook failed', {
                    error: error.message, guildId: guild.id, userId: author.id
                });
            }
        }

        // Send alert
        await this.sendSpamAlert(guild, config, author, spamScore);
    }

    /**
     * 'delete+warn' (H-716): delete the spam message, then send the member the server's warning DM, the same one
     * /admin mod warn sends. The warning is recorded like the other actions, by logInfractionForSpam above.
     * @returns {Promise<{ deleted: boolean, warned: boolean }>}
     */
    async deleteAndWarn(message) {
        const { guild, author } = message;
        const deleted = await Promise.resolve()
            .then(() => message.delete())
            .then(() => true)
            .catch((error) => {
                logger.warn('[AdaptiveSpam] Could not delete the spam message', { guildId: guild.id, userId: author.id, error: error.message });
                return false;
            });
        const { sendModerationDm } = await import('./moderation-manager.js');
        const dm = await sendModerationDm(guild, author, 'warn', {
            reason: 'Adaptive spam detection: your message was removed as spam.',
            moderator: this.client.user,
        });
        return { deleted, warned: !!dm?.sent };
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
            .setColor(themeColor(guild?.id, 'warning'))
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

        // Near-duplicate clusters age out on their own window; this drops users who have gone quiet
        // so the map does not hold every member who ever spoke.
        this.crossChannel.prune(now);
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
     * Get pattern effectiveness rankings
     */
    async getPatternEffectiveness(guildId, limit = 10) {
        try {
            const [rows] = await pool.execute(
                `SELECT s.*, p.pattern, p.pattern_type
                 FROM spam_patterns_stats s
                 JOIN automod_patterns p ON s.pattern_id = p.id AND p.target = 'message'
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
