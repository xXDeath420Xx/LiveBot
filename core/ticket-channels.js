/*
 * Is this channel a support ticket?
 *
 * Its own module because more than one filter needs the answer and none of them should be guessing.
 * A ticket is a private channel between one member and staff, opened BY that member to describe a
 * problem — long messages, repeated detail, follow-ups and pasted logs are the entire point of one.
 * Any automated filter that treats that as spam punishes somebody for asking for help.
 *
 * Static exemption lists cannot solve this: ticket channels are created on demand, so a channel that
 * did not exist when the config was written can never be on it.
 *
 * Three checks, because a ticket can be any of them:
 *   1. a live row in `tickets` for this channel — the definitive answer
 *   2. a channel whose parent is the guild's configured ticket category
 *   3. a thread whose parent channel is the configured thread parent
 *
 * Deliberately NOT a name check. "support" as a substring would exempt an ordinary #support-chat
 * where spam filtering is wanted, and a renamed ticket would slip past it.
 */
import pool from '../utils/db.js';

/** Cheap per-channel memo. Ticket-ness does not change over a channel's life. */
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function isTicketChannel(channel) {
  if (!channel?.id || !channel.guild?.id) return false;

  const hit = cache.get(channel.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = false;
  try {
    const [[t]] = await pool.execute(
      'SELECT 1 AS x FROM tickets WHERE channel_id = ? LIMIT 1', [channel.id]);
    if (t) value = true;

    if (!value) {
      const [[cfg]] = await pool.execute(
        'SELECT ticket_category_id, thread_parent_channel_id FROM ticket_config WHERE guild_id = ?',
        [channel.guild.id]);
      if (cfg) {
        const parent = channel.parentId ?? channel.parent?.id ?? null;
        if (cfg.ticket_category_id && parent === cfg.ticket_category_id) value = true;
        if (cfg.thread_parent_channel_id && parent === cfg.thread_parent_channel_id) value = true;
      }
    }

    // A panel can name its own category, separate from the guild-wide one.
    if (!value) {
      const parent = channel.parentId ?? channel.parent?.id ?? null;
      if (parent) {
        const [[p]] = await pool.execute(
          'SELECT 1 AS x FROM ticket_panels WHERE guild_id = ? AND ticket_category_id = ? LIMIT 1',
          [channel.guild.id, parent]);
        if (p) value = true;
      }
    }
  } catch {
    // A database hiccup must not cause a ticket to be treated as an ordinary channel and filtered.
    // Failing closed here means "assume it might be a ticket", which errs toward not punishing
    // somebody mid-support-request.
    value = true;
  }

  cache.set(channel.id, { value, at: Date.now() });
  if (cache.size > 5000) cache.clear();
  return value;
}

export default { isTicketChannel };
