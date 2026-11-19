/**
 * Self-promo "add me" backend for the Level-gated button + form.
 *
 * The manual path for streamers the presence Go-Live detector can't catch:
 * non-Twitch platforms (Kick has no Discord connection), or users who
 * haven't linked Twitch to Discord. They click the button (Level-gated), paste
 * their channel link(s), and get added to the self-promo list — then their other
 * linked platforms sync in via streamer-sync. Reuses the same helpers as the
 * presence path; does NOT touch handleSelfPromoMessage.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';
import { parseStreamUrl } from '../utils/stream-url-parser.js';
import {
  validatePlatformUser, isStreamerAlreadyTracked, getTeamSubscriptionId, createStreamerAndSubscription,
} from './self-promo-handler.js';
import { syncLinkedPlatforms } from './streamer-sync.js';
import * as rumbleApi from '../utils/platforms/rumble.js';

const keyOf = (platform, username) => `${platform}:${String(username).toLowerCase()}`;

// Rumble can't be verified from a URL (Cloudflare-blocked) — it needs the
// streamer's Live Stream API key, collected in the form's optional field and
// stored encrypted so utils/platforms/rumble.js can look it up by username.
async function storeRumbleKey(username, key, guildId, addedBy) {
  await pool.execute(`CREATE TABLE IF NOT EXISTS rumble_stream_keys (
    rumble_username VARCHAR(255) NOT NULL PRIMARY KEY, api_key TEXT NOT NULL,
    discord_user_id VARCHAR(20) NULL, added_by VARCHAR(20) NULL, guild_id VARCHAR(20) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.execute(
    `INSERT INTO rumble_stream_keys (rumble_username, api_key, discord_user_id, added_by, guild_id)
     VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE api_key=VALUES(api_key), discord_user_id=VALUES(discord_user_id), guild_id=VALUES(guild_id)`,
    [username, JSON.stringify(encryption.encrypt(key)), addedBy || null, addedBy || null, guildId || null]
  );
}

/** Pure: parse a pasted block (links one per line / space / comma) → deduped {platform, username}. */
export function parseLinksBlock(text) {
  const tokens = String(text ?? '').split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const tok of tokens) {
    const parsed = parseStreamUrl(tok);
    if (!parsed) continue;
    const k = keyOf(parsed.platform, parsed.username);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ platform: parsed.platform, username: parsed.username });
  }
  return out;
}

/**
 * Where the self-promo list lives + the level gate. Prefers the presence
 * auto-track row, falls back to self_promo_config. Returns null if neither.
 */
export async function getJoinConfig(guildId) {
  const [at] = await pool.execute(
    'SELECT announcement_channel_id, min_level, role_id FROM guild_streamer_auto_track WHERE guild_id = ? AND enabled = 1 LIMIT 1',
    [guildId]
  );
  if (at.length && at[0].announcement_channel_id) {
    let minLevel = Number(at[0].min_level) || 0;
    // The manual form must respect the SAME level gate as the auto-track role's
    // opt-in button (reaction_role_mappings.min_level), even when the presence
    // add-gate (guild_streamer_auto_track.min_level) is deliberately left at 0 so
    // existing role-holders keep announcing after an XP reset. Otherwise a low-level
    // user could self-add via the form and bypass the role's level requirement.
    if (at[0].role_id) {
      const [rm] = await pool.execute(
        'SELECT MAX(min_level) AS lvl FROM reaction_role_mappings WHERE role_id = ?',
        [at[0].role_id]
      );
      minLevel = Math.max(minLevel, Number(rm[0]?.lvl) || 0);
    }
    return { channelId: at[0].announcement_channel_id, minLevel };
  }
  const [sp] = await pool.execute(
    'SELECT channel_id, announce_min_level, announce_gate_enabled FROM self_promo_config WHERE guild_id = ? LIMIT 1',
    [guildId]
  );
  if (sp.length && sp[0].channel_id) {
    return { channelId: sp[0].channel_id, minLevel: sp[0].announce_gate_enabled ? (Number(sp[0].announce_min_level) || 0) : 0 };
  }
  return null;
}

