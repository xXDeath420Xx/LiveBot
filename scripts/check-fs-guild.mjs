import { REST, Routes } from 'discord.js';
import 'dotenv/config';
import pool from '/home/death/CertiFriedUtility/utils/db.js';

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const guildId = '1307517872301670480';
try {
  const g = await rest.get(Routes.guild(guildId));
  console.log('Guild ' + guildId + ' exists on Discord:', g.name, 'owner=' + g.owner_id);
} catch (e) {
  console.log('Guild ' + guildId + ':', e.status || '', e.message);
}
const [[dbg]] = await pool.query('SELECT guild_name, owner_id, left_at, last_seen FROM guilds WHERE guild_id = ?', [guildId]);
console.log('DB record:', JSON.stringify(dbg, null, 2));

const [[fmw]] = await pool.query('SELECT bot_id, bot_name FROM custom_bots WHERE bot_id = ?', ['1507873568095076425']);
console.log('French Maid Wolfie bot_id row:', JSON.stringify(fmw, null, 2));

process.exit(0);
