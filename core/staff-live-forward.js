/**
 * Staff live-link forwarder.
 *
 * When a Mod/Admin/Owner drops a stream link in a watched channel (e.g. the
 * everyone #self-promo or the staff signup channels), promote it to THAT tier's
 * live channel with the tier's Live Notis ping, then delete the original — so a
 * staff member's "going live" post lands where it belongs instead of the wrong
 * channel. Runs before the self-promo auto-tracker so staff links aren't also
 * turned into self-promo subscriptions.
 *
 * Config (per guild):
 *   staff_live_forward(guild_id, enabled, watch_channel_ids JSON)
 *   staff_live_forward_roles(guild_id, role_id, live_channel_id, ping_role_id, priority)
 * A member's highest-priority matching role decides the destination + ping.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// Broad stream-link detector — includes Rumble VIDEO links (rumble.com/v…),
// which the channel-only stream-url-parser deliberately doesn't match.
const STREAM_LINK = /https?:\/\/(?:www\.)?(twitch\.tv|kick\.com|youtube\.com|youtu\.be|rumble\.com|tiktok\.com|trovo\.live|facebook\.com|fb\.gg)\/\S+/i;
const PLATFORM_LABEL = [
  [/twitch\.tv/i, 'Twitch'], [/kick\.com/i, 'Kick'], [/youtu\.?be/i, 'YouTube'],
  [/rumble\.com/i, 'Rumble'], [/tiktok\.com/i, 'TikTok'], [/trovo\.live/i, 'Trovo'], [/facebook\.com|fb\.gg/i, 'Facebook'],
];

const CACHE = new Map(); // guildId -> { enabled, watch:Set, roles:[...], ts }
const TTL = 60_000;

async function loadConfig(guildId) {
  const hit = CACHE.get(guildId);
  if (hit && Date.now() - hit.ts < TTL) return hit;
  let cfg = { enabled: false, watch: new Set(), roles: [], ts: Date.now() };
  try {
    const [rows] = await pool.execute('SELECT enabled, watch_channel_ids FROM staff_live_forward WHERE guild_id=?', [guildId]);
    if (rows.length) {
      cfg.enabled = !!rows[0].enabled;
      let ch = [];
      try { ch = JSON.parse(rows[0].watch_channel_ids || '[]'); } catch { ch = []; }
      cfg.watch = new Set(ch.map(String));
      const [rr] = await pool.execute(
        'SELECT role_id, live_channel_id, ping_role_id, priority FROM staff_live_forward_roles WHERE guild_id=? ORDER BY priority DESC',
        [guildId]);
      cfg.roles = rr;
    }
  } catch (e) {
    logger.error('[StaffLiveForward] config load failed', { error: e.message, guildId });
  }
  CACHE.set(guildId, cfg);
  return cfg;
}

/** Invalidate the cache for a guild after a config change. */
export function invalidateStaffForwardCache(guildId) { CACHE.delete(guildId); }

// "inked_babe27" / "inked-babe27" → "Inked_babe" (strip trailing digits,
// separators→_, capitalize). Prefer the streamer's own handle over the Discord name.
function cleanName(u) {
  let s = String(u || '').replace(/\d+$/, '').replace(/[-.\s]+/g, '_').replace(/_+$/, '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(u || '');
}

async function resolveStreamerName(userId, member) {
  try {
    const [rows] = await pool.execute(
      'SELECT username, platform FROM streamers WHERE discord_user_id=? LIMIT 10', [userId]);
    if (rows.length) {
      // Prefer a non-YouTube handle (YouTube "usernames" are often channel IDs / odd casing).
      const pick = rows.find(r => r.platform !== 'youtube') || rows[0];
      return cleanName(pick.username);
    }
  } catch (e) {
    logger.warn('[StaffLiveForward] name resolve failed', { error: e.message, userId });
  }
  return member?.displayName || member?.user?.username || 'A streamer';
}

/**
 * @returns {Promise<boolean>} true if the message was consumed (forwarded).
 */
export async function handleStaffLiveForward(message) {
  try {
    if (!message.guild || !message.author || message.author.bot) return false;
    const content = message.content || '';
    if (!STREAM_LINK.test(content)) return false; // fast path: no stream link

    const cfg = await loadConfig(message.guild.id);
    if (!cfg.enabled || !cfg.watch.has(message.channel.id) || !cfg.roles.length) return false;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return false;
    const match = cfg.roles.find(r => member.roles.cache.has(r.role_id));
    if (!match) return false; // not staff → let normal self-promo handle it

    const dest = await message.client.channels.fetch(match.live_channel_id).catch(() => null);
    if (!dest?.isTextBased()) {
      logger.warn('[StaffLiveForward] destination channel missing', { guildId: message.guild.id, channel: match.live_channel_id });
      return false;
    }

    const name = await resolveStreamerName(message.author.id, member);
    const platform = (PLATFORM_LABEL.find(([re]) => re.test(content)) || [])[1];

    await dest.send({
      content: `<@&${match.ping_role_id}> 🔴 **${name}** is now LIVE${platform ? ` on ${platform}` : ''}!\n${content}`,
      allowedMentions: { parse: [], roles: [match.ping_role_id] },
    });
    await message.delete().catch(() => { /* original may already be gone */ });

    logger.info('[StaffLiveForward] forwarded staff live link', {
      guildId: message.guild.id, user: message.author.id, name,
      from: message.channel.id, to: match.live_channel_id,
    });
    return true;
  } catch (e) {
    logger.error('[StaffLiveForward] handler error', { error: e.message });
    return false;
  }
}

export default handleStaffLiveForward;
