import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { logFeatureEvent } from './feature-log.js';
import { latestUploads, classifyUploads } from '../utils/platforms/youtube-uploads.js';
import { buildFeedContent } from './feed-message.js';
import { pollsGuild } from './guild-presence-logic.js';
import { resolveYouTubeChannelId } from '../utils/platforms/youtube-resolve.js';

// Uploads remembered per feed, so a re-ordered or re-listed video is not posted twice.
const SEEN_KEEP = 60;
// New uploads posted per check at most; anything beyond waits for the next check.
const MAX_NEW_PER_CHECK = 3;

const UC_ID = /^UC[A-Za-z0-9_-]{22}$/;
const REPAIR_PER_RUN = 5;
const REPAIR_RETRY_HOURS = 6;
let repairing = null;

/**
 * H-669: a feed saved as a link, @handle or name (older add paths stored the text as typed) is never
 * polled, because the checker only reads UC… ids. Resolve such rows to their id. When the same YouTube
 * channel is already followed into the same Discord channel, the broken duplicate is removed. A row that
 * cannot be resolved records why and is retried after REPAIR_RETRY_HOURS. Shared by every bot client in
 * the process, so it runs once at a time. `deps` is for tests.
 * @returns {Promise<{fixed: number, removed: number, failed: number}>}
 */
