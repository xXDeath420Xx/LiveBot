// Read-only Discord-API survey for guild 800157336458231848 ("Gotham").
// Pulls: channels (text/voice/category), roles (with positions), member counts,
// the rules channel + Carl-bot message, candidate welcome/tech channels,
// and current overall bots present. No mutations.

import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const RULES_CH = '800256456997863434';
const CARL_RULES_MSG = '1253544082127585351';
const VERIFIED_ROLE = '800252381513777158';
const STREAMER_CH = '1038268111029280778';

const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }

async function api(method, path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}` },
  });
  if (!r.ok) return { __err: `${r.status}: ${(await r.text()).slice(0, 200)}` };
  return r.status === 204 ? null : r.json();
}

console.log('\n>>> Guild metadata');
const g = await api('GET', `/guilds/${GUILD}?with_counts=true`);
console.log({
  name: g.name, owner_id: g.owner_id,
  approximate_member_count: g.approximate_member_count,
  approximate_presence_count: g.approximate_presence_count,
  premium_tier: g.premium_tier,
  verification_level: g.verification_level,
});

console.log('\n>>> Roles (top 30 by position)');
const roles = await api('GET', `/guilds/${GUILD}/roles`);
roles.sort((a, b) => b.position - a.position);
for (const r of roles.slice(0, 30)) {
  const isVerified = r.id === VERIFIED_ROLE;
  console.log(`  pos=${String(r.position).padStart(3)} id=${r.id} name="${r.name}" perms=${r.permissions}${isVerified ? '  <<< Gotham Citizen / verified' : ''}`);
}
console.log(`  ... ${roles.length} total`);
const verified = roles.find(r => r.id === VERIFIED_ROLE);
if (!verified) console.log(`  WARNING: verified role ${VERIFIED_ROLE} not found`);

console.log('\n>>> Channels (by category)');
const channels = await api('GET', `/guilds/${GUILD}/channels`);
const cats = channels.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
const byParent = new Map();
for (const c of channels) {
  if (c.type === 4) continue;
  const k = c.parent_id || '__root__';
  if (!byParent.has(k)) byParent.set(k, []);
  byParent.get(k).push(c);
}
for (const arr of byParent.values()) arr.sort((a, b) => a.position - b.position);

const typeLabel = { 0: 'text', 2: 'voice', 5: 'announcement', 13: 'stage', 15: 'forum', 11: 'public-thread', 12: 'private-thread' };
function dumpChannel(c) {
  const ow = c.permission_overwrites?.length || 0;
  console.log(`    [${typeLabel[c.type] || c.type}] ${c.id} #${c.name}${ow ? ` ow=${ow}` : ''}`);
}
const root = byParent.get('__root__') || [];
if (root.length) { console.log('  (uncategorized)'); for (const c of root) dumpChannel(c); }
for (const cat of cats) {
  console.log(`  📁 ${cat.id} ${cat.name}`);
  for (const c of byParent.get(cat.id) || []) dumpChannel(c);
}

console.log('\n>>> Candidate channels by name');
const matches = (name, terms) => terms.some(t => name.toLowerCase().includes(t));
const candidates = {
  'tech': channels.filter(c => c.type === 0 && matches(c.name, ['tech', 'question', 'support', 'help'])),
  'welcome/intro/lobby': channels.filter(c => c.type === 0 && matches(c.name, ['welcome', 'intro', 'lobby', 'arrival', 'gate'])),
  'general/chat': channels.filter(c => c.type === 0 && matches(c.name, ['general', 'chat', 'main'])),
  'logs/audit': channels.filter(c => c.type === 0 && matches(c.name, ['log', 'audit', 'mod'])),
  'rules': channels.filter(c => c.type === 0 && matches(c.name, ['rules', 'agreement', 'verify'])),
  'tickets': channels.filter(c => c.type === 0 && matches(c.name, ['ticket'])),
};
for (const [k, v] of Object.entries(candidates)) {
  console.log(`  ${k}: ${v.map(c => `#${c.name}(${c.id})`).join(', ') || '(none)'}`);
}

console.log('\n>>> Rules channel current permission overwrites');
const rch = await api('GET', `/channels/${RULES_CH}`);
console.log(`  name="${rch.name}" type=${rch.type}`);
for (const ow of rch.permission_overwrites || []) {
  console.log(`    [${ow.type === 0 ? 'role' : 'user'}] ${ow.id}: allow=${ow.allow} deny=${ow.deny}`);
}

console.log('\n>>> Carl-bot rules message');
const msg = await api('GET', `/channels/${RULES_CH}/messages/${CARL_RULES_MSG}`);
if (msg.__err) console.log(`  ERR ${msg.__err}`);
else {
  console.log(`  author=${msg.author?.username} (${msg.author?.id}) bot=${msg.author?.bot}`);
  console.log(`  content snippet: ${(msg.content || '').slice(0, 200).replace(/\n/g, ' / ')}`);
  console.log(`  embeds=${msg.embeds?.length} components=${msg.components?.length}`);
  if (msg.reactions) console.log(`  reactions: ${msg.reactions.map(r => `${r.emoji.name}x${r.count}`).join(', ')}`);
}

console.log('\n>>> Streamer-history channel metadata');
const sch = await api('GET', `/channels/${STREAMER_CH}`);
console.log(`  name="${sch.name}" type=${sch.type} created≈${new Date(Number((BigInt(STREAMER_CH) >> 22n) + 1420070400000n)).toISOString()}`);

await pool.end();
