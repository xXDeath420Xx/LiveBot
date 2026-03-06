/**
 * CertiFried Extension - Formatting Utilities
 */

/**
 * Format currency value
 * @param {number} value
 * @param {boolean} compact - Use compact notation for large numbers
 */
export function formatCurrency(value, compact = false) {
    if (value === null || value === undefined || !isFinite(value)) return '$0';
    if (compact && value >= 1000000) {
        return (value / 1000000).toFixed(1) + 'M';
    }
    if (compact && value >= 1000) {
        return (value / 1000).toFixed(1) + 'K';
    }
    return value.toLocaleString();
}

/**
 * Format percentage
 * @param {number} value - Decimal value (0.15 = 15%)
 * @param {number} decimals - Decimal places
 */
export function formatPercent(value, decimals = 0) {
    return (value * 100).toFixed(decimals) + '%';
}

/**
 * Format time remaining
 * @param {number} ms - Milliseconds remaining
 * @param {boolean} short - Use short format
 */
export function formatTimeRemaining(ms, short = false) {
    // Handle invalid values
    if (ms === null || ms === undefined || isNaN(ms)) {
        return short ? '--' : 'Unknown';
    }
    if (ms <= 0) return short ? '0s' : 'Ready!';

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (short) {
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    const parts = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours % 24 > 0) parts.push(`${hours % 24} hour${hours % 24 !== 1 ? 's' : ''}`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60} min${minutes % 60 !== 1 ? 's' : ''}`);
    if (seconds % 60 > 0 && parts.length < 2) parts.push(`${seconds % 60} sec`);

    return parts.slice(0, 2).join(' ');
}

/**
 * Format relative time (e.g., "2 hours ago")
 * @param {Date|string|number} date
 */
export function formatRelativeTime(date) {
    const now = Date.now();
    // Handle both numeric timestamps and ISO date strings
    const num = Number(date);
    const then = isNaN(num) ? new Date(date).getTime() : num;
    const diff = now - then;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) return new Date(then).toLocaleDateString();
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}

/**
 * Format XP progress
 * @param {number} current
 * @param {number} required
 */
export function formatXpProgress(current, required) {
    const percent = Math.min(100, (current / required) * 100);
    return {
        current: formatCurrency(current, true),
        required: formatCurrency(required, true),
        percent: percent.toFixed(1)
    };
}

/**
 * Format quality tier name
 * @param {number} quality - Quality value (1-100)
 */
export function formatQualityTier(quality) {
    if (quality >= 95) return { name: 'Legendary', color: '#ff8c00' };
    if (quality >= 85) return { name: 'Epic', color: '#a855f7' };
    if (quality >= 70) return { name: 'Rare', color: '#3b82f6' };
    if (quality >= 50) return { name: 'Uncommon', color: '#22c55e' };
    return { name: 'Common', color: '#9ca3af' };
}

/**
 * Format strain rarity
 * @param {'common'|'uncommon'|'rare'|'epic'|'legendary'} rarity
 */
export function formatRarity(rarity) {
    const colors = {
        common: '#9ca3af',
        uncommon: '#22c55e',
        rare: '#3b82f6',
        epic: '#a855f7',
        legendary: '#ff8c00'
    };

    return {
        name: rarity.charAt(0).toUpperCase() + rarity.slice(1),
        color: colors[rarity] || '#9ca3af'
    };
}

/**
 * Format gene value
 * @param {number} value - Gene value (0-100)
 */
export function formatGene(value) {
    const stars = Math.ceil(value / 20);  // 1-5 stars
    return {
        value,
        stars,
        display: '★'.repeat(stars) + '☆'.repeat(5 - stars)
    };
}

/**
 * Truncate text with ellipsis
 * @param {string} text
 * @param {number} maxLength
 */
export function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
}

/**
 * Format a number with locale-aware separators
 * @param {number} value
 * @param {boolean} compact - Use compact notation for large numbers
 */
export function formatNumber(value, compact = false) {
    if (value === null || value === undefined || isNaN(value)) return '0';
    if (compact && value >= 1000000) {
        return (value / 1000000).toFixed(1) + 'M';
    }
    if (compact && value >= 1000) {
        return (value / 1000).toFixed(1) + 'K';
    }
    return Math.floor(value).toLocaleString();
}

/**
 * Format number with ordinal suffix
 * @param {number} n
 */
export function formatOrdinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default {
    formatCurrency,
    formatPercent,
    formatTimeRemaining,
    formatRelativeTime,
    formatXpProgress,
    formatQualityTier,
    formatRarity,
    formatGene,
    truncate,
    formatOrdinal,
    formatNumber
};
