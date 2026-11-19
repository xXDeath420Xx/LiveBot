import pool from '../utils/db.js';

/**
 * Record HOW a Discord→Twitch link was established, so a guess can never again pass as
 * a verified identity.
 *
 * findBestTwitchMatch derived candidate Twitch logins from a member's Discord display
 * name and bound the first login that happened to exist — no proof of ownership. Dormant
 * accounts squatting a common handle got bound permanently, reporting broadcaster_type ''
 * and pinning real affiliate streamers to non-affiliate (T2Fast -> a blank 2012 `t2fast`
 * account, while their real channel was `t2fast_motorsports`).
 *
 * Those guessed rows are indistinguishable from genuine links once written, so any audit
 * had to fall back on heuristics about the Twitch account (default avatar, empty bio) to
 * guess which links to distrust. link_source makes it explicit:
 *
 *   'guess'     — derived from a Discord name; NOT an identity. Default for legacy rows,
 *                 because every pre-existing row could have come from the guesser.
 *   'confirmed' — a human confirmed this handle (scripts/rebind-twitch-handle.mjs).
 *   'oauth'     — the member authenticated the link themselves (dashboard link flow).
 *   'presence'  — taken from Discord's own Twitch connection / streaming presence.
 *
 * Only 'confirmed' and 'oauth' should be treated as authoritative identity.
 */
export async function up() {
  const [cols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'community_twitch_links'
       AND COLUMN_NAME = 'link_source'`
  );
  if (cols.length === 0) {
    await pool.execute(
      `ALTER TABLE community_twitch_links
       ADD COLUMN link_source VARCHAR(16) NOT NULL DEFAULT 'guess' AFTER twitch_user_id`
    );
    console.log('[Migration 194] community_twitch_links.link_source added');
  } else {
    console.log('[Migration 194] link_source already present, skipped');
  }

  // Lookup-cache rows keyed tw:<id> are not identity at all — mark them as such so they
  // are never mistaken for a member link.
  const [res] = await pool.execute(
    `UPDATE community_twitch_links SET link_source = 'guess' WHERE discord_user_id LIKE 'tw:%'`
  );
  console.log(`[Migration 194] ${res.affectedRows} lookup-cache row(s) marked 'guess'`);
}

export async function down() {
  const [cols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'community_twitch_links'
       AND COLUMN_NAME = 'link_source'`
  );
  if (cols.length) {
    await pool.execute('ALTER TABLE community_twitch_links DROP COLUMN link_source');
  }
}
