// Audit every hardcoded Discord bot id in the repo against the live database.
//
// Scripts that pin `const BOT_ID = '...'` next to a `GUILD_ID` rot silently: the
// guild gets re-assigned to a different custom bot in `guild_bot_mapping` and the
// script keeps using a token that has no business in that guild. It doesn't error
// — it just returns 403/unknown-guild, or worse, hangs (a top-level-await ESM
// script swallows the rejection). That is how scripts/pac/* ended up pointing at
// 1409904443125665875 for a guild owned by 1496352090950467595.
//
// This reports, per file:
//   STALE   — the file names a guild AND a bot, and the DB maps that guild elsewhere
//   OK      — the pinned bot matches the mapping (still hardcoded, but correct today)
//   UNKNOWN — the id is not a bot we own (third-party bot, or a user/channel/role id)
//
// Read-only. Safe while PM2 is running.
//
//   node scripts/audit-hardcoded-bot-ids.mjs           # stale only
//   node scripts/audit-hardcoded-bot-ids.mjs --all     # every hardcoded bot id

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SHOW_ALL = process.argv.includes('--all');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'backups', 'docs', 'transcripts', 'logs', 'cf-jellyfin']);
const SNOWFLAKE = /['"`](\d{17,20})['"`]/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

let conn;
try {
  conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  const [bots] = await conn.query('SELECT bot_id, bot_name FROM custom_bots');
  const [maps] = await conn.query('SELECT guild_id, bot_id FROM guild_bot_mapping');
  const [guilds] = await conn.query('SELECT guild_id, guild_name FROM guilds WHERE left_at IS NULL');

  const mainBotId = process.env.DISCORD_CLIENT_ID || null;
  const botName = new Map(bots.map(b => [b.bot_id, b.bot_name]));
  if (mainBotId) botName.set(mainBotId, 'CertiFried (main)');
  const guildName = new Map(guilds.map(g => [g.guild_id, g.guild_name]));
  const mappedBot = new Map(maps.map(m => [m.guild_id, m.bot_id]));

  const files = walk(ROOT);
  const rows = [];

  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel.startsWith('scripts/audit-hardcoded-bot-ids')) continue;

    const src = readFileSync(file, 'utf8');
    const ids = new Set();
    for (const m of src.matchAll(SNOWFLAKE)) ids.add(m[1]);
    if (!ids.size) continue;

    const botsHere = [...ids].filter(id => botName.has(id));
    if (!botsHere.length) continue;
    const guildsHere = [...ids].filter(id => guildName.has(id));

    for (const bot of botsHere) {
      // A file can justify a literal with `// bot-id-ok: <reason>` on the same
      // line — for an id that is a historical fact (the previous author of a
      // message we are searching for) rather than a credential to act with.
      const sameLine = src.split('\n').find(l => l.includes(bot));
      if (sameLine && /bot-id-ok:/.test(sameLine)) continue;

      // Which guild is this file about? Prefer a guild the file names explicitly.
      const expected = guildsHere.map(g => mappedBot.get(g)).filter(Boolean);
      let status = 'OK';
      let note = '';

      if (!guildsHere.length) {
        status = 'NO-GUILD';
        note = 'bot pinned with no guild in the file — cannot verify';
      } else if (expected.includes(bot)) {
        status = 'OK';
        note = guildsHere.map(g => guildName.get(g)).join(', ');
      } else if (bot === mainBotId) {
        status = 'STALE';
        note = `main bot pinned, but ${guildsHere.map(g => `${guildName.get(g)} -> ${botName.get(mappedBot.get(g)) || mappedBot.get(g) || 'unmapped'}`).join('; ')}`;
      } else {
        status = 'STALE';
        note = `pins ${botName.get(bot)}, but ${guildsHere.map(g => `${guildName.get(g)} -> ${botName.get(mappedBot.get(g)) || mappedBot.get(g) || 'unmapped'}`).join('; ')}`;
      }

      const line = src.split('\n').findIndex(l => l.includes(bot)) + 1;
      rows.push({ rel, line, bot, status, note });
    }
  }

  const stale = rows.filter(r => r.status === 'STALE');
  const ok = rows.filter(r => r.status === 'OK');
  const noGuild = rows.filter(r => r.status === 'NO-GUILD');

  console.log(`Scanned ${files.length} files. Hardcoded bot ids: ${rows.length} across ${new Set(rows.map(r => r.rel)).size} files.`);
  console.log(`  STALE ${stale.length}   OK ${ok.length}   NO-GUILD ${noGuild.length}\n`);

  if (stale.length) {
    console.log('── STALE — the pinned bot does not own the guild this file targets ──');
    for (const r of stale) console.log(`  ${r.rel}:${r.line}\n      ${r.bot}  ${r.note}`);
  }

  if (SHOW_ALL) {
    console.log('\n── OK (hardcoded but currently correct) ──');
    for (const r of ok) console.log(`  ${r.rel}:${r.line}  ${botName.get(r.bot)}  [${r.note}]`);
    console.log('\n── NO-GUILD (bot pinned with no guild to check against) ──');
    for (const r of noGuild) console.log(`  ${r.rel}:${r.line}  ${botName.get(r.bot)}`);
  } else if (ok.length || noGuild.length) {
    console.log(`\n(${ok.length} correct-but-hardcoded and ${noGuild.length} unverifiable — re-run with --all)`);
  }

  process.exitCode = stale.length ? 1 : 0;
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 2;
} finally {
  await conn?.end().catch(() => {});
}
