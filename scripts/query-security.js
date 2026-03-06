import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const [guilds] = await conn.execute('SELECT guild_id, guild_name FROM guilds ORDER BY guild_name');
const [gb] = await conn.execute('SELECT guild_id FROM global_ban_config WHERE enabled = 1');
const [rp] = await conn.execute('SELECT guild_id FROM raid_protection_config WHERE enabled = 1');
const [ar] = await conn.execute('SELECT guild_id FROM anti_raid_config WHERE is_enabled = 1');
const [rd] = await conn.execute('SELECT guild_id FROM raid_detection_config WHERE enabled = 1');

const gbSet = new Set(gb.map(r => r.guild_id));
const rpSet = new Set(rp.map(r => r.guild_id));
const arSet = new Set(ar.map(r => r.guild_id));
const rdSet = new Set(rd.map(r => r.guild_id));

console.log('SEC | Server Name                                | Features');
console.log('----|---------------------------------------------|----------');
guilds.forEach(g => {
  const f = [];
  if (gbSet.has(g.guild_id)) f.push('GlobalBan');
  if (rpSet.has(g.guild_id)) f.push('RaidProtect');
  if (arSet.has(g.guild_id)) f.push('AntiRaid');
  if (rdSet.has(g.guild_id)) f.push('RaidDetect');
  const any = f.length > 0;
  console.log(`${any ? ' Y ' : ' N '} | ${(g.guild_name || 'Unknown').padEnd(43)} | ${f.join(', ') || 'None'}`);
});

const enabled = guilds.filter(g => gbSet.has(g.guild_id) || rpSet.has(g.guild_id) || arSet.has(g.guild_id) || rdSet.has(g.guild_id)).length;
console.log(`\n${enabled} of ${guilds.length} guilds have at least one security feature enabled.`);

await conn.end();
