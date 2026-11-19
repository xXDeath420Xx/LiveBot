/**
 * Post a /announce-style card from the shell, with the guild's own bot (REST only, safe under PM2).
 *   node scripts/post-announcement.mjs <guildId> <channelId> <body.txt> [--title T] [--footer F]
 *        [--image path] [--color #hex] [--ping roleId|everyone] [--apply]
 * Without --apply it prints the payload and posts nothing.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { resolveBotForGuild } from '../utils/bot-resolver.js';
import { buildAnnouncement, parseHexColor } from '../core/announcement-card.js';

const [guildId, channelId, bodyFile, ...rest] = process.argv.slice(2);
if (!guildId || !channelId || !bodyFile) { console.error('usage: see header'); process.exit(1); }
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const apply = rest.includes('--apply');

const body = fs.readFileSync(bodyFile, 'utf8').trim();
const imagePath = flag('image');
const imageName = imagePath ? `announcement${path.extname(imagePath).toLowerCase()}` : null;
const payload = buildAnnouncement({
    title: flag('title'), body, footer: flag('footer'),
    color: parseHexColor(flag('color')), imageName, pingRoleId: flag('ping'),
});
const json = {
    components: payload.components.map(c => c.toJSON()),
    flags: payload.flags,
    allowed_mentions: payload.allowedMentions.parse ? { parse: payload.allowedMentions.parse } : { roles: payload.allowedMentions.roles },
};
if (imageName) json.attachments = [{ id: 0, filename: imageName }];

if (!apply) { console.log(JSON.stringify(json, null, 2)); console.log('\n(dry run, add --apply)'); process.exit(0); }

const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const bot = await resolveBotForGuild(guildId, { db });

const form = new FormData();
form.append('payload_json', JSON.stringify(json));
if (imageName) form.append('files[0]', new Blob([fs.readFileSync(imagePath)]), imageName);
const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST', headers: { Authorization: `Bot ${bot.token}` }, body: form,
});
const out = await res.json();
if (!res.ok) { console.error(res.status, JSON.stringify(out)); await db.end(); process.exit(1); }
// Record it so the dashboard's Announce page lists it (migration 250).
await db.execute(
    `INSERT IGNORE INTO announcement_posts (guild_id, channel_id, message_id, title, source) VALUES (?, ?, ?, ?, 'script')`,
    [guildId, channelId, out.id, flag('title')?.slice(0, 256) || null]);
await db.end();
console.log(`posted as ${bot.botId ?? bot.id}: https://discord.com/channels/${guildId}/${channelId}/${out.id}`);
