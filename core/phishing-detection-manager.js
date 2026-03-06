import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import configCache from '../utils/configCache.js';

/**
 * Phishing Detection Manager - Checks messages against known phishing domains
 * Maintains an in-memory Set of domains for O(1) lookups on every message.
 * Domain list is synced from community GitHub lists every 4 hours.
 */
class PhishingDetectionManager {
    constructor(client) {
        this.client = client;
        this.domainSet = new Set();
    }

    /**
     * Load all known phishing domains from DB into the in-memory Set
     */
    async loadDomains() {
        try {
            const [rows] = await pool.execute('SELECT domain FROM phishing_domains');
            this.domainSet.clear();
            for (const row of rows) {
                this.domainSet.add(row.domain.toLowerCase());
            }
            logger.info(`[PhishingDetection] Loaded ${this.domainSet.size} domains into memory`);
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
     * Check a message for phishing links
     * @param {Message} message - Discord message to check
     * @returns {boolean} true if message was blocked
     */
    async checkMessage(message) {
        // Skip bots and DMs
        if (message.author.bot || !message.guild) return false;

        // Skip admins and owners
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = message.member.id === message.guild.ownerId;
            if (isAdmin || isOwner) return false;
        }

        // Quick bail — no URLs in content
        const domains = this.extractDomains(message.content);
        if (domains.length === 0) return false;

        // Get guild config
        const config = await this.getConfig(message.guild.id);
        if (!config) return false;

        // Check each domain against the Set
        for (const { domain, url } of domains) {
            if (this.domainSet.has(domain) && !this.isWhitelisted(domain, config)) {
                await this.takeAction(message, domain, url, config);
                return true;
            }
        }

        return false;
    }

    /**
     * Take action on a phishing message
     */
    async takeAction(message, matchedDomain, matchedUrl, config) {
        const { guild, author, channel, member } = message;

        // Always try to delete the message
        try {
            await message.delete();
        } catch (error) {
            logger.error('[PhishingDetection] Failed to delete message', { error: error.message });
        }

        // Log to database
        if (config.log_detections) {
            try {
                const source = this.domainSet.has(matchedDomain) ? 'auto-list' : 'manual';
                await pool.execute(
                    `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, matched_url, source, action_taken)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [guild.id, author.id, channel.id, matchedDomain, matchedUrl, source, config.action]
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
