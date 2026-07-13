// Post an EXPANDED leadership hierarchy reference into the Kitsune
// #mod-section channel (1491130798030585917) and pin it.
// Mirrors the #Leaders message structure, but adds 4 new fields per role
// (Responsibilities, Standing Permissions, Escalation Triggers, Examples)
// and appends each holder's bolded Discord username next to their mention chip.
// Does NOT modify the existing #Leaders message.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

const GUILD_ID    = '1469931133981687873';
const BOT_ID      = '1498486251576229958';
const MOD_SECTION = '1491130798030585917'; // #mod-section

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

// Verified Discord handles (from prior REST diag).
// If a user changes their username, re-run with updated values.
const USERNAMES = {
  WICKED:    'wicked_pinay',
  MIKE:      'mike_da_wckd',
  DEATH:     'death420',
  HIBIN:     'hibinforsaken',
  TECHNI:    'technicide2.0',
  DARKWORLD: 'darkworldwolf1',
  XALIRIA:   'xaliria',
  WOLFZ:     'wolfzgangz',
  KARLO:     'karlogeetv',
};

// Same color overrides applied via the earlier rewrite script.
const ROLE_COLOR_OVERRIDES = {
  [ROLES.SUN_WUKONG]:  0xa855f7,
  [ROLES.KAISHAKUNIN]: 0x6b0c0c,
  [ROLES.ITTO]:        0x0ea5e9,
};