/**
 * Tiered variant: resolve the join config for a SPECIFIC announcement channel
 * (e.g. per-role signup panels routing to mod-live / admin-live / self-promo).
 * Uses the matching guild_streamer_auto_track row (if any) for its level/role
 * gate, and always announces to the passed channel. Falls back to no gate when
 * there's no explicit auto-track row for that channel — the panel's own channel
 * visibility is the access control in that case.
 */
export async function getJoinConfigForChannel(guildId, channelId) {
  if (!channelId) return getJoinConfig(guildId);
  const [at] = await pool.execute(
    'SELECT min_level, role_id FROM guild_streamer_auto_track WHERE guild_id = ? AND announcement_channel_id = ? AND enabled = 1 LIMIT 1',
    [guildId, channelId]
  );
  let minLevel = 0;
  if (at.length) {
    minLevel = Number(at[0].min_level) || 0;
    if (at[0].role_id) {
      const [rm] = await pool.execute(
        'SELECT MAX(min_level) AS lvl FROM reaction_role_mappings WHERE role_id = ?',
        [at[0].role_id]
      );
      minLevel = Math.max(minLevel, Number(rm[0]?.lvl) || 0);
    }
  }
  return { channelId, minLevel };
}

/**
 * The member's link is already tracked. If nobody owns it yet (a friend added it
 * via "Track a friend's stream", or it predates linking), let the member claim it
 * — the same trust "Add my stream" gives a fresh add. Never steals a stream that is
 * already linked to someone else. tracking_origin is left alone: an 'external'
 * row may be a partner, and flipping it would expose them to departure untracking.
 */
async function alreadyOrClaim(member, platform, platformUserId, canonicalUsername) {
  const [rows] = await pool.execute(
    'SELECT discord_user_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
    [platform, platformUserId]
  );
  const owner = rows[0]?.discord_user_id || null;
  if (owner === String(member.id)) return { status: 'already', platform, username: canonicalUsername };
  if (owner) return { status: 'owned', platform, username: canonicalUsername };
  // Guarded on IS NULL so two members claiming at once can't overwrite each other.
  const [res] = await pool.execute(
    'UPDATE streamers SET discord_user_id = ? WHERE platform = ? AND platform_user_id = ? AND discord_user_id IS NULL',
    [member.id, platform, platformUserId]
  );
  if (res.affectedRows !== 1) return { status: 'owned', platform, username: canonicalUsername };
  logger.info('[SelfPromoJoin] member claimed an unlinked tracked stream', { userId: member.id, platform, username: canonicalUsername });
  return { status: 'linked', platform, username: canonicalUsername };
}

async function addOne(guild, member, channelId, platform, username, opts = {}) {
  // Rumble is verified from its channel page like everything else. A key is only
  // stored if the member volunteered one (it serves as a fallback for detection).
  if (platform === 'rumble') {
    const v = await rumbleApi.validateUser(username);
    if (!v) return { status: 'invalid', platform, username };
    const { canonicalUsername, platformUserId } = v;
    const key = opts.rumbleKey;
    if (key) {
      const kv = await rumbleApi.validateKey(key);
      if (kv.ok) await storeRumbleKey(canonicalUsername, key, guild.id, member.id);
    }
    const { tracked } = await isStreamerAlreadyTracked(guild.id, 'rumble', platformUserId);
    if (tracked) return alreadyOrClaim(member, 'rumble', platformUserId, canonicalUsername);
    const teamId = await getTeamSubscriptionId(guild.id, member.id).catch(() => null);
    const ok = await createStreamerAndSubscription(guild.id, 'rumble', platformUserId, canonicalUsername, member.id, channelId, teamId);
    return { status: ok ? 'added' : 'error', platform, username: canonicalUsername };
  }
  const validated = await validatePlatformUser(platform, username);
  if (!validated) return { status: 'invalid', platform, username };
  const { tracked } = await isStreamerAlreadyTracked(guild.id, platform, validated.platformUserId);
  if (tracked) return alreadyOrClaim(member, platform, validated.platformUserId, validated.canonicalUsername);
  const teamId = await getTeamSubscriptionId(guild.id, member.id).catch(() => null);
  const ok = await createStreamerAndSubscription(
    guild.id, platform, validated.platformUserId, validated.canonicalUsername, member.id, channelId, teamId
  );
  return { status: ok ? 'added' : 'error', platform, username: validated.canonicalUsername };
}

