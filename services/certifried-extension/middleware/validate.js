/**
 * Request Validation Middleware
 * Validates request bodies against schemas
 */

import logger from '../../../utils/logger.js';

/**
 * Simple validation helper
 * @param {object} data - Data to validate
 * @param {object} schema - Schema definition
 * @returns {object} { valid: boolean, errors: string[] }
 */
function validateData(data, schema) {
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
        const value = data[field];

        // Required check
        if (rules.required && (value === undefined || value === null || value === '')) {
            errors.push(`${field} is required`);
            continue;
        }

        // Skip optional fields that aren't provided
        if (value === undefined || value === null) {
            continue;
        }

        // Type check
        if (rules.type) {
            const actualType = Array.isArray(value) ? 'array' : typeof value;
            if (actualType !== rules.type) {
                errors.push(`${field} must be a ${rules.type}`);
                continue;
            }
        }

        // Number constraints
        if (rules.type === 'number') {
            if (rules.min !== undefined && value < rules.min) {
                errors.push(`${field} must be at least ${rules.min}`);
            }
            if (rules.max !== undefined && value > rules.max) {
                errors.push(`${field} must be at most ${rules.max}`);
            }
            if (rules.integer && !Number.isInteger(value)) {
                errors.push(`${field} must be an integer`);
            }
        }

        // String constraints
        if (rules.type === 'string') {
            if (rules.minLength && value.length < rules.minLength) {
                errors.push(`${field} must be at least ${rules.minLength} characters`);
            }
            if (rules.maxLength && value.length > rules.maxLength) {
                errors.push(`${field} must be at most ${rules.maxLength} characters`);
            }
            if (rules.pattern && !rules.pattern.test(value)) {
                errors.push(`${field} format is invalid`);
            }
            if (rules.enum && !rules.enum.includes(value)) {
                errors.push(`${field} must be one of: ${rules.enum.join(', ')}`);
            }
        }

        // Array constraints
        if (rules.type === 'array') {
            if (rules.minItems && value.length < rules.minItems) {
                errors.push(`${field} must have at least ${rules.minItems} items`);
            }
            if (rules.maxItems && value.length > rules.maxItems) {
                errors.push(`${field} must have at most ${rules.maxItems} items`);
            }
        }

        // Custom validator
        if (rules.validate && typeof rules.validate === 'function') {
            const customError = rules.validate(value, data);
            if (customError) {
                errors.push(customError);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Create validation middleware
 * @param {object} schema - Validation schema
 * @param {string} source - 'body', 'query', or 'params'
 */
export function validate(schema, source = 'body') {
    return (req, res, next) => {
        const data = req[source] || {};
        const result = validateData(data, schema);

        if (!result.valid) {
            logger.warn('[Validate] Validation failed', {
                path: req.path,
                errors: result.errors,
                bodyKeys: Object.keys(data),
                bodyTypes: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v]))
            });
            return res.status(400).json({
                error: 'Validation failed',
                code: 'VALIDATION_ERROR',
                details: result.errors
            });
        }

        next();
    };
}

// Common validation schemas
export const schemas = {
    // Planting - max increased to 100 to support location unlocks
    plant: {
        slotNumber: { type: 'number', required: true, min: 1, max: 100, integer: true },
        strainId: { type: 'number', required: true, min: 1, integer: true }
    },

    // Harvesting - max increased to 100 to support location unlocks
    harvest: {
        slotNumber: { type: 'number', required: true, min: 1, max: 100, integer: true }
    },

    // Selling to NPC
    sellNpc: {
        inventoryId: { type: 'number', required: true, min: 1, integer: true },
        quantity: { type: 'number', required: true, min: 1, integer: true }
    },

    // Market listing
    marketList: {
        inventoryId: { type: 'number', required: true, min: 1, integer: true },
        quantity: { type: 'number', required: true, min: 1, integer: true },
        pricePerUnit: { type: 'number', required: true, min: 1, integer: true }
    },

    // Market buy
    marketBuy: {
        listingId: { type: 'number', required: true, min: 1, integer: true },
        quantity: { type: 'number', required: false, min: 1, integer: true }
    },

    // Breeding
    breed: {
        parent1StrainId: { type: 'number', required: true, min: 1, integer: true },
        parent2StrainId: { type: 'number', required: true, min: 1, integer: true }
    },

    // Trading
    tradeCreate: {
        receiverId: { type: 'number', required: true, min: 1, integer: true },
        offeredItems: { type: 'array', required: false },
        offeredCash: { type: 'number', required: false, min: 0, integer: true },
        requestedItems: { type: 'array', required: false },
        requestedCash: { type: 'number', required: false, min: 0, integer: true }
    },

    tradeAction: {
        tradeId: { type: 'number', required: true, min: 1, integer: true }
    },

    // Skills
    skillUnlock: {
        skillId: { type: 'number', required: true, min: 1, integer: true }
    },

    // Facility
    facilityUpgrade: {
        upgradeKey: { type: 'string', required: true, minLength: 1, maxLength: 50 }
    },

    facilityRename: {
        name: {
            type: 'string',
            required: true,
            minLength: 1,
            maxLength: 100,
            validate: (value) => {
                // Basic profanity/injection check
                if (/<|>|script/i.test(value)) {
                    return 'Invalid characters in name';
                }
                return null;
            }
        }
    },

    // Bits transaction
    bitsTransaction: {
        sku: { type: 'string', required: true, minLength: 1, maxLength: 50 },
        transactionId: { type: 'string', required: true, minLength: 1, maxLength: 200 },
        receipt: { type: 'object', required: false }
    }
};

export default { validate, schemas, validateData };
