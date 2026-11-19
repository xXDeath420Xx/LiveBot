import pool from '/home/death/CertiFriedUtility/utils/db.js';

const DEAD_GUILDS = ['1414753158999179286', '1307517872301670480'];
const DEAD_BOTS   = ['1462813232409612447', '1507873568095076425']; // Flying Sharks, French Maid Wolfie

// Safety check: do these bots have mappings to any OTHER (still-live) guilds?
console.log('=== PRE-CHECK: do dead bots have live mappings? ===');
for (const botId of DEAD_BOTS) {
  const [maps] = await pool.query('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [botId]);
  const otherGuilds = maps.filter(m => !DEAD_GUILDS.includes(m.guild_id));
  console.log('bot ' + botId + ':', maps.length, 'total mapping(s),', otherGuilds.length, 'to OTHER guild(s):', otherGuilds.map(m => m.guild_id).join(',') || '(none)');
  if (otherGuilds.length) {
    console.log('  ABORTING delete of this bot — it has other mappings!');
    process.exit(2);
  }
}

console.log('\n=== DELETE in dependency order ===');
let a, b, c, d;
try {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    [a] = await conn.query(
      'DELETE FROM guild_bot_mapping WHERE guild_id IN (?, ?) OR bot_id IN (?, ?)',
      [...DEAD_GUILDS, ...DEAD_BOTS]
    );
    console.log('guild_bot_mapping deleted:', a.affectedRows);

    [b] = await conn.query('DELETE FROM custom_bots WHERE bot_id IN (?, ?)', DEAD_BOTS);
    console.log('custom_bots deleted:', b.affectedRows);

    [c] = await conn.query('DELETE FROM guilds WHERE guild_id IN (?, ?)', DEAD_GUILDS);
    console.log('guilds deleted:', c.affectedRows);

    await conn.commit();
    console.log('\nCOMMITTED');
  } catch (e) {
    await conn.rollback();
    console.error('ROLLED BACK:', e.message);
    process.exit(1);
  } finally {
    conn.release();
  }
} catch (e) {
  console.error('fatal:', e.message);
  process.exit(1);
}

console.log('\n=== POST-CHECK: anything left referencing dead ids? ===');
const [[rem1]] = await pool.query('SELECT COUNT(*) AS n FROM guild_bot_mapping WHERE guild_id IN (?, ?) OR bot_id IN (?, ?)', [...DEAD_GUILDS, ...DEAD_BOTS]);
const [[rem2]] = await pool.query('SELECT COUNT(*) AS n FROM custom_bots WHERE bot_id IN (?, ?)', DEAD_BOTS);
const [[rem3]] = await pool.query('SELECT COUNT(*) AS n FROM guilds WHERE guild_id IN (?, ?)', DEAD_GUILDS);
console.log('guild_bot_mapping residuals:', rem1.n);
console.log('custom_bots residuals:', rem2.n);
console.log('guilds residuals:', rem3.n);
process.exit(0);
