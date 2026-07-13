// Reconcile guild 1428091358522114090 (Wolves of shadows) — phase 1.
//
// Moves my Phase-2 channels into the pre-existing fancy category structure,
// deletes true duplicates, and fixes DB references that pointed at the soon-
// to-be-deleted channels.
//
// REST-only via DarkWolf's bot token. Idempotent (re-running is safe — every
// step checks current state before acting).
//
// Run order:  pm2 stop CertiFriedUtility  →  this script  →  the lockdown
// script (`scripts/wolves-lockdown.mjs`)  →  pm2 restart.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID  = '1428091358522114090';
const BOT_ID    = '1506374126594691092';

// Destination categories (pre-existing)
const CAT_WELCOME_IN   = '1448801173183139871';
const CAT_GENERAL_CHAT = '1428091360019218432';
const CAT_VOICE        = '1428091360019218433';
const CAT_ADMINS       = '1428140447443849376';

// Pre-existing channel to redirect temp_channel_config to
const JOIN_TO_CREATE = '1491939911706607776';

// Moves: { channel_id: target_parent_category_id }
const MOVES = {
    '1506378068099338392': CAT_WELCOME_IN,    // rules
    '1506378069022212188': CAT_WELCOME_IN,    // roles (user-specified)
    '1506378072113418390': CAT_GENERAL_CHAT,  // support (ticket panel)
    '1506378072956473364': CAT_VOICE,         // 🔊 General VC
    '1506378075678707822': CAT_ADMINS,        // mod-logs
    '1506378076643266731': CAT_ADMINS,        // ticket-alerts
    '1506378077377134674': CAT_ADMINS,        // ticket-logs
};

// Channels to delete (after moves)
const DELETE_CHANNELS = [
    ['1428141580711362621', 'ʀᴜʟᴇꜱ-📖 (pre-existing, superseded by rules w/ verify gate)'],
    ['1506378070007873618', 'general (mine, empty dup of active ɢᴇɴᴇʀᴀʟ)'],
    ['1506378071156985886', 'media (mine, empty)'],
    ['1506378074730791012', 'mod-chat (mine, empty dup of `chat` in Admins)'],
    ['1506378073774227626', '➕ Create VC (mine, empty dup of Join to Create)'],
];

// Categories to delete (after their kids are moved/deleted)
const DELETE_CATEGORIES = [
    ['1506378062722240602', '📋 Information'],
    ['1506378063745650688', '💬 Community'],
    ['1506378064567992400', '🔊 Voice'],
    ['1506378065549328536', '🔧 Staff'],
    ['1506378078761521272', '🎫 Tickets'],
];

// ────────────────────────────────────────────────────────────────────────────
const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
if (!rows.length) { console.error('Bot row missing'); process.exit(1); }
const TOKEN = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 120));
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
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

console.log('=== Wolves of shadows reconciliation (phase 1) ===\n');

// Step 1: fetch channels — gate everything on what's actually live
console.log('[1] Fetching current channel state…');
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
if (channels?.__err) { console.error('fetch channels failed:', channels.__err); process.exit(1); }
const byId = new Map(channels.map(c => [c.id, c]));

console.log('');

// Step 2: moves
console.log('[2] Moving channels into pre-existing categories…');
for (const [chId, targetParent] of Object.entries(MOVES)) {
    const ch = byId.get(chId);
    if (!ch) { console.log(`    ✗ ${chId} not found — skipping`); continue; }
    if (ch.parent_id === targetParent) {
        console.log(`    = #${ch.name} (${chId}) already under target — skip`);
        continue;
    }
    const res = await api('PATCH', `/channels/${chId}`, { parent_id: targetParent });
    if (res?.__err) console.log(`    ✗ #${ch.name}: ${res.__err.status} ${res.__err.body.slice(0,180)}`);
    else            console.log(`    ✓ #${ch.name} (${chId}) → ${byId.get(targetParent)?.name || targetParent}`);
}
console.log('');

