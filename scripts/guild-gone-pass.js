let task = null;
let startupTimer = null;

/*
 * More servers than this vanishing in one pass means a bot lost its guild cache or Discord is
 * misbehaving, not that a third of the network deleted their servers overnight. Stop and say so.
 */
const MAX_GUILDS_GONE_PER_SWEEP = 12;

/**
 * Pass 0: subscriptions in servers that are gone for us entirely.
 *
 * The membership reconcile below skips any server no running bot can see, on purpose: "this bot
 * can't see it" is not "it's gone". But a server that really is gone (deleted, or its bot removed
 * from our system) then stays active forever, and nothing could ever post there. This pass uses the
 * stricter evidence in subscriptionGuildsGone() and pauses those with reason 'guild_left'. It also
 * restores 'guild_left' rows whose server a bot is back in. Never deletes; permanent = 1 is honoured.
 */
export async function departGoneGuilds() {
  const stats = { guildsGone: 0, paused: 0, restored: 0, aborted: false };
  const bm = global.botManager;
  if (!bm?.clients?.size) return stats;

  const readyBotIds = new Set();
  const presentGuildIds = new Set();
  for (const [botId, client] of bm.clients) {
    if (!client.isReady?.()) continue;
    readyBotIds.add(botId);
    for (const id of client.guilds.cache.keys()) presentGuildIds.add(id);
  }
  if (!readyBotIds.has(bm.defaultBotId)) return stats;

  const [back] = await pool.query(
    "SELECT DISTINCT guild_id FROM subscriptions WHERE departed_reason = 'guild_left'");
  const returned = back.map((r) => r.guild_id).filter((id) => presentGuildIds.has(id));
  if (returned.length) {
    const [res] = await pool.query(
      "UPDATE subscriptions SET paused = 0, departed_at = NULL, departed_reason = NULL WHERE departed_reason = 'guild_left' AND guild_id IN (?)",
      [returned]);
    stats.restored = res.affectedRows;
    logger.info(`[StreamerDepartureSweeper] restored ${res.affectedRows} subscription(s) — a bot is back in ${returned.join(', ')}`);
  }

  const [active] = await pool.query('SELECT DISTINCT guild_id FROM subscriptions WHERE departed_at IS NULL AND permanent = 0');
  const ids = active.map((r) => r.guild_id);
  if (!ids.length) return stats;
  const [rows] = await pool.query('SELECT guild_id, left_at FROM guilds WHERE guild_id IN (?)', [ids]);
  const [maps] = await pool.query('SELECT guild_id, bot_id FROM guild_bot_mapping');
  const [known] = await pool.query('SELECT bot_id FROM custom_bots');

  const gone = subscriptionGuildsGone({
    subGuildIds: ids,
    guildRows: new Map(rows.map((r) => [r.guild_id, r])),
    presentGuildIds,
    readyBotIds,
    mapping: new Map(maps.map((m) => [m.guild_id, m.bot_id])),
    knownBotIds: new Set(known.map((k) => String(k.bot_id))),
    mainBotId: bm.defaultBotId,
  });
  if (!gone.length) return stats;
  if (gone.length > MAX_GUILDS_GONE_PER_SWEEP) {
    stats.aborted = true;
    logger.error(`[StreamerDepartureSweeper] ABORTING guild-gone pass: ${gone.length} servers look gone, ceiling is ${MAX_GUILDS_GONE_PER_SWEEP}. Nothing paused — investigate.`, { guildIds: gone });
    return stats;
  }

  const [res] = await pool.query(
    "UPDATE subscriptions SET paused = 1, departed_at = NOW(), departed_reason = 'guild_left' WHERE guild_id IN (?) AND departed_at IS NULL AND permanent = 0",
    [gone]);
  stats.guildsGone = gone.length;
  stats.paused = res.affectedRows;
  logger.warn(`[StreamerDepartureSweeper] paused ${res.affectedRows} subscription(s) in ${gone.length} server(s) no bot can serve any more`, { guildIds: gone });
  return stats;
}
