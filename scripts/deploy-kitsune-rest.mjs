/**
 * Use discord.js's REST manager — it has full bucket-aware rate-limit
 * handling: reads x-ratelimit-bucket headers, tracks remaining slots per
 * bucket, queues requests, and waits exactly the right amount on 429.
 *
 * Far smarter than the manual retry loop I built earlier.
 */
import { REST, Routes } from 'discord.js';
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

// retries: 10 — let discord.js handle ALL the rate-limit waiting via its
// bucket-aware queue. It reads x-ratelimit-* headers correctly and queues
// requests to avoid even hitting 429s in the first place.
// timeout: 5 min — generous, since bucket waits can be long
const rest = new REST({
  retries: 10,
  timeout: 5 * 60 * 1000,
  rejectOnRateLimit: null  // null = wait, never reject
}).setToken(token);

// Listen to rate-limit events so we can see what discord.js is doing
rest.on('rateLimited', (info) => {
  log(`  [rate-limited] bucket=${info.hash} route=${info.route} timeout=${info.timeToReset}ms`);
});
rest.on('response', (req, res) => {
  if (res.status >= 400) {
    log(`  [response] ${req.method} ${req.path} → ${res.status}`);
  }
});

const start = Date.now();
try {
  log(`Putting ${commands.length} commands via discord.js REST (bucket-aware)...`);
  const result = await rest.put(
    Routes.applicationGuildCommands(BOT_ID, GUILD_ID),
    { body: commands }
  );
  const elapsed = Date.now() - start;
  log(`✅ DEPLOYED ${result.length} commands in ${elapsed}ms`);
  log(`   sample: ${result.slice(0, 5).map(c => c.name).join(', ')}...`);

  const { createHash } = await import('crypto');
  const body = JSON.stringify(commands);
  const hash = createHash('sha256').update(body).digest('hex');
  await pool.execute(
    `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
     VALUES (?, ?, ?, NULL, NULL)
     ON DUPLICATE KEY UPDATE hash=VALUES(hash), deployed_at=NOW(), blocked_until=NULL, last_block_reason=NULL`,
    [BOT_ID, GUILD_ID, hash]
  );
  log(`✅ hash stored`);
  await pool.end();
  process.exit(0);
} catch (err) {
  log(`❌ FAILED after ${Date.now() - start}ms`);
  log(`   message: ${err.message}`);
  if (err.code) log(`   code: ${err.code}`);
  if (err.rawError) log(`   rawError: ${JSON.stringify(err.rawError).slice(0, 400)}`);
  await pool.end();
  process.exit(1);
}
