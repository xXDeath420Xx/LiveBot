/**
 * OAuth2 Token Verification
 * For standalone mode (non-extension) authentication
 */

import jwt from 'jsonwebtoken';
import logger from '../../../utils/logger.js';

// Game JWT secret (separate from Twitch extension secret)
const getGameSecret = () => {
    const secret = process.env.CFX_JWT_SECRET;
    if (!secret) {
        throw new Error('CFX_JWT_SECRET not configured');
    }
    return secret;
};

/**
 * Create a game JWT for a player
 * @param {object} player - Player data
 * @param {string} player.id - Player database ID
 * @param {string} player.platform - 'twitch' or 'kick'
 * @param {string} player.platformUserId - Platform-specific user ID
 * @param {string} player.displayName - Display name
 * @returns {string} JWT token
 */
export function createGameJWT(player) {
    const secret = getGameSecret();

    return jwt.sign({
        sub: player.id,
        platform: player.platform,
        platformUserId: player.platformUserId,
        displayName: player.displayName,
        type: 'game'
    }, secret, {
        expiresIn: '1h',
        algorithm: 'HS256'
    });
}

/**
 * Create a refresh token
 * @param {number} playerId - Player database ID
 * @returns {string} Refresh token
 */
export function createRefreshToken(playerId) {
    const secret = getGameSecret();

    return jwt.sign({
        sub: playerId,
        type: 'refresh'
    }, secret, {
        expiresIn: '7d',
        algorithm: 'HS256'
    });
}

/**
 * Verify a game JWT
 * @param {string} token - The game JWT
 * @returns {object|null} Decoded payload or null if invalid
 */
export function verifyGameJWT(token) {
    try {
        const secret = getGameSecret();
        const decoded = jwt.verify(token, secret, {
            algorithms: ['HS256']
        });

        if (decoded.type !== 'game') {
            return null;
        }

        return {
            playerId: decoded.sub,
            platform: decoded.platform,
            platformUserId: decoded.platformUserId,
            displayName: decoded.displayName,
            exp: decoded.exp,
            iat: decoded.iat
        };
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            logger.debug('[OAuthAuth] Game token expired');
        } else if (error.name === 'JsonWebTokenError') {
            logger.debug('[OAuthAuth] Invalid game token', { error: error.message });
        }
        return null;
    }
}

/**
 * Verify a refresh token
 * @param {string} token - The refresh token
 * @returns {object|null} Decoded payload or null if invalid
 */
export function verifyRefreshToken(token) {
    try {
        const secret = getGameSecret();
        const decoded = jwt.verify(token, secret, {
            algorithms: ['HS256']
        });

        if (decoded.type !== 'refresh') {
            return null;
        }

        return {
            playerId: decoded.sub,
            exp: decoded.exp,
            iat: decoded.iat
        };
    } catch (error) {
        return null;
    }
}

/**
 * Express middleware for game JWT auth
 */
export function oauthMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Missing authentication token',
            code: 'NO_TOKEN'
        });
    }

    const token = authHeader.substring(7);
    const decoded = verifyGameJWT(token);

    if (!decoded) {
        return res.status(401).json({
            error: 'Invalid or expired token',
            code: 'INVALID_TOKEN'
        });
    }

    req.gameUser = decoded;
    next();
}

export default {
    createGameJWT,
    createRefreshToken,
    verifyGameJWT,
    verifyRefreshToken,
    oauthMiddleware
};
