// List every channel grouped by category, normalized name visible, with
// @Verified visibility flag. Helps identify mod/admin channels I missed.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID      = '1469931133981687873';
const KITSUNE_ID    = '1498486251576229958';
const VERIFIED_ROLE = '1498502484912635906';
const VIEW = 1n << 10n;

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KITSUNE_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}` },
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

function normalize(s) {
  if (!s) return '';
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const cats = new Map(channels.filter(c => c.type === 4).map(c => [c.id, c.name]));

const grouped = {};
for (const ch of channels) {
  if (ch.type === 4) continue;
  const cat = ch.parent_id ? (cats.get(ch.parent_id) || '?') : '— TOP LEVEL —';
  if (!grouped[cat]) grouped[cat] = [];

  const ow = ch.permission_overwrites || [];
  const ev = ow.find(o => o.id === GUILD_ID);
  const v  = ow.find(o => o.id === VERIFIED_ROLE);
  const evDeniesView   = ev && (BigInt(ev.deny || '0') & VIEW) === VIEW;
  const vDeniesView    = v  && (BigInt(v.deny  || '0') & VIEW) === VIEW;
  const vAllowsView    = v  && (BigInt(v.allow || '0') & VIEW) === VIEW;

  const verifiedSees = vDeniesView ? false : vAllowsView ? true : !evDeniesView;

  grouped[cat].push({
    id: ch.id,
    name: ch.name,
    normalized: normalize(ch.name),
    verifiedSees,
  });
}

const STAFF_LOOK = /(found|leader|kanrisha|kaishakunin|musashi|lord?|lead|admin|moderator|owner|wukong|lu bu|stafff?|tickets?|punish|audit|reports?|backstage|^logs?|mod-log|mod-section|mod-chat)/i;

for (const [cat, list] of Object.entries(grouped)) {
  console.log(`\n📂 ${cat}`);
  for (const c of list) {
    const flag = STAFF_LOOK.test(c.normalized) ? '🔒STAFF?' : '';
    const vis = c.verifiedSees ? '👁 VISIBLE  ' : '   hidden   ';
    console.log(`  ${vis}  ${c.id.padEnd(20)}  #${c.name.padEnd(34)}  (norm: ${c.normalized.padEnd(30)})  ${flag}`);
  }
}

await pool.end();
