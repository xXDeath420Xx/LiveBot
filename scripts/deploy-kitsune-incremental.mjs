/**
 * Incremental Kitsune deploy via individual POST calls.
 * Each POST registers 1 command. On 30034, waits the EXACT retry_after
 * Discord specifies. Persists progress so a restart resumes where it left off.
 *
 * This works around the daily 200-create cap by treating it as a slowly-
 * refilling token bucket: each slot frees ~411s apart at the start, faster
 * once the burst that filled it rolls off.
 */
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'fs';
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
const PROGRESS_FILE = '/tmp/kitsune-deploy-progress.json';
const MAX_HOURS = 26;

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

const allCommands = await loadCommands();
log(`Loaded ${allCommands.length} commands`);

// Check what's already deployed so we don't waste budget re-creating them
const getUrl = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;
const headers = {
  Authorization: `Bot ${token}`,
  'Content-Type': 'application/json',
  'User-Agent': 'CertiFriedUtility-incremental (https://certifriedmultitool.com, 1.0)'
};

const getResp = await fetch(getUrl, { method: 'GET', headers });
const existing = await getResp.json();
const existingNames = new Set(Array.isArray(existing) ? existing.map(c => c.name) : []);
log(`Discord currently has ${existingNames.size} commands: ${[...existingNames].sort().join(', ') || '(none)'}`);

// Delete the leftover kitsune_deploy_probe / kitsune_post_test if present
for (const stale of ['kitsune_deploy_probe', 'kitsune_post_test']) {
  if (existingNames.has(stale)) {
    const cmd = existing.find(c => c.name === stale);
    log(`Deleting stale command "${stale}" (${cmd.id})...`);
    const dr = await fetch(`${getUrl}/${cmd.id}`, { method: 'DELETE', headers });
    log(`  → ${dr.status}`);
    existingNames.delete(stale);
    if (dr.status === 429) {
      const ra = parseFloat(dr.headers.get('retry-after') || '5');
      log(`  rate-limited, waiting ${ra}s before next op`);
      await new Promise(r => setTimeout(r, (ra + 1) * 1000));
    }
  }
}

// Filter to only commands we still need to create
const todo = allCommands.filter(c => !existingNames.has(c.name));
log(`Need to create ${todo.length} commands (skipping ${allCommands.length - todo.length} already present)`);

if (todo.length === 0) {
  log(`✅ All commands already deployed — storing hash and exiting`);
  const { createHash } = await import('crypto');
  const hash = createHash('sha256').update(JSON.stringify(allCommands)).digest('hex');
  await pool.execute(
    `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
     VALUES (?, ?, ?, NULL, NULL)
     ON DUPLICATE KEY UPDATE hash=VALUES(hash), deployed_at=NOW(), blocked_until=NULL, last_block_reason=NULL`,
    [BOT_ID, GUILD_ID, hash]
  );
  await pool.end();
  process.exit(0);
}

const startTime = Date.now();
let deployed = 0;
let nextCmd = todo[0];

while (todo.length > 0 && Date.now() - startTime < MAX_HOURS * 3600_000) {
  const cmd = todo[0];
  log(`POST "${cmd.name}" (${deployed + 1}/${deployed + todo.length} remaining)...`);
  const r = await fetch(getUrl, { method: 'POST', headers, body: JSON.stringify(cmd) });
  const txt = await r.text();

  if (r.status >= 200 && r.status < 300) {
    log(`  ✓ "${cmd.name}" registered`);
    todo.shift();
    deployed++;
    // Per Discord: even on success, the per-route bucket may need a brief wait
    const remaining = parseInt(r.headers.get('x-ratelimit-remaining') || '5', 10);
    if (remaining === 0) {
      const ra = parseFloat(r.headers.get('x-ratelimit-reset-after') || '1');
      log(`  bucket drained, waiting ${ra}s for refill`);
      await new Promise(rs => setTimeout(rs, (ra + 0.5) * 1000));
    } else {
      // Tiny breather between successful POSTs to be polite
      await new Promise(rs => setTimeout(rs, 250));
    }
    continue;
  }

  let parsed = {}; try { parsed = JSON.parse(txt); } catch { /* */ }

  if (parsed.code === 30034) {
    const ra = parseFloat(parsed.retry_after || '300');
    const waitMs = Math.ceil((ra + 2) * 1000);
    log(`  daily cap (30034) — waiting ${(ra + 2).toFixed(0)}s for next slot to roll off`);
    await new Promise(rs => setTimeout(rs, waitMs));
    continue;
  }

  if (r.status === 429) {
    const ra = parseFloat(r.headers.get('retry-after') || parsed.retry_after || '5');
    const waitMs = Math.ceil((ra + 1) * 1000);
    log(`  429 — waiting ${(ra + 1).toFixed(0)}s`);
    await new Promise(rs => setTimeout(rs, waitMs));
    continue;
  }

  // Non-retryable: bad command definition? log it but try the next command so
  // one bad apple doesn't block everything.
  log(`  ✗ "${cmd.name}" failed: status=${r.status} body=${txt.slice(0, 300)}`);
  todo.shift();
}

log(`========================================`);
log(`Done. Deployed ${deployed} commands in ${Math.round((Date.now() - startTime) / 60000)} min`);
if (todo.length > 0) {
  log(`Still pending: ${todo.length} (${todo.map(c => c.name).join(', ')})`);
}

// Store hash (even partial — at least we won't re-burn budget on restart)
const { createHash } = await import('crypto');
const hash = createHash('sha256').update(JSON.stringify(allCommands)).digest('hex');
await pool.execute(
  `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
   VALUES (?, ?, ?, NULL, NULL)
   ON DUPLICATE KEY UPDATE hash=VALUES(hash), deployed_at=NOW(), blocked_until=NULL, last_block_reason=NULL`,
  [BOT_ID, GUILD_ID, hash]
);
log(`✅ hash stored`);
await pool.end();
process.exit(todo.length > 0 ? 2 : 0);
