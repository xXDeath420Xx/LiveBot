/**
 * Anti-Scam Detection
 * Flags suspicious messages for mod review (doesn't auto-delete)
 * Bypasses users with Trader roles
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';

// Scam patterns - these are flagged for review
const SCAM_PATTERNS = [
    // Crypto wallet addresses
    /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/,  // Bitcoin
    /\b0x[a-fA-F0-9]{40}\b/,                 // Ethereum
    /\b[LM][a-km-zA-HJ-NP-Z1-9]{26,33}\b/,  // Litecoin

    // Suspicious shortened links
    /\b(bit\.ly|tinyurl|goo\.gl|t\.co|is\.gd|buff\.ly|ow\.ly|shorte\.st|adf\.ly)\b/i,

    // Payment scam phrases
    /send\s+(payment|money|funds|btc|eth|crypto)\s+to/i,
    /pay(ment)?\s+first\s+(then|and)/i,
    /western\s+union/i,
    /moneygram/i,
    /gift\s+card\s+(code|payment)/i,
    /cashapp.*\$[a-zA-Z]/i,
    /venmo.*@/i,
    /zelle.*@/i,

    // Impersonation attempts
    /i('m|am)\s+(a\s+)?(admin|moderator|mod|staff|owner)/i,

    // Urgency scams
    /(act|order|buy)\s+(now|fast|quick|today).*(limited|only|last|few)/i,
    /won\s+(a|the)\s+(prize|giveaway|lottery)/i,

    // Sus DM requests (only when combined with deals/money)
    /dm\s+(me|for).*(deal|price|payment|ship|order)/i,
    /message\s+(me|privately).*(deal|price|payment)/i
];

// Phrases that are suspicious but context-dependent
const SOFT_PATTERNS = [
    /free\s+.{0,20}(just|only)\s+pay\s+(ship|s&h|postage)/i,  // "Free X just pay shipping"
    /\d+%\s+off.*(limited|today|now)/i,                        // Urgency discounts
];

// Roles that bypass the filter
const BYPASS_ROLES = ['trader', 'trusted', 'veteran', 'elite', 'moderator', 'admin', 'staff'];

export default {
    name: 'messageCreate',
    async execute(message) {
        // Ignore bots, DMs, and system messages
        if (message.author.bot || !message.guild || message.system) return;

        // Check for bypass roles
        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) {
            const hasBypassRole = member.roles.cache.some(r =>
                BYPASS_ROLES.some(bypass => r.name.toLowerCase().includes(bypass))
            );
            if (hasBypassRole) return;
        }

        // Check message content
        const content = message.content;
        if (!content || content.length < 10) return;

        // Check for scam patterns
        let matchedPattern = null;
        let severity = 'low';

        for (const pattern of SCAM_PATTERNS) {
            if (pattern.test(content)) {
                matchedPattern = pattern.toString();
                severity = 'high';
                break;
            }
        }

        // If no hard match, check soft patterns
        if (!matchedPattern) {
            for (const pattern of SOFT_PATTERNS) {
                if (pattern.test(content)) {
                    matchedPattern = pattern.toString();
                    severity = 'medium';
                    break;
                }
            }
        }

        if (!matchedPattern) return;

        // Log the detection
        logger.warn(`[AntiScam] Suspicious message detected`, {
            guildId: message.guild.id,
            userId: message.author.id,
            channelId: message.channel.id,
            severity,
            pattern: matchedPattern
        });

        // Find mod-log channel
        const modLogChannel = message.guild.channels.cache.find(c =>
            c.name.includes('mod-log') || c.name.includes('modlog') || c.name.includes('staff-log')
        );

        if (!modLogChannel) return;

        // Create alert embed
        const colors = {
            high: 0xE74C3C,    // Red
            medium: 0xF39C12,  // Orange
            low: 0xF1C40F      // Yellow
        };

        const embed = new EmbedBuilder()
            .setColor(colors[severity])
            .setTitle(`🚨 Potential Scam Detected (${severity.toUpperCase()})`)
            .setDescription(`A message in ${message.channel} may contain scam content.`)
            .addFields(
                { name: 'User', value: `${message.author} (${message.author.tag})`, inline: true },
                { name: 'Account Age', value: `<t:${Math.floor(message.author.createdAt.getTime() / 1000)}:R>`, inline: true },
                { name: 'Channel', value: `${message.channel}`, inline: true },
                { name: 'Message Content', value: content.length > 1000 ? content.substring(0, 1000) + '...' : content, inline: false },
                { name: 'Jump to Message', value: `[Click Here](${message.url})`, inline: false }
            )
            .setFooter({ text: 'Review and take action if needed. Trader roles bypass this filter.' })
            .setTimestamp();

        await modLogChannel.send({ embeds: [embed] }).catch(() => {});
    }
};
