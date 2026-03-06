/**
 * CertiFried Extension - Bot Message Formatters
 * Utilities for formatting messages for Discord/Twitch chat
 */

/**
 * Format currency with thousands separator
 * @param {number} amount
 * @param {boolean} compact - Use K/M notation
 */
export function formatCurrency(amount, compact = false) {
    if (compact) {
        if (amount >= 1000000) {
            return (amount / 1000000).toFixed(1) + 'M';
        }
        if (amount >= 1000) {
            return (amount / 1000).toFixed(1) + 'K';
        }
    }
    return amount.toLocaleString();
}

/**
 * Format time duration
 * @param {number} ms - Milliseconds
 * @param {boolean} short - Short format
 */
export function formatDuration(ms, short = false) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (short) {
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m`;
        return `${seconds}s`;
    }

    const parts = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours % 24 > 0) parts.push(`${hours % 24} hour${hours % 24 !== 1 ? 's' : ''}`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60} min`);

    return parts.length > 0 ? parts.join(' ') : 'now';
}

/**
 * Format percentage
 * @param {number} value - Decimal (0.15 = 15%)
 * @param {number} decimals
 */
export function formatPercent(value, decimals = 0) {
    return (value * 100).toFixed(decimals) + '%';
}

/**
 * Format quality tier name
 * @param {number} quality - 1-100
 */
export function formatQuality(quality) {
    if (quality >= 95) return 'Legendary';
    if (quality >= 85) return 'Epic';
    if (quality >= 70) return 'Rare';
    if (quality >= 50) return 'Uncommon';
    return 'Common';
}

/**
 * Format rarity color for Discord embed
 * @param {string} rarity
 */
export function rarityColor(rarity) {
    const colors = {
        common: 0x9ca3af,
        uncommon: 0x22c55e,
        rare: 0x3b82f6,
        epic: 0xa855f7,
        legendary: 0xff8c00
    };
    return colors[rarity.toLowerCase()] || colors.common;
}

/**
 * Create progress bar string
 * @param {number} current
 * @param {number} max
 * @param {number} length - Bar length in characters
 */
export function progressBar(current, max, length = 10) {
    const filled = Math.round((current / max) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format XP progress
 * @param {number} xp
 * @param {number} required
 */
export function formatXP(xp, required) {
    return `${formatCurrency(xp)}/${formatCurrency(required)} XP`;
}

/**
 * Create embed-ready player stats object (for Discord)
 * @param {object} stats
 */
export function playerStatsEmbed(stats) {
    return {
        title: '🌿 CertiFried Stats',
        color: 0x22c55e,
        fields: [
            {
                name: 'Level',
                value: `${stats.level}`,
                inline: true
            },
            {
                name: 'Currency',
                value: formatCurrency(stats.currency),
                inline: true
            },
            {
                name: 'Prestige',
                value: stats.prestigeLevel > 0 ? `P${stats.prestigeLevel}` : 'None',
                inline: true
            },
            {
                name: 'Garden',
                value: `${stats.activePlots}/${stats.maxPlots} plots`,
                inline: true
            },
            {
                name: 'Strains',
                value: `${stats.unlockedStrains} unlocked`,
                inline: true
            },
            {
                name: 'Inventory',
                value: `${stats.inventoryItems} items`,
                inline: true
            }
        ],
        footer: {
            text: 'Use the extension panel to play!'
        }
    };
}

/**
 * Create simple text stats for Twitch chat
 * @param {object} stats
 */
export function playerStatsText(stats) {
    const parts = [
        `Lv${stats.level}`,
        `${formatCurrency(stats.currency, true)} coins`,
        `${stats.activePlots}/${stats.maxPlots} plots`,
        `${stats.unlockedStrains} strains`
    ];

    if (stats.prestigeLevel > 0) {
        parts.unshift(`P${stats.prestigeLevel}`);
    }

    return parts.join(' | ');
}

export default {
    formatCurrency,
    formatDuration,
    formatPercent,
    formatQuality,
    rarityColor,
    progressBar,
    formatXP,
    playerStatsEmbed,
    playerStatsText
};
