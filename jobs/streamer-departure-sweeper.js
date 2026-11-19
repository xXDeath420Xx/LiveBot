/*
 * Reconciles the streamer tracker against who is actually in each server, and retires the rows
 * belonging to people who have been gone a month.
 *
 * WHY THIS EXISTS WHEN THE GATEWAY EVENTS ALREADY HANDLE DEPARTURES
 *
 * guildMemberRemove and guildBanAdd only fire while a bot is connected. Every departure during a
 * deploy, a crash, a network drop or a guild the bot had not yet joined is invisible to them,
 * permanently — there is no replay. That is exactly how the 53 stale subscriptions found in the
 * 2026-09 audit accumulated: nobody was ever notified about most of them. An event handler alone
 * would have kept the tracker correct going forward and left every existing error in place.
 *
 * So the events are the fast path and this is the truth. Discord's member endpoint is the only
 * thing that actually knows, and asking it costs one cheap request per linked subscription.
 *
 * TWO PASSES, RUN IN THIS ORDER
 *
 *   1. reconcile — every subscription with a linked Discord account gets a membership check.
 *      Missing members are paused and stamped 'sweep'; members found present after being marked
 *      departed are restored, which is what catches a rejoin the gateway missed.
 *
 *   2. retire — subscriptions departed for DELETE_AFTER_DAYS get deleted, but ONLY after the
 *      membership check is repeated at the moment of deletion. This is not belt-and-braces: the
 *      stamp could be thirty days old and the person could have walked back in yesterday during a
 *      restart. Deleting is the one step here with no undo, so it re-asks rather than trusting a
 *      month-old observation.
 *
 * WHAT IT WILL NOT TOUCH
 *
 *   • `permanent = 1` — the owner's explicit "never auto-remove", already honoured by the
 *     Community Support rotation.
 *   • subscriptions whose streamer has no linked discord_user_id — 365 of 958 network-wide. They
 *     cannot be matched to a member, so they are out of scope rather than guessed at.
 *   • guilds the running bot cannot see. Each bot's guild cache is only its own subset, so a guild
 *     that is missing here belongs to a different bot, NOT to nobody. Treating "I can't see it" as
 *     "they left" would empty other bots' trackers.
 *
 * Daily rather than hourly: the thing it measures changes on a scale of days, and the two failure
 * modes it corrects (a missed gateway event, a month-old departure) are both tolerant of a day.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { DELETE_AFTER_DAYS, markReturned } from '../core/streamer-departure.js';
import { subscriptionGuildsGone } from '../core/guild-presence-logic.js';

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

/*
 * A sweep that wanted to delete more than this has misread something — a database blip, a Discord
 * outage answering 404 to everything, a bot that lost its guilds. The whole network had 53 stale
 * rows accumulated over a year, so a single day producing 50 deletions is not a real result. It
 * stops and says so instead of clearing the tracker.
 */
const MAX_DELETES_PER_SWEEP = 50;

/** Ceiling on membership checks in one pass, so a runaway can't sit on the API for hours. */
const MAX_CHECKS_PER_SWEEP = 2000;

/**
 * Fetch the member, distinguishing "not in the guild" from "we could not tell".
 *
 * The distinction is the whole safety story. `null` (unknown) must never be treated as a departure:
 * a 503 from Discord, a permission problem or a network error would otherwise pause everyone in the
 * guild. Only an explicit 10007 / 404 — Discord stating the member does not exist there — counts.
 */
async function memberPresence(guild, userId) {
  try {
    await guild.members.fetch({ user: userId, force: true });
    return true;
  } catch (err) {
    // 10007 = Unknown Member. discord.js surfaces it as `code`; the raw status is on `status`.
    if (err?.code === 10007 || err?.status === 404) return false;
    return null;
  }
}

/** The guild object from whichever bot actually serves it, or null if none of them do. */
function resolveGuild(guildId) {
  if (!global.botManager?.clients) return null;
  for (const [, client] of global.botManager.clients) {
    const guild = client.guilds.cache.get(guildId);
    if (guild) return guild;
  }
  return null;
}

