// Transfer ownership of all default-bot-posted interactive messages in
// The Bat Cave to Harley's Bat (1503936879635202149).
//
// For each known panel:
//   1. Fetch current message (via Harley's Bat, which has MANAGE_MESSAGES)
//   2. Delete it
//   3. Re-post identical content via Harley's Bat
//   4. Update DB pointers (reaction_role_panels.message_id or
//      ticket_panels.panel_message_id)
//
// Also sweeps every text channel for any other default-bot-posted message
// with components and migrates those too.
//
// Does NOT re-post welcome cards or log entries (per user — no spam).

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const HARLEY_BOT_ID  = '1503936879635202149';
const DEFAULT_BOT_ID = '1409904443125665875';

// Panels I posted earlier in this server, by channel/message
const KNOWN_PANELS = [
  { kind: 'reaction_role', dbId: 143, channel: '800256456997863434', messageId: '1503938676953190472', label: 'Rules' },
  { kind: 'reaction_role', dbId: 142, channel: '1503936002379747340', messageId: '1503936004560519169', label: 'Streamer signup' },
  { kind: 'ticket',         dbId: 26,  channel: '1503912714479730799', messageId: '1503938674348396664', label: 'Tech ticket panel' },
];

// Decrypt Harley's Bat token
const [row] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [HARLEY_BOT_ID]);
const harleyToken = encryption.decrypt(JSON.parse(row[0].bot_token));

async function api(method, path, body, useDefaultToken = false) {
  await new Promise(r => setTimeout(r, 80));
  const token = useDefaultToken ? process.env.DISCORD_TOKEN : harleyToken;
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 300));
    return api(method, path, body, useDefaultToken);
  }
  if (!r.ok) return { __err: { status: r.status, body: (await r.text()).slice(0, 250) } };
  return r.status === 204 ? null : r.json();
}

console.log('=== Migrating to Harley\'s Bat ===\n');

const migrations = [];

// ─── 1. Known panels ────────────────────────────────────────────────────
console.log('[1] Re-posting the 3 known interactive panels under Harley\'s Bat…');
for (const panel of KNOWN_PANELS) {
  const orig = await api('GET', `/channels/${panel.channel}/messages/${panel.messageId}`);
  if (orig?.__err) {
    console.log(`   ✗ ${panel.label} (${panel.messageId}) couldn't be fetched: ${orig.__err.status} ${orig.__err.body.slice(0,80)}`);
    continue;
  }
  if (orig.author?.id === HARLEY_BOT_ID) {
    console.log(`   = ${panel.label} (${panel.messageId}) already owned by Harley's Bat — skipping`);
    continue;
  }
  if (orig.author?.id !== DEFAULT_BOT_ID) {
    console.log(`   ! ${panel.label} (${panel.messageId}) NOT owned by default bot (author=${orig.author?.id}) — skipping`);
    continue;
  }

  // Re-post under Harley's Bat
  const repost = await api('POST', `/channels/${panel.channel}/messages`, {
    embeds: orig.embeds,
    components: orig.components,
  });
  if (repost?.__err) {
    console.log(`   ✗ ${panel.label} repost failed: ${repost.__err.status} ${repost.__err.body.slice(0,150)}`);
    continue;
  }
  console.log(`   ✓ ${panel.label}: ${panel.messageId} → ${repost.id}`);

  // Delete original (via Harley's Bat — needs MANAGE_MESSAGES on the channel)
  const del = await api('DELETE', `/channels/${panel.channel}/messages/${panel.messageId}`);
  if (del?.__err) console.log(`     ⚠ couldn't delete old: ${del.__err.status} ${del.__err.body.slice(0,80)}`);

  // Update DB pointer
  if (panel.kind === 'reaction_role') {
    await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [repost.id, panel.dbId]);
  } else if (panel.kind === 'ticket') {
    await pool.execute('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [repost.id, panel.dbId]);
  }
  migrations.push({ ...panel, newMessageId: repost.id });
}

// ─── 2. Sweep all channels for OTHER default-bot interactive messages ───
console.log('\n[2] Sweeping all channels for any other default-bot-owned messages with components…');
const channels = await api('GET', `/guilds/${GUILD}/channels`);
const textChannels = (channels || []).filter(c => c.type === 0 || c.type === 5);
const handledIds = new Set(KNOWN_PANELS.map(p => p.messageId));
let extra = 0;

for (const ch of textChannels) {
  const msgs = await api('GET', `/channels/${ch.id}/messages?limit=100`);
  if (!Array.isArray(msgs)) continue;
  for (const m of msgs) {
    if (m.author?.id !== DEFAULT_BOT_ID) continue;
    if (handledIds.has(m.id)) continue;
    if (!m.components?.length) continue; // only interactive messages need migration

    console.log(`   → #${ch.name} (${ch.id}) msg ${m.id} has components — migrating`);
    const repost = await api('POST', `/channels/${ch.id}/messages`, {
      content: m.content || undefined,
      embeds: m.embeds,
      components: m.components,
    });
    if (repost?.__err) {
      console.log(`     ✗ repost failed: ${repost.__err.status} ${repost.__err.body.slice(0,80)}`);
      continue;
    }
    const del = await api('DELETE', `/channels/${ch.id}/messages/${m.id}`);
    if (del?.__err) console.log(`     ⚠ couldn't delete old: ${del.__err.status} ${del.__err.body.slice(0,80)}`);
    console.log(`     ✓ ${m.id} → ${repost.id}`);
    extra++;
  }
}
console.log(`   sweep complete — ${extra} additional message(s) migrated`);

// ─── 3. Verify ──────────────────────────────────────────────────────────
console.log('\n[3] Post-migration verification…');
for (const m of migrations) {
  const check = await api('GET', `/channels/${m.channel}/messages/${m.newMessageId}`);
  if (check?.__err) {
    console.log(`   ✗ ${m.label}: fetch new message failed (${check.__err.status})`);
    continue;
  }
  const ok = check.author?.id === HARLEY_BOT_ID && check.components?.length > 0;
  console.log(`   ${ok ? '✓' : '✗'} ${m.label}: author=${check.author?.username} components=${check.components?.length || 0}`);
}

// ─── 4. DB pointer sanity ───────────────────────────────────────────────
console.log('\n[4] DB pointers after migration:');
const [rrp] = await pool.execute('SELECT id, panel_name, channel_id, message_id FROM reaction_role_panels WHERE guild_id = ?', [GUILD]);
for (const r of rrp) console.log(`   reaction_role_panels.${r.id}: ${r.panel_name} → ${r.message_id}`);
const [tp] = await pool.execute('SELECT panel_id, panel_name, panel_message_id FROM ticket_panels WHERE guild_id = ?', [GUILD]);
for (const r of tp) console.log(`   ticket_panels.${r.panel_id}: ${r.panel_name} → ${r.panel_message_id}`);

console.log('\n=== Summary ===');
console.log(`Known panels migrated: ${migrations.length}`);
console.log(`Other interactive messages migrated: ${extra}`);
console.log(`Total: ${migrations.length + extra}`);

await pool.end();
console.log('\nDone.');
