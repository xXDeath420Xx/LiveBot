/**
 * Rotates the encrypted token for Kitsune in the custom_bots table.
 * Reads the new token from env var NEW_TOKEN — NEVER from a file, NEVER prints
 * the token (only the prefix for sanity check). Verifies the round-trip
 * (encrypt → store → fetch → decrypt) returns the same value, then pings
 * Discord with the new token to confirm it's accepted.
 */
import enc from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1498486251576229958';
const newToken = process.env.NEW_TOKEN;

if (!newToken || newToken.length < 50) {
  console.error('NEW_TOKEN env var missing or too short');
  process.exit(1);
}

console.log(`Rotating token for bot ${BOT_ID}`);
console.log(`New token prefix: ${newToken.slice(0, 24)}... (length ${newToken.length})`);

// Encrypt + store
const encrypted = enc.encrypt(newToken);
const stored = JSON.stringify(encrypted);

const [r] = await pool.execute(
  'UPDATE custom_bots SET bot_token = ? WHERE bot_id = ?',
  [stored, BOT_ID]
);
console.log(`UPDATE affected ${r.affectedRows} row(s)`);

// Verify round-trip
const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const decrypted = enc.decrypt(JSON.parse(row.bot_token));
const roundtripOK = decrypted === newToken;
console.log(`Round-trip decrypt: ${roundtripOK ? '✓ matches' : '✗ MISMATCH (encryption broken!)'}`);

if (!roundtripOK) {
  console.error('Refusing to continue — DB write is corrupt');
  await pool.end();
  process.exit(2);
}

// Test with Discord — GET /applications/@me
const r2 = await fetch('https://discord.com/api/v10/applications/@me', {
  headers: {
    Authorization: `Bot ${decrypted}`,
    'User-Agent': 'CertiFriedUtility-rotate (https://certifriedmultitool.com, 1.0)'
  }
});
console.log(`Discord auth test: ${r2.status} ${r2.statusText}`);
if (r2.status === 200) {
  const app = await r2.json();
  console.log(`  app.name: ${app.name}`);
  console.log(`  app.id:   ${app.id}`);
  if (app.id !== BOT_ID) {
    console.error(`  ⚠ TOKEN BELONGS TO DIFFERENT APP (${app.id}) — expected ${BOT_ID}`);
  } else {
    console.log(`✅ Token rotated successfully — Discord accepts it for the correct app`);
  }
} else {
  const txt = await r2.text();
  console.error(`Discord rejected the new token: ${txt.slice(0, 300)}`);
}

await pool.end();
process.exit(0);
