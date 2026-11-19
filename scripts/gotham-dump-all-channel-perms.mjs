// Dump every channel's @everyone allow/deny + sync state + summary of who can see.
// Read-only.

import 'dotenv/config';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '800157336458231848';
// The acting bot comes from guild_bot_mapping — never pinned here.
const CITIZEN = '800252381513777158';
const VIEW = 1024n;

const actingBot = await resolveBotForGuild(GUILD, { db: pool });
const token = actingBot.token;

async function api(method, path) {
  await new Promise(r => setTimeout(r, 50));
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

const channels = await api('GET', `/guilds/${GUILD}/channels`);
const cats = new Map(channels.filter(c => c.type === 4).map(c => [c.id, c]));

console.log(`\nAll ${channels.length} channels in The Bat Cave:\n`);
console.log('  type  id                    name                                  parent                              @everyone(A/D)            citizen(A/D)              public?');
console.log('  ----  --------------------  ------------------------------------  ----------------------------------  ------------------------  ------------------------  -------');

const sortedChannels = channels.slice().sort((a, b) => (a.parent_id || '').localeCompare(b.parent_id || '') || a.position - b.position);

const publicChannels = [];
for (const ch of sortedChannels) {
  const ow = ch.permission_overwrites || [];
  const ev = ow.find(o => o.id === GUILD);
  const ci = ow.find(o => o.id === CITIZEN);
  const evAllow = BigInt(ev?.allow || '0');
  const evDeny  = BigInt(ev?.deny  || '0');
  const ciAllow = BigInt(ci?.allow || '0');
  const ciDeny  = BigInt(ci?.deny  || '0');

  // Can @everyone see? Only if channel allows VIEW.
  const everyoneCanSee = (evAllow & VIEW) === VIEW;
  if (everyoneCanSee) publicChannels.push(ch);

  const parent = cats.get(ch.parent_id)?.name || '(top-level)';
  const name = (ch.name || '').padEnd(36).slice(0, 36);
  const parentName = parent.padEnd(34).slice(0, 34);
  const evStr = `${ev?.allow || '0'}/${ev?.deny || '0'}`.padEnd(24).slice(0, 24);
  const ciStr = `${ci?.allow || '0'}/${ci?.deny || '0'}`.padEnd(24).slice(0, 24);
  const isPublic = everyoneCanSee ? '★ PUBLIC' : '';
  console.log(`  ${String(ch.type).padStart(4)}  ${ch.id.padEnd(20)}  ${name}  ${parentName}  ${evStr}  ${ciStr}  ${isPublic}`);
}

console.log(`\n=== PUBLIC channels (@everyone has channel-level allow VIEW) (${publicChannels.length}) ===`);
for (const ch of publicChannels) console.log(`  ${ch.id} #${ch.name}`);
console.log('\nExpected: only #gcpd-handbook-of-rules and #welcome should be PUBLIC.\n');

await pool.end();
