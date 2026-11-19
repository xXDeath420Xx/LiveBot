// Dump EVERY overwrite (role + member) on EVERY channel. No filtering, no simulation.
// Pure raw state.

import 'dotenv/config';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '800157336458231848';
// The acting bot comes from guild_bot_mapping — never pinned here.
const VIEW = 1024n;

const bot = await resolveBotForGuild(GUILD, { db: pool });
const token = bot.token;

async function api(method, path) {
  await new Promise(r => setTimeout(r, 50));
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0,250)}`);
  return r.json();
}

const channels = await api('GET', `/guilds/${GUILD}/channels`);
const roles    = await api('GET', `/guilds/${GUILD}/roles`);
const roleName = new Map(roles.map(r => [r.id, r.name]));

for (const ch of channels.sort((a,b) => (a.parent_id || '').localeCompare(b.parent_id || '') || a.position - b.position)) {
  console.log(`\n${ch.id}  type=${ch.type}  #${ch.name}  (parent=${ch.parent_id || 'TOP'})`);
  const ow = ch.permission_overwrites || [];
  if (ow.length === 0) {
    console.log('  (no overwrites)');
    continue;
  }
  for (const o of ow) {
    const isRole = o.type === 0;
    const name = isRole ? (o.id === GUILD ? '@everyone' : (roleName.get(o.id) || `role:${o.id}`)) : `member:${o.id}`;
    const allow = BigInt(o.allow || '0');
    const deny  = BigInt(o.deny  || '0');
    const allowVIEW = (allow & VIEW) === VIEW;
    const denyVIEW  = (deny  & VIEW) === VIEW;
    const flag = allowVIEW ? '★ allow VIEW' : (denyVIEW ? '◇ deny VIEW' : '');
    console.log(`  ${isRole ? 'ROLE  ' : 'MEMBER'}  ${name.padEnd(25)}  allow=${o.allow.padEnd(20)}  deny=${o.deny.padEnd(20)}  ${flag}`);
  }
}

await pool.end();
