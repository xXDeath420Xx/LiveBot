// Twitch EventSub push subscriptions.
//
// We were detecting "went live" by polling Helix GET /streams once a minute, one streamer at a
// time, serially — so a streamer near the end of a 500-broadcaster list could go live and not be
// announced for minutes. EventSub reverses that: Twitch POSTs us `stream.online` within seconds of
// a broadcast starting. `stream.online`/`stream.offline` need only an app access token (no streamer
// authorization), so we can subscribe to every tracked broadcaster.
//
// This table is the ledger of what we've asked Twitch to notify us about, so we can reconcile the
// live set against our tracker list (subscribe new streamers, prune removed ones) and prune orphans
// Twitch still holds after a restart.

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS twitch_eventsub_subscriptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      -- Twitch's own subscription id (UUID) — needed to DELETE the subscription later.
      twitch_sub_id VARCHAR(64) NOT NULL,
      -- The broadcaster this watches. Matches streamers.platform_user_id for platform='twitch'.
      broadcaster_id VARCHAR(64) NOT NULL,
      broadcaster_login VARCHAR(255) NULL,
      -- 'stream.online' | 'stream.offline'
      sub_type VARCHAR(64) NOT NULL,
      -- Twitch subscription lifecycle: 'enabled' | 'webhook_callback_verification_pending' | 'revoked' | ...
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_broadcaster_type (broadcaster_id, sub_type),
      KEY idx_twitch_sub_id (twitch_sub_id),
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS twitch_eventsub_subscriptions');
}
