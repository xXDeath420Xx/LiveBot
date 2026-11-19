import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD_ID = '1500965606659194982';
// The acting bot comes from guild_bot_mapping — never pinned here.

const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const token = bot.token;

async function api(path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const [roles, channels] = await Promise.all([
  api(`/guilds/${GUILD_ID}/roles`),
  api(`/guilds/${GUILD_ID}/channels`),
]);

const categories = channels.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
const gamingCat = categories.find(c => /gaming/i.test(c.name)) || null;

console.log('=== CATEGORIES ===');
for (const c of categories) console.log(`  [${c.id}] ${c.name}`);

console.log(`\n=== GAMING CATEGORY: ${gamingCat?.name} (${gamingCat?.id}) ===`);
if (gamingCat) {
  const inGaming = channels.filter(c => c.parent_id === gamingCat.id).sort((a, b) => a.position - b.position);
  for (const c of inGaming) console.log(`  type=${c.type} [${c.id}] #${c.name}`);
}

console.log('\n=== ROLES (excluding @everyone, managed) ===');
const filtered = roles
  .filter(r => r.name !== '@everyone')
  .filter(r => !r.managed)
  .sort((a, b) => b.position - a.position);
for (const r of filtered) {
  const color = `#${r.color.toString(16).padStart(6, '0')}`;
  console.log(`  pos=${String(r.position).padStart(3)} [${r.id}] ${r.name}  (color=${color} hoist=${r.hoist} mentionable=${r.mentionable})`);
}

await pool.end();
