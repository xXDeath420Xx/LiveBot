/**
 * Move newly-created Forsaken Warriors channels into their proper categories.
 * Idempotent — re-running this just confirms each channel's parent_id.
 */
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1469931133981687873';
const KITSUNE_BOT_ID = '1498486251576229958';

const MOVES = [
  { name: 'support',      id: '1498965812898172998', parent_id: '1469931134845456531' /* 𝒯𝒽𝑒 𝒞𝒽𝒶𝓃𝓃𝑒𝓁𝓈 */ },
  { name: 'tech-support', id: '1498965813850542220', parent_id: '1469931134845456531' /* 𝒯𝒽𝑒 𝒞𝒽𝒶𝓃𝓃𝑒𝓁𝓈 */ },
  { name: 'suggestions',  id: '1498965818518667406', parent_id: '1469931134845456531' /* 𝒯𝒽𝑒 𝒞𝒽𝒶𝓃𝓃𝑒𝓁𝓈 */ },
  { name: 'music',        id: '1498965817050792038', parent_id: '1470598657412960297' /* 𝐵🏵𝒯𝒮 (BOTS) */ },
];

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KITSUNE_BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));
const rest = new REST({ version: '10' }).setToken(token);

for (const m of MOVES) {
  const before = await rest.get(Routes.channel(m.id));
  if (before.parent_id === m.parent_id) {
    console.log(`#${m.name} already under ${m.parent_id} — skipping`);
    continue;
  }
  await rest.patch(Routes.channel(m.id), {
    body: { parent_id: m.parent_id },
    reason: 'CertiFried setup: integrate community channels into existing categories'
  });
  console.log(`#${m.name}  ${before.parent_id ?? 'top-level'}  →  ${m.parent_id}`);
}

await pool.end();
