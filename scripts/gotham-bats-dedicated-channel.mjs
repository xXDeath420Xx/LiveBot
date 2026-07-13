// Bats' streams (xbatmangoddessx) should land in #gotham-announcements,
// not the shared #bats-reccomendations consolidation channel.
//
// Pattern: pre-create a subscription with the override channel BEFORE
// presence-detect kicks in. presenceUpdate.js dedupes on discord_user_id
// (line 195), so once this row exists, the auto-detect skips her and
// future live announcements route through this row's announcement_channel_id.

import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const BATS_DISCORD_ID = '570651332143480853';
const BATS_TWITCH_USERNAME = 'xbatmangoddessx';
const GOTHAM_ANNOUNCEMENTS = '800215763083722784';

console.log('=== Bats dedicated stream routing ===');

// 1. Ensure the streamer row exists with her Discord ID
const [existing] = await pool.execute(
  'SELECT streamer_id, discord_user_id FROM streamers WHERE platform=? AND LOWER(username)=?',
  ['twitch', BATS_TWITCH_USERNAME]
);

let streamerId;
if (existing.length) {
  streamerId = existing[0].streamer_id;
  if (!existing[0].discord_user_id || existing[0].discord_user_id !== BATS_DISCORD_ID) {
    await pool.execute('UPDATE streamers SET discord_user_id=? WHERE streamer_id=?', [BATS_DISCORD_ID, streamerId]);
    console.log(`  ✓ updated streamer_id=${streamerId} discord_user_id=${BATS_DISCORD_ID}`);
  } else {
    console.log(`  ✓ reused streamer_id=${streamerId}`);
  }
} else {
  // Validate via Twitch API
  let twitchApi;
  try { twitchApi = await import('../utils/platforms/twitch.js'); }
  catch (e) { console.error('  ✗ failed to import twitch api:', e.message); process.exit(1); }

  const tu = await twitchApi.getTwitchUser(BATS_TWITCH_USERNAME);
  if (!tu) { console.error(`  ✗ Twitch API didn\'t find user ${BATS_TWITCH_USERNAME}`); process.exit(1); }

  const [ins] = await pool.execute(
    'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, guild_id) VALUES (?, ?, ?, ?, ?)',
    ['twitch', tu.id, tu.login, BATS_DISCORD_ID, GUILD]
  );
  streamerId = ins.insertId;
  console.log(`  ✓ inserted streamer_id=${streamerId} (twitch_id=${tu.id})`);
}

// 2. Upsert the subscription routed to #gotham-announcements
const [existingSub] = await pool.execute(
  'SELECT subscription_id, announcement_channel_id FROM subscriptions WHERE guild_id=? AND streamer_id=?',
  [GUILD, streamerId]
);

if (existingSub.length) {
  if (existingSub[0].announcement_channel_id !== GOTHAM_ANNOUNCEMENTS) {
    await pool.execute(
      'UPDATE subscriptions SET announcement_channel_id=?, edit_on_end=1, delete_on_end=0, paused=0 WHERE subscription_id=?',
      [GOTHAM_ANNOUNCEMENTS, existingSub[0].subscription_id]
    );
    console.log(`  ✓ redirected sub ${existingSub[0].subscription_id}: ${existingSub[0].announcement_channel_id} → ${GOTHAM_ANNOUNCEMENTS}`);
  } else {
    console.log(`  ✓ sub ${existingSub[0].subscription_id} already routed to ${GOTHAM_ANNOUNCEMENTS}`);
  }
} else {
  const [ins] = await pool.execute(
    `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, edit_on_end, delete_on_end, paused)
     VALUES (?, ?, ?, 1, 0, 0)`,
    [GUILD, streamerId, GOTHAM_ANNOUNCEMENTS]
  );
  console.log(`  ✓ created subscription ${ins.insertId} → ${GOTHAM_ANNOUNCEMENTS}`);
}

// 3. Verify
const [check] = await pool.execute(
  `SELECT sub.subscription_id, sub.announcement_channel_id, s.username, s.discord_user_id
   FROM subscriptions sub JOIN streamers s USING(streamer_id)
   WHERE sub.guild_id=? AND s.platform='twitch' AND LOWER(s.username)=?`,
  [GUILD, BATS_TWITCH_USERNAME]
);
console.log('  → final state:', JSON.stringify(check[0]));

await pool.end();
console.log('\nDone. Future live events for xbatmangoddessx will post to #gotham-announcements.');
console.log('Auto-detection in presenceUpdate.js will skip her (subscription exists by user_id).');
