// Move Shoutout Eligible reward from level 3 → level 2, and retroactively
// grant it to current Lair members at level >= 2 who don't have it.
//
// Auto-Live role + opt-in button stay as-is; Shoutout Eligible becomes a
// visible level-2 status badge.
//
// REST-only — safe alongside live PM2.

import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD_ID = '1216126780767731722';
// The acting bot comes from guild_bot_mapping — never pinned here.
const SHOUTOUT_ELIGIBLE_ROLE = '1496409523328516137';
const REWARD_ROW_ID = 39;
const TARGET_LEVEL  = 2;

const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const token = bot.token;

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json();
}

console.log('=== Lair: Shoutout Eligible → level 2 ===\n');

console.log('[1/3] Updating level_role_rewards…');
const [before] = await pool.execute('SELECT id, level, role_id FROM level_role_rewards WHERE id=?', [REWARD_ROW_ID]);
console.log(`       before: ${JSON.stringify(before[0])}`);
await pool.execute('UPDATE level_role_rewards SET level=? WHERE id=? AND guild_id=?', [TARGET_LEVEL, REWARD_ROW_ID, GUILD_ID]);
const [after] = await pool.execute('SELECT id, level, role_id FROM level_role_rewards WHERE id=?', [REWARD_ROW_ID]);
console.log(`       after:  ${JSON.stringify(after[0])}\n`);

console.log(`[2/3] Finding Lair members at level >= ${TARGET_LEVEL} who don't have Shoutout Eligible…`);
const [eligibleRows] = await pool.execute(
  'SELECT user_id, level FROM user_levels WHERE guild_id = ? AND level >= ? ORDER BY level DESC, xp DESC',
  [GUILD_ID, TARGET_LEVEL]
);
console.log(`       ${eligibleRows.length} user(s) at level >= ${TARGET_LEVEL}`);

let granted = 0, alreadyHad = 0, failed = 0;
for (const r of eligibleRows) {
  try {
    const member = await api('GET', `/guilds/${GUILD_ID}/members/${r.user_id}`);
    if (member.roles?.includes(SHOUTOUT_ELIGIBLE_ROLE)) {
      alreadyHad++;
      console.log(`       ${r.user_id} (lvl ${r.level}) already has Shoutout Eligible`);
      continue;
    }
    await api('PUT', `/guilds/${GUILD_ID}/members/${r.user_id}/roles/${SHOUTOUT_ELIGIBLE_ROLE}`);
    granted++;
    console.log(`       ${r.user_id} (lvl ${r.level}) → granted Shoutout Eligible`);
  } catch (e) {
    failed++;
    console.log(`       ✗ ${r.user_id}: ${e.message}`);
  }
}

console.log(`\n[3/3] Done. granted=${granted}, alreadyHad=${alreadyHad}, failed=${failed}`);

await pool.end();
