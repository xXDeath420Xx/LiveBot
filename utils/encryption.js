import crypto from 'crypto';
import logger from './logger.js';

/**
 * Encryption utility for sensitive data like bot tokens
 * Uses AES-256-GCM encryption for maximum security
 */
class EncryptionService {
    constructor() {
        this.algorithm = 'aes-256-gcm';
        this.key = this.getEncryptionKey();
    }

    /**
     * Get or validate encryption key from environment
     */
    getEncryptionKey() {
        if (!process.env.BOT_ENCRYPTION_KEY) {
            logger.error('[Encryption] BOT_ENCRYPTION_KEY not set in .env file');
            throw new Error('Encryption key not configured');
        }

        // Key should be 32 bytes (64 hex characters)
        const key = Buffer.from(process.env.BOT_ENCRYPTION_KEY, 'hex');
        if (key.length !== 32) {
            throw new Error('Encryption key must be 32 bytes (64 hex characters)');
        }

        return key;
    }

    /**
     * Encrypt data (bot tokens, etc.)
     * @param {string} data - Plain text data to encrypt
     * @returns {object} Object containing iv, encryptedData, and authTag
     */
    encrypt(data) {
        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

            let encrypted = cipher.update(data, 'utf8', 'hex');
            encrypted += cipher.final('hex');

            const authTag = cipher.getAuthTag();

            return {
                iv: iv.toString('hex'),
                encryptedData: encrypted,
                authTag: authTag.toString('hex')
            };
        } catch (error) {
            logger.error('[Encryption] Failed to encrypt data:', error);
            throw error;
        }
    }

    /**
     * Decrypt data
     * @param {object} encryptedObj - Object containing iv, encryptedData, and authTag
     * @returns {string} Decrypted plain text
     */
    decrypt(encryptedObj) {
        try {
            const iv = Buffer.from(encryptedObj.iv, 'hex');
            const authTag = Buffer.from(encryptedObj.authTag, 'hex');

            const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
            decipher.setAuthTag(authTag);

            let decrypted = decipher.update(encryptedObj.encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            logger.error('[Encryption] Failed to decrypt data:', error);
            throw error;
        }
    }

    /**
     * Generate a new encryption key (for setup)
     * @returns {string} 64-character hex string (32 bytes)
     */
    static generateKey() {
        return crypto.randomBytes(32).toString('hex');
    }
}

export default new EncryptionService();
