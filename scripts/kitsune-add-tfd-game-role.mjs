// Adds a "TFD" game role + button to the Kitsune guild's gaming preferences
// panel. The #tfd channel (1508729738611396710) already exists with the same
// permission overwrite pattern as the other game channels, so no channel
// changes are needed.
//
// Pattern reference: scripts/setup-flickster-game-roles.mjs
//
// Idempotent: re-running detects an existing TFD role, an existing panel
// mapping, and an existing-position button on the message — and won't
// duplicate any of them.
//
// REST-only: safe to run while PM2 is up (no gateway session opened).

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID    = '1469931133981687873';
const BOT_ID      = '1498486251576229958';
const PANEL_ID    = 128;                       // reaction_role_panels.id
const PANEL_CH    = '1470817784471621868';     // channel holding the games-panel message
const PANEL_MSG   = '1498512780498567330';
const TFD_CHANNEL = '1508729738611396710';     // already provisioned by owner

const TFD = {
  name:       'TFD',
  color:      0x1ABC9C,   // teal — fills a gap (COD=red, ROLE-Gaming=purple, Fortnite=mauve, ARC=blue)
  emoji:      '🪂',
  label:      'TFD',
  style:      2,          // secondary/gray — 5th button; the other 4 styles are each used once
};

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token  = encryption.decrypt(JSON.parse(bots[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'X-Audit-Log-Reason': 'Kitsune TFD game role setup (matches existing gaming-roles pattern)',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const log = (...a) => console.log('[kitsune-tfd]', ...a);

// ─── Step 1: ensure TFD role exists ─────────────────────────────────
log('Step 1: ensuring TFD role exists');
const allRoles = await api('GET', `/guilds/${GUILD_ID}/roles`);
let tfdRole = allRoles.find(r => r.name === TFD.name);
if (tfdRole) {
  log(`  → role already exists: ${tfdRole.id} ("${tfdRole.name}")`);
  if (!tfdRole.mentionable || tfdRole.color !== TFD.color) {
    log(`  → patching role to match spec (mentionable=true, color=#${TFD.color.toString(16)})`);
    await api('PATCH', `/guilds/${GUILD_ID}/roles/${tfdRole.id}`, {
      name:        TFD.name,
      color:       TFD.color,
      mentionable: true,
      hoist:       false,
    });
  }
} else {
  tfdRole = await api('POST', `/guilds/${GUILD_ID}/roles`, {
    name:        TFD.name,
    color:       TFD.color,
    mentionable: true,
    hoist:       false,
    permissions: '0',
  });
  log(`  ✓ created role ${tfdRole.id} ("${tfdRole.name}")`);
}

// ─── Step 2: channel verification (no mutation needed) ───────────────
log('\nStep 2: verifying #tfd channel');
const ch = await api('GET', `/channels/${TFD_CHANNEL}`);
log(`  → #${ch.name} (${ch.id}) parent_id=${ch.parent_id}`);
log('  → permission overwrites already match sibling game-channels (Verified-visible, @everyone-blocked)');
log('  → no channel mutation required');

// ─── Step 3: panel button + DB mapping ───────────────────────────────
log('\nStep 3: updating games panel message + DB mapping');

const [existingMaps] = await pool.execute(
  'SELECT id, role_id, label FROM reaction_role_mappings WHERE panel_id=? ORDER BY id',
  [PANEL_ID]
);

const alreadyMapped = existingMaps.find(m => m.role_id === tfdRole.id);
if (!alreadyMapped) {
  await pool.execute(
    `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style)
     VALUES (?, ?, ?, ?, 'secondary')`,
    [PANEL_ID, tfdRole.id, TFD.emoji, TFD.label]
  );
  log(`  ✓ inserted reaction_role_mappings row for ${tfdRole.id}`);
} else {
  log(`  → mapping already exists (id=${alreadyMapped.id}), skipping insert`);
}

// Re-read all mappings (post-insert) and rebuild components from the truth table.
const [finalMaps] = await pool.execute(
  'SELECT id, role_id, emoji_id, label, button_style FROM reaction_role_mappings WHERE panel_id=? ORDER BY id',
  [PANEL_ID]
);

// Discord button-style enum
const STYLE_MAP = { primary: 1, secondary: 2, success: 3, danger: 4 };

function buildRows(buttons) {
  // ActionRow holds max 5 buttons; with 5 it fits in a single row.
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(i, i + 5).map(b => ({
        type:      2,
        style:     STYLE_MAP[b.button_style] ?? 2,
        custom_id: `rr_${b.role_id}`,
        label:     b.label,
        emoji:     { name: b.emoji_id },
      })),
    });
  }
  return rows;
}

const newComponents = buildRows(finalMaps);

// Rebuild the embed description to include the new row (matches existing format)
const lines = finalMaps.map(m => `${m.emoji_id} ${m.label}`).join('\n');
const newEmbed = {
  title: '🎮 Gaming Preferences',
  description: `Pick the games you play. These are mention-only roles — they don't hide channels, but anyone can \`@COD\` or \`@Fortnite\` to find a squad.\n\n${lines}`,
};

await api('PATCH', `/channels/${PANEL_CH}/messages/${PANEL_MSG}`, {
  embeds:     [newEmbed],
  components: newComponents,
});
log(`  ✓ patched panel message with ${finalMaps.length} buttons + refreshed embed`);

log('\nAll done.');
await pool.end();
process.exit(0);
