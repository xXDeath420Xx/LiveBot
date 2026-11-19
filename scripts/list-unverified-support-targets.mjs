/**
 * List community-support targets whose Twitch identity is a NAME GUESS, not a verified link.
 *
 * findBestTwitchMatch derives candidate Twitch logins from a Discord display name and takes
 * the first one that exists. That is not proof of ownership — dormant accounts squatting a
 * common handle get picked up and pin the real streamer to non-affiliate. Those guesses are
 * no longer bound as identity; this report is where they surface for a human to confirm.
 *
 * A target is UNVERIFIED when no community_twitch_links row keyed on a real Discord user id
 * backs it (rows keyed `tw:<id>` are lookup cache, not identity).
 *
 * Usage: node scripts/list-unverified-support-targets.mjs [--days=30] [--guild=<id>]
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const daysArg = process.argv.find(a => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
const guildArg = process.argv.find(a => a.startsWith('--guild='));
const GUILD = guildArg ? guildArg.split('=')[1] : null;
// Default to the actionable set: targets whose bound account looks wrong. --all adds the
// merely-unconfirmed ones that resolve to healthy active channels.
const SHOW_ALL = process.argv.includes('--all');

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
try {
  const { getTwitchUsers } = await import('../utils/platforms/twitch-api.js');

  const params = [DAYS];
  let where = 'e.created_at > NOW() - INTERVAL ? DAY';
  if (GUILD) { where += ' AND e.guild_id = ?'; params.push(GUILD); }

  const [rows] = await db.execute(
    `SELECT e.guild_id, g.guild_name, e.target_username, e.target_twitch_id,
            COUNT(*) entries, MIN(e.created_at) first_seen, MAX(e.created_at) last_seen
     FROM community_support_entries e
     LEFT JOIN guilds g ON g.guild_id = e.guild_id
     WHERE ${where}
     GROUP BY 1,2,3,4 ORDER BY entries DESC`, params);

  // Provenance, not shape, decides trust (migration 194). A Discord-keyed row proves
  // nothing on its own — the old guesser wrote those itself. Only a handle a human
  // confirmed, or one the member authenticated, counts as identity.
  const [links] = await db.execute(
    `SELECT guild_id, twitch_username FROM community_twitch_links
     WHERE link_source IN ('confirmed','oauth')`);
  const verified = new Set(links.map(l => `${l.guild_id}|${l.twitch_username?.toLowerCase()}`));

  const names = [...new Set(rows.map(r => r.target_username?.toLowerCase()).filter(Boolean))];
  const tw = new Map();
  for (let i = 0; i < names.length; i += 100) {
    for (const u of (await getTwitchUsers(names.slice(i, i + 100))) || []) tw.set(u.login.toLowerCase(), u);
  }

  const out = [];
  for (const r of rows) {
    const key = `${r.guild_id}|${r.target_username?.toLowerCase()}`;
    const u = tw.get(r.target_username?.toLowerCase());
    // A dormant account: exists, but no bio, no broadcaster type, and the default avatar.
    const dormant = !!u && !u.broadcaster_type && !u.description &&
                    (u.profile_image_url || '').includes('user-default-pictures');
    // A confirmed handle wins outright — a real person said this is the account, so a
    // dormant-looking profile is simply a quiet streamer, not a wrong bind. Everything
    // else falls back to evidence about the account itself.
    if (verified.has(key)) continue;
    const status = !u ? 'NO TWITCH ACCOUNT' : dormant ? 'DORMANT (likely wrong account)'
                 : !u.broadcaster_type && !u.description ? 'no streaming evidence — check handle'
                 : 'unverified guess';

    // Post-migration every legacy row reads 'guess', so listing all of them buries the
    // handful that are actually broken. A guess landing on an active affiliate is almost
    // always right — the flag it produces is correct either way. Only the ones where the
    // account itself looks wrong are worth a human's time; --all shows the rest.
    if (!SHOW_ALL && status === 'unverified guess') continue;
    out.push({
      guild: r.guild_name, target: r.target_username,
      twitchType: u ? (u.broadcaster_type || '(none)') : '-',
      status, entries: r.entries, last_seen: r.last_seen?.toISOString().slice(0, 10),
    });
  }

  console.log(`\n=== ${SHOW_ALL ? 'Unconfirmed' : 'Suspect'} support targets — last ${DAYS}d ===\n`);
  if (!out.length) {
    console.log(SHOW_ALL
      ? 'none — every target has a confirmed handle.'
      : 'none suspect — no target is bound to a missing or dormant Twitch account.\n'
        + 'Run with --all to also list handles that are merely unconfirmed.');
  } else {
    console.table(out);
    console.log(`\n${out.length} target(s) need a confirmed Twitch handle.`);
    console.log('Rebind with: node scripts/rebind-twitch-handle.mjs --map=handles.json --apply');
  }
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
finally { await db.end(); }
