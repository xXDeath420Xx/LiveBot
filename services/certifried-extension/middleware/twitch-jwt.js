/**
 * Twitch Extension JWT Verification
 * Verifies JWTs from Twitch Extension Helper SDK
 */

import jwt from 'jsonwebtoken';
import logger from '../../../utils/logger.js';

// The extension secret as shown in the Twitch developer console (base64). CFX_TWITCH_EXT_SECRET wins
// when both are set; TWITCH_EXT_SECRET is the name the service has always used.
const getExtensionSecret = () => {
    const secret = process.env.CFX_TWITCH_EXT_SECRET || process.env.TWITCH_EXT_SECRET;
    if (!secret) {
        throw new Error('TWITCH_EXT_SECRET not configured');
    }
    return Buffer.from(secret, 'base64');
};

/**
 * Verify a Bits transaction receipt (transaction.transactionReceipt from
 * Twitch.ext.bits.onTransactionComplete). Twitch signs it with the extension
 * secret, so a valid one proves the viewer really spent the Bits (H-401).
 * @returns {{transactionId: string, userId: string, sku: string, bits: number, inDevelopment: boolean}|null}
 */
export function verifyBitsReceipt(receipt) {
    if (typeof receipt !== 'string' || receipt.length > 4096) return null;
    try {
        const decoded = jwt.verify(receipt, getExtensionSecret(), { algorithms: ['HS256'] });
        const d = decoded?.data;
        if (decoded?.topic !== 'bits_transaction_receipt' || !d?.transactionId || !d?.userId || !d?.product?.sku) return null;
        return {
            transactionId: String(d.transactionId),
            userId: String(d.userId),
            sku: String(d.product.sku),
            bits: Number(d.product.cost?.amount) || 0,
            inDevelopment: !!d.product.inDevelopment
        };
    } catch (error) {
        logger.debug('[TwitchJWT] Invalid Bits receipt', { error: error.message });
        return null;
    }
}

/**
 * Verify a Twitch Extension JWT
 * @param {string} token - The JWT from Twitch.ext.onAuthorized
 * @returns {object|null} Decoded payload or null if invalid
 */
export function verifyTwitchJWT(token) {
    try {
        const secret = getExtensionSecret();
        const decoded = jwt.verify(token, secret, {
            algorithms: ['HS256']
        });

        // Validate required fields
        if (!decoded.user_id || !decoded.channel_id) {
            logger.warn('[TwitchJWT] Missing required fields in token');
            return null;
        }

        return {
            userId: decoded.user_id,
            channelId: decoded.channel_id,
            opaqueUserId: decoded.opaque_user_id,
            role: decoded.role, // 'broadcaster', 'moderator', 'viewer', etc.
            isUnlinked: decoded.is_unlinked || false,
            pubsubPerms: decoded.pubsub_perms || {},
            exp: decoded.exp,
            iat: decoded.iat
        };
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            logger.debug('[TwitchJWT] Token expired');
        } else if (error.name === 'JsonWebTokenError') {
            logger.debug('[TwitchJWT] Invalid token', { error: error.message });
        } else {
            logger.error('[TwitchJWT] Verification error', { error: error.message });
        }
        return null;
    }
}

/**
 * Express middleware for Twitch JWT auth
 */
export function twitchJWTMiddleware(req, res, next) {
    // Get token from header
    const authHeader = req.headers['x-extension-jwt'] || req.headers['authorization'];

    if (!authHeader) {
        return res.status(401).json({
            error: 'Missing authentication token',
            code: 'NO_TOKEN'
        });
    }

    // Remove 'Bearer ' prefix if present
    const token = authHeader.replace(/^Bearer\s+/i, '');

    const decoded = verifyTwitchJWT(token);

    if (!decoded) {
        return res.status(401).json({
            error: 'Invalid or expired token',
            code: 'INVALID_TOKEN'
        });
    }

    // Attach to request
    req.twitchUser = decoded;
    next();
}

export default { verifyTwitchJWT, twitchJWTMiddleware };
