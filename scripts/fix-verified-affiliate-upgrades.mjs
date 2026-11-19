/**
 * Apply ONLY the provable half of the affiliate backlog repair: entries whose bound
 * Twitch account is confirmed affiliate/partner but are recorded as non-affiliate.
 *
 * The other direction (recorded affiliate, Twitch says no) is deliberately NOT applied
 * here. Those targets are bound to dormant squatter accounts that name-guessing picked
 * up — downgrading a member's public embed on the strength of an account that isn't
 * theirs is worse than leaving it. Those need the real handle rebound first.
 *
 * Usage: node scripts/fix-verified-affiliate-upgrades.mjs [--days=30] [--apply]
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const daysArg = process.argv.find(a => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
try {
  const { getTwitchUsers } = await import('../utils/platforms/twitch-api.js');
  console.log(`\n=== Verified affiliate upgrades — ${DAYS}d — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

  const [entries] = await db.execute(
    `SELECT id, guild_id, user_id, entry_type, target_username, target_is_affiliate, points_awarded
     FROM community_support_entries
     WHERE created_at > NOW() - INTERVAL ? DAY AND target_is_affiliate = 0`, [DAYS]);

  const names = [...new Set(entries.map(e => e.target_username?.toLowerCase()).filter(Boolean))];
  const tw = new Map();
  for (let i = 0; i < names.length; i += 100) {
    for (const u of (await getTwitchUsers(names.slice(i, i + 100))) || []) tw.set(u.login.toLowerCase(), u);
  }

  const [cfgRows] = await db.execute('SELECT * FROM community_support_config');
  const cfg = new Map(cfgRows.map(r => [r.guild_id, r]));

  const fixes = [];
  for (const e of entries) {
    const u = tw.get(e.target_username?.toLowerCase());
    if (!u || !['affiliate', 'partner'].includes(u.broadcaster_type)) continue;
    // Only raid points depend on the flag; support is a flat rate. Re-price only the flip.
    const newPts = e.entry_type === 'raid'
      ? (cfg.get(e.guild_id)?.raid_affiliate_points ?? 5)
      : e.points_awarded;
    fixes.push({ ...e, twitchId: u.id, login: u.login, newPts });
  }

  if (!fixes.length) { console.log('nothing to correct.'); }
  for (const f of fixes) {
    console.log(`  #${String(f.id).padEnd(5)} ${f.entry_type.padEnd(7)} ${f.login.padEnd(20)} non -> aff   ${f.points_awarded} -> ${f.newPts} pts`);
  }
  const delta = new Map();
  for (const f of fixes) {
    const k = `${f.guild_id}/${f.user_id}`;
    delta.set(k, (delta.get(k) || 0) + (f.newPts - f.points_awarded));
  }
  console.log('\npoint movement:');
  for (const [k, v] of delta) if (v !== 0) console.log(`   ${k}: ${v > 0 ? '+' : ''}${v}`);

  if (APPLY) {
    for (const f of fixes) {
      await db.execute(
        'UPDATE community_support_entries SET target_is_affiliate = 1, points_awarded = ?, target_twitch_id = ? WHERE id = ?',
        [f.newPts, f.twitchId, f.id]);
      await db.execute(
        `UPDATE community_twitch_links SET is_affiliate = 1, affiliate_checked_at = NOW()
         WHERE guild_id = ? AND twitch_username = ?`, [f.guild_id, f.login]);
    }
    console.log(`\napplied ${fixes.length} entr(ies).`);
  } else {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  }
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
finally { await db.end(); }
