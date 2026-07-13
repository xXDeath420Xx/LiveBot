// Replace the current hierarchy message in #Leaders with a polished version:
//  • PATCHes 3 role colors (Sun Wukong, Kaishakunin, Itto Rikui) to new shades
//    that visually separate the previously-overlapping red & green families.
//  • Restructures each of 8 stacked embeds with author/title/description/fields/footer
//    so each role's info pane is uniform and scannable.
// Idempotent: PATCH is a no-op when color matches; post-then-delete is safe.
import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1469931133981687873';
const BOT_ID   = '1498486251576229958';
const CHANNEL  = '1469932427647516856';  // #Leaders

// Old embed-chain message — delete after new post succeeds.
const OLD_MSG = '1505495681786445995';

const ROLES = {
  KITSUNE:     '1470260643998208101',
  SUN_WUKONG:  '1469932798638035197',
  LU_BU:       '1470108472325570690',
  KAISHAKUNIN: '1470860854009401366',
  MUSASHI:     '1469932629003468917',
  ITTO:        '1470666282280943740',
  SANTO:       '1470665850112446546',
};

const USERS = {
  WICKED:    '533297810309906444',
  MIKE:      '316037348733353984',
  DEATH:     '365905620060340224',
  HIBIN:     '1089432531641831474',
  TECHNI:    '1326803672679579669',
  DARKWORLD: '817782486507454504',
  XALIRIA:   '477972657384718336',
  WOLFZ:     '684441860747427872',
  KARLO:     '1339054976663818333',
};

// New tonal shades to break visual overlap between the two reds + three greens.
// Keys = role ID; values = decimal color int. Roles not listed keep their live color.
const ROLE_COLOR_OVERRIDES = {
  [ROLES.SUN_WUKONG]:  0xa855f7,  // richer purple (was muted #9b59b6)
  [ROLES.KAISHAKUNIN]: 0x6b0c0c,  // deep burgundy (was #a60808 — too close to Owner red)
  [ROLES.ITTO]:        0x0ea5e9,  // cyan-blue (was #06f895 — too close to Musashi/Santo)
};

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  const init = {
    method,
    headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const r = await fetch(`https://discord.com/api/v10${path}`, init);
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 404 && method === 'DELETE') return null;
    throw new Error(`${r.status} ${method} ${path}: ${t.slice(0, 250)}`);
  }
  return r.status === 204 ? null : r.json();
}

// ── Phase 0: PATCH role colors to new shades ────────────────────────────
console.log('Phase 0: PATCHing role colors to new shades...');
for (const [rid, color] of Object.entries(ROLE_COLOR_OVERRIDES)) {
  const role = await api('PATCH', `/guilds/${GUILD_ID}/roles/${rid}`, { color });
  console.log(`  ✓ ${role.name} → #${color.toString(16).padStart(6, '0')}`);
}

// ── Fetch live roles AFTER the PATCH so colorOf returns the new values ─
const liveRoles = await api('GET', `/guilds/${GUILD_ID}/roles`);
const colorOf = (rid) => {
  if (ROLE_COLOR_OVERRIDES[rid] != null) return ROLE_COLOR_OVERRIDES[rid];
  const r = liveRoles.find(x => x.id === rid);
  const c = r?.color ?? 0;
  return c === 0 ? 0x2B2D31 : c;
};

// ── Embed builders ──────────────────────────────────────────────────────
function buildRoleEmbed({ tier, emoji, title, roleId, holdersField, reportsTo, authorityLines, seatNote }) {
  return {
    color: colorOf(roleId),
    author: { name: tier },
    title: `${emoji} ${title}`,
    description: `<@&${roleId}>`,
    fields: [
      { name: '👤 Holder(s)',  value: holdersField,            inline: true },
      { name: '⬆ Reports To', value: reportsTo,               inline: true },
      { name: '🎯 Authority',  value: authorityLines.join('\n'), inline: false },
    ],
    footer: { text: `Role ID: ${roleId} · ${seatNote}` },
  };
}

