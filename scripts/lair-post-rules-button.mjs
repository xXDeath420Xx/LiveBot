// Post the I-Agree rules button after the 7 rule images in Mama Bear's Lair.
// Updates verify_config.gate_message_id so admins can find the gate later.
// Handler (interactions/buttons/verify_accept.js) keys off custom_id, not msg id.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1216126780767731722';
const RULES_CH = '1216603920542208000';
const BOT_ID   = '1496406792417185802';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
if (!rows.length) { console.error('CertiFried Bear token not found'); process.exit(1); }
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

const body = {
  embeds: [{
    color: 0xff8a3d,
    title: '🐻 Welcome to the Lair',
    description: [
      'By clicking **I Agree** below, you confirm you have **read and agree to all the rules above** and are **18 or older**.',
      '',
      'Verified members get full access to the server. Unverified members are auto-removed after 7 days.',
    ].join('\n'),
  }],
  components: [{
    type: 1,
    components: [{
      type: 2,
      style: 3,      // GREEN / Success
      label: 'I Agree',
      emoji: { name: '✅' },
      custom_id: 'verify_accept',
    }],
  }],
};

const res = await fetch(`https://discord.com/api/v10/channels/${RULES_CH}/messages`, {
  method: 'POST',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`POST failed: ${res.status} ${(await res.text()).slice(0, 250)}`);
  await pool.end();
  process.exit(1);
}

const msg = await res.json();
console.log(`✓ Posted I-Agree button as message ${msg.id}`);

await pool.execute(
  'UPDATE verify_config SET gate_message_id = ?, gate_channel_id = ?, enabled = 1, updated_at = NOW() WHERE guild_id = ?',
  [msg.id, RULES_CH, GUILD_ID]
);
console.log(`✓ verify_config.gate_message_id → ${msg.id}`);

await pool.end();
console.log('\nDone.');
