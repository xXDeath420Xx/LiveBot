/**
 * Input validation utilities for API endpoints
 * Prevents XSS, SQL injection, and oversized inputs
 */

import logger from './logger.js';

// Maximum lengths for various field types
export const MAX_LENGTHS = {
    COMMAND_NAME: 50,
    COMMAND_RESPONSE: 500,      // Kick's max is 500 chars
    CUSTOM_ALIAS: 30,
    PROFILE_BIO: 500,
    STRAIN_NAME: 100,
    CHANNEL_NAME: 100,
    GENERIC_SHORT: 100,
    GENERIC_MEDIUM: 255,
    GENERIC_LONG: 1000
};

// Patterns for various input types
const PATTERNS = {
    COMMAND_NAME: /^[a-z0-9_-]+$/i,           // alphanumeric, underscore, hyphen
    USERNAME: /^[a-zA-Z0-9_]+$/,               // alphanumeric and underscore
    SLUG: /^[a-z0-9-]+$/,                      // lowercase, numbers, hyphen
    SAFE_TEXT: /^[\w\s.,!?@#$%&*()-+=:;'"<>\/\\[\]{}|~`]+$/u,  // Most printable chars
    NO_SCRIPT: /<script|javascript:|on\w+\s*=/i  // Detect script injection attempts
};

// List of valid timezones (subset - add more as needed)
const VALID_TIMEZONES = [
    'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris',
    'Europe/Berlin', 'Europe/Moscow', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
    'Australia/Sydney', 'Pacific/Auckland'
];

/**
 * Sanitize string input - remove potential XSS vectors
 * @param {string} input - The input string
 * @returns {string} Sanitized string
 */
export function sanitizeString(input) {
    if (!input || typeof input !== 'string') return '';

    return input
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;')
        .trim();
}

/**
 * Validate and sanitize a command name
 * @param {string} name - Command name to validate
 * @returns {{valid: boolean, value: string, error: string}} Validation result
 */
export function validateCommandName(name) {
    if (!name || typeof name !== 'string') {
        return { valid: false, value: '', error: 'Command name is required' };
    }

    const trimmed = name.trim().toLowerCase();

    if (trimmed.length < 1) {
        return { valid: false, value: '', error: 'Command name cannot be empty' };
    }

    if (trimmed.length > MAX_LENGTHS.COMMAND_NAME) {
        return { valid: false, value: '', error: `Command name cannot exceed ${MAX_LENGTHS.COMMAND_NAME} characters` };
    }

    if (!PATTERNS.COMMAND_NAME.test(trimmed)) {
        return { valid: false, value: '', error: 'Command name can only contain letters, numbers, underscore, and hyphen' };
    }

    // Block reserved/dangerous names
    const reserved = ['eval', 'exec', 'script', 'function', 'constructor', '__proto__'];
    if (reserved.includes(trimmed)) {
        return { valid: false, value: '', error: 'This command name is reserved' };
    }

    return { valid: true, value: trimmed, error: null };
}

/**
 * Validate and sanitize a command response
 * @param {string} response - Command response to validate
 * @returns {{valid: boolean, value: string, error: string}} Validation result
 */
export function validateCommandResponse(response) {
    if (!response || typeof response !== 'string') {
        return { valid: false, value: '', error: 'Response is required' };
    }

    const trimmed = response.trim();

    if (trimmed.length < 1) {
        return { valid: false, value: '', error: 'Response cannot be empty' };
    }

    if (trimmed.length > MAX_LENGTHS.COMMAND_RESPONSE) {
        return { valid: false, value: '', error: `Response cannot exceed ${MAX_LENGTHS.COMMAND_RESPONSE} characters` };
    }

    // Check for script injection attempts
    if (PATTERNS.NO_SCRIPT.test(trimmed)) {
        logger.warn('[InputValidation] Script injection attempt detected', { input: trimmed.substring(0, 50) });
        return { valid: false, value: '', error: 'Response contains invalid content' };
    }

    return { valid: true, value: trimmed, error: null };
}

/**
 * Validate a profile bio
 * @param {string} bio - Bio text to validate
 * @returns {{valid: boolean, value: string, error: string}} Validation result
 */
export function validateProfileBio(bio) {
    if (!bio) {
        return { valid: true, value: null, error: null }; // Optional field
    }

    if (typeof bio !== 'string') {
        return { valid: false, value: '', error: 'Invalid bio format' };
    }

    const trimmed = bio.trim();

    if (trimmed.length > MAX_LENGTHS.PROFILE_BIO) {
        return { valid: false, value: '', error: `Bio cannot exceed ${MAX_LENGTHS.PROFILE_BIO} characters` };
    }

    // Check for script injection
    if (PATTERNS.NO_SCRIPT.test(trimmed)) {
        return { valid: false, value: '', error: 'Bio contains invalid content' };
    }

    return { valid: true, value: sanitizeString(trimmed), error: null };
}

/**
 * Validate a timezone
 * @param {string} timezone - Timezone to validate
 * @returns {{valid: boolean, value: string, error: string}} Validation result
 */
export function validateTimezone(timezone) {
    if (!timezone) {
        return { valid: true, value: null, error: null }; // Optional field
    }

    if (typeof timezone !== 'string') {
        return { valid: false, value: '', error: 'Invalid timezone format' };
    }

    // Try to validate with Intl API
    try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
        return { valid: true, value: timezone, error: null };
    } catch (e) {
        return { valid: false, value: '', error: 'Invalid timezone' };
    }
}

