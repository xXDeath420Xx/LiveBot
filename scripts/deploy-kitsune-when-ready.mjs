/**
 * Background poller: tests a single-command PUT every ~5 min. The instant
 * Discord stops returning 30034, fires the full 49-command bulk PUT.
 *
 * Designed to run unattended via `pm2 start --name kitsune-deploy-watcher`.
 * Logs progress + budget status to stdout. Auto-exits on success.
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
const POLL_INTERVAL_MS = 5 * 60 * 1000 + 30_000; // 5m30s
const MAX_HOURS = 26;
const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;

async function loadAllCommands() {
  const commandsDir = resolve(process.cwd(), 'commands');
  const out = [];
  for (const cat of readdirSync(commandsDir)) {
    const catDir = join(commandsDir, cat);
    if (!statSync(catDir).isDirectory()) continue;
    for (const file of readdirSync(catDir)) {
      if (!file.endsWith('.js') || file.endsWith('-handler.js')) continue;
      try {
        const mod = await import(pathToFileURL(join(catDir, file)).href);
        const cmd = mod.default || mod;
        if (cmd?.data?.toJSON) out.push(cmd.data.toJSON());
        else if (cmd?.data) out.push(cmd.data);
      } catch { /* skip */ }
    }
  }
  return out;
}

async function run() {
  const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
  const token = enc.decrypt(JSON.parse(row.bot_token));
  await pool.end();

  const commands = await loadAllCommands();
  log(`Loaded ${commands.length} commands for Kitsune deploy`);
  const body = JSON.stringify(commands);

  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'CertiFriedUtility-watcher (https://certifriedmultitool.com, 1.0)'
  };

  // Probe with a 1-command "test" body. If 200, immediately do the real 49.
  // If 30034, wait and retry. We DON'T use the probe body for real deploy
  // since it'd waste 1 budget slot per probe; instead, probe with the SAME
  // full body each time — that way a success is the real success.
  // But: if the real PUT costs 49 slots, probing it costs 49 fail-attempt
  // slots too (Discord may or may not charge for failed creates).
  // Safer: probe with 1, then immediately do 49 once probe passes.
  const probeBody = JSON.stringify([
    { name: 'kitsune_deploy_probe', description: 'temp probe', type: 1 }
  ]);

  const startTime = Date.now();
  let attempt = 0;
  while (Date.now() - startTime < MAX_HOURS * 3600_000) {
    attempt++;
    log(`[probe ${attempt}] testing 1-cmd PUT...`);
    const pr = await fetch(url, { method: 'PUT', headers, body: probeBody });
    const ptxt = await pr.text();
    let pjs = {};
    try { pjs = JSON.parse(ptxt); } catch { /* */ }

    if (pr.status >= 200 && pr.status < 300) {
      log(`  probe SUCCESS — budget has at least 1 slot. Firing full 49-cmd PUT now...`);
      // Wait the short bucket window
      const remaining = parseFloat(pr.headers.get('x-ratelimit-remaining') || '0');
      const resetAfter = parseFloat(pr.headers.get('x-ratelimit-reset-after') || '30');
      if (remaining === 0) {
        log(`  short bucket drained, waiting ${resetAfter + 1}s for reset...`);
        await new Promise(r => setTimeout(r, (resetAfter + 1) * 1000));
      }
      const rr = await fetch(url, { method: 'PUT', headers, body });
      const rtxt = await rr.text();
      if (rr.status >= 200 && rr.status < 300) {
        const arr = JSON.parse(rtxt);
        log(`✅ DEPLOYED ${arr.length} commands to Kitsune`);
        const pool2 = (await import('../utils/db.js')).default;
        const { createHash } = await import('crypto');
        const hash = createHash('sha256').update(body).digest('hex');
        await pool2.execute(
          `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
           VALUES (?, ?, ?, NULL, NULL)
           ON DUPLICATE KEY UPDATE hash=VALUES(hash), deployed_at=NOW(), blocked_until=NULL, last_block_reason=NULL`,
          [BOT_ID, GUILD_ID, hash]
        );
        await pool2.end();
        log(`✅ hash stored. exiting.`);
        process.exit(0);
      } else {
        let rjs = {}; try { rjs = JSON.parse(rtxt); } catch { /* */ }
        log(`  full PUT failed: status=${rr.status} code=${rjs.code} retry_after=${rjs.retry_after}`);
        log(`  going back to probe loop`);
      }
    } else if (pjs.code === 30034) {
      const ra = pjs.retry_after || 300;
      const waitMs = Math.min(Math.ceil((ra + 5) * 1000), POLL_INTERVAL_MS);
      log(`  budget exhausted (30034). Discord says retry_after=${ra}s. Sleeping ${waitMs}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
    } else {
      log(`  unexpected status=${pr.status} body=${ptxt.slice(0, 200)}`);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  log(`❌ Gave up after ${MAX_HOURS}h`);
  process.exit(1);
}

run().catch(err => { log(`UNCAUGHT: ${err.stack || err.message}`); process.exit(1); });
