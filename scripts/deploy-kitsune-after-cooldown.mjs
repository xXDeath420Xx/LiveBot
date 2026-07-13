/**
 * Waits 18 minutes (well past Discord's 10-min invalid-request window),
 * then makes EXACTLY ONE deploy attempt using discord.js's bucket-aware
 * REST manager. If it succeeds, stores hash. If it fails, exits without
 * retrying — repeated attempts during the cooldown extend it.
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
const COOLDOWN_MS = 18 * 60 * 1000;

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
log(`Loaded ${commands.length} commands. Sleeping ${COOLDOWN_MS / 60_000} minutes of TOTAL Discord silence...`);

await new Promise(r => setTimeout(r, COOLDOWN_MS));

log(`Cooldown done. Making EXACTLY ONE deploy attempt.`);

const rest = new REST({
  retries: 0,             // no automatic retries — we WILL see what Discord returns
  timeout: 90_000
}).setToken(token);

rest.on('rateLimited', (info) => {
  log(`  [rate-limited] bucket=${info.hash} timeout=${info.timeToReset}ms`);
});

const start = Date.now();
try {
  const result = await rest.put(
    Routes.applicationGuildCommands(BOT_ID, GUILD_ID),
    { body: commands }
  );
  log(`✅ DEPLOYED ${result.length} commands in ${Date.now() - start}ms`);
  const { createHash } = await import('crypto');
  const hash = createHash('sha256').update(JSON.stringify(commands)).digest('hex');
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
  if (err.status) log(`   http status: ${err.status}`);
  log(`   NOT retrying — repeated attempts during cooldown extend it.`);
  await pool.end();
  process.exit(1);
}
