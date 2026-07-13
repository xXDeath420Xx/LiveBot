// READ-ONLY full wiring audit for guild 1475352754682597468 (Your Mafia).
// REST only. Reconciles every stored role reference + panel button against the
// live role list and the live panel messages. Writes nothing.
import { REST, Routes, PermissionFlagsBits } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
dotenv.config();

const BOT_ID = '1475353066243883111';
const GUILD  = '1475352754682597468';

// purpose map for referenced roles (id -> human label)
const PURPOSE = {
  '1475365665664667699': 'quarantine_role',
  '1475365668621783151': 'muted_role',
  '1475365680999043177': 'staff (modmail+ticket+automod-ignore)',
  '1475365675974262805': 'automod-ignore',
  '1475365691099054192': 'automod-ignore',
  '1475365688104325183': 'automod-ignore',
  '1475365685755510888': 'automod-ignore',
  '1475365683612090418': 'automod-ignore',
  '1487024558715174913': 'Verified (panel 33)',
};

const has = (perms, bit) => (BigInt(perms) & bit) === bit;
const [[bot]] = [await pool.query('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID])];
const token = encryption.decrypt(JSON.parse(bot[0].bot_token));
const rest = new REST({ version: '10' }).setToken(token);

const roles = await rest.get(Routes.guildRoles(GUILD));
const byId = Object.fromEntries(roles.map(r => [r.id, r]));

// bot hierarchy
const me = await rest.get(Routes.guildMember(GUILD, BOT_ID));
const myRoles = me.roles.map(id => byId[id]).filter(Boolean);
const myHighest = myRoles.reduce((m, r) => r.position > m.position ? r : m, { position: -1, name: '(none)' });
let permBits = BigInt(byId[GUILD]?.permissions || 0);
for (const r of myRoles) permBits |= BigInt(r.permissions);
const admin = has(permBits, PermissionFlagsBits.Administrator);
const manage = has(permBits, PermissionFlagsBits.ManageRoles);
console.log(`BOT: highest pos=${myHighest.position} "${myHighest.name}" | Administrator=${admin} ManageRoles=${manage}`);
const canAssign = (id) => (admin || manage) && byId[id] && byId[id].position < myHighest.position;

// --- referenced roles from config (recompute, same logic as discovery) ---
const [db] = await pool.query('SELECT DATABASE() db'); const dbname = db[0].db;
const [cols] = await pool.query("SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema=? AND column_name LIKE '%role%'", [dbname]);
const refs = new Map(); // id -> Set(sources)
const addRef = (id, src) => { if (!refs.has(id)) refs.set(id, new Set()); refs.get(id).add(src); };
for (const row of cols) {
  const T = row.t || row.table_name, C = row.c || row.column_name;
  const [gc] = await pool.query("SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name='guild_id'", [dbname, T]);
  if (!gc[0].n) continue;
  try {
    const [rows] = await pool.query(`SELECT \`${C}\` v FROM \`${T}\` WHERE guild_id=? AND \`${C}\` IS NOT NULL AND \`${C}\`<>''`, [GUILD]);
    for (const r of rows) for (const id of (String(r.v).match(/\d{17,20}/g) || [])) addRef(id, `${T}.${C}`);
  } catch {}
}
const [rrr] = await pool.query('SELECT m.role_id rid, p.panel_name pn FROM reaction_role_mappings m JOIN reaction_role_panels p ON m.panel_id=p.id WHERE p.guild_id=?', [GUILD]);
for (const r of rrr) addRef(String(r.rid), `panel:${r.pn}`);

console.log('\n=== ROLE REFERENCE RECONCILIATION ===');
let missing = 0, aboveBot = 0;
for (const [id, srcs] of refs) {
  const r = byId[id];
  const tag = r ? `OK   pos=${String(r.position).padStart(2)} "${r.name}"` : 'MISSING ❌';
  if (!r) missing++;
  const hier = r && r.position >= myHighest.position ? '  ⚠ ABOVE BOT' : '';
  if (r && r.position >= myHighest.position) aboveBot++;
  console.log(`${id}  ${tag}${hier}   [${[...srcs].join(', ')}]`);
}

// --- panel-by-panel: live button customId vs DB mapping vs existence ---
console.log('\n=== PANEL BUTTON WIRING (live message vs DB vs live roles) ===');
const [panels] = await pool.query('SELECT id,panel_name,channel_id,message_id,interaction_type FROM reaction_role_panels WHERE guild_id=? ORDER BY id', [GUILD]);
for (const p of panels) {
  console.log(`\npanel ${p.id} "${p.panel_name}" (${p.interaction_type}) msg=${p.message_id}`);
  const [maps] = await pool.query('SELECT emoji_id, role_id FROM reaction_role_mappings WHERE panel_id=?', [p.id]);
  const dbByEmoji = Object.fromEntries(maps.map(m => [m.emoji_id, m.role_id]));
  let msg;
  try { msg = await rest.get(Routes.channelMessage(p.channel_id, p.message_id)); }
  catch (e) { console.log(`  ⚠ cannot fetch live message: ${e.message}`); continue; }
  for (const row of (msg.components || [])) for (const c of (row.components || [])) {
    if (c.type === 2) { // button
      const cidRole = (c.custom_id || '').startsWith('rr_') ? c.custom_id.slice(3) : '(non-role)';
      const emoji = c.emoji?.name || c.emoji?.id;
      const dbRole = dbByEmoji[emoji];
      const cidOk = byId[cidRole] ? 'exists' : 'MISSING❌';
      const matchDb = cidRole === dbRole ? 'db✓' : `db≠(${dbRole})❌`;
      const assign = byId[cidRole] ? (canAssign(cidRole) ? 'assignable' : 'NOT-assignable⚠') : '-';
      console.log(`  btn emoji=${emoji} label="${c.label}" -> role ${cidRole} [${cidOk}, ${matchDb}, ${assign}]`);
    } else if (c.type === 3) { // select
      console.log(`  select customId=${c.custom_id} options=${(c.options||[]).map(o=>o.value+(byId[o.value]?'':'❌')).join(',')}`);
    }
  }
}

console.log(`\n=== SUMMARY ===  missingRoles=${missing}  rolesAboveBot=${aboveBot}`);
await pool.end(); process.exit(0);
