import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import configCache from '../utils/configCache.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import {
    REPORT_PATTERNS,
    EVIDENCE_POST_PATTERNS,
    EVIDENCE_CHANNEL_PATTERNS,
    USER_ID_REGEX
} from '../utils/report-patterns.js';
import { isWhitelisted } from '../utils/automod-whitelist.js';
import { extractImageText } from './scam-image-ocr.js';
import { scoreScamText } from './scam-text-classifier.js';

/**
 * Phishing Detection Manager - Checks messages against known phishing domains
 * Maintains an in-memory Set of domains for O(1) lookups on every message.
 * Domain list is synced from community GitHub lists every 4 hours.
 */
// Domains that must never be flagged as phishing, even if present in community lists
const SAFE_DOMAINS = new Set([
    'discord.com',
    'discordapp.com',
    'cdn.discordapp.com',
    'cdn.discord.com',
    'media.discordapp.net',
    'images-ext-1.discordapp.net',
    'images-ext-2.discordapp.net',
    'discord.gg',
    'discord.media',
    'discordstatus.com',
    'twitch.tv',
    'kick.com',
    'youtube.com',
    'youtu.be',
    'twitter.com',
    'x.com',
    'steamcommunity.com',
    'store.steampowered.com',
    'github.com',
    'tenor.com',
    'giphy.com',
    'imgur.com',
]);

class PhishingDetectionManager {
    constructor(client) {
        this.client = client;
        this.domainSet = new Set();
    }

    /**
     * Load all known phishing domains from DB into the in-memory Set.
     * Excludes SAFE_DOMAINS to prevent false positives from community lists.
     */
    async loadDomains() {
        try {
            const [rows] = await pool.execute('SELECT domain FROM phishing_domains');
            this.domainSet.clear();
            let skipped = 0;
            for (const row of rows) {
                const domain = row.domain.toLowerCase();
                if (SAFE_DOMAINS.has(domain)) {
                    skipped++;
                    continue;
                }
                this.domainSet.add(domain);
            }
            logger.info(`[PhishingDetection] Loaded ${this.domainSet.size} domains into memory${skipped ? ` (skipped ${skipped} safe domains)` : ''}`);
        } catch (error) {
            logger.error('[PhishingDetection] Failed to load domains', { error: error.message });
        }
    }

    /**
     * Get guild config from cache
     */
    async getConfig(guildId) {
        return configCache.get('phishing_config', guildId, async () => {
            const [rows] = await pool.execute(
                'SELECT * FROM phishing_config WHERE guild_id = ? AND enabled = 1',
                [guildId]
            );
            return rows[0] || null;
        });
    }

    /**
     * Extract unique domains from message content
     * @param {string} content - Message content
     * @returns {Array<{domain: string, url: string}>} Extracted domains with their full URLs
     */
    extractDomains(content) {
        const urlRegex = /https?:\/\/[^\s<>]+/gi;
        const matches = content.match(urlRegex);
        if (!matches) return [];

        const seen = new Set();
        const results = [];

        for (const rawUrl of matches) {
            try {
                const url = new URL(rawUrl);
                let domain = url.hostname.toLowerCase();
                if (domain.startsWith('www.')) {
                    domain = domain.slice(4);
                }
                if (!seen.has(domain)) {
                    seen.add(domain);
                    results.push({ domain, url: rawUrl });
                }
            } catch {
                // Malformed URL — skip
            }
        }

        return results;
    }

    /**
     * Check if a domain is whitelisted for the guild
     */
    isWhitelisted(domain, config) {
        if (!config.whitelist_domains) return false;

        let whitelist;
        try {
            whitelist = JSON.parse(config.whitelist_domains);
        } catch {
            return false;
        }

        if (!Array.isArray(whitelist)) return false;

        return whitelist.some(safe => {
            const safeLower = safe.toLowerCase();
            return domain === safeLower || domain.endsWith('.' + safeLower);
        });
    }

    /**
     * Check if a channel is exempt from phishing detection.
     * Layer 1: explicit exempt list OR channel name pattern match.
     */
    isExemptChannel(channel, config) {
        if (config.exempt_channels) {
            try {
                const exemptList = JSON.parse(config.exempt_channels);
                if (Array.isArray(exemptList) && exemptList.includes(channel.id)) {
                    return true;
                }
            } catch {
                // Malformed JSON — skip
            }
        }

        const name = channel.name?.toLowerCase() || '';
        return EVIDENCE_CHANNEL_PATTERNS.some(pattern => name.includes(pattern));
    }

