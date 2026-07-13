// Adds 7 new game-role channels + buttons to Flickster's House, matching
// the existing Arc Raiders pattern. Idempotent (re-running won't duplicate
// channels or buttons).
//
// REST-only — does NOT open a gateway, safe to run while PM2 is up.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID    = '1500965606659194982';
const BOT_ID      = '1502798840124670133';
const GAMING_CAT  = '1502814382520926320';
const ROLES_CH    = '1502814398715138148';
const GAMES_MSG   = '1502814747580698755';
const GAMES_PANEL = 138;
const ARC_RAIDERS_ROLE = '1502814372718710895';

const NEW_GAMES = [
  { roleId: '1503184007142182932', baseName: 'Call of Duty',    emoji: '🎯', channel: 'call-of-duty'   },
  { roleId: '1503184187941982299', baseName: 'Windrose',        emoji: '🧭', channel: 'windrose'       },
  { roleId: '1503184088184520795', baseName: 'Counterstrike',   emoji: '💥', channel: 'counterstrike'  },
  { roleId: '1503184235484151828', baseName: 'Battlefield',     emoji: '🪖', channel: 'battlefield'    },
  { roleId: '1503184271563690105', baseName: 'SCUM',            emoji: '💀', channel: 'scum'           },
  { roleId: '1503184386412118127', baseName: 'The Division 2',  emoji: '🦠', channel: 'the-division-2' },
  { roleId: '1503184569338171393', baseName: 'Ready or Not',    emoji: '👮', channel: 'ready-or-not'   },
];

// Discord permission bit constants
const VIEW_CHANNEL  = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS   = 1n << 14n;
const READ_HISTORY  = 1n << 16n;

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token  = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'X-Audit-Log-Reason': 'Flickster game role setup (matches Arc Raiders pattern)',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status} ${text}`);
  }
  return r.status === 204 ? null : r.json();
}

const log = (...a) => console.log('[flickster-games]', ...a);

// ─── Step 1: rename roles + make mentionable ─────────────────────────
log('Step 1: patching roles (rename + mentionable)');
for (const g of NEW_GAMES) {
  const newName = `${g.emoji} ${g.baseName}`;
  try {
    await api('PATCH', `/guilds/${GUILD_ID}/roles/${g.roleId}`, {
      name: newName,
      mentionable: true,
    });
    log(`  ✓ ${g.roleId} → "${newName}" (mentionable=true)`);
  } catch (e) {
    log(`  ! ${g.baseName} role patch failed: ${e.message}`);
  }
}

// ─── Step 2: create channels ─────────────────────────────────────────
log('\nStep 2: creating private channels under Gaming');
const existingChannels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const byName = new Map(existingChannels.map(c => [c.name, c]));

for (const g of NEW_GAMES) {
  if (byName.has(g.channel)) {
    log(`  → #${g.channel} already exists (${byName.get(g.channel).id}), skipping create`);
    continue;
  }
  try {
    const ch = await api('POST', `/guilds/${GUILD_ID}/channels`, {
      name: g.channel,
      type: 0,
      parent_id: GAMING_CAT,
      topic: `Discussion for ${g.baseName}. Unlocked via the role.`,
      permission_overwrites: [
        { id: GUILD_ID,   type: 0, allow: '0', deny: String(VIEW_CHANNEL) },
        { id: g.roleId,   type: 0, allow: String(VIEW_CHANNEL),           deny: '0' },
        { id: BOT_ID,     type: 1, allow: String(VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | READ_HISTORY), deny: '0' },
      ],
    });
    log(`  ✓ created #${ch.name} (${ch.id})`);
  } catch (e) {
    log(`  ! #${g.channel} create failed: ${e.message}`);
  }
}

// ─── Step 3: rebuild games panel components on existing message ──────
log('\nStep 3: updating games panel message components');

const allButtons = [
  { roleId: ARC_RAIDERS_ROLE, label: 'Arc Raiders',   emoji: '🎮' },
  ...NEW_GAMES.map(g => ({ roleId: g.roleId, label: g.baseName, emoji: g.emoji })),
];

// Discord ActionRow holds max 5 buttons. 8 buttons → 4 + 4 split.
function buildRows(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) {
    const chunk = buttons.slice(i, i + 4);
    rows.push({
      type: 1, // ActionRow
      components: chunk.map(b => ({
        type: 2, // Button
        style: 2, // Secondary
        custom_id: `rr_${b.roleId}`,
        label: b.label,
        emoji: { name: b.emoji },
      })),
    });
  }
  return rows;
}

try {
  await api('PATCH', `/channels/${ROLES_CH}/messages/${GAMES_MSG}`, {
    components: buildRows(allButtons),
  });
  log(`  ✓ patched games panel message (${GAMES_MSG}) with ${allButtons.length} buttons`);
} catch (e) {
  log(`  ! panel message patch failed: ${e.message}`);
  throw e;
}

// ─── Step 4: sync reaction_role_mappings to match new buttons ────────
log('\nStep 4: syncing reaction_role_mappings rows');
await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [GAMES_PANEL]);
for (const b of allButtons) {
  await pool.execute(
    `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style)
     VALUES (?, ?, ?, ?, 'secondary')`,
    [GAMES_PANEL, b.roleId, b.emoji, b.label]
  );
}
log(`  ✓ inserted ${allButtons.length} mappings for panel ${GAMES_PANEL}`);

log('\nAll done.');
await pool.end();
