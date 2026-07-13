// FIX: rewire the Verification panel button + DB mapping to the current
// "Verified" role. REST only (no gateway). Idempotent + verifies after.
// Guild 1475352754682597468, custom bot 1475353066243883111.
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

dotenv.config();

const BOT_ID   = '1475353066243883111';
const GUILD    = '1475352754682597468';
const CHANNEL  = '1475365704772358237';
const MESSAGE  = '1475365831817957466';
const OLD_ROLE = '1475365671075315753'; // deleted role the button points at
const VERIFIED = '1487024558715174913'; // current "Verified" role
const PANEL_ID = 33;
const MAPPING_ID = 130;
const OLD_CUSTOM = `rr_${OLD_ROLE}`;
const NEW_CUSTOM = `rr_${VERIFIED}`;

const [[bot]] = [await pool.query('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID])];
const token = encryption.decrypt(JSON.parse(bot[0].bot_token));
const rest = new REST({ version: '10' }).setToken(token);

// Guard: confirm the Verified role still exists before pointing anything at it.
const roles = await rest.get(Routes.guildRoles(GUILD));
if (!roles.some(r => r.id === VERIFIED)) {
  console.error(`ABORT: Verified role ${VERIFIED} not found in guild.`);
  await pool.end(); process.exit(1);
}

// --- 1) Edit the live message button customId (preserve everything else) ---
const msg = await rest.get(Routes.channelMessage(CHANNEL, MESSAGE));
let edited = false;
const components = (msg.components || []).map(row => ({
  ...row,
  components: (row.components || []).map(c => {
    if (c.custom_id === OLD_CUSTOM || c.custom_id === NEW_CUSTOM) {
      if (c.custom_id !== NEW_CUSTOM) edited = true;
      return { ...c, custom_id: NEW_CUSTOM };
    }
    return c;
  })
}));

if (edited) {
  await rest.patch(Routes.channelMessage(CHANNEL, MESSAGE), {
    body: { embeds: msg.embeds, components }
  });
  console.log(`MESSAGE: button customId ${OLD_CUSTOM} -> ${NEW_CUSTOM}`);
} else {
  console.log('MESSAGE: button already points at the Verified role (no change).');
}

// --- 2) Update the DB mapping ---
const [res] = await pool.query(
  'UPDATE reaction_role_mappings SET role_id = ? WHERE id = ? AND panel_id = ?',
  [VERIFIED, MAPPING_ID, PANEL_ID]
);
console.log(`DB: mapping ${MAPPING_ID} role_id -> ${VERIFIED} (rows affected: ${res.affectedRows})`);

// --- 3) Verify ---
console.log('\n=== VERIFY ===');
const after = await rest.get(Routes.channelMessage(CHANNEL, MESSAGE));
for (const row of (after.components || []))
  for (const c of (row.components || []))
    console.log(`live button customId="${c.custom_id}" label="${c.label}"`);
const [m] = await pool.query('SELECT id, role_id, emoji_id FROM reaction_role_mappings WHERE id = ?', [MAPPING_ID]);
console.log('db mapping:', JSON.stringify(m[0]));

await pool.end();
process.exit(0);
