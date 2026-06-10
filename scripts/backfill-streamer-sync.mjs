// Backfill cross-platform sync for an existing guild: for every user already on
// a stream list, add their OTHER linked platforms to the same channel they're on.
// Usage: node scripts/backfill-streamer-sync.mjs <guildId>
import pool from '../utils/db.js';
import { syncLinkedPlatforms } from '../core/streamer-sync.js';

const G = process.argv[2];
if (!G) { console.error('usage: node scripts/backfill-streamer-sync.mjs <guildId>'); process.exit(1); }

// Each user's primary channel = the channel of their existing sub(s).
const [rows] = await pool.execute(
  `SELECT st.discord_user_id, s.announcement_channel_id ch, COUNT(*) n
     FROM subscriptions s JOIN streamers st ON st.streamer_id = s.streamer_id
    WHERE s.guild_id = ? AND st.discord_user_id IS NOT NULL
    GROUP BY st.discord_user_id, s.announcement_channel_id`, [G]);

// pick one channel per user (the one with the most existing subs)
const primary = new Map();
for (const r of rows) {
  const cur = primary.get(r.discord_user_id);
  if (!cur || r.n > cur.n) primary.set(r.discord_user_id, { ch: r.ch, n: r.n });
}

let totalAdded = 0;
for (const [discordId, { ch }] of primary) {
  if (!ch) continue;
  const added = await syncLinkedPlatforms({ id: G }, discordId, ch);
  if (added.length) {
    totalAdded += added.length;
    console.log(`+${added.length} for ${discordId} -> #${ch}: ${added.map(a => a.platform + ':' + a.username).join(', ')}`);
  }
}
console.log(`\nBackfill done. ${primary.size} users checked, ${totalAdded} platform subs added.`);
process.exit(0);