export async function repairFeedChannelIds(deps = {}) {
  const db = deps.db || pool;
  const resolve = deps.resolve || resolveYouTubeChannelId;
  const out = { fixed: 0, removed: 0, failed: 0 };
  const [rows] = await db.execute(
    `SELECT id, youtube_channel_id FROM youtube_feeds
      WHERE youtube_channel_id NOT REGEXP '^UC[A-Za-z0-9_-]{22}$'
        AND (suspended_until IS NULL OR suspended_until < NOW())
      ORDER BY id LIMIT ${REPAIR_PER_RUN}`
  );
  for (const row of rows) {
    let channelId;
    try {
      ({ channelId } = await resolve(row.youtube_channel_id));
      if (!UC_ID.test(String(channelId || ''))) throw new Error('No channel id found.');
    } catch (err) {
      out.failed++;
      await db.execute(
        `UPDATE youtube_feeds SET last_error = ?, failed_count = failed_count + 1,
                suspended_until = DATE_ADD(NOW(), INTERVAL ${REPAIR_RETRY_HOURS} HOUR) WHERE id = ?`,
        [`Could not find this YouTube channel: ${String(err.message).slice(0, 200)}`, row.id]
      );
      continue;
    }
    try {
      await db.execute('UPDATE youtube_feeds SET youtube_channel_id = ?, failed_count = 0, last_error = NULL WHERE id = ?', [channelId, row.id]);
      out.fixed++;
      logger.info(`[YouTubeFeed] Feed ${row.id}: "${row.youtube_channel_id}" resolved to ${channelId}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await db.execute('DELETE FROM youtube_feeds WHERE id = ?', [row.id]);
      out.removed++;
      logger.info(`[YouTubeFeed] Feed ${row.id}: "${row.youtube_channel_id}" is ${channelId}, already followed there; removed the duplicate`);
    }
  }
  return out;
}

/**
 * Check all YouTube feeds and post new content
 */
async function checkYouTubeFeeds(client) {
  try {
    // Fix rows saved as a link or @handle first, so they are polled in this same check (H-669).
    repairing ||= repairFeedChannelIds()
      .catch(err => logger.warn(`[YouTubeFeed] Channel id repair failed: ${err.message}`))
      .finally(() => { repairing = null; });
    await repairing;
    // Skip feeds that have been suspended due to repeated failures (circuit
    // breaker). Without this, malformed channel IDs spam the logs forever —
    // 671 warnings in ~hour before this fix.
    const [feeds] = await pool.execute(
      `SELECT * FROM youtube_feeds
       WHERE (suspended_until IS NULL OR suspended_until < NOW())
         AND youtube_channel_id REGEXP '^UC[A-Za-z0-9_-]{22}$'`
    );
    // Every bot client runs this check; each handles only the servers it is in. Fetching first and checking
    // the guild after meant every feed was downloaded once per bot (about 45 times a cycle).
    // One bot per server (H-315: core/guild-presence-logic.js pollsGuild).
    const mine = feeds.filter(feed => pollsGuild(client, feed.guild_id, global.botManager));
    for (const feed of mine) {
      await processYouTubeFeed(feed, client);
    }
  } catch (error) {
    logger.error('[YouTubeFeed] Error checking YouTube feeds:', error);
  }
}

const parseSeen = raw => {
  if (!raw) return null;
  try { const ids = JSON.parse(raw); return Array.isArray(ids) ? ids : null; } catch { return null; }
};

/**
 * Process a single YouTube feed
 */
async function processYouTubeFeed(feed, client) {
  try {
    const { uploads, channelName: sourceName, source } = await latestUploads(feed.youtube_channel_id);
    if (!uploads.length) return;

    const seen = parseSeen(feed.seen_video_ids);
    if (!seen) {
      // First check of this feed (or the first since the switch to tracking seen ids): remember what is already
      // there and post nothing, so turning a feed on never posts the channel's back catalogue.
      await pool.execute(
        'UPDATE youtube_feeds SET seen_video_ids = ?, last_video_id = ?, failed_count = 0, last_error = NULL WHERE id = ?',
        [JSON.stringify(uploads.map(u => u.id).slice(0, SEEN_KEEP)), uploads[0].id, feed.id]
      );
      logger.info(`[YouTubeFeed] Feed ${feed.id} (${feed.channel_name || feed.youtube_channel_id}) baselined from ${source} with ${uploads.length} uploads`);
      return;
    }

    const known = new Set(seen);
    // uploads are newest-first; post the oldest new one first so the channel reads in order.
    const fresh = uploads.filter(u => !known.has(u.id)).slice(0, MAX_NEW_PER_CHECK).reverse();
    if (!fresh.length) {
      // Successful fetch but nothing new — still reset failure counter so
      // a temporary blip doesn't trip the circuit breaker.
      if (feed.failed_count > 0) {
        await pool.execute('UPDATE youtube_feeds SET failed_count = 0, last_error = NULL WHERE id = ?', [feed.id]);
      }
      return;
    }

    const guild = client.guilds.cache.get(feed.guild_id);
    if (!guild) return;
    const channel = await guild.channels.fetch(feed.discord_channel_id).catch(() => null);
    if (!channel) return;

    // Update the channel name in the database if it's not set
    let channelName = feed.channel_name;
    if (!channelName && sourceName) {
      channelName = sourceName;
      await pool.execute('UPDATE youtube_feeds SET channel_name = ? WHERE id = ?', [channelName, feed.id]);
    }
    channelName ||= 'This channel';

    // Opt-in pings: ping_role_id is NULL by default (no ping, just embed). When set, ping that one
    // role and nothing else, or @everyone when it is the literal 'everyone' (as subscriptions do in
    // utils/announcer.js). allowed_mentions only ever lets through the ping that was chosen.
    const pingRoleId = feed.ping_role_id || null;
    const everyone = pingRoleId === 'everyone';
    const mention = everyone ? '@everyone' : pingRoleId ? `<@&${pingRoleId}>` : null;

    // Type toggles (include_videos / include_shorts / include_live; a missing column counts as on).
    // Uploads are only classified when a toggle is off, so a feed with all three on makes no extra
    // requests and posts exactly as before. Skipped uploads are still remembered as seen below.
    const wantVideos = feed.include_videos !== 0;
    const wantShorts = feed.include_shorts !== 0;
    const wantLive = feed.include_live !== 0;
    const kinds = (wantVideos && wantShorts && wantLive) ? null : await classifyUploads(fresh);

    const posted = [];
    const skipped = [];
    for (const video of fresh) {
      const kind = kinds?.get(video.id);
      const isShort = kind ? kind.short : !!video.short;
      if (kinds) {
        const allowed = isShort ? wantShorts : kind?.live ? wantLive : wantVideos;
        if (!allowed) { skipped.push(video.id); continue; }
      }
      const typeWord = isShort ? 'Short' : 'video';
      const embed = new EmbedBuilder()
        .setColor(themeColor(guild?.id, 'danger'))
        .setTitle(String(video.title).slice(0, 256))
        .setURL(video.url)
        .setAuthor({
          name: `${channelName} just uploaded a new ${typeWord}!`,
          iconURL: 'https://i.imgur.com/k2EXDBl.png'
        })
        .setImage(video.thumbnail);
      if (video.description) embed.setDescription(video.description.length > 250 ? `${video.description.substring(0, 250)}...` : video.description);
      if (video.published) embed.setTimestamp(new Date(video.published));

      let content = mention
        ? `${mention} a new ${typeWord} from **${channelName}** is out!`
        : `A new ${typeWord} from **${channelName}** is out!`;
      let allowedMentions = everyone ? { parse: ['everyone'] } : pingRoleId ? { parse: [], roles: [pingRoleId] } : { parse: [] };
      // A custom message replaces the default line; the ping (if any) still goes in front.
      if (feed.custom_message && String(feed.custom_message).trim()) {
        const built = buildFeedContent({
          template: feed.custom_message,
          pingRoleId,
          vars: { channel: channelName, title: video.title, type: typeWord, url: video.url },
        });
        content = built.content;
        allowedMentions = built.allowedMentions || { parse: [] };
      }
      await channel.send({
        content,
        embeds: [embed],
        allowedMentions,
      });
      posted.push(video.id);
    }
    if (skipped.length) logger.info(`[YouTubeFeed] Feed ${feed.id} skipped ${skipped.length} upload(s) by its type filter: ${skipped.join(', ')}`);

    const nextSeen = [...new Set([...uploads.map(u => u.id), ...seen])].slice(0, SEEN_KEEP);
    await pool.execute(
      'UPDATE youtube_feeds SET seen_video_ids = ?, last_video_id = ?, failed_count = 0, last_error = NULL WHERE id = ?',
      [JSON.stringify(nextSeen), uploads[0].id, feed.id]
    );
    logger.info(`[YouTubeFeed] Feed ${feed.id} posted ${posted.length} upload(s) from ${source}: ${posted.join(', ')}`);
  } catch (error) {
    // Circuit breaker: track consecutive failures, suspend after 5 in a row
    // for 24h. Stops "channel doesn't exist" feeds from spamming the logs +
    // burning HTTP requests on every check cycle.
    try {
      const [r] = await pool.execute(
        `UPDATE youtube_feeds
         SET failed_count = failed_count + 1,
             last_error = ?,
             suspended_until = CASE WHEN failed_count + 1 >= 5 THEN DATE_ADD(NOW(), INTERVAL 24 HOUR) ELSE suspended_until END
         WHERE id = ?`,
        [String(error.message || error).slice(0, 240), feed.id]
      );
      if (r.affectedRows > 0) {
        const newCount = (feed.failed_count || 0) + 1;
        if (newCount === 5) {
          logger.error(`[YouTubeFeed] Suspending feed ${feed.id} (channel "${feed.youtube_channel_id}") for 24h after 5 consecutive failures: ${error.message}`);
          const logGuild = global.botManager?.getClientForGuild?.(feed.guild_id)?.guilds.cache.get(feed.guild_id)
            || client?.guilds?.cache?.get(feed.guild_id);
          void logFeatureEvent(() => (logGuild), 'system.featureDisabled', () => ({
            title: '⛔ Feature Auto-Disabled',
            description: 'YouTube upload alerts for a channel were paused for 24 hours after 5 failed checks in a row. They resume automatically; if it keeps failing, check the YouTube channel ID.',
            fields: [
              ['Feature', 'YouTube upload alerts'],
              ['Why', `5 failed checks in a row: ${String(error.message || error).slice(0, 200)}`, false],
              ['YouTube channel', feed.channel_name || feed.youtube_channel_id],
              ['Posts to', feed.discord_channel_id ? `<#${feed.discord_channel_id}>` : null],
              ['Resumes', `<t:${Math.floor(Date.now() / 1000) + 24 * 3600}:R>`],
            ],
          }));
        }
      }
    } catch (_) { /* meta-failure on the failure counter — don't compound */ }
    logger.warn(`[YouTubeFeed] Failed to process feed for channel ID ${feed.youtube_channel_id}:`, error.message);
  }
}

export { checkYouTubeFeeds };
