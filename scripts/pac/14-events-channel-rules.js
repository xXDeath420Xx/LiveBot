// Posting rules for #events (1456057618542887058) in Welcome to The Pac.
//
// The channel is for event adverts — an event poster, not "here's my twitch link".
// Two gates, enforced by core/channel-post-rules.js from events/messageCreate.js:
//   1. require_image — the poster must be attached to the SAME message. Link
//      previews deliberately don't count, so a bare twitch link, or a twitch link
//      with a caption, is removed. A poster WITH a twitch link is fine: that's a
//      legitimate event ad.
//   2. min_level 2 — the author must have earned level 2 (375 XP ≈ 25 messages),
//      so someone can't join and immediately advertise.
//
// Staff (Manage Messages / Manage Channels) bypass both. Removals are DM'd to the
// author, with a self-deleting in-channel note as fallback when DMs are closed,
// and logged to the admin/mod channel.
//
// Idempotent: upserts the single rule row. DB-only, safe while PM2 runs.

import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD_ID   = '1099732505243959407';
const EVENTS_CH  = '1456057618542887058';
const LOG_CH     = '1439739127728701571'; // #logging

const RULE = {
  enabled: 1,
  require_image: 1,
  blocked_link_domains: null,   // twitch links are fine WITH a poster — the image rule is the gate
  min_level: 2,
  min_messages: 0,              // using the level gate instead
  activity_window_days: 30,
  min_member_days: 0,
  exempt_role_ids: null,        // staff bypass by permission; no extra roles needed
  delete_violations: 1,
  notify_user: 1,
  log_channel_id: LOG_CH,
};

let conn;
try {
  conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  await conn.execute(
    `INSERT INTO channel_post_rules
       (guild_id, channel_id, enabled, require_image, blocked_link_domains, min_level,
        min_messages, activity_window_days, min_member_days, exempt_role_ids,
        delete_violations, notify_user, log_channel_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled), require_image = VALUES(require_image),
       blocked_link_domains = VALUES(blocked_link_domains), min_level = VALUES(min_level),
       min_messages = VALUES(min_messages), activity_window_days = VALUES(activity_window_days),
       min_member_days = VALUES(min_member_days), exempt_role_ids = VALUES(exempt_role_ids),
       delete_violations = VALUES(delete_violations), notify_user = VALUES(notify_user),
       log_channel_id = VALUES(log_channel_id)`,
    [GUILD_ID, EVENTS_CH, RULE.enabled, RULE.require_image, RULE.blocked_link_domains,
     RULE.min_level, RULE.min_messages, RULE.activity_window_days, RULE.min_member_days,
     RULE.exempt_role_ids, RULE.delete_violations, RULE.notify_user, RULE.log_channel_id]
  );

  const [[row]] = await conn.execute(
    'SELECT * FROM channel_post_rules WHERE guild_id = ? AND channel_id = ?',
    [GUILD_ID, EVENTS_CH]
  );

  console.log('=== #events posting rules — guild 1099732505243959407 ===\n');
  console.log(`  channel          : ${row.channel_id}`);
  console.log(`  enabled          : ${row.enabled ? 'yes' : 'no'}`);
  console.log(`  image required   : ${row.require_image ? 'yes — poster must be on the same message' : 'no'}`);
  console.log(`  minimum level    : ${row.min_level}`);
  console.log(`  blocked domains  : ${row.blocked_link_domains || 'none (twitch allowed alongside a poster)'}`);
  console.log(`  on violation     : ${row.delete_violations ? 'delete' : 'keep'}${row.notify_user ? ' + tell the author why' : ''}`);
  console.log(`  log channel      : ${row.log_channel_id || 'none'}`);
  console.log('\nStaff (Manage Messages / Manage Channels) bypass both gates.');
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  await conn?.end().catch(() => {});
}
