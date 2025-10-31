import { logger } from './logger';
import { checkFacebook } from './api_checks';

interface FacebookUserData {
    username: string;
    profileImageUrl: string | null;
    isLive: boolean;
}

interface FacebookStreamData {
    isLive: boolean;
    profileImageUrl?: string | null;
    title?: string;
    game?: string;
    viewers?: string | number;
    thumbnailUrl?: string | null;
}

async function getFacebookUser(username: string): Promise<FacebookUserData | null> {
    if (typeof username !== 'string' || !username) return null;

    logger.info(`[Facebook API] getFacebookUser started for: ${username}`);
    try {
        const facebookData = await checkFacebook(username);
        if (facebookData && facebookData.profileImageUrl) {
            logger.info(`[Facebook API] Successfully retrieved Facebook Gaming user ${username}.`);
            return {
                username: username,
                profileImageUrl: facebookData.profileImageUrl,
                isLive: (typeof facebookData.isLive === 'boolean' ? facebookData.isLive : false)
            };
        }
        logger.info(`[Facebook API] Could not find Facebook Gaming user ${username}.`);
        return null;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Facebook API] Error getting user ${username}:`, { message: errorMessage });
        return null;
    }
}

async function isStreamerLive(username: string): Promise<boolean> {
    try {
        const data = await checkFacebook(username);
        return (typeof data?.isLive === 'boolean' ? data.isLive : false);
    } catch (error: unknown) {
        logger.error(`[Facebook API] Error checking live status for ${username}:`, { error });
        return false;
    }
}

interface StreamDetails {
    title: string;
    game_name: string;
    viewer_count: string | number;
    thumbnail_url: string | null;
}

async function getStreamDetails(username: string): Promise<StreamDetails | null> {
    try {
        const data = await checkFacebook(username);
        if (!data || !data.isLive) {
            return null;
        }

        return {
            title: (data as any).title || 'Live on Facebook Gaming',
            game_name: (data as any).game || 'N/A',
            viewer_count: (data as any).viewers || 'N/A',
            thumbnail_url: (data as any).thumbnailUrl || data.profileImageUrl || null,
        };
    } catch (error: unknown) {
        logger.error(`[Facebook API] Failed to get stream details for ${username}:`, { error });
        return null;
    }
}

export { getFacebookUser, isStreamerLive, getStreamDetails };
