import { logger } from './logger';
import { checkTrovo, getTrovoUser } from './api_checks';

interface StreamDetails {
    title: string;
    game_name: string;
    viewer_count: number | string;
    thumbnail_url: string | null;
    started_at: string | null;
}

/**
 * Check if a Trovo user is currently live
 * Uses browser automation via api_checks.ts
 */
async function isStreamerLive(username: string): Promise<boolean> {
    try {
        logger.info(`[Trovo API] Checking if user ${username} is live`);
        const result = await checkTrovo(username);

        if (result.isLive === true) {
            logger.info(`[Trovo API] User ${username} is LIVE`);
            return true;
        }

        logger.info(`[Trovo API] User ${username} is NOT live`);
        return false;
    } catch (error: unknown) {
        logger.error(`[Trovo API] Error checking live status for ${username}:`, { error });
        return false;
    }
}

/**
 * Get stream details for a live Trovo user
 * Uses browser automation via api_checks.ts
 */
async function getStreamDetails(username: string): Promise<StreamDetails | null> {
    try {
        logger.info(`[Trovo API] Fetching stream details for user ${username}`);
        const result = await checkTrovo(username);

        if (result.isLive !== true) {
            logger.info(`[Trovo API] User ${username} is not live, no details available`);
            return null;
        }

        return {
            title: result.title || 'Untitled Stream',
            game_name: result.game || 'N/A',
            viewer_count: result.viewers || 0,
            thumbnail_url: result.thumbnailUrl || null,
            started_at: null, // Trovo doesn't provide exact start time via browser scraping
        };
    } catch (error: unknown) {
        logger.error(`[Trovo API] Failed to get stream details for ${username}:`, { error });
        return null;
    }
}

/**
 * Validate that a Trovo user exists
 * Uses browser automation via api_checks.ts
 */
async function validateUser(username: string): Promise<boolean> {
    try {
        logger.info(`[Trovo API] Validating user ${username}`);
        const user = await getTrovoUser(username);

        if (user) {
            logger.info(`[Trovo API] User ${username} validated successfully`);
            return true;
        }

        logger.info(`[Trovo API] User ${username} does not exist`);
        return false;
    } catch (error: unknown) {
        logger.error(`[Trovo API] Error validating user ${username}:`, { error });
        return false;
    }
}

export { isStreamerLive, getStreamDetails, validateUser };