// Step 3: delete duplicate channels
console.log('[3] Deleting duplicate channels…');
for (const [chId, label] of DELETE_CHANNELS) {
    const ch = byId.get(chId);
    if (!ch) { console.log(`    = ${label}  ALREADY GONE`); continue; }
    const res = await api('DELETE', `/channels/${chId}`);
    if (res?.__err) console.log(`    ✗ ${label}: ${res.__err.status} ${res.__err.body.slice(0,180)}`);
    else            console.log(`    ✓ deleted ${label}`);
}
console.log('');

// Step 4: delete emptied categories (re-fetch first to confirm they're empty)
console.log('[4] Deleting emptied categories…');
const channelsAfter = await api('GET', `/guilds/${GUILD_ID}/channels`);
const byIdAfter = new Map(channelsAfter.map(c => [c.id, c]));
for (const [catId, label] of DELETE_CATEGORIES) {
    const cat = byIdAfter.get(catId);
    if (!cat) { console.log(`    = ${label}  ALREADY GONE`); continue; }
    const kids = channelsAfter.filter(c => c.parent_id === catId);
    if (kids.length) {
        console.log(`    ✗ ${label} still has ${kids.length} child(ren): ${kids.map(k => k.name).join(', ')} — skipping delete`);
        continue;
    }
    const res = await api('DELETE', `/channels/${catId}`);
    if (res?.__err) console.log(`    ✗ ${label}: ${res.__err.status} ${res.__err.body.slice(0,180)}`);
    else            console.log(`    ✓ deleted ${label}`);
}
console.log('');

// Step 5: DB redirects for deleted channels
console.log('[5] Updating DB references…');

// temp_channel_config: redirect to Join to Create (pre-existing)
const [tc] = await pool.execute('SELECT creator_channel_id FROM temp_channel_config WHERE guild_id = ?', [GUILD_ID]);
if (tc.length && tc[0].creator_channel_id === '1506378073774227626') {
    await pool.execute(
        `UPDATE temp_channel_config
         SET creator_channel_id = ?, category_id = ?
         WHERE guild_id = ?`,
        [JOIN_TO_CREATE, CAT_VOICE, GUILD_ID]
    );
    console.log(`    ✓ temp_channel_config.creator_channel_id → ${JOIN_TO_CREATE} (Join to Create)`);
} else {
    console.log(`    = temp_channel_config already points elsewhere or absent (current: ${tc[0]?.creator_channel_id || 'NONE'})`);
}

// Sanity-check other DB pointers (verify they don't reference deleted channels)
const deletedIds = new Set(DELETE_CHANNELS.map(([id]) => id));
const tablesToCheck = [
    { table: 'logging_config',  cols: ['log_channel_id'] },
    { table: 'log_event_config', cols: ['log_channel_id'] },
    { table: 'ticket_panels',   cols: ['panel_channel_id', 'log_channel_id', 'alert_channel_id', 'ticket_category_id'] },
    { table: 'level_config',    cols: ['level_up_channel_id'] },
    { table: 'moderation_config', cols: ['mod_log_channel_id'] },
    { table: 'anti_nuke_config',   cols: ['alert_channel_id'] },
    { table: 'raid_detection_config', cols: ['alert_channel_id'] },
    { table: 'adaptive_spam_config', cols: ['alert_channel_id'] },
    { table: 'phishing_config',  cols: ['alert_channel_id', 'report_channel_id'] },
    { table: 'selfbot_detection_config', cols: ['alert_channel_id'] },
];
let danglingRefs = 0;
for (const { table, cols } of tablesToCheck) {
    for (const col of cols) {
        const [r] = await pool.execute(
            `SELECT ${col} AS val FROM ${table} WHERE guild_id = ? AND ${col} IS NOT NULL`,
            [GUILD_ID]
        ).catch(() => [[]]);
        for (const row of r) {
            if (deletedIds.has(row.val)) {
                console.log(`    ! DANGLING: ${table}.${col} = ${row.val} (now deleted)`);
                danglingRefs++;
            }
        }
    }
}
if (!danglingRefs) console.log('    ✓ No dangling references to deleted channels');

await pool.end();
console.log('\nPhase 1 complete. Next: run scripts/wolves-lockdown.mjs');