/** Add the pasted links for this member, then sync their other linked platforms. */
export async function joinFromText(guild, member, channelId, text, opts = {}) {
  const entries = parseLinksBlock(text);
  const results = [];
  for (const e of entries) {
    try { results.push(await addOne(guild, member, channelId, e.platform, e.username, opts)); }
    catch (err) {
      logger.warn('[SelfPromoJoin] addOne failed', { error: err.message, platform: e.platform, username: e.username });
      results.push({ status: 'error', platform: e.platform, username: e.username });
    }
  }
  try {
    const synced = await syncLinkedPlatforms(guild, member.id, channelId);
    for (const s of synced) results.push({ status: 'added', platform: s.platform, username: s.username, synced: true });
  } catch (err) {
    logger.warn('[SelfPromoJoin] sync after join failed', { error: err.message, userId: member.id });
  }
  return results;
}

/**
 * "Track a friend's stream" — the member is adding SOMEONE ELSE's channel, so
 * nothing is tied to the clicker: no discord_user_id link (streamers.discord_user_id
 * is global, a wrong link would follow that streamer network-wide), no team
 * routing, no linked-platform sync. tracking_origin='external' because the
 * streamer isn't known to be a member, so the departure sweeper leaves them be.
 */
async function addFriendOne(guild, channelId, platform, username) {
  const validated = platform === 'rumble'
    ? await rumbleApi.validateUser(username)
    : await validatePlatformUser(platform, username);
  if (!validated) return { status: 'invalid', platform, username };
  const { platformUserId, canonicalUsername } = validated;
  const { tracked } = await isStreamerAlreadyTracked(guild.id, platform, platformUserId);
  if (tracked) return { status: 'already', platform, username: canonicalUsername };
  const ok = await createStreamerAndSubscription(
    guild.id, platform, platformUserId, canonicalUsername, null, channelId, null, { trackingOrigin: 'external' }
  );
  return { status: ok ? 'added' : 'error', platform, username: canonicalUsername };
}

export async function addFriendsFromText(guild, addedBy, channelId, text) {
  const results = [];
  for (const e of parseLinksBlock(text)) {
    try { results.push(await addFriendOne(guild, channelId, e.platform, e.username)); }
    catch (err) {
      logger.warn('[SelfPromoJoin] addFriendOne failed', { error: err.message, platform: e.platform, username: e.username });
      results.push({ status: 'error', platform: e.platform, username: e.username });
    }
  }
  const added = results.filter(r => r.status === 'added');
  if (added.length) {
    logger.info('[SelfPromoJoin] friend stream(s) added', {
      guildId: guild.id, addedBy, channelId, streams: added.map(r => `${r.platform}:${r.username}`),
    });
  }
  return results;
}

/** Human-readable ephemeral summary. */
export function summarize(results) {
  if (!results.length) return "I couldn't find any valid stream links in that — paste full channel URLs (e.g. `https://twitch.tv/yourname`).";
  const by = (s) => results.filter(r => r.status === s);
  const fmt = (arr) => arr.map(r => `\`${r.username}\` (${r.platform}${r.synced ? ', auto-linked' : ''})`).join(', ');
  const lines = [];
  const added = by('added'), linked = by('linked'), already = by('already'), owned = by('owned'), invalid = by('invalid'), error = by('error');
  if (added.length) lines.push(`✅ Added: ${fmt(added)}`);
  if (linked.length) lines.push(`🔗 Already tracked — now linked to your Discord: ${fmt(linked)}`);
  if (already.length) lines.push(`ℹ️ Already on the list: ${fmt(already)}`);
  if (owned.length) lines.push(`🔒 Already linked to another member — ask a mod if that's yours: ${fmt(owned)}`);
  if (invalid.length) lines.push(`❌ Couldn't verify (check the spelling/URL): ${fmt(invalid)}`);
  if (error.length) lines.push(`⚠️ Hit an error adding: ${fmt(error)}`);
  return lines.join('\n');
}
