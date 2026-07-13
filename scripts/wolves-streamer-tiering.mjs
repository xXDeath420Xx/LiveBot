// Tighten streamer access for guild 1428091358522114090 (Wolves of shadows).
//
//   1. Exclude #ꜱᴇʟꜰ-ᴘʀᴏᴍᴏ from XP gain (level_config.ignored_channels)
//   2. Voice-XP already enabled — confirm
//   3. Add min_level=3 gate to the 🎥 Streamer reaction-role button (panel 151)
//   4. Update button label to "🎥 Streamer (Lv 3+)" so members see the gate
//   5. Re-render the self-roles panel embed in #roles to match the new label
//   6. PATCH #ꜱᴇʟꜰ-ᴘʀᴏᴍᴏ channel: @Verified deny SEND, @Streamers + staff allow
//      (manual posts now require the level-gated Streamers role; bot announces still post fine via its admin role)
//
// REST-only via DarkWolf token. Idempotent.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1428091358522114090';
const BOT_ID   = '1506374126594691092';
const SELF_PROMO_CH  = '1428140205151621191';
const ROLES_CH       = '1506378069022212188';
const STREAMERS_ROLE = '1428139684290232392';
const VERIFIED_ROLE  = '1506378052286812200';
const SUPPORTERS_ROLE = '1428139836031762513';

// Staff roles auto-discovered earlier in the lockdown — explicit allow for posting
const STAFF_ROLES = [
    '1428111354526699530',  // Sever admin
    '1477150090530521098',  // Founder
    '1491870756068393060',  // Server editor and lead admin
    '1506378050231865525',  // 🛠️ Moderator
];

const MIN_LEVEL = 3;

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
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 300) } };
    return res.status === 204 ? null : res.json();
}

console.log('=== Wolves streamer tiering ===\n');

// ─── Step 1: level_config — ignore self-promo channel for XP ─────────────────
console.log('[1] level_config.ignored_channels…');
const [[lcfg]] = await pool.execute('SELECT ignored_channels, voice_xp_enabled, xp_per_voice_minute FROM level_config WHERE guild_id = ?', [GUILD_ID]);
let ignored = [];
try { ignored = lcfg?.ignored_channels ? JSON.parse(lcfg.ignored_channels) : []; } catch { ignored = []; }
if (!ignored.includes(SELF_PROMO_CH)) ignored.push(SELF_PROMO_CH);
await pool.execute(
    'UPDATE level_config SET ignored_channels = ?, voice_xp_enabled = 1 WHERE guild_id = ?',
    [JSON.stringify(ignored), GUILD_ID]
);
console.log(`    ✓ ignored_channels = ${JSON.stringify(ignored)}`);
console.log(`    ✓ voice_xp_enabled = 1 (xp_per_voice_minute = ${lcfg?.xp_per_voice_minute ?? 5})`);

// ─── Step 2: gate the Streamer button on min_level=3 + re-label ──────────────
console.log('\n[2] reaction_role_mappings min_level + label…');
const [[panel]] = await pool.execute(
    `SELECT id, channel_id, message_id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = 'self-roles'`,
    [GUILD_ID]
);
if (!panel) { console.error('self-roles panel not found'); process.exit(1); }
const NEW_STREAMER_LABEL = `Streamer (Lv ${MIN_LEVEL}+)`;
await pool.execute(
    `UPDATE reaction_role_mappings SET min_level = ?, label = ? WHERE panel_id = ? AND role_id = ?`,
    [MIN_LEVEL, NEW_STREAMER_LABEL, panel.id, STREAMERS_ROLE]
);
console.log(`    ✓ panel ${panel.id} / role ${STREAMERS_ROLE}: min_level=${MIN_LEVEL}, label="${NEW_STREAMER_LABEL}"`);

// ─── Step 3: re-render the self-roles embed message so members see the gate ──
console.log('\n[3] Re-rendering self-roles embed…');
const STREAMER_EMOJI = '🎥';
const SUPPORTER_EMOJI = '💜';

const embed = {
    color: 0xE91E63,
    title: '🎭 Self Roles',
    description: 'Click a button below to toggle a community-identity role.\n\n' +
                 `**${STREAMER_EMOJI} Streamer** — gates access to the social/stream channels. Requires **Level ${MIN_LEVEL}+** (chat + voice activity counts; self-promo posts don't earn XP).\n` +
                 `**${SUPPORTER_EMOJI} Supporter** — community supporter badge.`,
};
const row = {
    type: 1,
    components: [
        { type: 2, style: 1, label: NEW_STREAMER_LABEL,  emoji: { name: STREAMER_EMOJI },  custom_id: `rr_${STREAMERS_ROLE}` },
        { type: 2, style: 2, label: 'Supporter',          emoji: { name: SUPPORTER_EMOJI }, custom_id: `rr_${SUPPORTERS_ROLE}` },
    ],
};