    /**
     * Check if a message looks like someone reporting/sharing evidence
     * rather than posting a scam. Layer 2 heuristic.
     * Returns true if ANY evidence signal matches (boolean, not scored).
     */
    looksLikeEvidencePost(message) {
        const content = message.content || '';

        if (EVIDENCE_POST_PATTERNS.some(p => p.test(content))) return true;
        if (REPORT_PATTERNS.some(p => p.test(content))) return true;

        const hasUserId = USER_ID_REGEX.test(content);
        const hasImages = message.attachments.some(a => a.contentType?.startsWith('image/'));
        if (hasUserId && hasImages) return true;

        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isMod = message.member.permissions.has(PermissionFlagsBits.ModerateMembers);
            if (isAdmin || isMod) return true;
        }

        return false;
    }

    /**
     * Forward a suspected evidence post to the report channel and alert mods.
     * Deletes from original channel (still contains phishing link).
     */
    async forwardEvidencePost(message, matchedDomain, matchedUrl, config) {
        const { guild, author, channel } = message;

        const attachmentUrls = message.attachments.map(a => a.url);
        const originalContent = message.content || '(no text content)';

        try {
            await message.delete();
        } catch (error) {
            logger.error('[PhishingDetection] Failed to delete evidence post', { error: error.message });
        }

        if (config.report_channel_id) {
            try {
                const reportChannel = guild.channels.cache.get(config.report_channel_id);
                if (reportChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xF39C12)
                        .setTitle('Possible Evidence Post Redirected')
                        .setDescription(
                            'This message was removed from its original channel because it contained a known phishing domain, ' +
                            'but it appears to be an evidence/report post. No action was taken against the user.'
                        )
                        .addFields(
                            { name: 'Author', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Original Channel', value: `${channel}`, inline: true },
                            { name: 'Phishing Domain Found', value: `\`${matchedDomain}\``, inline: true },
                            { name: 'Original Message', value: originalContent.length > 1024 ? originalContent.substring(0, 1021) + '...' : originalContent, inline: false }
                        )
                        .setFooter({ text: `User ID: ${author.id} | Use this channel for evidence posts` })
                        .setTimestamp();

                    if (attachmentUrls.length > 0) {
                        embed.addFields({
                            name: 'Attachments',
                            value: attachmentUrls.map((url, i) => `[Attachment ${i + 1}](${url})`).join('\n'),
                            inline: false
                        });
                    }

                    await reportChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to forward evidence post', { error: error.message });
            }
        }

        if (config.alert_channel_id) {
            try {
                const alertChannel = guild.channels.cache.get(config.alert_channel_id);
                if (alertChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xF39C12)
                        .setTitle('Phishing Detection — Evidence Post Flagged')
                        .setDescription(
                            `A message in ${channel} contained phishing domain \`${matchedDomain}\` but appeared to be an evidence/report post. ` +
                            `Message was deleted and ${config.report_channel_id ? 'forwarded to <#' + config.report_channel_id + '>' : 'not forwarded (no report channel configured)'}. ` +
                            'No action taken against the user.'
                        )
                        .addFields(
                            { name: 'User', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Channel', value: `${channel}`, inline: true }
                        )
                        .setFooter({ text: `User ID: ${author.id}` })
                        .setTimestamp();

                    await alertChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to send evidence alert', { error: error.message });
            }
        }

        if (config.log_detections) {
            try {
                await pool.execute(
                    `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, matched_url, source, action_taken)
                     VALUES (?, ?, ?, ?, ?, 'evidence_flagged', 'flagged_evidence')`,
                    [guild.id, author.id, channel.id, matchedDomain, matchedUrl]
                );
            } catch (error) {
                logger.error('[PhishingDetection] Failed to log evidence detection', { error: error.message });
            }
        }

        logger.info('[PhishingDetection] Evidence post flagged — no action against user', {
            guildId: guild.id,
            userId: author.id,
            domain: matchedDomain,
            channelId: channel.id
        });
    }

    /**
     * Check a message for phishing links.
     * Three-layer filter: channel exemption -> evidence heuristic -> normal action.
     * @param {Message} message - Discord message to check
     * @returns {boolean} true if message was acted on
     */
    async checkMessage(message) {
        // Skip bots and DMs
        if (message.author.bot || !message.guild) return false;

        // Skip admins, owners, and whitelisted users
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = message.member.id === message.guild.ownerId;
            if (isAdmin || isOwner) return false;
        }
        if (await isWhitelisted(message.guild.id, message.author.id)) return false;

        // Fast bail: nothing to scan unless there's a URL in text OR an image attachment.
        const hasImages = message.attachments.some(a => a.contentType?.startsWith('image/'));
        const hasUrlInText = /https?:\/\//i.test(message.content || '');
        if (!hasImages && !hasUrlInText) return false;

        // Get guild config
        const config = await this.getConfig(message.guild.id);
        if (!config) return false;

        // Layer 1: Channel exemption — skip entirely (covers reports/red-flags channels)
        if (this.isExemptChannel(message.channel, config)) return false;

        // OCR image attachments (only when enabled) and fold the text into the scan.
        let ocrText = '';
        if (hasImages && config.scan_images) {
            ocrText = await extractImageText(message.attachments.values());
        }

        const combined = `${message.content || ''}\n${ocrText}`;
        const domains = this.extractDomains(combined);

        // Known phishing domain (in text OR image) — high confidence.
        for (const { domain, url } of domains) {
            if (this.domainSet.has(domain) && !this.isWhitelisted(domain, config)) {
                const source = ocrText && new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(ocrText)
                    ? 'image-domain' : 'auto-list';
                if (this.looksLikeEvidencePost(message)) {
                    await this.forwardEvidencePost(message, domain, url, config);
                    return true;
                }
                await this.takeAction(message, domain, url, config, source);
                return true;
            }
        }

        // Scam-genre heuristic — runs ONLY on image-derived text (never plain chat).
        if (ocrText) {
            const genre = scoreScamText(ocrText);
            if (genre.matched) {
                const reason = `image-scam (${genre.groups.join('+')})`;
                if (this.looksLikeEvidencePost(message)) {
                    await this.forwardEvidencePost(message, reason, '(in image)', config);
                    return true;
                }
                await this.takeAction(message, reason, '(text inside image)', config, 'image-genre');
                return true;
            }
        }

        return false;
    }

    /**
     * Take action on a phishing message
     */
    async takeAction(message, matchedDomain, matchedUrl, config, source = null) {
        const { guild, author, channel, member } = message;

        // Always try to delete the message
        try {
            await message.delete();
        } catch (error) {
            logger.error('[PhishingDetection] Failed to delete message', { error: error.message });
        }

        // Never apply mute/kick/ban to the protected bot owner — just stop after the delete
        if (isProtectedFromBanCommands(author?.id)) {
            return;
        }

        // Log to database
        if (config.log_detections) {
            try {
                const detectionSource = source || (this.domainSet.has(matchedDomain) ? 'auto-list' : 'manual');
                await pool.execute(
                    `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, matched_url, source, action_taken)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [guild.id, author.id, channel.id, matchedDomain, matchedUrl, detectionSource, config.action]
                );
            } catch (error) {
                logger.error('[PhishingDetection] Failed to log detection', { error: error.message });
            }
        }

        // Apply secondary action
        try {
            switch (config.action) {
                case 'mute':
                    if (member && member.moderatable) {
                        const duration = (config.mute_duration_minutes || 30) * 60 * 1000;
                        await member.timeout(duration, `Phishing link detected: ${matchedDomain}`);
                    }
                    break;
                case 'kick':
                    if (member && member.kickable) {
                        await member.kick(`Phishing link detected: ${matchedDomain}`);
                    }
                    break;
                case 'ban':
                    if (member && member.bannable) {
                        await member.ban({ reason: `Phishing link detected: ${matchedDomain}`, deleteMessageSeconds: 86400 });
                    }
                    break;
                case 'warn':
                    await channel.send({
                        content: `${author}, your message was removed because it contained a known phishing link. Please be careful with the links you share.`,
                    }).catch(() => {});
                    break;
                // 'delete' — already handled above
            }
        } catch (error) {
            logger.error('[PhishingDetection] Failed to apply action', {
                action: config.action,
                error: error.message
            });
        }

        // Send alert to configured channel
        if (config.alert_channel_id) {
            try {
                const alertChannel = guild.channels.cache.get(config.alert_channel_id);
                if (alertChannel) {
                    const accountAge = Math.floor(author.createdAt.getTime() / 1000);
                    const embed = new EmbedBuilder()
                        .setColor(0xE74C3C)
                        .setTitle('Phishing Link Detected')
                        .setDescription(`A message in ${channel} contained a known phishing domain.`)
                        .addFields(
                            { name: 'User', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Account Age', value: `<t:${accountAge}:R>`, inline: true },
                            { name: 'Action Taken', value: config.action, inline: true },
                            { name: 'Matched Domain', value: `\`${matchedDomain}\``, inline: true },
                            { name: 'Full URL', value: matchedUrl.length > 500 ? matchedUrl.substring(0, 500) + '...' : matchedUrl, inline: false },
                            { name: 'Channel', value: `${channel}`, inline: true }
                        )
                        .setFooter({ text: `User ID: ${author.id}` })
                        .setTimestamp();

                    await alertChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to send alert', { error: error.message });
            }
        }

        logger.warn('[PhishingDetection] Phishing link blocked', {
            guildId: guild.id,
            userId: author.id,
            domain: matchedDomain,
            action: config.action
        });
    }
}

export default PhishingDetectionManager;
