#!/usr/bin/env node
/**
 * Upload the generated Cat Bot sprites as **application emoji**, and record the
 * resulting snowflakes in `catbot_emojis`.
 *
 * Application emoji belong to a single application, so a custom bot cannot render the
 * main bot's emoji — every bot that serves Cat Bot needs its own upload. Without a row
 * for a given bot, core/catbot/emoji.js falls back to unicode (which always renders).
 *
 * This is REST-only, so it is safe to run while PM2 is up (no gateway session).
 *
 *   node scripts/catbot-upload-emoji.mjs                 # the default bot
 *   node scripts/catbot-upload-emoji.mjs --bot <botId>   # one custom bot
 *   node scripts/catbot-upload-emoji.mjs --all           # default + every enabled custom bot
 *   node scripts/catbot-upload-emoji.mjs --dry-run
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import encryption from '../utils/encryption.js';
import { CAT_TYPES } from '../core/catbot/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPRITE_DIR = join(__dirname, '..', 'assets', 'catbot');
const API = 'https://discord.com/api/v10';

const has = f => process.argv.includes(`--${f}`);
const val = f => { const i = process.argv.indexOf(`--${f}`); return i !== -1 ? process.argv[i + 1] : null; };
const DRY = has('dry-run');

const emojiName = type => `catbot_${type.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const retry = Number((await res.json()).retry_after ?? 1) * 1000;
    await new Promise(r => setTimeout(r, retry + 250));
    return api(token, method, path, body);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 180)}`);
  return parsed;
}

async function uploadForBot(db, { botId, botName, token }) {
  console.log(`\n── ${botName} (${botId})`);

  const existing = await api(token, 'GET', `/applications/${botId}/emojis`).catch(err => {
    console.log(`   cannot list emoji: ${err.message}`);
    return null;
  });
  if (!existing) return { ok: 0, skipped: 0, failed: CAT_TYPES.length };
  const byName = new Map((existing.items ?? existing ?? []).map(e => [e.name, e]));

  let ok = 0, skipped = 0, failed = 0;
  for (const type of CAT_TYPES) {
    const name = emojiName(type);
    const file = join(SPRITE_DIR, `${type.toLowerCase()}.png`);
    if (!existsSync(file)) { console.log(`   ${type}: no sprite — run catbot-generate-art.mjs`); failed++; continue; }

    let emoji = byName.get(name);
    if (emoji) {
      skipped++;
    } else if (DRY) {
      console.log(`   ${type}: would upload as :${name}:`);
      continue;
    } else {
      const image = `data:image/png;base64,${(await readFile(file)).toString('base64')}`;
      try {
        emoji = await api(token, 'POST', `/applications/${botId}/emojis`, { name, image });
        ok++;
      } catch (err) {
        console.log(`   ${type}: upload failed — ${err.message}`);
        failed++;
        continue;
      }
      await new Promise(r => setTimeout(r, 250)); // be polite
    }

    if (!DRY) {
      await db.execute(
        `INSERT INTO catbot_emojis (bot_id, cat_type, emoji_id, emoji_name, animated)
         VALUES (?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE emoji_id = VALUES(emoji_id), emoji_name = VALUES(emoji_name)`,
        [botId, type, emoji.id, emoji.name]);
    }
  }
  console.log(`   uploaded ${ok}, already present ${skipped}, failed ${failed}`);
  return { ok, skipped, failed };
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  const targets = [];
  const wantBot = val('bot');

  if (!wantBot || has('all')) {
    const token = process.env.DISCORD_TOKEN;
    const me = await api(token, 'GET', '/users/@me');
    targets.push({ botId: me.id, botName: `${me.username} (default)`, token });
  }
  if (wantBot || has('all')) {
    const [rows] = await db.execute(
      `SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1 ${wantBot ? 'AND bot_id = ?' : ''}`,
      wantBot ? [wantBot] : []);
    for (const r of rows) {
      try { targets.push({ botId: r.bot_id, botName: r.bot_name, token: encryption.decrypt(JSON.parse(r.bot_token)) }); }
      catch { console.log(`skipping ${r.bot_name}: token decrypt failed`); }
    }
  }

  if (!targets.length) { console.log('No target bots.'); await db.end(); return; }
  if (DRY) console.log('DRY RUN — nothing will be uploaded or written.\n');

  const totals = { ok: 0, skipped: 0, failed: 0 };
  for (const t of targets) {
    const r = await uploadForBot(db, t);
    totals.ok += r.ok; totals.skipped += r.skipped; totals.failed += r.failed;
  }

  console.log(`\n${targets.length} bot(s): ${totals.ok} uploaded, ${totals.skipped} already present, ${totals.failed} failed.`);
  if (!DRY && totals.ok) console.log('Restart the bot (or call loadCustomEmoji()) to pick the new emoji up.');
  await db.end();
}

main().catch(err => { console.error(err); process.exit(1); });