const conn = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [rows] = await conn.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
await conn.end();
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  const init = {
    method,
    headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const r = await fetch(`https://discord.com/api/v10${path}`, init);
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${(await r.text()).slice(0, 250)}`);
  return r.status === 204 ? null : r.json();
}

const liveRoles = await api('GET', `/guilds/${GUILD_ID}/roles`);
const colorOf = (rid) => {
  if (ROLE_COLOR_OVERRIDES[rid] != null) return ROLE_COLOR_OVERRIDES[rid];
  const r = liveRoles.find(x => x.id === rid);
  const c = r?.color ?? 0;
  return c === 0 ? 0x2B2D31 : c;
};

// ── Phase 0: grant all hierarchy roles explicit view+chat on #mod-section ─
// Owner/Founder/Head Admin/Co-Head already have ADMINISTRATOR so they bypass
// channel overrides — but adding explicit allow is defense-in-depth (in case
// ADMINISTRATOR ever gets revoked).  Co-Owners + Mods + Jr. Mods need this
// for actual functional access.
const BIT = {
  ADD_REACTIONS:        1n << 6n,
  VIEW_CHANNEL:         1n << 10n,
  SEND_MESSAGES:        1n << 11n,
  EMBED_LINKS:          1n << 14n,
  ATTACH_FILES:         1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  USE_EXTERNAL_EMOJIS:  1n << 18n,
};
const HIERARCHY_ALLOW = BIT.VIEW_CHANNEL | BIT.READ_MESSAGE_HISTORY | BIT.SEND_MESSAGES
                      | BIT.EMBED_LINKS | BIT.ATTACH_FILES | BIT.USE_EXTERNAL_EMOJIS | BIT.ADD_REACTIONS;

console.log('Phase 0: granting all hierarchy roles view+chat on #mod-section...');
for (const [key, rid] of Object.entries(ROLES)) {
  await api('PUT', `/channels/${MOD_SECTION}/permissions/${rid}`, {
    type: 0,
    allow: HIERARCHY_ALLOW.toString(),
    deny: '0',
  });
  console.log(`  ✓ ${key.padEnd(12)} → allow view+chat`);
}

// Format helper: mention chip + bolded plain-text username.
const holder = (uidKey) => `<@${USERS[uidKey]}> **${USERNAMES[uidKey]}**`;

function buildRoleEmbed({
  tier, emoji, title, roleId,
  holdersField, reportsTo, authorityLines,
  responsibilities, permissions, escalation, examples,
  seatNote,
}) {
  return {
    color: colorOf(roleId),
    author: { name: tier },
    title: `${emoji} ${title}`,
    description: `<@&${roleId}>`,
    fields: [
      { name: '👤 Holder(s)',                value: holdersField,                  inline: true  },
      { name: '⬆ Reports To',                value: reportsTo,                    inline: true  },
      { name: '🎯 Authority',                value: authorityLines.join('\n'),    inline: false },
      { name: '📋 Day-to-Day Responsibilities', value: responsibilities.join('\n'), inline: false },
      { name: '🔑 Standing Permissions',     value: permissions.join('\n'),       inline: false },
      { name: '🚨 Escalation Triggers',      value: escalation.join('\n'),        inline: false },
      { name: '💡 Typical Examples',         value: examples.join('\n'),          inline: false },
    ],
    footer: { text: `Role ID: ${roleId} · ${seatNote}` },
  };
}

const blocks = [
  // Header
  {
    color: colorOf(ROLES.KITSUNE),
    title: '🏯 Kitsune — Internal Staff Reference',
    description: [
      '**Staff-only deep dive.** Each role block: holder, perms, escalation triggers, typical scenarios.',
      '',
      'Chain: Owner → Founder → Head Admin → Co-Owners → Co-Head → Mods → Jr. Mods',
    ].join('\n'),
    footer: { text: '7 roles · 3 tiers · Pinned for fast reference' },
  },

  buildRoleEmbed({
    tier: 'Tier I · Ownership',
    emoji: '👑',
    title: 'Owner',
    roleId: ROLES.KITSUNE,
    holdersField: holder('WICKED'),
    reportsTo: '*Top of hierarchy*',
    authorityLines: ['✦ All Access', '✦ Full control', '✦ Final oversight'],
    responsibilities: [
      '✦ Final decision authority on guild policy',
      '✦ Owns bot / dashboard configuration',
      '✦ Approves new staff appointments',
      '✦ Resolves cross-tier staff disputes',
      '✦ Sets community vision & direction',
    ],
    permissions: ['✦ `ADMINISTRATOR` (full Discord permission bit)'],
    escalation: ['✦ *Top of hierarchy — buck stops here*'],
    examples: [
      '✦ Banning a user that all other staff have appealed up',
      '✦ Approving a major new server initiative',
      '✦ Granting an exception to standing rules',
    ],
    seatNote: '1 / 1 seat',
  }),

  buildRoleEmbed({
    tier: 'Tier I · Ownership',
    emoji: '⚜️',
    title: 'Founder',
    roleId: ROLES.SUN_WUKONG,
    holdersField: holder('MIKE'),
    reportsTo: `<@&${ROLES.KITSUNE}>`,
    authorityLines: ['✦ All Access · Full control', '✦ 2nd in command — final oversight'],
    responsibilities: [
      '✦ Operational lead in Owner\'s absence',
      '✦ Co-Founder partnership on strategy',
      '✦ Reviews escalations from Head Admin',
      '✦ Sets community direction',
    ],
    permissions: ['✦ `ADMINISTRATOR`'],
    escalation: [
      '✦ Decisions requiring final Owner sign-off',
      '✦ Strategic shifts affecting the whole server',
    ],
    examples: [
      '✦ Approving a Head Admin\'s policy proposal',
      '✦ Acting as Owner during their absence',
    ],
    seatNote: '1 / 1 seat',
  }),

  buildRoleEmbed({
    tier: 'Tier II · Executive Leadership',
    emoji: '🛡️',
    title: 'Head Admin',
    roleId: ROLES.LU_BU,
    holdersField: holder('DEATH'),
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>`,
    authorityLines: [
      '✦ All Access · Full control',
      '✦ Oversight of admin / mod roles + permissions',
      '✦ Bot management & control',
    ],
    responsibilities: [
      '✦ Bot configuration tuning',
      '✦ Channel / role permission management',
      '✦ Staff training & evaluation',
      '✦ Tier-3 escalation handling',
      '✦ Daily operations oversight',
    ],
    permissions: ['✦ `ADMINISTRATOR`'],
    escalation: [
      '✦ Policy questions outside written guidelines',
      '✦ Staff disputes between tiers',
      '✦ Configuration changes that affect all staff',
    ],
    examples: [
      '✦ Tuning automod rules',
      '✦ Adding / removing channels',
      '✦ Reviewing staff conduct issues',
    ],
    seatNote: '1 / 1 seat · single-seat role',
  }),

  buildRoleEmbed({
    tier: 'Tier II · Executive Leadership',
    emoji: '⚔️',
    title: 'Co-Owners',
    roleId: ROLES.MUSASHI,
    holdersField: `${holder('HIBIN')}\n${holder('TECHNI')}`,
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>\n<@&${ROLES.LU_BU}>`,
    authorityLines: [
      '✦ Nearly full access',
      '✦ Invites · Bans',
      '✦ Create / delete channels',
      '✦ Move users',
      '✦ Delete messages',
      '✦ Access to all rooms',
    ],
    responsibilities: [
      '✦ Channel architecture decisions',
      '✦ Member management (kick / ban / move)',
      '✦ Message-level moderation',
      '✦ Mid-tier policy enforcement',
    ],
    permissions: [
      '✦ `CREATE_INSTANT_INVITE` · `KICK_MEMBERS` · `BAN_MEMBERS`',
      '✦ `MANAGE_CHANNELS` · `MANAGE_MESSAGES` · `MOVE_MEMBERS`',
      '✦ Standard chat perms (`SEND_MESSAGES`, `EMBED_LINKS`, `ATTACH_FILES`, etc.)',
    ],
    escalation: [
      '✦ Policy ambiguity needing admin sign-off',
      '✦ Permanent ban appeals',
      '✦ Cross-tier staff disputes',
    ],
    examples: [
      '✦ Creating a new event channel',
      '✦ Banning a repeat offender',
      '✦ Moving users between voice rooms',
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
    responsibilities: [
      '✦ Acting Head Admin when needed',
      '✦ Specialized administrative tasks',
      '✦ Secondary audit oversight',
    ],
    permissions: ['✦ `ADMINISTRATOR`'],
    escalation: [
      '✦ Decisions Head Admin would normally make alone',
      '✦ Conflicts requiring a second admin opinion',
    ],
    examples: [
      '✦ Co-signing major bans',
      '✦ Acting in Head Admin\'s absence',
    ],
    seatNote: '0 / 1 seat · single-seat role · Open',
  }),

  buildRoleEmbed({
    tier: 'Tier III · Moderation',
    emoji: '🔨',
    title: 'Mods',
    roleId: ROLES.ITTO,
    holdersField: `${holder('DARKWORLD')}\n${holder('XALIRIA')}\n${holder('WOLFZ')}`,
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>\n<@&${ROLES.LU_BU}>\n<@&${ROLES.MUSASHI}>\n<@&${ROLES.KAISHAKUNIN}>`,
    authorityLines: [
      '✦ Invites · Bans',
      '✦ Message deletion',
      '✦ Enter locked rooms',
    ],
    responsibilities: [
      '✦ Front-line moderation',
      '✦ Rule enforcement',
      '✦ Welcome new members',
      '✦ Handle member reports',
      '✦ Access locked rooms for sensitive matters',
    ],
    permissions: [
      '✦ `CREATE_INSTANT_INVITE` · `KICK_MEMBERS` · `BAN_MEMBERS` · `MANAGE_MESSAGES`',
      '✦ Standard chat perms',
      '✦ Channel-override access: #Leaders, #mod-section, #Commands',
    ],
    escalation: [
      '✦ Permanent bans',
      '✦ Repeat offenders',
      '✦ Channel-level policy questions',
    ],
    examples: [
      '✦ Warning rule-breakers',
      '✦ Time-out spammers',
      '✦ Muting disruptive voice members',
    ],
    seatNote: '3 seats filled',
  }),

  buildRoleEmbed({
    tier: 'Tier III · Moderation',
    emoji: '🪶',
    title: 'Jr. Mods',
    roleId: ROLES.SANTO,
    holdersField: holder('KARLO'),
    reportsTo: `<@&${ROLES.SUN_WUKONG}>\n<@&${ROLES.KITSUNE}>\n<@&${ROLES.LU_BU}>\n<@&${ROLES.MUSASHI}>\n<@&${ROLES.KAISHAKUNIN}>\n<@&${ROLES.ITTO}>`,
    authorityLines: [
      '✦ Invites · Bans',
      '✦ Message deletion',
    ],
    responsibilities: [
      '✦ Initial response moderation',
      '✦ Basic rule enforcement',
      '✦ Welcome new members',
      '✦ Surface patterns to senior mods',
    ],
    permissions: [
      '✦ `CREATE_INSTANT_INVITE` · `KICK_MEMBERS` · `BAN_MEMBERS` · `MANAGE_MESSAGES`',
      '✦ Standard chat perms',
      '✦ *No locked-room access*',
    ],
    escalation: [
      '✦ Bans',
      '✦ Locked-room access requests',
      '✦ Repeat-offender patterns',
    ],
    examples: [
      '✦ Warning first-time rule-breakers',
      '✦ Routine spam cleanup',
      '✦ Helping new members navigate',
    ],
    seatNote: '1 seat filled',
  }),
];

// Char budget sanity
const totalChars = blocks.reduce((n, b) => {
  const t = (b.title?.length || 0) + (b.description?.length || 0)
          + (b.author?.name?.length || 0) + (b.footer?.text?.length || 0);
  const f = (b.fields || []).reduce((m, x) => m + (x.name?.length || 0) + (x.value?.length || 0), 0);
  return n + t + f;
}, 0);
console.log(`Embeds: ${blocks.length}, total chars: ${totalChars} / 6000`);
if (blocks.length > 10) throw new Error('too many embeds (max 10 per message)');
if (totalChars > 6000) throw new Error(`embed char total ${totalChars} exceeds 6000`);

// Post
const posted = await api('POST', `/channels/${MOD_SECTION}/messages`, {
  embeds: blocks,
  allowed_mentions: { parse: [] },
});
console.log(`✓ Posted expanded hierarchy to #mod-section (${posted.id})`);

// Pin
await api('PUT', `/channels/${MOD_SECTION}/pins/${posted.id}`);
console.log(`✓ Pinned message ${posted.id}`);

console.log('\nDone.');
process.exit(0);
