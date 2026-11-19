#!/usr/bin/env node
// Sends the bot owner a Discord DM: node scripts/publish/notify-owner.mjs "message"
// Reads DISCORD_TOKEN and BOT_OWNER_ID from the working copy's .env. Prints nothing secret.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const text = (process.argv[2] || 'publish-github: no message').slice(0, 1900);
if (!env.DISCORD_TOKEN || !env.BOT_OWNER_ID) { console.error('notify-owner: DISCORD_TOKEN or BOT_OWNER_ID missing'); process.exit(1); }
const api = (p, body) => fetch(`https://discord.com/api/v10${p}`, {
  method: 'POST',
  headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const dm = await api('/users/@me/channels', { recipient_id: env.BOT_OWNER_ID });
if (!dm.ok) { console.error(`notify-owner: opening the DM failed (${dm.status})`); process.exit(1); }
const { id } = await dm.json();
const sent = await api(`/channels/${id}/messages`, { content: text, allowed_mentions: { parse: [] } });
if (!sent.ok) { console.error(`notify-owner: sending failed (${sent.status})`); process.exit(1); }
