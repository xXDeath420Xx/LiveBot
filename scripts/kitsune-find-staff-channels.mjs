// Read-only inspection: list every channel in the Kitsune guild with its
// current @Verified visibility, so we can see which ones an admin/mod channel
// got mis-classified.

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

// Strip combining marks, decompose unicode-styled letters back to ASCII for matching.
// "𝔎𝘪𝘵𝘴𝘶𝘯𝘦" → "kitsune", "𝓂𝑜𝒹" → "mod", "𝒜𝒹𝓂𝒾𝓃" → "admin", etc.
function normalize(s) {
  if (!s) return '';
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const STAFF_HINT = /mod[\s_-]?log|admin|staff|kanrisha|punish|tickets?|audit|owner|^logs?$|mod[\s_-]chat|mod[\s_-]section|report/i;

const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
const roleName = new Map(roles.map(r => [r.id, r.name]));

const verifiedCanSee = [];
const verifiedExplicitDeny = [];
const verifiedNoOverwrite = [];

for (const ch of channels.sort((a,b) => (a.parent_id||'').localeCompare(b.parent_id||'') || a.position - b.position)) {
  if (ch.type === 4) continue; // skip categories
  const normalized = normalize(ch.name);
  const looksStaff = STAFF_HINT.test(normalized);

  const ow = ch.permission_overwrites || [];
  const ev = ow.find(o => o.id === GUILD_ID);
  const v  = ow.find(o => o.id === VERIFIED_ROLE);

  const evDeniesView   = ev && (BigInt(ev.deny || '0') & VIEW) === VIEW;
  const evAllowsView   = ev && (BigInt(ev.allow|| '0') & VIEW) === VIEW;
  const vDeniesView    = v  && (BigInt(v.deny  || '0') & VIEW) === VIEW;
  const vAllowsView    = v  && (BigInt(v.allow || '0') & VIEW) === VIEW;

  let verifiedSees;
  if (vDeniesView) verifiedSees = false;
  else if (vAllowsView) verifiedSees = true;
  else if (evDeniesView) verifiedSees = false;
  else if (evAllowsView) verifiedSees = true;
  else verifiedSees = false; // @everyone role lacks VIEW (stripped), no overwrite → not visible

  const flag = looksStaff ? '🔒STAFF?' : '';
  const line = `  ${verifiedSees ? '👁 VISIBLE  ' : '   hidden   '}  ${ch.id.padEnd(20)}  #${ch.name}  ${flag}`;
  if (looksStaff || verifiedSees) console.log(line);
}

console.log('\nDone. Channels marked 🔒STAFF? are ones whose normalized name suggests admin/mod use.');

await pool.end();
