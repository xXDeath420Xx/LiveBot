/*
 * One-off: run the departure sweeper's reconcile pass from outside the bot process.
 *
 * jobs/streamer-departure-sweeper.js does this on a daily cron, but it resolves guilds through
 * `global.botManager`, which only exists inside the running bot. This script exists so the first
 * pass can be applied at deploy time — otherwise 53 known-stale subscriptions keep announcing
 * ex-members until the next 04:40.
 *
 * REST GETs plus DB writes only, so it is safe to run while PM2 is up: it never opens a gateway
 * session that would compete with a live bot.
 *
 * Same safety rules as the sweeper, deliberately duplicated rather than shared, because the two
 * resolve guilds by completely different means:
 *   • only an explicit 404/10007 counts as absent — never a 503, a 403 or a network error
 *   • `permanent = 1` is untouched
 *   • streamers with no linked discord_user_id are out of scope
 *   • it PAUSES only. Nothing here deletes; that is the 30-day sweeper's job and its alone.
 */
import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { listDeparted, DELETE_AFTER_DAYS } from '../core/streamer-departure.js';

const APPLY = process.argv.includes('--apply');
const LIST = process.argv.includes('--list');

/*
 * `--list` answers the operator question this whole feature creates: who is currently marked
 * departed, and when does each one actually get deleted? Reads only.
 */
if (LIST) {
  const departed = await listDeparted();
  if (departed.length === 0) {
    console.log('Nothing is currently marked as departed.');
  } else {
    console.log(`${departed.length} subscription(s) marked departed — deleted at ${DELETE_AFTER_DAYS} days gone:\n`);
    for (const d of departed) {
      const left = DELETE_AFTER_DAYS - Number(d.days_gone);
      console.log(`  sub#${String(d.subscription_id).padEnd(5)} ${(d.platform + '/' + d.username).padEnd(34)} guild ${d.guild_id}  ${d.departed_reason}  ${d.days_gone}d gone  ${left > 0 ? `${left}d left` : 'DUE'}`);
    }
  }
  process.exit(0);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const [maps] = await pool.execute(
  `SELECT m.guild_id, b.bot_name, b.bot_token, b.enabled
     FROM guild_bot_mapping m JOIN custom_bots b ON b.bot_id = m.bot_id`);
const byGuild = new Map(maps.map(m => [m.guild_id, m]));

function tokenFor(guildId) {
  const m = byGuild.get(guildId);
  if (m && m.enabled) {
    try { return encryption.decrypt(JSON.parse(m.bot_token)); } catch { /* fall through to main */ }
  }
  return process.env.DISCORD_TOKEN;
}

/** true = present, false = confirmed absent, null = could not tell (never acted on). */
async function memberPresence(guildId, userId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { headers: { Authorization: `Bot ${tokenFor(guildId)}` } });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(((j.retry_after ?? 1) * 1000) + 250);
      continue;
    }
    if (res.ok) return true;
    if (res.status === 404) return false;
    if (res.status >= 500) { await sleep(1000); continue; }   // transient — retry, never conclude
    return null;                                              // 403 etc: not our call to make
  }
  return null;
}

const [rows] = await pool.execute(
  `SELECT sub.subscription_id, sub.guild_id, sub.departed_at, s.discord_user_id, s.platform, s.username,
          g.guild_name
     FROM subscriptions sub
     JOIN streamers s ON s.streamer_id = sub.streamer_id
     LEFT JOIN guilds g ON g.guild_id = sub.guild_id
    WHERE s.discord_user_id IS NOT NULL AND s.discord_user_id <> ''
      AND sub.permanent = 0
    ORDER BY sub.guild_id`);

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${rows.length} linked subscriptions to check\n`);

const cache = new Map();
const stats = { checked: 0, paused: 0, restored: 0, unknown: 0, present: 0 };

for (const r of rows) {
  const key = `${r.guild_id}:${r.discord_user_id}`;
  if (!cache.has(key)) { cache.set(key, await memberPresence(r.guild_id, r.discord_user_id)); stats.checked++; await sleep(120); }
  const present = cache.get(key);

  if (present === null) { stats.unknown++; console.log(`  ?  sub#${r.subscription_id} ${r.platform}/${r.username} — could not determine, left alone`); continue; }

  if (present) {
    stats.present++;
    if (r.departed_at) {
      stats.restored++;
      console.log(`  ^  sub#${r.subscription_id} ${r.platform}/${r.username} — back in ${r.guild_name}, restoring`);
      if (APPLY) await pool.execute(
        'UPDATE subscriptions SET paused = 0, departed_at = NULL, departed_reason = NULL WHERE subscription_id = ? AND departed_at IS NOT NULL',
        [r.subscription_id]);
    }
    continue;
  }

  if (r.departed_at) continue;   // already marked; the sweeper owns its clock from here
  stats.paused++;
  console.log(`  -  sub#${r.subscription_id} ${r.platform}/${r.username} — gone from ${r.guild_name ?? r.guild_id}, pausing`);
  if (APPLY) await pool.execute(
    `UPDATE subscriptions SET paused = 1, departed_at = NOW(), departed_reason = 'sweep'
      WHERE subscription_id = ? AND departed_at IS NULL AND permanent = 0`,
    [r.subscription_id]);
}

console.log(`\nchecked ${stats.checked} · present ${stats.present} · paused ${stats.paused} · restored ${stats.restored} · undetermined ${stats.unknown}`);
if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply to commit.');
process.exit(0);
