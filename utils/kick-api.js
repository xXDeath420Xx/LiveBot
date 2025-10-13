const logger = require('./logger');
const { getCycleTLSInstance } = require('./tls-manager'); // Corrected import

// This module centralizes all Kick API interactions.

async function getKickUser(username) {
    if (typeof username !== 'string' || !username) return null;
    logger.info(`[Kick API] getKickUser started for: ${username}`);
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const cycleTLS = await getCycleTLSInstance();
            const requestUrl = `https://kick.com/api/v1/channels/${username}`;
            logger.info(`[Kick API] Initiating cycleTLS request for ${username} to ${requestUrl} (Attempt ${attempt})`);

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`CycleTLS request timed out after 30 seconds for ${username}`)), 30000)
            );

            const cycleTLSRequest = cycleTLS(requestUrl, {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            });

            const response = await Promise.race([cycleTLSRequest, timeoutPromise]);
            logger.info(`[Kick API] cycleTLS request completed for ${username}. Status: ${response.status}`);

            if (response.status === 200 && response.body) {
                const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
                if (!data || !data.user) {
                    logger.info(`[Kick API] No 'user' object in response for '${username}', assuming non-existent.`);
                    return null;
                }
                logger.info(`[Kick API] Successfully retrieved Kick user data for ${username}.`);
                return data;
            }

            if (response.status === 404) {
                logger.warn(`[Kick API] Received 404 for ${username}, user likely does not exist. Not retrying.`);
                return null;
            }

            logger.warn(`[Kick API] Received status ${response.status} for ${username}. Retrying in ${RETRY_DELAY / 1000}s...`);

        } catch (error) {
            logger.error(`[Kick API Check Error] for "${username}" on attempt ${attempt}: ${error.message}`);
        }

        if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }

    logger.error(`[Kick API] All retries failed for ${username}.`);
    return null;
}

async function isStreamerLive(username) {
    try {
        const user = await getKickUser(username);
        return user?.livestream?.is_live || false;
    } catch (error) {
        logger.error(`[Kick API] Error checking live status for ${username}:`, { error });
        return false;
    }
}

async function getStreamDetails(username) {
    try {
        const user = await getKickUser(username);
        if (!user || !user.livestream || !user.livestream.is_live) {
            return null;
        }

        return {
            title: user.livestream.session_title,
            game_name: user.livestream.categories[0]?.name || 'Not Set',
            viewer_count: user.livestream.viewer_count || 0,
            thumbnail_url: user.livestream.thumbnail?.url || null,
        };
    } catch (error) {
        logger.error(`[Kick API] Failed to get stream details for ${username}:`, { error });
        return null;
    }
}

module.exports = { getKickUser, isStreamerLive, getStreamDetails };