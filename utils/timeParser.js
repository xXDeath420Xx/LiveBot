/**
 * Unified time parsing utilities
 * Consolidates 14+ duplicate implementations across the codebase
 */

/**
 * Parse time string into seconds
 * Supports single units: "30s", "5m", "2h", "1d", "1w"
 * Supports compound: "1mo2w3d10h5m30s", "1d 12h", "2w 3d"
 * Supports months: "mo" (30 days)
 * @param {string} timeStr - Time string like "30m", "2h", "1d 12h", "1mo2w"
 * @returns {number|null} Seconds, or null if invalid format
 */
export function parseTimeToSeconds(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    if (timeStr === 'off' || timeStr === '0') return 0;

    const cleaned = timeStr.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');

    // Try single-unit first for backwards compatibility
    const singleMatch = cleaned.match(/^(\d+)(s|m|h|d|w)$/);
    if (singleMatch) {
        const value = parseInt(singleMatch[1], 10);
        const unit = singleMatch[2];
        switch (unit) {
            case 's': return value;
            case 'm': return value * 60;
            case 'h': return value * 3600;
            case 'd': return value * 86400;
            case 'w': return value * 604800;
            default: return null;
        }
    }

    // Compound format: extract all number+unit pairs
    const unitMap = {
        'mo': 2592000, // 30 days
        'w': 604800,
        'd': 86400,
        'h': 3600,
        'm': 60,
        's': 1
    };

    const pattern = /(\d+)(mo|w|d|h|m|s)/g;
    let total = 0;
    let matched = false;
    let result;

    while ((result = pattern.exec(cleaned)) !== null) {
        const value = parseInt(result[1], 10);
        const unit = result[2];
        if (unitMap[unit] !== undefined) {
            total += value * unitMap[unit];
            matched = true;
        }
    }

    return matched ? total : null;
}

/**
 * Parse time string into milliseconds
 * @param {string} timeStr - Time string like "30m", "2h", "1d"
 * @param {number} maxMs - Maximum allowed milliseconds (default: 28 days for Discord timeout)
 * @returns {number|null} Milliseconds, or null if invalid format
 */
export function parseTimeToMs(timeStr, maxMs = 28 * 24 * 60 * 60 * 1000) {
    const seconds = parseTimeToSeconds(timeStr);
    if (seconds === null) return null;

    const ms = seconds * 1000;
    return maxMs ? Math.min(ms, maxMs) : ms;
}

/**
 * Alias for parseTimeToMs (backwards compatibility)
 */
export function parseDuration(timeStr, maxMs) {
    return parseTimeToMs(timeStr, maxMs);
}

/**
 * Alias for parseTimeToSeconds (backwards compatibility)
 */
export function parseTime(timeStr) {
    return parseTimeToSeconds(timeStr);
}

/**
 * Format seconds into human-readable duration
 * @param {number} seconds - Duration in seconds
 * @param {boolean} short - Use short format (1h 30m vs 1 hour 30 minutes)
 * @returns {string} Formatted duration
 */
export function formatDuration(seconds, short = true) {
    if (seconds <= 0) return short ? '0s' : '0 seconds';

    const units = [
        { label: short ? 'mo' : ' month', seconds: 2592000 },
        { label: short ? 'w' : ' week', seconds: 604800 },
        { label: short ? 'd' : ' day', seconds: 86400 },
        { label: short ? 'h' : ' hour', seconds: 3600 },
        { label: short ? 'm' : ' minute', seconds: 60 },
        { label: short ? 's' : ' second', seconds: 1 }
    ];

    const parts = [];
    let remaining = seconds;

    for (const unit of units) {
        if (remaining >= unit.seconds) {
            const count = Math.floor(remaining / unit.seconds);
            remaining %= unit.seconds;

            if (short) {
                parts.push(`${count}${unit.label}`);
            } else {
                parts.push(`${count}${unit.label}${count !== 1 ? 's' : ''}`);
            }
        }
    }

    return parts.join(' ');
}

/**
 * Format milliseconds into human-readable duration
 * @param {number} ms - Duration in milliseconds
 * @param {boolean} short - Use short format
 * @returns {string} Formatted duration
 */
export function formatDurationMs(ms, short = true) {
    return formatDuration(Math.floor(ms / 1000), short);
}

/**
 * Parse a relative time string and return a Date object
 * @param {string} timeStr - Time string like "30m", "2h", "1d" (from now)
 * @returns {Date|null} Future date, or null if invalid
 */
export function parseRelativeTime(timeStr) {
    const ms = parseTimeToMs(timeStr, null);
    if (ms === null) return null;
    return new Date(Date.now() + ms);
}

/**
 * Get time remaining until a date as formatted string
 * @param {Date|number} target - Target date or timestamp
 * @param {boolean} short - Use short format
 * @returns {string} Formatted time remaining
 */
export function getTimeRemaining(target, short = true) {
    const targetMs = target instanceof Date ? target.getTime() : target;
    const remaining = Math.max(0, targetMs - Date.now());
    return formatDurationMs(remaining, short);
}

/**
 * Check if a time string is valid
 * @param {string} timeStr - Time string to validate
 * @returns {boolean} True if valid format
 */
export function isValidTimeString(timeStr) {
    return parseTimeToSeconds(timeStr) !== null;
}

export default {
    parseTimeToSeconds,
    parseTimeToMs,
    parseDuration,
    parseTime,
    formatDuration,
    formatDurationMs,
    parseRelativeTime,
    getTimeRemaining,
    isValidTimeString
};
