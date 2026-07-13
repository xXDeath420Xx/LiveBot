/**
 * Smart Kitsune deploy: respects Discord's ACTUAL retry-after, not hardcoded
 * waits. Bails on 30034 (daily cap), otherwise sleeps exactly what Discord
 * says and tries again. Up to 30 attempts.
 */
import { readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import enc from '../utils/encryption.js';
import pool from '../utils/db.js';

const log = (...a) => {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] ` + a.join(' ') + '\n');
};

const BOT_ID = '1498486251576229958';
const GUILD_ID = '1469931133981687873';
const MAX_ATTEMPTS = 30;

async function loadCommands() {
  const dir = resolve(process.cwd(), 'commands');
  const out = [];
  for (const cat of readdirSync(dir)) {
    const catDir = join(dir, cat);
    if (!statSync(catDir).isDirectory()) continue;
    for (const file of readdirSync(catDir)) {
      if (!file.endsWith('.js') || file.endsWith('-handler.js')) continue;
      try {
        const mod = await import(pathToFileURL(join(catDir, file)).href);
        const cmd = mod.default || mod;
        if (cmd?.data?.toJSON) out.push(cmd.data.toJSON());
        else if (cmd?.data) out.push(cmd.data);
      } catch { /* */ }
    }
  }
  return out;
}

const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token = enc.decrypt(JSON.parse(row.bot_token));

const commands = await loadCommands();
log(`Loaded ${commands.length} commands`);

const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;
const headers = {
  Authorization: `Bot ${token}`,
  'Content-Type': 'application/json',
  'User-Agent': 'CertiFriedUtility-deploy (https://certifriedmultitool.com, 1.0)'
};
const body = JSON.stringify(commands);

let success = false;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const start = Date.now();
  log(`[attempt ${attempt}/${MAX_ATTEMPTS}] PUT ${commands.length} commands (${body.length} bytes)...`);
  const r = await fetch(url, { method: 'PUT', headers, body });
  const txt = await r.text();
  const elapsed = Date.now() - start;
  log(`  → ${r.status} in ${elapsed}ms`);

  if (r.status >= 200 && r.status < 300) {
    const arr = JSON.parse(txt);
    log(`✅ DEPLOYED ${arr.length} commands to Kitsune`);
    log(`   sample: ${arr.slice(0, 5).map(c => c.name).join(', ')}...`);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(body).digest('hex');
    await pool.execute(
      `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
       VALUES (?, ?, ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE hash=VALUES(hash), deployed_at=NOW(), blocked_until=NULL, last_block_reason=NULL`,
      [BOT_ID, GUILD_ID, hash]
    );
    log(`✅ hash stored — future restarts will skip`);
    success = true;
    break;
  }

  let parsed = {}; try { parsed = JSON.parse(txt); } catch { /* */ }
  if (parsed.code === 30034) {
    log(`❌ FATAL: 30034 daily cap — wait until UTC midnight + 24h`);
    break;
  }
  if (r.status === 429) {
    // Respect Discord's retry-after exactly + 1s safety margin
    const retryAfter = parseFloat(r.headers.get('retry-after') || parsed.retry_after || '5');
    const waitMs = Math.ceil((retryAfter + 1) * 1000);
    log(`  429 — waiting ${(retryAfter + 1).toFixed(1)}s (Discord said ${retryAfter}s)`);
    await new Promise(rs => setTimeout(rs, waitMs));
    continue;
  }
  log(`❌ unexpected ${r.status}: ${txt.slice(0, 300)}`);
  break;
}

await pool.end();
process.exit(success ? 0 : 1);
