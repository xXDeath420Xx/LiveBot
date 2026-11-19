import pool from '/home/death/CertiFriedUtility/utils/db.js';
const deadGuild = '1414753158999179286';
console.log('=== Guild ' + deadGuild + ' ===');
const [[g]] = await pool.query('SELECT * FROM guilds WHERE guild_id = ?', [deadGuild]);
console.log('guilds row:', g ? JSON.stringify(g, null, 2) : '(none)');
const [m] = await pool.query('SELECT * FROM guild_bot_mapping WHERE guild_id = ?', [deadGuild]);
console.log('guild_bot_mapping:', m.length ? JSON.stringify(m, null, 2) : '(none)');

// How many tables reference guild_id?
const [tables] = await pool.query(`
  SELECT TABLE_NAME, COUNT(*) AS c FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'guild_id'
   GROUP BY TABLE_NAME ORDER BY TABLE_NAME
`);
console.log('\nTables with guild_id column:', tables.length);
let totalRows = 0;
const hits = [];
for (const t of tables) {
  try {
    const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM  WHERE guild_id = ?', [deadGuild]);
    if (r.n > 0) { hits.push([t.TABLE_NAME, r.n]); totalRows += r.n; }
  } catch { /* some tables may error */ }
}
console.log('Tables with rows for dead guild:', hits.length, 'total rows:', totalRows);
for (const [t, n] of hits.sort((a,b)=>b[1]-a[1])) console.log('  ' + t.padEnd(50) + ' ' + n);

console.log('\n=== Flying Sharks custom bot ===');
const [fs] = await pool.query('SELECT bot_id, bot_name, client_id, created_at FROM custom_bots WHERE bot_name LIKE ?', ['%Flying Sharks%']);
console.log(JSON.stringify(fs, null, 2));
if (fs.length) {
  const [fsg] = await pool.query('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [fs[0].bot_id]);
  console.log('mapped guilds:', fsg.map(r => r.guild_id).join(', ') || '(none)');
}
process.exit(0);
