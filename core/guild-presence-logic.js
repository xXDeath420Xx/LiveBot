/**
 * Pure half of core/guild-presence.js (no DB import, so tests can load it). See that file
 * for why these rules exist.
 */

/** True when any ready client other than `exceptClient` still has the guild. */
export function servedByAnotherClient(botManager, guildId, exceptClient = null) {
    if (!botManager?.clients) return false;
    for (const client of botManager.clients.values()) {
        if (client === exceptClient) continue;
        if (client.isReady?.() && client.guilds.cache.has(guildId)) return true;
    }
    return false;
}

/**
 * Pure decision for the startup sweep.
 * @param {object} p
 * @param {string[]} p.openGuildIds   guilds rows with left_at IS NULL
 * @param {Set<string>} p.presentGuildIds guilds some ready client has
 * @param {Set<string>} p.readyBotIds  bot ids whose client is ready
 * @param {Map<string,string>} p.mapping guild -> custom bot id
 * @param {string} p.mainBotId
 * @returns {string[]} guild ids to mark left
 */
export function guildsToMarkLeft({ openGuildIds, presentGuildIds, readyBotIds, mapping, mainBotId }) {
    return openGuildIds.filter(id =>
        !presentGuildIds.has(id) && readyBotIds.has(mapping.get(id) || mainBotId));
}

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

/**
 * Should this bot poll a feed that posts into guildId? (H-315)
 *
 * Every bot client runs the social-feed checks. Twitter and Bluesky used to fetch every feed in the
 * database on every bot (about 45 times a cycle) and only then look for the server, so the feeds
 * of a server no bot is in any more were polled forever ("Guild … not found", 200 times in 48 h).
 * A feed is polled by the one bot that serves its server: the server must be in this client's
 * cache, and if a bot manager is running it must pick this client for that server. A server no
 * bot of ours is in is skipped by everyone and picked up again as soon as a bot is back, the same
 * rule the departure sweeper uses for subscriptions ("gone" only while no ready client has it).
 */
export function pollsGuild(client, guildId, botManager = null) {
    if (!client?.guilds?.cache?.has?.(guildId)) return false;
    const owner = botManager?.getClientForGuild?.(guildId);
    return !owner || owner === client;
}
