/**
 * Safe JSON parsing utilities
 * Prevents crashes from malformed JSON in database or config
 */
import logger from './logger.js';

/**
 * Safely parse JSON with fallback value
 * @param {string} jsonString - The JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails (default: null)
 * @param {string} context - Optional context for logging (e.g., 'automod config')
 * @returns {*} Parsed value or defaultValue on failure
 */
export function safeJsonParse(jsonString, defaultValue = null, context = '') {
  if (jsonString === null || jsonString === undefined) {
    return defaultValue;
  }

  // If it's already an object/array, return as-is
  if (typeof jsonString === 'object') {
    return jsonString;
  }

  // If it's not a string, return default
  if (typeof jsonString !== 'string') {
    return defaultValue;
  }

  // Empty string should return default
  if (jsonString.trim() === '') {
    return defaultValue;
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logger.warn(`[SafeJSON] Failed to parse JSON${context ? ` (${context})` : ''}: ${error.message}`, {
      preview: jsonString.substring(0, 100),
      defaultUsed: typeof defaultValue
    });
    return defaultValue;
  }
}

/**
 * Safely parse JSON array with empty array fallback
 * @param {string} jsonString - The JSON string to parse
 * @param {string} context - Optional context for logging
 * @returns {Array} Parsed array or empty array on failure
 */
export function safeJsonArray(jsonString, context = '') {
  const result = safeJsonParse(jsonString, [], context);
  return Array.isArray(result) ? result : [];
}

/**
 * Safely parse JSON object with empty object fallback
 * @param {string} jsonString - The JSON string to parse
 * @param {string} context - Optional context for logging
 * @returns {Object} Parsed object or empty object on failure
 */
export function safeJsonObject(jsonString, context = '') {
  const result = safeJsonParse(jsonString, {}, context);
  return (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
}

/**
 * Safely stringify JSON with error handling
 * @param {*} value - The value to stringify
 * @param {string} defaultValue - Default string if stringify fails (default: '{}')
 * @param {string} context - Optional context for logging
 * @returns {string} JSON string or defaultValue on failure
 */
export function safeJsonStringify(value, defaultValue = '{}', context = '') {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    logger.warn(`[SafeJSON] Failed to stringify JSON${context ? ` (${context})` : ''}: ${error.message}`);
    return defaultValue;
  }
}

export default {
  parse: safeJsonParse,
  parseArray: safeJsonArray,
  parseObject: safeJsonObject,
  stringify: safeJsonStringify
};
