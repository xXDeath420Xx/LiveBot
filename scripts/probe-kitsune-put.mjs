/**
 * Tests the bulk PUT with progressively realistic payloads to find what
 * Discord is choking on. Does NOT print the token.
 */
import enc from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1498486251576229958';
const GUILD_ID = '1469931133981687873';

const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token = enc.decrypt(JSON.parse(row.bot_token));
const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;

async function probe(label, body) {
  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'CertiFriedUtility-probe (https://certifriedmultitool.com, 1.0)'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const elapsed = Date.now() - start;
    const txt = await r.text();
    console.log(`\n[${label}] (${body.length} cmds, ${JSON.stringify(body).length} bytes) → ${r.status} in ${elapsed}ms`);
    for (const h of ['x-ratelimit-remaining', 'x-ratelimit-reset-after', 'x-ratelimit-scope', 'retry-after']) {
      const v = r.headers.get(h);
      if (v) console.log(`  ${h}: ${v}`);
    }
    if (r.status >= 400) console.log(`  body: ${txt.slice(0, 500)}`);
    else console.log(`  ✅ accepted ${JSON.parse(txt).length} commands back`);
    return r.status;
  } catch (e) {
    clearTimeout(t);
    console.log(`\n[${label}] FAILED after ${Date.now() - start}ms: ${e.message}`);
    return -1;
  }
}

// Test 1: empty bulk PUT (should clear all commands and return [])
await probe('empty', []);
await new Promise(r => setTimeout(r, 1000));

// Test 2: single tiny command
await probe('single', [{
  name: 'probe1',
  description: 'test command 1',
  type: 1
}]);
await new Promise(r => setTimeout(r, 1000));

// Test 3: 10 tiny commands
const ten = Array.from({ length: 10 }, (_, i) => ({
  name: `probe_${i}`,
  description: `test command ${i}`,
  type: 1
}));
await probe('ten', ten);

await pool.end();
