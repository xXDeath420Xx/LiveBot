// Creates (or re-applies permissions to) the #Giveaways channel in guild
// 1469931133981687873, served by Kitsune.
//
// End state:
//   - Channel lives in the "The Chatter" category.
//   - @everyone cannot see it (guild-wide lockdown convention — see kitsune-lockdown.mjs).
//   - @Verified — i.e. every member — can SEE the giveaway and REACT 🎉 to enter,
//     but cannot post, so the channel stays a clean list of giveaways.
//   - Staff roles (anything holding a moderation permission bit) can post and manage.
//
// Idempotent: re-running finds the existing channel by name and re-PATCHes the
// overwrites rather than creating a second one.
//
// REST-only via Kitsune's bot token. Safe to run while PM2 is live.

import 'dotenv/config';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD_ID    = '1469931133981687873';
// The acting bot comes from guild_bot_mapping — never pinned here.
const KITSUNE_ROLE = '1498509154640330855'; // Kitsune's managed bot role
const CATEGORY_ID = '1469931134845456531';  // "The Chatter"
const VERIFIED    = '1498502484912635906';
const CHANNEL_NAME = '🎉𝒢𝒾𝓋ℯ𝒶𝓌𝒶𝓎𝓈';

const VIEW = 1n << 10n, SEND = 1n << 11n, HIST = 1n << 16n, REACT = 1n << 6n,
      INVITE = 1n << 0n, MANAGE_MSG = 1n << 13n, EXT_EMOJI = 1n << 18n,
      EMBED = 1n << 14n, ATTACH = 1n << 15n;

// Same staff-bit detection the lockdown script uses, so the two agree on who staff is.
const ADMIN = 1n << 3n, KICK = 1n << 1n, BAN = 1n << 2n, MANAGE_CH = 1n << 4n,
      MANAGE_GUILD = 1n << 5n, MANAGE_ROLES = 1n << 28n, MODERATE = 1n << 40n;
const STAFF_BITS = ADMIN | KICK | BAN | MANAGE_CH | MANAGE_GUILD | MANAGE_ROLES | MANAGE_MSG | MODERATE;

// Members see and enter; they don't chat. Reactions are the entry mechanism, so
// REACT is granted explicitly rather than inherited.
const MEMBER_ALLOW = VIEW | HIST | REACT | EXT_EMOJI;
const MEMBER_DENY  = SEND | INVITE;
const STAFF_ALLOW  = VIEW | SEND | HIST | REACT | MANAGE_MSG | EXT_EMOJI | EMBED | ATTACH;
const EVERYONE_DENY = VIEW | HIST | INVITE;

try {
  const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
  const token = bot.token;

  async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 120));
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 300));
      return api(method, path, body);
    }
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 300) } };
    return res.status === 204 ? null : res.json();
  }

  console.log('=== #Giveaways — guild 1469931133981687873 ===\n');

  const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
  if (roles?.__err) { console.error('Failed to fetch roles:', roles.__err); process.exit(1); }

  const staffRoles = roles
    .filter(r => r.id !== GUILD_ID && r.id !== VERIFIED && !r.managed)
    .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
    .sort((a, b) => b.position - a.position);

  console.log(`[1] Staff roles that may post/manage (${staffRoles.length}):`);
  for (const r of staffRoles) console.log(`      • ${r.name} (${r.id})`);

  const overwrites = [
    { id: GUILD_ID, type: 0, allow: '0', deny: String(EVERYONE_DENY) },
    { id: VERIFIED, type: 0, allow: String(MEMBER_ALLOW), deny: String(MEMBER_DENY) },
    { id: KITSUNE_ROLE, type: 0, allow: String(STAFF_ALLOW), deny: '0' },
    ...staffRoles.map(r => ({ id: r.id, type: 0, allow: String(STAFF_ALLOW), deny: '0' })),
  ];

  const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
  if (channels?.__err) { console.error('Failed to fetch channels:', channels.__err); process.exit(1); }
  const existing = channels.find(c => c.type === 0 && c.name === CHANNEL_NAME);

  let channel;
  if (existing) {
    console.log(`\n[2] Channel already exists (${existing.id}) — re-applying permissions…`);
    channel = await api('PATCH', `/channels/${existing.id}`, {
      parent_id: CATEGORY_ID,
      permission_overwrites: overwrites,
    });
  } else {
    console.log('\n[2] Creating channel…');
    channel = await api('POST', `/guilds/${GUILD_ID}/channels`, {
      name: CHANNEL_NAME,
      type: 0,
      parent_id: CATEGORY_ID,
      topic: 'Giveaways — react with 🎉 on a giveaway post to enter. Winners are drawn automatically when the timer runs out.',
      permission_overwrites: overwrites,
    });
  }
  if (channel?.__err) { console.error('    ✗ Failed:', channel.__err); process.exit(1); }

  console.log(`    ✓ #${channel.name} → ${channel.id}`);
  console.log(`      @everyone      : hidden`);
  console.log(`      @Verified      : view + read history + react 🎉, cannot post`);
  console.log(`      staff (${staffRoles.length} roles) : post + manage messages`);
  console.log(`\nDone. Start one with: /manage giveaway start (run it in the channel)`);
} catch (e) {
  console.error('ERR', e.message, e.stack);
} finally {
  await pool.end().catch(() => {});
}
