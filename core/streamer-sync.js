/**
 * Universal cross-platform streamer sync.
 *
 * When a Discord user is added to a guild's stream list on ANY one platform,
 * this pulls in every OTHER platform that user is already linked to in the
 * system (Twitch / Kick / YouTube / Trovo …) and subscribes those too — so
 * nobody has to add each platform by hand (death420's request, generalized).
 *
 * Safety: it only ADDS platforms not yet subscribed in the guild; it never
 * re-routes or touches an existing subscription (so protected placements like
 * Admins/Mods/VIP/Founder lists are left alone).
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import {
  isStreamerAlreadyTracked, getTeamSubscriptionId, createStreamerAndSubscription,
} from './self-promo-handler.js';

const keyOf = (platform, username) => `${platform}:${String(username).toLowerCase()}`;

// Only LIVE-stream platforms are synced as self-promo subscriptions. Feed-only
// platforms (tiktok/instagram/facebook) are excluded — they aren't go-live.
const LIVE_PLATFORMS = new Set(['twitch', 'kick', 'youtube', 'trovo']);

/**
 * Pure: merge platform rows from `streamers` and `community_twitch_links` into a
 * deduped list of {platform, username, platformUserId}. streamers wins on a tie.
 */
export function mergePlatformSources(streamerRows = [], twitchLinkRows = []) {
  const map = new Map();
  for (const r of streamerRows) {
    if (!r.platform || !r.username) continue;
    map.set(keyOf(r.platform, r.username), {
      platform: r.platform, username: r.username, platformUserId: r.platform_user_id ?? null,
    });
  }
  for (const r of twitchLinkRows) {
    if (!r.twitch_username) continue;
    const k = keyOf('twitch', r.twitch_username);
    if (!map.has(k)) map.set(k, { platform: 'twitch', username: r.twitch_username, platformUserId: r.twitch_user_id ?? null });
  }
  return [...map.values()];
}

/** Every platform account the system knows for this Discord user (any guild). */
export async function getLinkedPlatforms(discordUserId) {
  const [streamerRows] = await pool.execute(
    'SELECT DISTINCT platform, username, platform_user_id FROM streamers WHERE discord_user_id = ?',
    [discordUserId]
  );
  let twitchLinkRows = [];
  try {
    [twitchLinkRows] = await pool.execute(
      'SELECT DISTINCT twitch_username, twitch_user_id FROM community_twitch_links WHERE discord_user_id = ?',
      [discordUserId]
    );
  } catch { /* table optional */ }
  return mergePlatformSources(streamerRows, twitchLinkRows);
}

/**
 * Subscribe every linked platform for `discordUserId` to `channelId` in `guild`
 * that isn't already subscribed in the guild. Returns the platforms newly added.
 */
export async function syncLinkedPlatforms(guild, discordUserId, channelId, opts = {}) {
  const linked = (await getLinkedPlatforms(discordUserId)).filter(p => LIVE_PLATFORMS.has(p.platform));
  if (linked.length <= 1) return []; // nothing else to sync

  // Cross-PLATFORM, not cross-account: only add platforms the user has NO
  // subscription on in this guild, and at most ONE account per platform.
  // (Multiple twitch accounts under one Discord id are separate channels, not a
  // single person's cross-platform presence — adding them pollutes curated lists.)
  const [existing] = await pool.execute(
    `SELECT DISTINCT st.platform FROM subscriptions s JOIN streamers st ON st.streamer_id = s.streamer_id
     WHERE s.guild_id = ? AND st.discord_user_id = ?`,
    [guild.id, discordUserId]
  );
  const havePlatform = new Set(existing.map(r => r.platform));
  const seenPlatform = new Set();
  const toAdd = [];
  for (const p of linked) {
    if (!p.platformUserId) continue;
    if (havePlatform.has(p.platform) || seenPlatform.has(p.platform)) continue;
    seenPlatform.add(p.platform);
    toAdd.push(p);
  }
  if (!toAdd.length) return [];

  const teamId = await getTeamSubscriptionId(guild.id, discordUserId).catch(() => null);
  const added = [];
  for (const p of toAdd) {
    try {
      const { tracked } = await isStreamerAlreadyTracked(guild.id, p.platform, p.platformUserId);
      if (tracked) continue; // already subscribed in this guild — never re-route it
      const ok = await createStreamerAndSubscription(
        guild.id, p.platform, p.platformUserId, p.username, discordUserId, channelId, teamId
      );
      if (ok) added.push(p);
    } catch (err) {
      logger.warn('[StreamerSync] sync failed for platform', {
        error: err.message, platform: p.platform, username: p.username, discordUserId,
      });
    }
  }
  if (added.length) {
    logger.info('[StreamerSync] synced linked platforms', {
      guildId: guild.id, discordUserId, added: added.map(a => `${a.platform}:${a.username}`),
    });
  }
  return added;
}
