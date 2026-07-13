/**
 * Deploys Kitsune's 49 commands with aggressive retry-after handling.
 * Up to 10 attempts; each respects Discord's retry-after header + 1s margin.
 * Bails immediately on code 30034 (daily budget exhausted — no retry helps).
 *
 * Never prints the token. Uses process.stdout.write + explicit exit so output
 * doesn't get lost in pipe buffers.
 */
import { readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import enc from '../utils/encryption.js';
import pool from '../utils/db.js';

const log = (...a) => { process.stdout.write(a.join(' ') + '\n'); };

const BOT_ID = '1498486251576229958';
const GUILD_ID = '1469931133981687873';
const MAX_ATTEMPTS = 10;

async function loadAllCommands() {
  const commandsDir = resolve(process.cwd(), 'commands');
  const out = [];
  for (const cat of readdirSync(commandsDir)) {
    const catDir = join(commandsDir, cat);
    if (!statSync(catDir).isDirectory()) continue;
    for (const file of readdirSync(catDir)) {
      if (!file.endsWith('.js') || file.endsWith('-handler.js')) continue;
      const full = join(catDir, file);
      try {
        const mod = await import(pathToFileURL(full).href);
        const cmd = mod.default || mod;
        if (cmd?.data && typeof cmd.data.toJSON === 'function') {
          out.push(cmd.data.toJSON());
        } else if (cmd?.data) {
          out.push(cmd.data);
        }
      } catch (e) {
        log(`  skipped ${cat}/${file}: ${e.message}`);
      }
    }
  }
  return out;
}

async function main() {
  const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
  const token = enc.decrypt(JSON.parse(row.bot_token));
  await pool.end(); // close DB before HTTP loop so we don't hold the connection

  log('Loading commands from disk...');
  const commands = await loadAllCommands();
  log(`Loaded ${commands.length} command definitions`);

  const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'CertiFriedUtility-deploy (https://certifriedmultitool.com, 1.0)'
  };
  const body = JSON.stringify(commands);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    log(`[Attempt ${attempt}/${MAX_ATTEMPTS}] PUT ${commands.length} commands...`);
    const r = await fetch(url, { method: 'PUT', headers, body });
    const txt = await r.text();
    const elapsed = Date.now() - start;
    log(`  → status ${r.status} in ${elapsed}ms`);

    if (r.status >= 200 && r.status < 300) {
      const arr = JSON.parse(txt);
      log(`✅ DEPLOYED ${arr.length} commands to Kitsune`);
      // Re-open DB just to write the hash
      const pool2 = (await import('../utils/db.js')).default;
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update(body).digest('hex');
      await pool2.execute(
        `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
         VALUES (?, ?, ?, NULL, NULL)
         ON DUPLICATE KEY UPDATE hash = VALUES(hash), deployed_at = NOW(), blocked_until = NULL, last_block_reason = NULL`,
        [BOT_ID, GUILD_ID, hash]
      );
      log(`✅ Deploy hash stored — bot-manager won't redeploy on restart`);
      await pool2.end();
      process.exit(0);
    }

    // Parse Discord's error
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = {}; }

    if (parsed.code === 30034) {
      log(`❌ FATAL: code 30034 — daily 200-create budget exhausted. Wait until UTC midnight + ~24h.`);
      log(`   body: ${txt.slice(0, 300)}`);
      process.exit(2);
    }

    if (r.status === 429) {
      const retryAfter = parseFloat(r.headers.get('retry-after') || parsed.retry_after || '5');
      const waitMs = Math.ceil((retryAfter + 1) * 1000);
      log(`  429 — waiting ${waitMs}ms (${retryAfter}s + 1s margin)`);
      await new Promise(rs => setTimeout(rs, waitMs));
      continue;
    }

    log(`❌ Non-retryable status ${r.status}: ${txt.slice(0, 400)}`);
    process.exit(1);
  }

  log(`❌ Gave up after ${MAX_ATTEMPTS} attempts`);
  process.exit(1);
}

main().catch(err => {
  log(`❌ UNCAUGHT: ${err.stack || err.message}`);
  process.exit(1);
});