/**
 * Validate a cooldown value
 * @param {any} cooldown - Cooldown value to validate
 * @returns {{valid: boolean, value: number, error: string}} Validation result
 */
export function validateCooldown(cooldown) {
    if (cooldown === undefined || cooldown === null || cooldown === '') {
        return { valid: true, value: 5, error: null }; // Default to 5
    }

    const num = parseInt(cooldown, 10);

    if (isNaN(num)) {
        return { valid: false, value: 5, error: 'Cooldown must be a number' };
    }

    if (num < 0) {
        return { valid: false, value: 5, error: 'Cooldown cannot be negative' };
    }

    if (num > 3600) {
        return { valid: false, value: 5, error: 'Cooldown cannot exceed 3600 seconds (1 hour)' };
    }

    return { valid: true, value: num, error: null };
}

/**
 * Validate an array of aliases
 * @param {any} aliases - Aliases to validate
 * @returns {{valid: boolean, value: string[], error: string}} Validation result
 */
export function validateAliases(aliases) {
    if (!aliases) {
        return { valid: true, value: [], error: null };
    }

    let arr;
    if (typeof aliases === 'string') {
        try {
            arr = JSON.parse(aliases);
        } catch {
            arr = aliases.split(',').map(a => a.trim());
        }
    } else if (Array.isArray(aliases)) {
        arr = aliases;
    } else {
        return { valid: false, value: [], error: 'Invalid aliases format' };
    }

    if (!Array.isArray(arr)) {
        return { valid: false, value: [], error: 'Aliases must be an array' };
    }

    if (arr.length > 10) {
        return { valid: false, value: [], error: 'Maximum 10 aliases allowed' };
    }

    const validated = [];
    for (const alias of arr) {
        const result = validateCommandName(alias);
        if (!result.valid) {
            return { valid: false, value: [], error: `Invalid alias "${alias}": ${result.error}` };
        }
        if (result.value.length > MAX_LENGTHS.CUSTOM_ALIAS) {
            return { valid: false, value: [], error: `Alias "${alias}" exceeds maximum length` };
        }
        validated.push(result.value);
    }

    return { valid: true, value: validated, error: null };
}

/**
 * Validate a boolean field
 * @param {any} value - Value to validate
 * @param {boolean} defaultValue - Default value if not provided
 * @returns {{valid: boolean, value: boolean, error: string}} Validation result
 */
export function validateBoolean(value, defaultValue = false) {
    if (value === undefined || value === null) {
        return { valid: true, value: defaultValue, error: null };
    }

    if (typeof value === 'boolean') {
        return { valid: true, value, error: null };
    }

    if (value === 'true' || value === '1' || value === 1) {
        return { valid: true, value: true, error: null };
    }

    if (value === 'false' || value === '0' || value === 0) {
        return { valid: true, value: false, error: null };
    }

    return { valid: false, value: defaultValue, error: 'Invalid boolean value' };
}

/**
 * Validate a numeric ID
 * @param {any} id - ID to validate
 * @returns {{valid: boolean, value: number, error: string}} Validation result
 */
export function validateId(id) {
    if (!id) {
        return { valid: false, value: null, error: 'ID is required' };
    }

    const num = parseInt(id, 10);

    if (isNaN(num) || num < 1) {
        return { valid: false, value: null, error: 'Invalid ID' };
    }

    return { valid: true, value: num, error: null };
}

export default {
    MAX_LENGTHS,
    sanitizeString,
    validateCommandName,
    validateCommandResponse,
    validateProfileBio,
    validateTimezone,
    validateCooldown,
    validateAliases,
    validateBoolean,
    validateId
};
