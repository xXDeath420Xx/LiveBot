/**
 * Self-promo "add me" service — the backend for the level-gated button + form.
 *
 * Composes the existing self-promo helpers (exported from self-promo-handler.js)
 * to: parse pasted stream links, add a member's channel(s) to the self-promo
 * list, and SYNC every other platform that member is already linked to in the
 * system (so adding one platform pulls in the rest — death420's request,
 * generalized to everyone). It deliberately does NOT touch handleSelfPromoMessage
 * so the existing channel-watch path is unchanged.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { parseStreamUrl } from '../utils/stream-url-parser.js';
import {
  validatePlatformUser, isStreamerAlreadyTracked, looksLikeOwnedChannel,
  getTeamSubscriptionId, createStreamerAndSubscription,
} from './self-promo-handler.js';

const keyOf = (platform, username) => `${platform}:${String(username).toLowerCase()}`;

/** Pure: turn a pasted block of text into a deduped list of {platform, username}. */
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

/** Every platform account the system already knows for this Discord user. */
export async function getKnownPlatformsForDiscord(discordUserId) {
  const [rows] = await pool.execute(
    'SELECT DISTINCT platform, username, platform_user_id FROM streamers WHERE discord_user_id = ?',
    [discordUserId]
  );
  return rows.map(r => ({ platform: r.platform, username: r.username, platformUserId: r.platform_user_id }));
}

/** Add one platform entry to the self-promo channel. Returns a status object. */
async function addEntry(guild, member, config, platform, username, { enforceOwnership = true } = {}) {
  const validated = await validatePlatformUser(platform, username);
  if (!validated) return { status: 'invalid', platform, username };

  const { tracked, channelId } = await isStreamerAlreadyTracked(guild.id, platform, validated.platformUserId);
  if (tracked) return { status: 'already', platform, username: validated.canonicalUsername, channelId };

  if (enforceOwnership && !looksLikeOwnedChannel(member, validated.canonicalUsername)) {
    return { status: 'not_owned', platform, username: validated.canonicalUsername };
  }

  const teamId = await getTeamSubscriptionId(guild.id, member.id);
  const ok = await createStreamerAndSubscription(
    guild.id, platform, validated.platformUserId, validated.canonicalUsername, member.id, config.channel_id, teamId
  );
  return { status: ok ? 'added' : 'error', platform, username: validated.canonicalUsername };
}

/**
 * Add the given typed entries, then sync in every OTHER platform the member is
 * already linked to. Typed entries enforce the ownership gate; already-linked
 * platforms are trusted (no re-check). Returns the per-entry result list.
 */
export async function addAndSync(guild, member, config, typedEntries = []) {
  // Build a union keyed by platform:username. Known/linked entries trust ownership.
  const union = new Map();
  for (const e of typedEntries) union.set(keyOf(e.platform, e.username), { ...e, enforceOwnership: true });
  try {
    const known = await getKnownPlatformsForDiscord(member.id);
    for (const k of known) union.set(keyOf(k.platform, k.username), { platform: k.platform, username: k.username, enforceOwnership: false });
  } catch (err) {
    logger.warn('[SelfPromoAdd] could not load linked platforms', { error: err.message, userId: member.id });
  }

  const results = [];
  for (const e of union.values()) {
    try {
      results.push(await addEntry(guild, member, config, e.platform, e.username, { enforceOwnership: e.enforceOwnership }));
    } catch (err) {
      logger.error('[SelfPromoAdd] addEntry failed', { error: err.message, platform: e.platform, username: e.username });
      results.push({ status: 'error', platform: e.platform, username: e.username });
    }
  }
  return results;
}

/** Human-readable ephemeral summary of an addAndSync result list. */
export function summarize(results) {
  const by = (s) => results.filter(r => r.status === s);
  const fmt = (arr) => arr.map(r => `\`${r.username}\` (${r.platform})`).join(', ');
  const lines = [];
  const added = by('added'), already = by('already'), notOwned = by('not_owned'), invalid = by('invalid'), error = by('error');
  if (added.length) lines.push(`✅ Added: ${fmt(added)}`);
  if (already.length) lines.push(`ℹ️ Already tracked: ${fmt(already)}`);
  if (notOwned.length) lines.push(`🚫 Doesn't look like your channel (ask a mod to link it): ${fmt(notOwned)}`);
  if (invalid.length) lines.push(`❌ Couldn't verify: ${fmt(invalid)}`);
  if (error.length) lines.push(`⚠️ Error adding: ${fmt(error)}`);
  return lines.join('\n') || 'No valid stream links found.';
}
