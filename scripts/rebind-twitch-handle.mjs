/**
 * Rebind a Discord member to their REAL Twitch handle and repair history retroactively.
 *
 * Use when a support target was bound to the wrong Twitch account by name guessing.
 * Given confirmed handles, this:
 *   1. verifies each handle against Twitch (must exist; reads live broadcaster_type)
 *   2. writes the verified Discord→Twitch identity into community_twitch_links
 *   3. removes the stale wrong-account link row and its tw:<id> lookup cache
 *   4. rewrites community_support_entries in the window: target_username, target_twitch_id,
 *      target_is_affiliate — re-pricing ONLY raid entries whose affiliate flag actually
 *      flipped (support points are a flat rate; re-pricing them would rewrite history)
 *
 * Afterwards run scripts/repair-affiliate-posted-messages.mjs --days=N --apply to retag the
 * embeds the bot already posted.
 *
 * Map file — JSON array, `discord` optional but strongly preferred (it is what makes the
 * link an identity rather than another guess):
 *   [ { "guild": "1529507432605421598", "wrong": "t2fast",
 *       "twitch": "t2fast_motorsports", "discord": "991826674037559297" } ]
 *
 * Usage:
 *   node scripts/rebind-twitch-handle.mjs --map=handles.json            # dry run, 30 days
 *   node scripts/rebind-twitch-handle.mjs --map=handles.json --apply
 *   node scripts/rebind-twitch-handle.mjs --guild=G --wrong=old --twitch=new --discord=D --apply
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';

const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : null; };
const APPLY = process.argv.includes('--apply');
const DAYS = parseInt(arg('days') || '30', 10);

let jobs;
const mapPath = arg('map');
if (mapPath) {
  jobs = JSON.parse(await readFile(mapPath, 'utf8'));
} else if (arg('guild') && arg('twitch')) {
  jobs = [{ guild: arg('guild'), wrong: arg('wrong'), twitch: arg('twitch'), discord: arg('discord') }];
} else {
  console.error('need --map=<file.json> or --guild= --twitch= [--wrong=] [--discord=]');
  process.exit(1);
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
try {
  const { getTwitchUsers } = await import('../utils/platforms/twitch-api.js');
  console.log(`\n=== Rebind Twitch handles — ${DAYS}d — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

  // Verify every new handle up front; refuse to rebind onto an account that doesn't exist.
  const wanted = [...new Set(jobs.map(j => j.twitch.toLowerCase()))];
  const tw = new Map();
  for (let i = 0; i < wanted.length; i += 100) {
    for (const u of (await getTwitchUsers(wanted.slice(i, i + 100))) || []) tw.set(u.login.toLowerCase(), u);
  }
  const missing = wanted.filter(w => !tw.has(w));
  if (missing.length) {
    console.error(`REFUSING — these Twitch logins do not exist: ${missing.join(', ')}`);
    process.exit(1);
  }

  const [cfgRows] = await db.execute('SELECT * FROM community_support_config');
  const cfg = new Map(cfgRows.map(r => [r.guild_id, r]));

  for (const j of jobs) {
    const u = tw.get(j.twitch.toLowerCase());
    const isAff = ['affiliate', 'partner'].includes(u.broadcaster_type);
    console.log(`\n--- ${j.wrong || '(unbound)'} -> ${u.login}  [${u.broadcaster_type || 'no broadcaster type'}] ${isAff ? 'AFFILIATE' : 'not affiliate'}`);
    if (!isAff) console.log('    NOTE: this handle is not an affiliate/partner — entries will read non-affiliate.');

    const [entries] = await db.execute(
      `SELECT id, user_id, entry_type, target_is_affiliate, points_awarded
       FROM community_support_entries
       WHERE guild_id = ? AND LOWER(target_username) = ? AND created_at > NOW() - INTERVAL ? DAY`,
      [j.guild, (j.wrong || j.twitch).toLowerCase(), DAYS]);

    let repriced = 0;
    for (const e of entries) {
      const flipped = !!e.target_is_affiliate !== isAff;
      const newPts = (e.entry_type === 'raid' && flipped)
        ? (isAff ? (cfg.get(j.guild)?.raid_affiliate_points ?? 5)
                 : (cfg.get(j.guild)?.raid_non_affiliate_points ?? 10))
        : e.points_awarded;
      if (newPts !== e.points_awarded) repriced++;
      if (APPLY) {
        await db.execute(
          `UPDATE community_support_entries
           SET target_username = ?, target_twitch_id = ?, target_is_affiliate = ?, points_awarded = ?
           WHERE id = ?`, [u.login, u.id, isAff ? 1 : 0, newPts, e.id]);
      }
    }
    console.log(`    entries in window: ${entries.length}  (raid re-prices: ${repriced})`);

    if (APPLY) {
      // Drop the wrong-account identity row and its lookup cache, then write the verified link.
      if (j.wrong) {
        await db.execute(
          'DELETE FROM community_twitch_links WHERE guild_id = ? AND LOWER(twitch_username) = ?',
          [j.guild, j.wrong.toLowerCase()]);
      }
      const key = j.discord || `tw:${u.id}`;
      // A handle supplied by a human is 'confirmed'; without a Discord id this is only
      // lookup cache, so it stays a 'guess' and must never count as identity.
      const source = j.discord ? 'confirmed' : 'guess';
      await db.execute(
        `INSERT INTO community_twitch_links (guild_id, discord_user_id, twitch_username, twitch_user_id, link_source, is_affiliate, affiliate_checked_at, last_checked)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE twitch_username = VALUES(twitch_username), twitch_user_id = VALUES(twitch_user_id),
                                 link_source = VALUES(link_source), is_affiliate = VALUES(is_affiliate),
                                 affiliate_checked_at = NOW(), last_checked = NOW()`,
        [j.guild, key, u.login, u.id, source, isAff ? 1 : 0]);
      console.log(`    linked ${key} -> ${u.login} [${source}]${j.discord ? '' : ' — lookup cache only, no discord id given'}`);
    }
  }

  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  else console.log('\nDone. Now run: node scripts/repair-affiliate-posted-messages.mjs --days=' + DAYS + ' --apply');
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
finally { await db.end(); }
