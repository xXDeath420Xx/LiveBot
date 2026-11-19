
/**
 * Pure decision for the streamer departure sweeper: which servers holding subscriptions are gone
 * for us, so announcing there can never work again.
 *
 * Never gone while any ready client has the server. Otherwise gone when guild presence already
 * recorded left_at, or when the bot responsible for the server is ready and does not have it.
 * Responsible = the mapped custom bot, unless that bot no longer exists in our system (deleted
 * from custom_bots), in which case nothing could ever serve the server through it and the main
 * bot stands in. A mapped bot that exists but did not log in this boot is not ready, so its
 * servers are left alone, same rule as guildsToMarkLeft.
 *
 * @param {object} p
 * @param {string[]} p.subGuildIds          guilds with active subscriptions
 * @param {Map<string,{left_at:any}>} p.guildRows  guilds rows by id (missing = no row at all)
 * @param {Set<string>} p.presentGuildIds   guilds some ready client has
 * @param {Set<string>} p.readyBotIds       bot ids whose client is ready
 * @param {Map<string,string>} p.mapping    guild -> custom bot id
 * @param {Set<string>} p.knownBotIds       bot ids that still exist (custom_bots)
 * @param {string} p.mainBotId
 * @returns {string[]}
 */
export function subscriptionGuildsGone({ subGuildIds, guildRows, presentGuildIds, readyBotIds, mapping, knownBotIds, mainBotId }) {
    return [...new Set(subGuildIds)].filter((id) => {
        if (presentGuildIds.has(id)) return false;
        if (guildRows.get(id)?.left_at) return true;
        const mapped = mapping.get(id);
        const responsible = mapped && knownBotIds.has(mapped) ? mapped : mainBotId;
        return readyBotIds.has(responsible);
    });
}
