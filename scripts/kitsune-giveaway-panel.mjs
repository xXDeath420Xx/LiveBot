// Posts the role-gated "Create Giveaway" panel into #Giveaways in guild
// 1469931133981687873, and seeds giveaway_host_roles with the guild's staff roles.
//
// Why a panel instead of just /manage giveaway start: /manage carries
// default_member_permissions = Manage Server, and Discord filters slash commands
// by that BEFORE dispatching, so the mod-tier roles (Manage Messages + Ban/Kick,
// no Manage Server) never see the command and no code-side check can grant it
// back. A button has no such gate — interactions/buttons/giveaway_create.js
// checks giveaway_host_roles itself.
//
// Idempotent: re-running edits the existing panel message rather than posting
// a second one, and re-seeds the same role rows.

import 'dotenv/config';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD_ID   = '1469931133981687873';
// The acting bot comes from guild_bot_mapping — never pinned here.
const CHANNEL_ID = '1531421374118236261'; // #🎉𝒢𝒾𝓋ℯ𝒶𝓌𝒶𝓎𝓈
const VERIFIED   = '1498502484912635906';

const ADMIN = 1n << 3n, KICK = 1n << 1n, BAN = 1n << 2n, MANAGE_CH = 1n << 4n,
      MANAGE_GUILD = 1n << 5n, MANAGE_ROLES = 1n << 28n, MANAGE_MSG = 1n << 13n,
      MODERATE = 1n << 40n;
const STAFF_BITS = ADMIN | KICK | BAN | MANAGE_CH | MANAGE_GUILD | MANAGE_ROLES | MANAGE_MSG | MODERATE;

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

  console.log('=== Giveaway panel — guild 1469931133981687873 ===\n');

  // ── 1. Seed the role gate ────────────────────────────────────────────────
  const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
  if (roles?.__err) { console.error('Failed to fetch roles:', roles.__err); process.exit(1); }

  const staffRoles = roles
    .filter(r => r.id !== GUILD_ID && r.id !== VERIFIED && !r.managed)
    .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
    .sort((a, b) => b.position - a.position);

  console.log(`[1] Seeding giveaway_host_roles with ${staffRoles.length} staff role(s):`);
  for (const r of staffRoles) {
    await pool.execute(
      'INSERT INTO giveaway_host_roles (guild_id, role_id, added_by) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)',
      [GUILD_ID, r.id, 'setup-script']
    );
    console.log(`      • ${r.name} (${r.id})`);
  }

  // ── 2. Post (or refresh) the panel ───────────────────────────────────────
  const payload = {
    embeds: [{
      title: '🎉 Giveaways',
      description:
        '**Entering is one click.** When a giveaway is posted below, react with 🎉 to enter. ' +
        'That\'s it — no command, no form.\n\n' +
        'When the timer runs out the winners are drawn automatically and pinged right here. ' +
        'You can leave at any time by removing your reaction.\n\n' +
        '*Staff: use the button below to start one in this channel.*',
      color: 0x5865F2,
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 1,
        label: 'Create Giveaway',
        emoji: { name: '🎉' },
        custom_id: 'giveaway_create',
      }],
    }],
  };

  const existing = await api('GET', `/channels/${CHANNEL_ID}/messages?limit=50`);
  if (existing?.__err) { console.error('Failed to read channel:', existing.__err); process.exit(1); }
  const prior = Array.isArray(existing)
    ? existing.find(m => m.author?.id === bot.botId
        && m.components?.[0]?.components?.some(c => c.custom_id === 'giveaway_create'))
    : null;

  let msg;
  if (prior) {
    console.log(`\n[2] Panel already posted (${prior.id}) — refreshing it…`);
    msg = await api('PATCH', `/channels/${CHANNEL_ID}/messages/${prior.id}`, payload);
  } else {
    console.log('\n[2] Posting panel…');
    msg = await api('POST', `/channels/${CHANNEL_ID}/messages`, payload);
  }
  if (msg?.__err) { console.error('    ✗ Failed:', msg.__err); process.exit(1); }
  console.log(`    ✓ Panel message ${msg.id}`);

  const pin = await api('PUT', `/channels/${CHANNEL_ID}/pins/${msg.id}`);
  console.log(pin?.__err ? `    • pin skipped (${pin.__err.status})` : '    ✓ Pinned');

  console.log('\nDone. Staff click the button; everyone else reacts 🎉 to enter.');
} catch (e) {
  console.error('ERR', e.message, e.stack);
} finally {
  await pool.end().catch(() => {});
}
