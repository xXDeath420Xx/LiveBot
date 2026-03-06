/**
 * Discord username resolver with batched rate limiting.
 * Resolves user IDs to current usernames via Discord REST API.
 */

import { Routes } from 'discord.js';
import { USERNAME_BATCH_SIZE, USERNAME_BATCH_DELAY_MS } from './constants.js';

/**
 * Resolve usernames for a list of user IDs.
 * @param {REST} rest - Discord REST client
 * @param {string[]} userIds - Array of user IDs to resolve
 * @returns {Map<string, {username: string, globalName: string|null, display: string}>}
 */
export async function resolveUsernames(rest, userIds) {
    const results = new Map();
    let resolved = 0;
    let failed = 0;

    console.log(`\nResolving usernames for ${userIds.length} user IDs...`);

    for (let i = 0; i < userIds.length; i++) {
        const userId = userIds[i];

        // Skip if already resolved (deduplication)
        if (results.has(userId)) continue;

        try {
            const user = await rest.get(Routes.user(userId));
            results.set(userId, {
                username: user.username,
                globalName: user.global_name || null,
                display: user.global_name || user.username,
            });
            resolved++;
        } catch (err) {
            // 404 = deleted/unknown user, anything else is an API error
            const status = err.status || err.rawError?.code;
            results.set(userId, {
                username: null,
                globalName: null,
                display: status === 404 || status === 10013
                    ? 'Deleted User'
                    : 'Unknown User',
            });
            failed++;
        }

        // Rate limit: pause after every batch
        if ((i + 1) % USERNAME_BATCH_SIZE === 0) {
            console.log(`  ...resolved ${i + 1}/${userIds.length}`);
            await new Promise(r => setTimeout(r, USERNAME_BATCH_DELAY_MS));
        }
    }

    console.log(`  Resolved: ${resolved}, Failed/Deleted: ${failed}`);
    return results;
}
