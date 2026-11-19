import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD_ID = '1469931133981687873';
// The acting bot comes from guild_bot_mapping — never pinned here.

const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const token = bot.token;
const rest = new REST({ version: '10' }).setToken(token);

const channels = await rest.get(Routes.guildChannels(GUILD_ID));
channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

const categories = channels.filter(c => c.type === 4);
const orphans   = channels.filter(c => c.type !== 4 && !c.parent_id);

console.log('=== Top-level (no category) ===');
for (const c of orphans) {
  const t = ({0:'TEXT',2:'VOICE',5:'NEWS',13:'STAGE',15:'FORUM'})[c.type] || `t${c.type}`;
  console.log(`  [${t}] ${c.name}  (${c.id})`);
}

for (const cat of categories) {
  console.log(`\n=== ${cat.name}  (${cat.id}) ===`);
  const kids = channels.filter(c => c.parent_id === cat.id).sort((a,b) => (a.position ?? 0) - (b.position ?? 0));
  for (const c of kids) {
    const t = ({0:'TEXT',2:'VOICE',5:'NEWS',13:'STAGE',15:'FORUM'})[c.type] || `t${c.type}`;
    console.log(`  [${t}] ${c.name}  (${c.id})`);
  }
}

await pool.end();
