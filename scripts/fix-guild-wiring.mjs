// FIX: rewire all stale role references in guild 1475352754682597468 to the
// current (Mar-27 rebuild) roles, rebuild the Notifications self-role panel in
// 🎭・roles, and drop the orphaned Game-Identity panel. REST + DB. Verifies after.
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
dotenv.config();

const BOT_ID = '1475353066243883111';
const GUILD  = '1475352754682597468';
const ROLES_CHANNEL = '1487024719889825932'; // 🎭・roles

// current role IDs
const MUTED='1487024577057001583', QUARANTINE='1487024579628241039', MODERATOR='1487024531078910042';
const STAFF6 = ['1487024522736697464','1487024524984713246','1487024526800850986','1487024529007181864','1487024531078910042','1487024533264273461']; // Owner..Trial Mod
// Notifications new roles by emoji
const NOTIF = [
  { mapId:131, emoji:'📢', role:'1487024560715993159', name:'Announcements' },
  { mapId:132, emoji:'🎉', role:'1487024562557157489', name:'Events' },
  { mapId:133, emoji:'📋', role:'1487024564759302286', name:'Patch Notes' },
  { mapId:134, emoji:'🎁', role:'1487024567108108358', name:'Giveaways' },
];

const [[bot]] = [await pool.query('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID])];
const token = encryption.decrypt(JSON.parse(bot[0].bot_token));
const rest = new REST({ version: '10' }).setToken(token);

// ---- GUARD: every target role + the roles channel must exist ----
const roles = await rest.get(Routes.guildRoles(GUILD));
const exists = id => roles.some(r => r.id === id);
const need = [MUTED, QUARANTINE, MODERATOR, ...STAFF6, ...NOTIF.map(n=>n.role)];
const bad = need.filter(id => !exists(id));
if (bad.length) { console.error('ABORT: target roles missing:', bad); await pool.end(); process.exit(1); }
try { await rest.get(Routes.channel(ROLES_CHANNEL)); }
catch { console.error('ABORT: roles channel not found', ROLES_CHANNEL); await pool.end(); process.exit(1); }
console.log('GUARD ok: all target roles + roles channel exist.\n');

// ---- 1) moderation / quarantine / staff DB rewires ----
const upd = async (sql, params, label) => { const [r] = await pool.query(sql, params); console.log(`${label}: rows=${r.affectedRows}`); };
await upd('UPDATE moderation_config SET muted_role_id=? WHERE guild_id=?', [MUTED, GUILD], 'muted_role -> Muted');
await upd('UPDATE quarantine_config SET quarantine_role_id=? WHERE guild_id=?', [QUARANTINE, GUILD], 'quarantine_role -> Quarantine');
await upd('UPDATE modmail_config SET staff_role_id=? WHERE guild_id=?', [MODERATOR, GUILD], 'modmail staff -> Moderator');
await upd('UPDATE ticket_config SET support_role_id=? WHERE guild_id=?', [MODERATOR, GUILD], 'ticket support -> Moderator');

// automod ignored_roles: every rule that had a (now-dead) ignore list -> the 6 staff roles
const staffJson = JSON.stringify(STAFF6);
await upd(
  "UPDATE automod_rules SET ignored_roles=? WHERE guild_id=? AND ignored_roles IS NOT NULL AND ignored_roles NOT IN ('[]','')",
  [staffJson, GUILD], 'automod ignored_roles -> 6 staff roles');

// ---- 2) rebuild Notifications panel (id 34) in 🎭・roles ----
const [[p34row]] = [await pool.query('SELECT description, embed_color FROM reaction_role_panels WHERE id=34')];
const p34 = p34row[0];
const buttons = NOTIF.map(n => ({ type:2, style:2, label:n.name, emoji:{ name:n.emoji }, custom_id:`rr_${n.role}` }));
const rows = [{ type:1, components: buttons }]; // 4 buttons fit one action row
const posted = await rest.post(Routes.channelMessages(ROLES_CHANNEL), { body: {
  embeds: [{ title:'🔔 Notifications', description: p34?.description || 'Pick which notifications you want to receive', color: parseInt((p34?.embed_color||'#3498DB').replace('#',''),16) }],
  components: rows,
}});
console.log(`\nNotifications panel posted: msg=${posted.id} in #roles`);
await pool.query('UPDATE reaction_role_panels SET channel_id=?, message_id=? WHERE id=34', [ROLES_CHANNEL, posted.id]);
for (const n of NOTIF) await pool.query('UPDATE reaction_role_mappings SET role_id=? WHERE id=? AND panel_id=34', [n.role, n.mapId]);
console.log('panel 34 channel/message + 4 mappings updated.');

// ---- 3) drop orphaned Game-Identity panel (id 35) ----
const [dm] = await pool.query('DELETE FROM reaction_role_mappings WHERE panel_id=35');
const [dp] = await pool.query('DELETE FROM reaction_role_panels WHERE id=35');
console.log(`Game-Identity dropped: mappings=${dm.affectedRows} panel=${dp.affectedRows}`);

// ---- 4) VERIFY ----
console.log('\n=== VERIFY ===');
const [[mod]]=[await pool.query('SELECT muted_role_id FROM moderation_config WHERE guild_id=?',[GUILD])];
const [[q]]=[await pool.query('SELECT quarantine_role_id FROM quarantine_config WHERE guild_id=?',[GUILD])];
const [[mm]]=[await pool.query('SELECT staff_role_id FROM modmail_config WHERE guild_id=?',[GUILD])];
const [[tk]]=[await pool.query('SELECT support_role_id FROM ticket_config WHERE guild_id=?',[GUILD])];
const [am]=await pool.query("SELECT ignored_roles FROM automod_rules WHERE guild_id=? AND ignored_roles NOT IN ('[]','')",[GUILD]);
console.log('muted:',mod[0].muted_role_id,'quarantine:',q[0].quarantine_role_id,'modmail:',mm[0].staff_role_id,'ticket:',tk[0].support_role_id);
console.log('automod ignored rows now:', am.map(r=>r.ignored_roles));
const [p]=await pool.query('SELECT id,panel_name,channel_id,message_id FROM reaction_role_panels WHERE guild_id=? ORDER BY id',[GUILD]);
console.log('panels:', JSON.stringify(p));
const live = await rest.get(Routes.channelMessage(ROLES_CHANNEL, posted.id));
for (const r of live.components) for (const c of r.components) console.log(`  live notif btn: ${c.emoji?.name} "${c.label}" -> ${c.custom_id}`);
await pool.end(); process.exit(0);
