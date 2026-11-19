/*
 * Repost #server-info📰 (985116833193553933) in 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 as the guild's own bot, replacing the
 * 14 MEE6 embed-webhook posts (webhook 1347122544376807557, "⁴²⁰𝑅𝑒𝑒𝒇𝑒𝓇 𝑅𝑒𝒶𝓁𝓂⁷¹⁰ Bot").
 * Originals + banners are archived in archives/teamaura-server-info-985116833193553933/.
 * Layout: one Components V2 card per section (5 messages, spacers dropped) — banner media
 * gallery ON TOP, text below; an embed's image always renders at the bottom.
 * Posts the new set FIRST, then deletes the old webhook messages — the channel is never empty.
 * Rerun with our posts already present → edits them in place (keeps their position).
 *   node scripts/repost-teamaura-server-info.mjs [--dry]
 * REST-only via the resolved custom bot token (safe while PM2 runs).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const DRY = process.argv.includes('--dry');
const GUILD = '985116833193553930';
const CHANNEL = '985116833193553933';
const OLD_WEBHOOK = '1347122544376807557';
const STREAM_PROMO = '1474951572914966618'; // rule 5's old #channel was deleted; self_promo_config points here
const CONTACT_STAFF = '1347122912989286472';
const ARCHIVE = new URL('../archives/teamaura-server-info-985116833193553933/', import.meta.url);
const COLOR = 0xB3122E; // Aura red, matches the banners (originals were MEE6 grey)

const SECTIONS = [
  { banner: 'banner-welcome.png', embed: {
    title: 'Welcome to 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊',
    description: "Hello and a warm welcome to all of our new members! 👋 We're thrilled to have you join our community ❤️\n\n🤝 Please, take some time to introduce yourself to the community – share a bit about yourself, your interests, and what brings you here.\n\n📜 Before you dive in, please take a moment to read through our server rules. We want everyone to have a great time here, and following the guidelines helps create a positive environment for everyone.\n\nWe're excited to have you here, and we can't wait to get to know you better. Enjoy your stay! 🎉",
  } },
  { banner: 'banner-links.png', embed: {
    description: 'For additional questions feel free to contact us.',
    fields: [{ name: 'Socials', inline: true, value: '[Youtube](https://www.youtube.com/@fliiqzy)\n[Twitch](https://www.twitch.tv/fliiqzy)\n[Twitter](https://twitter.com/FLiiQzy)\n[TikTok](https://www.tiktok.com/@fliiqzytv)\n[CashApp](https://cash.app/$FLiiQzy)\n[Instagram](https://www.instagram.com/fliiqzy)\n[Kick](https://kick.com/FLiiQzy)' }],
  } },
  { banner: 'banner-rules.png', embed: {
    description: `😃 1. Be cool, kind, and respectful to one another.\n📇 2. Keep your Discord profile appropriate.\n✉️ 3. Do not spam.\n🔔 4. Do not @mention or direct message the staff. See Mods below in the channel for exceptions.\n📣 5. No self-promotion or advertisements outside of <#${STREAM_PROMO}>- Only promote your streams or sponsorships: Our bot will filter out / remove any unauthorized links - including discord invites. \n🛡️ 6. No personal information.\n🤬 7. No hate speech or harmful language.\n🏛️ 8. No political or religious topics.\n🚨 9. No piracy, sexual, NSFW, or otherwise suspicious content.\n🤔 10. Rules are subject to common sense.`,
  } },
  { banner: 'banner-mods.png', embed: {
    description: `Our moderation team is here to make sure this cozy little corner of Discord stays warm and safe for everyone. 🍵\n\nIf you ever come across any problems related to our server, don't hesitate to tag them in the <#${CONTACT_STAFF}> channel. ❤️\n\nQuick heads-up: The moderation team won't handle issues through DMs between members.\nIf you run into any trouble there, it's best to report it directly to Discord's Trust & Safety and block the user.`,
  } },
  { banner: 'banner-invite.png', embed: {
    title: 'Spread the love by sharing our server invite link',
    description: '```https://discord.gg/A4pvxKeXJc```',
  } },
];

const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, charset: 'utf8mb4' });
process.on('unhandledRejection', (e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
const bot = await resolveBotForGuild(GUILD, { db });
await db.end();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(method, path, body) {
  if (DRY && method !== 'GET') { console.log('[dry]', method, path); return { id: 'dry' }; }
  for (let a = 0; a < 6; a++) {
    const headers = { Authorization: `Bot ${bot.token}`, 'X-Audit-Log-Reason': 'Replace MEE6 server-info posts with TeamAura Utility' };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(`https://discord.com/api/v10${path}`, { method, headers, body: body instanceof FormData ? body : body && JSON.stringify(body) });
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep((j.retry_after ?? 1) * 1000 + 250); continue; }
    if (res.status === 204) return null;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(j)}`);
    return j;
  }
  throw new Error(`${method} ${path} rate-limited out`);
}

const IS_COMPONENTS_V2 = 1 << 15;
// Embed → V2 card: banner, then title as a heading, description, fields as bold-name blocks.
function card(s) {
  const text = [s.embed.title && `## ${s.embed.title}`, s.embed.description,
    ...(s.embed.fields ?? []).map((f) => `**${f.name}**\n${f.value}`)].filter(Boolean).join('\n\n');
  return [{ type: 17, accent_color: COLOR, components: [
    { type: 12, items: [{ media: { url: 'attachment://banner.png' } }] },
    { type: 10, content: text },
  ] }];
}

const existing = await rest('GET', `/channels/${CHANNEL}/messages?limit=100`);
const old = existing.filter((m) => m.webhook_id === OLD_WEBHOOK);
const mine = existing.filter((m) => m.author.id === bot.botId).reverse(); // oldest first = section order
console.log(`channel has ${existing.length} msgs: ${old.length} MEE6-webhook, ${mine.length} ours`);

if (mine.length) {
  if (mine.length !== SECTIONS.length) throw new Error(`expected ${SECTIONS.length} of our posts, found ${mine.length} — fix by hand`);
  for (const [i, s] of SECTIONS.entries()) {
    const form = new FormData(); // re-upload the banner: a V2 edit swaps the message's attachments
    form.append('payload_json', JSON.stringify({ flags: IS_COMPONENTS_V2, content: '', embeds: [], components: card(s), attachments: [{ id: 0, filename: 'banner.png' }], allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([readFileSync(new URL(s.banner, ARCHIVE))], { type: 'image/png' }), 'banner.png');
    await rest('PATCH', `/channels/${CHANNEL}/messages/${mine[i].id}`, form);
    console.log('edited', mine[i].id, s.embed.title ?? s.embed.description.slice(0, 40));
  }
} else {
  for (const s of SECTIONS) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ flags: IS_COMPONENTS_V2, components: card(s), attachments: [{ id: 0, filename: 'banner.png' }], allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([readFileSync(new URL(s.banner, ARCHIVE))], { type: 'image/png' }), 'banner.png');
    const m = await rest('POST', `/channels/${CHANNEL}/messages`, form);
    console.log('posted', m.id, s.embed.title ?? s.embed.description.slice(0, 40));
  }
}
for (const m of old.reverse()) { await rest('DELETE', `/channels/${CHANNEL}/messages/${m.id}`); console.log('deleted', m.id); }
console.log('done');
