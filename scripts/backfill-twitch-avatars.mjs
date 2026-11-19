/*
 * Backfill streamers.profile_image_url for Twitch streamers.
 *
 * Live announcements show the streamer's avatar (Discord's proxy can't fetch Twitch's
 * preview CDN any more), so a missing avatar means an embed with no image at all.
 * helix/users takes 100 logins per request, so the whole table costs a handful of calls.
 *
 * REST-only — safe to run while PM2 is up. Idempotent: only fills rows that are empty
 * unless --refresh is passed, which re-fetches every Twitch streamer.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const REFRESH = process.argv.includes('--refresh');
const DRY = process.argv.includes('--dry');

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: process.env.DB_PORT || 3306,
});

try {
  const tok = await (await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  })).json();
  if (!tok.access_token) throw new Error(`Twitch token failed: ${JSON.stringify(tok)}`);

  const [rows] = await db.query(
    `SELECT streamer_id, username FROM streamers
      WHERE platform = 'twitch' ${REFRESH ? '' : "AND (profile_image_url IS NULL OR profile_image_url = '')"}`);
  console.log(`${rows.length} Twitch streamer(s) to resolve${DRY ? ' (dry run)' : ''}`);

  let updated = 0, notFound = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const qs = batch.map(r => `login=${encodeURIComponent(String(r.username).trim().toLowerCase())}`).join('&');
    const res = await fetch(`https://api.twitch.tv/helix/users?${qs}`, {
      headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${tok.access_token}` },
    });
    if (!res.ok) { console.error(`  batch ${i / 100 + 1}: HTTP ${res.status}`); continue; }
    const { data = [] } = await res.json();

    const byLogin = new Map(data.map(u => [u.login.toLowerCase(), u.profile_image_url]));
    for (const r of batch) {
      const url = byLogin.get(String(r.username).trim().toLowerCase());
      if (!url) { notFound++; continue; }
      if (!DRY) {
        await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [url, r.streamer_id]);
      }
      updated++;
    }
    console.log(`  batch ${i / 100 + 1}: ${data.length}/${batch.length} resolved`);
    await new Promise(s => setTimeout(s, 300));
  }

  console.log(`\nupdated=${updated}  not-found-on-twitch=${notFound}`);
  const [[after]] = await db.query(
    "SELECT COUNT(*) total, SUM(profile_image_url IS NULL OR profile_image_url = '') missing FROM streamers WHERE platform = 'twitch'");
  console.log(`twitch streamers: ${after.total}, still missing an avatar: ${after.missing}`);
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
process.exit(process.exitCode ?? 0);