export async function runDepartureSweep() {
  const stats = { checked: 0, paused: 0, restored: 0, deleted: 0, unknown: 0, unreachableGuilds: 0 };

  try {
    stats.guildPass = await departGoneGuilds();
  } catch (err) {
    logger.error(`[StreamerDepartureSweeper] guild-gone pass failed: ${err.message}`);
  }

  let rows;
  try {
    const [result] = await pool.execute(
      `SELECT sub.subscription_id, sub.guild_id, sub.departed_at, sub.permanent,
              s.discord_user_id, s.username, s.platform,
              DATEDIFF(NOW(), sub.departed_at) AS days_gone
         FROM subscriptions sub
         JOIN streamers s ON s.streamer_id = sub.streamer_id
        WHERE s.discord_user_id IS NOT NULL AND s.discord_user_id <> ''
          AND sub.permanent = 0
          -- Deliberately-external streamers (Twitch-team rosters, promoted partners) are not
          -- tracked on the strength of server membership, so membership must not retire them.
          AND sub.tracking_origin <> 'external'
        ORDER BY sub.guild_id
        LIMIT ${MAX_CHECKS_PER_SWEEP}`);
    rows = result;
  } catch (err) {
    logger.error(`[StreamerDepartureSweeper] could not read subscriptions: ${err.message}`);
    return stats;
  }

  // One membership answer per (guild, user) even when they hold several subscriptions in that
  // guild — a Twitch and a TikTok row for the same person is one question, not two.
  const presenceCache = new Map();
  const unreachable = new Set();
  const toDelete = [];

  for (const row of rows) {
    const guild = resolveGuild(row.guild_id);
    if (!guild) {
      // Not an error: this guild belongs to a bot that is not this process's concern, or the bot
      // has been removed from it. Either way we have no standing to judge its members.
      if (!unreachable.has(row.guild_id)) { unreachable.add(row.guild_id); stats.unreachableGuilds++; }
      continue;
    }

    const key = `${row.guild_id}:${row.discord_user_id}`;
    if (!presenceCache.has(key)) {
      presenceCache.set(key, await memberPresence(guild, row.discord_user_id));
      stats.checked++;
    }
    const present = presenceCache.get(key);

    if (present === null) { stats.unknown++; continue; }

    if (present) {
      // Back in the server. Clears the mark and the clock; a no-op for the vast majority.
      if (row.departed_at) stats.restored += await markReturned(row.guild_id, row.discord_user_id);
      continue;
    }

    if (!row.departed_at) {
      // Gone, and nothing had noticed — a departure that happened while the bot was offline.
      const [res] = await pool.execute(
        `UPDATE subscriptions SET paused = 1, departed_at = NOW(), departed_reason = 'sweep'
          WHERE subscription_id = ? AND departed_at IS NULL AND permanent = 0
            AND tracking_origin <> 'external'`,
        [row.subscription_id]);
      if (res.affectedRows) {
        stats.paused++;
        logger.info(`[StreamerDepartureSweeper] paused sub#${row.subscription_id} (${row.platform}/${row.username}) — ${row.discord_user_id} is not in ${row.guild_id}`);
      }
      continue;
    }

    // Marked departed AND confirmed still absent just now. Eligible once the clock runs out.
    if (Number(row.days_gone) >= DELETE_AFTER_DAYS) toDelete.push(row);
  }

  if (toDelete.length > MAX_DELETES_PER_SWEEP) {
    logger.error(`[StreamerDepartureSweeper] ABORTING deletes: ${toDelete.length} rows eligible, ceiling is ${MAX_DELETES_PER_SWEEP}. Nothing deleted — investigate before this runs again.`);
  } else {
    for (const row of toDelete) {
      try {
        // Re-asserts departed_at in the WHERE so a rejoin racing this sweep wins.
        const [res] = await pool.execute(
          'DELETE FROM subscriptions WHERE subscription_id = ? AND departed_at IS NOT NULL AND permanent = 0',
          [row.subscription_id]);
        if (res.affectedRows) {
          stats.deleted++;
          logger.info(`[StreamerDepartureSweeper] deleted sub#${row.subscription_id} (${row.platform}/${row.username}) — gone from ${row.guild_id} for ${row.days_gone} days`);
        }
      } catch (err) {
        logger.error(`[StreamerDepartureSweeper] delete failed for sub#${row.subscription_id}: ${err.message}`);
      }
    }
  }

  logger.info(`[StreamerDepartureSweeper] sweep complete — checked ${stats.checked}, paused ${stats.paused}, restored ${stats.restored}, deleted ${stats.deleted}, undetermined ${stats.unknown}, guilds not served here ${stats.unreachableGuilds}`);
  return stats;
}

export function startStreamerDepartureSweeper() {
  if (task) return task;
  // 04:40 — after the 03:00 backup window, well clear of the nightly jobs around midnight.
  task = cron.schedule('40 4 * * *', () => {
    runDepartureSweep().catch(err =>
      logger.error(`[StreamerDepartureSweeper] sweep threw: ${err.message}`));
  });
  logger.info('[StreamerDepartureSweeper] scheduled daily at 04:40');
  // Also run the guild-gone pass once per boot, after every client has logged in and guild
  // presence has reconciled (startup takes ~7 min), so a restart applies it without waiting a day.
  startupTimer = setTimeout(() => {
    departGoneGuilds().catch(err =>
      logger.error(`[StreamerDepartureSweeper] startup guild-gone pass threw: ${err.message}`));
  }, 12 * 60_000);
  return task;
}

export function stopStreamerDepartureSweeper() {
  if (task) { task.stop(); task = null; }
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
}
