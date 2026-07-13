// READ-ONLY diagnostic for the Verification reaction-role panel.
// Guild 1475352754682597468, custom bot 1475353066243883111.
// Uses REST only (no gateway session). Prints evidence; writes nothing.
import { REST, Routes, PermissionFlagsBits } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

dotenv.config();

const BOT_ID   = '1475353066243883111';
const GUILD    = '1475352754682597468';
const CHANNEL  = '1475365704772358237';
const MESSAGE  = '1475365831817957466';
const OLD_ROLE = '1475365671075315753'; // currently granted
const VERIFIED = '1487024558715174913'; // intended

const has = (perms, bit) => (BigInt(perms) & bit) === bit;

const [[bot]] = [await pool.query('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID])];
const token = encryption.decrypt(JSON.parse(bot[0].bot_token));
const rest = new REST({ version: '10' }).setToken(token);

console.log('=== ROLES ===');
const roles = await rest.get(Routes.guildRoles(GUILD));
const byId = Object.fromEntries(roles.map(r => [r.id, r]));
const show = (id, tag) => {
  const r = byId[id];
  console.log(tag.padEnd(10), r ? `EXISTS  pos=${r.position}  name="${r.name}"  managed=${r.managed}` : 'DOES NOT EXIST', id);
};
show(OLD_ROLE, 'OLD');
show(VERIFIED, 'VERIFIED');

console.log('\n=== BOT MEMBER + HIERARCHY ===');
const me = await rest.get(Routes.guildMember(GUILD, BOT_ID));
const myRoles = me.roles.map(id => byId[id]).filter(Boolean);
const myHighest = myRoles.reduce((m, r) => (r.position > m.position ? r : m), { position: -1, name: '(none)' });
const everyone = byId[GUILD]; // @everyone role shares the guild id
let permBits = BigInt(everyone?.permissions || 0);
for (const r of myRoles) permBits |= BigInt(r.permissions);
const admin = has(permBits, PermissionFlagsBits.Administrator);
const manageRoles = has(permBits, PermissionFlagsBits.ManageRoles);
console.log('bot highest role:', `pos=${myHighest.position} name="${myHighest.name}"`);
console.log('bot Administrator:', admin, '| bot ManageRoles:', manageRoles);
const vPos = byId[VERIFIED]?.position;
if (vPos !== undefined) {
  const aboveBot = vPos >= myHighest.position;
  console.log(`Verified pos=${vPos} vs botHighest=${myHighest.position} -> ${aboveBot ? 'ABOVE/EQUAL bot (CANNOT assign!)' : 'below bot (assignable)'}`);
  console.log('CAN BOT ASSIGN VERIFIED?', (admin || manageRoles) && !aboveBot);
}

console.log('\n=== LIVE PANEL MESSAGE COMPONENTS ===');
const msg = await rest.get(Routes.channelMessage(CHANNEL, MESSAGE));
console.log('content/embeds title:', msg.embeds?.[0]?.title, '| desc:', msg.embeds?.[0]?.description);
for (const row of (msg.components || [])) {
  for (const c of (row.components || [])) {
    console.log(`button: customId="${c.custom_id}" label="${c.label}" style=${c.style} emoji=${JSON.stringify(c.emoji)}`);
  }
}

console.log('\n=== DB MAPPING (panel 33) ===');
const [m] = await pool.query('SELECT * FROM reaction_role_mappings WHERE panel_id=33');
console.log(JSON.stringify(m));

await pool.end();
process.exit(0);
