/**
 * Self-promo "add me" backend for the Level-gated button + form.
 *
 * The manual path for streamers the presence Go-Live detector can't catch:
 * non-Twitch platforms (Kick/Trovo have no Discord connection), or users who
 * haven't linked Twitch to Discord. They click the button (Level-gated), paste
 * their channel link(s), and get added to the self-promo list — then their other
 * linked platforms sync in via streamer-sync. Reuses the same helpers as the
 * presence path; does NOT touch handleSelfPromoMessage.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { parseStreamUrl } from '../utils/stream-url-parser.js';
import {
  validatePlatformUser, isStreamerAlreadyTracked, getTeamSubscriptionId, createStreamerAndSubscription,
} from './self-promo-handler.js';
import { syncLinkedPlatforms } from './streamer-sync.js';

const keyOf = (platform, username) => `${platform}:${String(username).toLowerCase()}`;

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
    'SELECT announcement_channel_id, min_level FROM guild_streamer_auto_track WHERE guild_id = ? AND enabled = 1 LIMIT 1',
    [guildId]
  );
  if (at.length && at[0].announcement_channel_id) {
    return { channelId: at[0].announcement_channel_id, minLevel: Number(at[0].min_level) || 0 };
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

async function addOne(guild, member, channelId, platform, username) {
  const validated = await validatePlatformUser(platform, username);
  if (!validated) return { status: 'invalid', platform, username };
  const { tracked } = await isStreamerAlreadyTracked(guild.id, platform, validated.platformUserId);
  if (tracked) return { status: 'already', platform, username: validated.canonicalUsername };
  const teamId = await getTeamSubscriptionId(guild.id, member.id).catch(() => null);
  const ok = await createStreamerAndSubscription(
    guild.id, platform, validated.platformUserId, validated.canonicalUsername, member.id, channelId, teamId
  );
  return { status: ok ? 'added' : 'error', platform, username: validated.canonicalUsername };
}

/** Add the pasted links for this member, then sync their other linked platforms. */
export async function joinFromText(guild, member, channelId, text) {
  const entries = parseLinksBlock(text);
  const results = [];
  for (const e of entries) {
    try { results.push(await addOne(guild, member, channelId, e.platform, e.username)); }
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

/** Human-readable ephemeral summary. */
export function summarize(results) {
  if (!results.length) return "I couldn't find any valid stream links in that — paste full channel URLs (e.g. `https://twitch.tv/yourname`).";
  const by = (s) => results.filter(r => r.status === s);
  const fmt = (arr) => arr.map(r => `\`${r.username}\` (${r.platform}${r.synced ? ', auto-linked' : ''})`).join(', ');
  const lines = [];
  const added = by('added'), already = by('already'), invalid = by('invalid'), error = by('error');
  if (added.length) lines.push(`✅ Added: ${fmt(added)}`);
  if (already.length) lines.push(`ℹ️ Already on the list: ${fmt(already)}`);
  if (invalid.length) lines.push(`❌ Couldn't verify (check the spelling/URL): ${fmt(invalid)}`);
  if (error.length) lines.push(`⚠️ Hit an error adding: ${fmt(error)}`);
  return lines.join('\n');
}