const editResp = await api('PATCH', `/channels/${panel.channel_id}/messages/${panel.message_id}`, { embeds: [embed], components: [row] });
if (editResp?.__err) {
    console.log(`    ✗ in-place edit failed (${editResp.__err.status}); reposting…`);
    // Fallback: post a new message and update panel
    const newMsg = await api('POST', `/channels/${panel.channel_id}/messages`, { embeds: [embed], components: [row] });
    if (newMsg?.__err) { console.error('    ✗ repost failed:', newMsg.__err); process.exit(1); }
    await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [newMsg.id, panel.id]);
    console.log(`    ✓ reposted as new message ${newMsg.id}`);
} else {
    console.log(`    ✓ in-place edit OK — message ${panel.message_id}`);
}

// ─── Step 4: PATCH #ꜱᴇʟꜰ-ᴘʀᴏᴍᴏ — only @Streamers + staff can post ────────────
console.log('\n[4] #ꜱᴇʟꜰ-ᴘʀᴏᴍᴏ posting lockdown…');
const SEND_MESSAGES         = 1n << 11n;
const EMBED_LINKS           = 1n << 14n;
const ATTACH_FILES          = 1n << 15n;
const ADD_REACTIONS         = 1n << 6n;
const USE_EXTERNAL_EMOJIS   = 1n << 18n;
const VIEW_CHANNEL          = 1n << 10n;
const READ_MESSAGE_HISTORY  = 1n << 16n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const CREATE_PUBLIC_THREADS  = 1n << 35n;
const CREATE_PRIVATE_THREADS = 1n << 36n;
const POST_BITS = SEND_MESSAGES | ATTACH_FILES | EMBED_LINKS | ADD_REACTIONS | USE_EXTERNAL_EMOJIS | SEND_MESSAGES_IN_THREADS | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS;

const ch = await api('GET', `/channels/${SELF_PROMO_CH}`);
if (ch?.__err) { console.error('    ✗ fetch self-promo failed:', ch.__err); process.exit(1); }
const ow = (ch.permission_overwrites || []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));

function set(id, type, addAllow, removeAllow, addDeny, removeDeny) {
    let e = ow.find(o => o.id === id);
    if (!e) { e = { id, type, allow: '0', deny: '0' }; ow.push(e); }
    const a = (BigInt(e.allow) | addAllow) & ~removeAllow;
    const d = (BigInt(e.deny)  | addDeny)  & ~removeDeny;
    e.allow = String(a); e.deny = String(d);
}

// @Verified: keep VIEW + READ; deny POST bits (must hold @Streamers to post)
set(VERIFIED_ROLE, 0, VIEW_CHANNEL | READ_MESSAGE_HISTORY, POST_BITS, POST_BITS, VIEW_CHANNEL | READ_MESSAGE_HISTORY);
// @Streamers: allow VIEW + READ + POST
set(STREAMERS_ROLE, 0, VIEW_CHANNEL | READ_MESSAGE_HISTORY | POST_BITS, 0n, 0n, VIEW_CHANNEL | READ_MESSAGE_HISTORY | POST_BITS);
// Staff: allow all
for (const sid of STAFF_ROLES) {
    set(sid, 0, VIEW_CHANNEL | READ_MESSAGE_HISTORY | POST_BITS, 0n, 0n, VIEW_CHANNEL | READ_MESSAGE_HISTORY | POST_BITS);
}

const patch = await api('PATCH', `/channels/${SELF_PROMO_CH}`, { permission_overwrites: ow });
if (patch?.__err) console.log(`    ✗ patch failed: ${patch.__err.status} ${patch.__err.body}`);
else              console.log(`    ✓ #ꜱᴇʟꜰ-ᴘʀᴏᴍᴏ — @Verified view-only; @Streamers + staff can post`);

// ─── Verification ────────────────────────────────────────────────────────────
console.log('\n[5] Verification:');
const [[v1]] = await pool.execute('SELECT ignored_channels, voice_xp_enabled FROM level_config WHERE guild_id = ?', [GUILD_ID]);
console.log('    level_config.ignored_channels =', v1.ignored_channels);
console.log('    level_config.voice_xp_enabled =', v1.voice_xp_enabled);
const [[v2]] = await pool.execute('SELECT min_level, label FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?', [panel.id, STREAMERS_ROLE]);
console.log('    Streamer button: min_level =', v2.min_level, '| label =', v2.label);

await pool.end();
console.log('\nDone.');
