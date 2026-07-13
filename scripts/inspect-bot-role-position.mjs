// REST-only inspector: dumps a guild's full role list (sorted by position desc)
// and highlights where a given bot member sits in the hierarchy.
//
// Usage: node scripts/inspect-bot-role-position.mjs <guild_id> <bot_user_id>
// Defaults to main DISCORD_TOKEN; pass --custom <bot_id> to use a custom bot token.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const args = process.argv.slice(2);
const guildId = args[0];
const botUserId = args[1];
const customIdx = args.indexOf('--custom');
const customBotId = customIdx >= 0 ? args[customIdx + 1] : null;

if (!guildId || !botUserId) {
  console.error('Usage: node scripts/inspect-bot-role-position.mjs <guild_id> <bot_user_id> [--custom <bot_id>]');
  process.exit(1);
}

let token = process.env.DISCORD_TOKEN;
if (customBotId) {
  const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [customBotId]);
  if (!rows.length) { console.error(`Custom bot ${customBotId} not found`); process.exit(1); }
  token = encryption.decrypt(JSON.parse(rows[0].bot_token));
}

const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

async function api(path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, { headers });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${path}: ${await r.text()}`);
  return r.json();
}

const [guild, roles, member] = await Promise.all([
  api(`/guilds/${guildId}`),
  api(`/guilds/${guildId}/roles`),
  api(`/guilds/${guildId}/members/${botUserId}`),
]);

const sorted = [...roles].sort((a, b) => b.position - a.position);
const botRoleIds = new Set(member.roles);

console.log(`\nGuild: ${guild.name} (${guild.id})`);
console.log(`Bot member: ${member.user?.username ?? botUserId}`);
console.log(`Bot's assigned roles: ${member.roles.length ? member.roles.join(', ') : '(none — @everyone only)'}\n`);

console.log(`Full role hierarchy (${sorted.length} roles, highest first):\n`);
const PERM_ADMIN = 1n << 3n;
for (const r of sorted) {
  const mine    = botRoleIds.has(r.id) ? ' ← BOT HAS' : '';
  const managed = r.managed ? ' [managed]' : '';
  const admin   = (BigInt(r.permissions) & PERM_ADMIN) === PERM_ADMIN ? ' [ADMIN]' : '';
  const hoist   = r.hoist ? ' [hoist]' : '';
  console.log(`  pos=${String(r.position).padStart(3)}  ${r.id.padEnd(20)}  ${r.name}${admin}${managed}${hoist}${mine}`);
}

const botHighest = sorted.find(r => botRoleIds.has(r.id));
console.log(`\nBot's highest role: ${botHighest ? `${botHighest.name} (pos=${botHighest.position}, id=${botHighest.id})` : '@everyone only'}`);
const ranking = sorted.findIndex(r => r.id === botHighest?.id);
if (ranking >= 0) {
  console.log(`Ranking: #${ranking + 1} of ${sorted.length} (${sorted.length - 1 - ranking} role(s) below it, ${ranking} above)`);
}

await pool.end();
