import { logger } from './logger';
import { checkInstagram } from './api_checks';

interface InstagramUserData {
    username: string;
    profileImageUrl: string | null;
    isLive: boolean;
}

interface InstagramStreamData {
    isLive: boolean;
    profileImageUrl?: string | null;
    title?: string;
    game?: string;
    viewers?: string | number;
    thumbnailUrl?: string | null;
}

async function getInstagramUser(username: string): Promise<InstagramUserData | null> {
    if (typeof username !== 'string' || !username) return null;

    logger.info(`[Instagram API] getInstagramUser started for: ${username}`);
    try {
        const instagramData = await checkInstagram(username);
        if (instagramData && instagramData.profileImageUrl) {
            logger.info(`[Instagram API] Successfully retrieved Instagram user ${username}.`);
            return {
                username: username,
                profileImageUrl: instagramData.profileImageUrl,
                isLive: (typeof instagramData.isLive === 'boolean' ? instagramData.isLive : false)
            };
        }
        logger.info(`[Instagram API] Could not find Instagram user ${username}.`);
        return null;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Instagram API] Error getting user ${username}:`, { message: errorMessage });
        return null;
    }
}

async function isStreamerLive(username: string): Promise<boolean> {
    try {
        const data = await checkInstagram(username);
        return (typeof data?.isLive === 'boolean' ? data.isLive : false);
    } catch (error: unknown) {
        logger.error(`[Instagram API] Error checking live status for ${username}:`, { error });
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
        const data = await checkInstagram(username);
        if (!data || !data.isLive) {
            return null;
        }

        return {
            title: (data as any).title || `${username} is live on Instagram`,
            game_name: (data as any).game || 'N/A',
            viewer_count: (data as any).viewers || 'N/A',
            thumbnail_url: (data as any).thumbnailUrl || data.profileImageUrl || null,
        };
    } catch (error: unknown) {
        logger.error(`[Instagram API] Failed to get stream details for ${username}:`, { error });
        return null;
    }
}

export { getInstagramUser, isStreamerLive, getStreamDetails };
