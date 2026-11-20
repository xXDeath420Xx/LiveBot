import logger from '../utils/logger.js';

/**
 * Achievement awards from the features they are about (register H-817): /pokemon catches, quests, duels, Last.fm,
 * memes, fortunes, animal pictures, game and film lookups, birthdays. Each feature calls awardAchievement() at the
 * point its action has succeeded; everything else goes through core/achievement-manager.js as before
 * (trackAchievement: counted per server, completed and paid once, the claim guarded so two events cannot both pay;
 * coins only where the economy is on, XP only where leveling is on; the unlock posted only where announcements are
 * switched on with a channel).
 *
 * Never throws and never holds up the reply: the promise it returns always resolves (to the completion or null).
 */

/**
 * The achievement manager for a server: the bot's own (index.js attachManagers gives every client one, custom-branded
 * bots included: BotManager step 8), else the server's bot's, else the main bot's (a client built without managers).
 */
export function achievementManagerFor(client, guildId) {
    return client?.achievementManager
        || global.botManager?.getClientForGuild?.(guildId)?.achievementManager
        || global.botManager?.clients?.get?.('default')?.achievementManager
        || null;
}

/**
 * ctx: an interaction (or the message adapter): user, guildId/guild and client come from it; any of them can be
 * given instead (userId, guildId, client) for work that has no interaction (a birthday post, a PvP result).
 * progress: added to the count (trackAchievement). total: a count the feature already keeps, or a function that
 * reads it; progress is raised to it, never added to (recordTotal), so repeating it changes nothing.
 */
export function awardAchievement(ctx, key, { progress = 1, total = null, eventData = {}, userId = null, guildId = null, client = null } = {}) {
    const uid = userId ?? ctx?.user?.id ?? null;
    const gid = guildId ?? ctx?.guildId ?? ctx?.guild?.id ?? null;
    if (!uid || !gid || (!userId && ctx?.user?.bot)) return Promise.resolve(null);
    const am = achievementManagerFor(client ?? ctx?.client, gid);
    if (!am) return Promise.resolve(null);
    const run = async () => {
        if (total === null) return am.trackAchievement(uid, gid, key, progress, eventData);
        const n = typeof total === 'function' ? await total() : total;
        return am.recordTotal(uid, gid, key, n, eventData);
    };
    return run().catch((error) => {
        logger.warn('[Achievements] award failed', { key, guildId: gid, userId: uid, error: error.message });
        return null;
    });
}

/** `return withAchievement(ix, 'key', await handler(ix))`: starts the award and hands the handler's result back. */
export function withAchievement(ctx, key, result, opts) {
    awardAchievement(ctx, key, opts);
    return result;
}
