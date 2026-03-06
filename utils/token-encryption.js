import crypto from 'crypto';
import logger from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Get encryption key from environment variable
 * BOT_ENCRYPTION_KEY should be a 64-character hex string (32 bytes)
 */
function getEncryptionKey() {
    const key = process.env.BOT_ENCRYPTION_KEY;
    if (!key) {
        throw new Error('BOT_ENCRYPTION_KEY environment variable is not set');
    }

    // If key is hex string, convert to buffer
    if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
        return Buffer.from(key, 'hex');
    }

    // Otherwise derive key from passphrase using PBKDF2
    return crypto.pbkdf2Sync(key, 'tokes-bot-salt', 100000, 32, 'sha256');
}

/**
 * Encrypt a token or sensitive string
 * @param {string} plaintext - The text to encrypt
 * @returns {string} Encrypted string in format: iv:authTag:ciphertext (all base64)
 */
export function encryptToken(plaintext) {
    if (!plaintext) return null;

    try {
        const key = getEncryptionKey();
        const iv = crypto.randomBytes(IV_LENGTH);

        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        let encrypted = cipher.update(plaintext, 'utf8', 'base64');
        encrypted += cipher.final('base64');

        const authTag = cipher.getAuthTag();

        // Return format: iv:authTag:ciphertext (all base64)
        return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
    } catch (error) {
        logger.error('[TokenEncryption] Encryption failed', { error: error.message });
        throw new Error('Token encryption failed');
    }
}

/**
 * Decrypt an encrypted token
 * @param {string} encryptedData - The encrypted string in format: iv:authTag:ciphertext
 * @returns {string} Decrypted plaintext
 */
export function decryptToken(encryptedData) {
    if (!encryptedData) return null;

    // Check if data is already plaintext (for migration period)
    if (!encryptedData.includes(':') || encryptedData.split(':').length !== 3) {
        // This is likely an unencrypted token - return as-is but log warning
        logger.warn('[TokenEncryption] Unencrypted token detected - migration needed');
        return encryptedData;
    }

    try {
        const key = getEncryptionKey();
        const [ivB64, authTagB64, ciphertext] = encryptedData.split(':');

        const iv = Buffer.from(ivB64, 'base64');
        const authTag = Buffer.from(authTagB64, 'base64');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        logger.error('[TokenEncryption] Decryption failed', { error: error.message });
        // Return null instead of throwing to handle corrupted data gracefully
        return null;
    }
}

/**
 * Check if a string is encrypted (has our format)
 * @param {string} data - The string to check
 * @returns {boolean} True if the string appears to be encrypted
 */
export function isEncrypted(data) {
    if (!data || typeof data !== 'string') return false;
    const parts = data.split(':');
    return parts.length === 3 && parts.every(p => p.length > 0);
}

/**
 * Hash sensitive data for logging (one-way, for audit purposes)
 * @param {string} data - The data to hash
 * @returns {string} First 8 characters of SHA-256 hash
 */
export function hashForLogging(data) {
    if (!data) return 'null';
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 8);
}

/**
 * Generate a secure random token
 * @param {number} length - Length in bytes (default 32)
 * @returns {string} Hex-encoded random token
 */
export function generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

/**
 * Securely compare two strings (timing-safe)
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
export function secureCompare(a, b) {
    if (!a || !b) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

export default {
    encryptToken,
    decryptToken,
    isEncrypted,
    hashForLogging,
    generateSecureToken,
    secureCompare
};