const blocks = [
  // Header
  {
    color: colorOf(ROLES.KITSUNE),
    title: '🏯 Kitsune Server — Role Hierarchy & Chain of Command',
    description: [
      'Each block below shows one role: who holds it, what they can do, and who they report to.',
      '',
      '**Chain of command** (top → bottom):',
      '> Owner → Founder → Head Admin → Co-Owners → Co-Head → Mods → Jr. Mods',
      '',
      '**Tiers**',
      '✦ **Tier I · Ownership** — Owner · Founder',
      '✦ **Tier II · Executive Leadership** — Head Admin · Co-Owners · Co-Head',
      '✦ **Tier III · Moderation** — Mods · Jr. Mods',
      '',
      '_Single-seat roles are marked. Unfilled seats display `Open`._',
    ].join('\n'),
    footer: { text: '7 roles · 3 tiers · Authoritative structure' },
  },

  buildRoleEmbed({
    tier: 'Tier I · Ownership',
    emoji: '👑',
    title: 'Owner',
    roleId: ROLES.KITSUNE,
    holdersField: `<@${USERS.WICKED}>`,
    reportsTo: '*Top of hierarchy*',
    authorityLines: ['✦ All Access', '✦ Full control', '✦ Final oversight'],
    seatNote: '1 / 1 seat',
  }),

  buildRoleEmbed({
    tier: 'Tier I · Ownership',
    emoji: '⚜️',
    title: 'Founder',
    roleId: ROLES.SUN_WUKONG,
    holdersField: `<@${USERS.MIKE}>`,
    reportsTo: `<@&${ROLES.KITSUNE}>`,
    authorityLines: ['✦ All Access', '✦ Full control', '✦ 2nd in command — final oversight'],
    seatNote: '1 / 1 seat',
  }),

  buildRoleEmbed({
    tier: 'Tier II · Executive Leadership',
    emoji: '🛡️',
    title: 'Head Admin',
    roleId: ROLES.LU_BU,
    holdersField: `<@${USERS.DEATH}>`,
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>`,
    authorityLines: [
      '✦ All Access · Full control',
      '✦ Oversight of admin / mod roles + permissions',
      '✦ Bot management & control',
    ],
    seatNote: '1 / 1 seat · single-seat role',
  }),

  buildRoleEmbed({
    tier: 'Tier II · Executive Leadership',
    emoji: '⚔️',
    title: 'Co-Owners',
    roleId: ROLES.MUSASHI,
    holdersField: `<@${USERS.HIBIN}>\n<@${USERS.TECHNI}>`,
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>\n<@&${ROLES.LU_BU}>`,
    authorityLines: [
      '✦ Nearly full access',
      '✦ Invites · Bans',
      '✦ Create / delete channels',
      '✦ Move users',
      '✦ Delete messages',
      '✦ Access to all rooms',
    ],
    seatNote: '2 seats filled',
  }),

  buildRoleEmbed({
    tier: 'Tier II · Executive Leadership',
    emoji: '🗡️',
    title: 'Co-Head',
    roleId: ROLES.KAISHAKUNIN,
    holdersField: '`Open`',
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>\n<@&${ROLES.LU_BU}>\n<@&${ROLES.MUSASHI}>`,
    authorityLines: [
      '✦ All Access · Full control',
      '✦ Oversight on all administrative actions',
    ],
    seatNote: '0 / 1 seat · single-seat role · Open',
  }),

  buildRoleEmbed({
    tier: 'Tier III · Moderation',
    emoji: '🔨',
    title: 'Mods',
    roleId: ROLES.ITTO,
    holdersField: `<@${USERS.DARKWORLD}>\n<@${USERS.XALIRIA}>\n<@${USERS.WOLFZ}>`,
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>\n<@&${ROLES.LU_BU}>\n<@&${ROLES.MUSASHI}>\n<@&${ROLES.KAISHAKUNIN}>`,
    authorityLines: [
      '✦ Invites · Bans',
      '✦ Message deletion',
      '✦ Enter locked rooms',
    ],
    seatNote: '3 seats filled',
  }),

  buildRoleEmbed({
    tier: 'Tier III · Moderation',
    emoji: '🪶',
    title: 'Jr. Mods',
    roleId: ROLES.SANTO,
    holdersField: `<@${USERS.KARLO}>`,
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>\n<@&${ROLES.LU_BU}>\n<@&${ROLES.MUSASHI}>\n<@&${ROLES.KAISHAKUNIN}>\n<@&${ROLES.ITTO}>`,
    authorityLines: [
      '✦ Invites · Bans',
      '✦ Message deletion',
    ],
    seatNote: '1 seat filled',
  }),
];

// Char budget sanity (6000 ceiling across all embeds in one message)
const totalChars = blocks.reduce((n, b) => {
  const titleLen = (b.title?.length || 0);
  const descLen  = (b.description?.length || 0);
  const authorLen = (b.author?.name?.length || 0);
  const footerLen = (b.footer?.text?.length || 0);
  const fieldsLen = (b.fields || []).reduce((m, f) => m + (f.name?.length || 0) + (f.value?.length || 0), 0);
  return n + titleLen + descLen + authorLen + footerLen + fieldsLen;
}, 0);
console.log(`\nEmbeds: ${blocks.length}, total chars: ${totalChars} / 6000`);
if (blocks.length > 10) throw new Error('too many embeds (max 10 per message)');
if (totalChars > 6000) throw new Error('embed char total exceeds 6000');

console.log('\nFinal colors:');
for (const [k, rid] of Object.entries(ROLES)) {
  console.log(`  ${k.padEnd(12)} → #${colorOf(rid).toString(16).padStart(6, '0')}`);
}

// Post the new message (no notifications)
const posted = await api('POST', `/channels/${CHANNEL}/messages`, {
  embeds: blocks,
  allowed_mentions: { parse: [] },
});
console.log(`\n✓ Posted new hierarchy embed-chain (${posted.id})`);

// Delete the prior embed message
const del = await api('DELETE', `/channels/${CHANNEL}/messages/${OLD_MSG}`);
console.log(del === null ? `  (old message ${OLD_MSG} already gone)` : `✓ Deleted old embed message (${OLD_MSG})`);

await pool.end();
console.log('\nDone.');
