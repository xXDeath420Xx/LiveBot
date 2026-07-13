import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID   = '1502798840124670133';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

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
