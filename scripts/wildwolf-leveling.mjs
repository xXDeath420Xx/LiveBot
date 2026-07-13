// Builds out the leveling-visible infrastructure for WildWolf:
//   1. #levels channel (under Pack Hangout, Verified-class)
//   2. Six tier roles (Pack Howler @ 3 → Pack Legend @ 100), unhoisted
//   3. level_role_rewards rows (DELETE + INSERT for idempotency — no UNIQUE on guild+level)
//   4. Move level_config.level_up_channel_id → #levels (no more level-up spam in #general-chat)
//   5. Pinned tier-progression embed in #levels
//   6. Patch #stream-signup embed to point users at /rank in #levels for tracking progress
//   7. Patch #self-roles embed similarly for the Streamers level gate
//   8. Backfill any current users who already qualify for tier roles
//
// Idempotent. Tier role names + levels match the wolf theme.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';
const VERIFIED_ROLE = '1455255019627479071';
const WOLFIE_LIVE_CH = '1455251028399099934';
const STREAM_SIGNUP_CH = '1508616684703842355';
const SELF_ROLES_CH = '1508621207191294105';

// Permission bits
const CREATE_INSTANT_INVITE = 1n << 0n;
const ADD_REACTIONS         = 1n << 6n;
const VIEW_CHANNEL          = 1n << 10n;
const SEND_MESSAGES         = 1n << 11n;
const MANAGE_MESSAGES       = 1n << 13n;
const EMBED_LINKS           = 1n << 14n;
const ATTACH_FILES          = 1n << 15n;
const READ_MESSAGE_HISTORY  = 1n << 16n;
const USE_EXTERNAL_EMOJIS   = 1n << 18n;
const VIEW_PAIR = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const STAFF_BITS = (1n<<1n)|(1n<<2n)|(1n<<3n)|(1n<<4n)|(1n<<5n)|(1n<<28n)|(1n<<13n)|(1n<<40n);
const STAFF_NAME_BLOCKLIST = /^(bots?|bot manager|new role)$/i;
const STAFF_TEXT_ALLOW = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | MANAGE_MESSAGES;

// Tier ladder — colors are Discord-style hex ints, all unhoisted + non-mentionable
const TIERS = [
    { name: '🌙 Pack Howler',   level: 3,   color: 0x95a5a6 },
    { name: '🐺 Pack Hunter',   level: 5,   color: 0x3498db },
    { name: '⚔️ Pack Warrior',  level: 10,  color: 0x9b59b6 },
    { name: '🛡️ Pack Guardian', level: 25,  color: 0xe67e22 },
    { name: '👑 Pack Alpha',    level: 50,  color: 0xf1c40f },
    { name: '🏆 Pack Legend',   level: 100, color: 0xe74c3c },
];

const [botRows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const TOKEN = encryption.decrypt(JSON.parse(botRows[0].bot_token));

async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 150));
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
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 400) } };
    return res.status === 204 ? null : res.json();
}

function ok(msg)   { console.log(`    ✓ ${msg}`); }
function info(msg) { console.log(`    • ${msg}`); }
function err(msg)  { console.log(`    ✗ ${msg}`); }

console.log('═════════════════════════════════════════════════════════════');
console.log(' WildWolf — leveling infrastructure');
console.log('═════════════════════════════════════════════════════════════\n');

// ─── [0] Inventory ───
const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const STAFF_IDS = roles
    .filter(r => r.id !== GUILD_ID && r.id !== VERIFIED_ROLE && !r.managed)
    .filter(r => !STAFF_NAME_BLOCKLIST.test(r.name))
    .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
    .sort((a,b) => b.position - a.position)
    .map(r => r.id);
const packHangoutCat = channels.find(c => c.type === 4 && /pack hangout/i.test(c.name));
info(`Pack Hangout category = ${packHangoutCat?.id}`);
info(`staff roles = ${STAFF_IDS.length}`);
console.log('');

// ─── [1] Create tier roles ───
console.log('[1] Ensuring tier roles…');
const tierRoleIds = {};
for (const tier of TIERS) {
    let role = roles.find(r => r.name === tier.name);
    if (role) {
        info(`role exists: ${tier.name} (${role.id})`);
        tierRoleIds[tier.level] = role.id;
        continue;
    }
    role = await api('POST', `/guilds/${GUILD_ID}/roles`, {
        name: tier.name,
        color: tier.color,
        permissions: '0',
        mentionable: false,
        hoist: false,
    });
    if (role?.__err) { err(`create ${tier.name}: ${role.__err.body}`); continue; }
    roles.push(role);
    tierRoleIds[tier.level] = role.id;
    ok(`created ${tier.name} (${role.id})`);
}
console.log('');

// ─── [2] Create #levels channel ───
console.log('[2] Ensuring #levels channel…');
let levelsCh = channels.find(c => c.type === 0 && c.name === 'levels');
if (!levelsCh) {
    const verifiedAllow = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | ADD_REACTIONS | USE_EXTERNAL_EMOJIS;
    const overwrites = [
        { id: GUILD_ID,      type: 0, allow: '0',                   deny: String(VIEW_PAIR | CREATE_INSTANT_INVITE) },
        { id: VERIFIED_ROLE, type: 0, allow: String(verifiedAllow), deny: '0' },
    ];
    for (const sid of STAFF_IDS) overwrites.push({ id: sid, type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' });
    levelsCh = await api('POST', `/guilds/${GUILD_ID}/channels`, {
        name: 'levels',
        type: 0,
        parent_id: packHangoutCat?.id,
        topic: 'Your XP, rank, level rewards, and the Wolfie Pack leaderboard. Use /rank and /leaderboard.',
        permission_overwrites: overwrites,
    });
    if (levelsCh?.__err) { err(`create #levels: ${levelsCh.__err.body}`); process.exit(1); }
    ok(`created #levels (${levelsCh.id})`);
} else {
    info(`#levels exists (${levelsCh.id})`);
}
console.log('');

// ─── [3] Wire level_role_rewards (DELETE + INSERT) ───
console.log('[3] Writing level_role_rewards…');
await pool.execute('DELETE FROM level_role_rewards WHERE guild_id=?', [GUILD_ID]);
for (const tier of TIERS) {
    const rid = tierRoleIds[tier.level];
    if (!rid) { err(`missing role id for level ${tier.level}`); continue; }
    await pool.execute('INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?)', [GUILD_ID, tier.level, rid]);
    ok(`level ${tier.level} → ${tier.name}`);
}
console.log('');

// ─── [4] Move level_up_channel_id → #levels ───
console.log('[4] Updating level_config.level_up_channel_id → #levels…');
await pool.execute(
    'UPDATE level_config SET level_up_channel_id=?, level_up_message=? WHERE guild_id=?',
    [levelsCh.id, '🐺 {user} just leveled up to **Level {level}**! Howl with the pack!', GUILD_ID]
);
ok(`level-up notifications now go to #levels`);
console.log('');

// ─── [5] Pinned tier-progression embed ───
console.log('[5] Posting pinned tier-progression embed…');
{
    const embed = {
        type: 'rich',
        title: '🏆 Wolfie Pack — Levels & Rewards',
        description: [
            `> Chat in the server and hang out in voice channels to earn XP. Level up to unlock perks!`,
            ``,
            `### 📊 How XP works`,
            `> • **20 XP** per message *(60s cooldown — spam doesn't help)*`,
            `> • **5 XP** per minute in voice channels`,
            `> • Weekend XP multiplier can be toggled by staff`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `### 🎖️ Tier rewards`,
            `Every time you hit a tier, you'll get the matching role automatically:`,
            ``,
            `\`Lv 3 \`  🌙 **Pack Howler** — *unlocks @Streamers eligibility + stream-signup*`,
            `\`Lv 5 \`  🐺 **Pack Hunter**`,
            `\`Lv 10\`  ⚔️ **Pack Warrior**`,
            `\`Lv 25\`  🛡️ **Pack Guardian**`,
            `\`Lv 50\`  👑 **Pack Alpha**`,
            `\`Lv 100\` 🏆 **Pack Legend**`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `### ⚙️ Commands`,
            `> \`/rank\` — check your current level + XP`,
            `> \`/leaderboard\` — see the top members of the Pack`,
            ``,
            `*Level-up notifications post in this channel so the rest of the server stays clean.*`,
        ].join('\n'),
        color: 0xf1c40f,
    };
    const recent = await api('GET', `/channels/${levelsCh.id}/messages?limit=20`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === embed.title) : null;
    let msgId;
    if (existing) {
        const upd = await api('PATCH', `/channels/${levelsCh.id}/messages/${existing.id}`, { embeds: [embed] });
        msgId = existing.id;
        if (upd?.__err) err(`patch: ${upd.__err.body}`);
        else ok(`patched existing embed ${msgId}`);
    } else {
        const post = await api('POST', `/channels/${levelsCh.id}/messages`, { embeds: [embed] });
        if (post?.__err) { err(`post: ${post.__err.body}`); }
        else { msgId = post.id; ok(`posted tier embed ${msgId}`); }
    }
    if (msgId) {
        const pin = await api('PUT', `/channels/${levelsCh.id}/pins/${msgId}`);
        if (pin?.__err && !pin.__err.body.includes('Cannot pin')) info(`pin: ${pin.__err.body.slice(0,100)}`);
        else ok('pinned');
    }
}
console.log('');

// ─── [6] Patch #stream-signup embed to mention #levels ───
console.log('[6] Patching #stream-signup embed to reference #levels for tracking…');
{
    const embed = {
        type: 'rich',
        title: '📡 Stream Signup',
        description: [
            `> Reach **Level 3** in the server, then drop your stream URL in this channel — the bot will auto-add you to the shoutout system and announce your streams in <#${WOLFIE_LIVE_CH}>.`,
            ``,
            `### 📊 Check your level`,
            `Use \`/rank\` anywhere (or head to <#${levelsCh.id}>) to see your current XP and how far you are from **Level 3**.`,
            ``,
            `### Supported platforms`,
            `**Twitch** · **Kick** · **YouTube** · **TikTok** · **Trovo** · **Facebook Gaming**`,
            ``,
            `### How it works`,
            `\`1.\` Hit **Level 3** from chatting / voice activity *(see <#${levelsCh.id}> for the full tier ladder)*`,
            `\`2.\` Paste your stream URL here (one per line if you have multiple)`,
            `\`3.\` Bot DMs you confirmation`,
            `\`4.\` When you go live, your stream is announced in <#${WOLFIE_LIVE_CH}>`,
            ``,
            `> *Pre-Level-3 posts will be cleaned up automatically.*`,
            ``,
            `### Want to opt-into the @Streamers role?`,
            `Pick it up from the button panel in <#${SELF_ROLES_CH}> — also gated to **Level 3**.`,
        ].join('\n'),
        color: 0x9146FF,
    };
    const recent = await api('GET', `/channels/${STREAM_SIGNUP_CH}/messages?limit=20`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === embed.title) : null;
    if (existing) {
        const upd = await api('PATCH', `/channels/${STREAM_SIGNUP_CH}/messages/${existing.id}`, { embeds: [embed] });
        if (upd?.__err) err(`patch: ${upd.__err.body}`);
        else ok(`patched stream-signup embed`);
    } else {
        info('stream-signup embed missing — skipping (run wildwolf-finalize.mjs first)');
    }
}
console.log('');

// ─── [7] Patch #self-roles embed to mention #levels ───
console.log('[7] Patching #self-roles embed to reference #levels…');
{
    const embed = {
        type: 'rich',
        title: '🐺 Self-Assign Roles',
        description: [
            `> Pick up notification & opt-in roles below. Click a button to **grant** — click the same button again to **remove**.`,
            ``,
            `### 🔔 Stream Pings`,
            `Get pinged in <#${WOLFIE_LIVE_CH}> every time Wolfie goes live.`,
            ``,
            `### 🎉 Event Pings`,
            `Get pinged for events, collabs, and special streams.`,
            ``,
            `### 📺 Streamers  *(Level 3 required)*`,
            `Opt into the **@Streamers** role. Lets you post stream links and gets you auto-announced in <#${WOLFIE_LIVE_CH}> when you go live.`,
            `> *Not at Level 3 yet? Check your progress with \`/rank\` or visit <#${levelsCh.id}>.*`,
        ].join('\n'),
        color: 0x7179CA,
    };
    const recent = await api('GET', `/channels/${SELF_ROLES_CH}/messages?limit=20`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === embed.title) : null;
    if (existing) {
        const buttons = existing.components || [];
        const upd = await api('PATCH', `/channels/${SELF_ROLES_CH}/messages/${existing.id}`, { embeds: [embed], components: buttons });
        if (upd?.__err) err(`patch: ${upd.__err.body}`);
        else ok(`patched self-roles embed (buttons preserved)`);
    } else {
        info('self-roles panel missing — skipping');
    }
}
console.log('');

// ─── [8] Backfill: grant tier roles to existing qualifying users ───
console.log('[8] Backfilling tier roles for existing members…');
{
    const [users] = await pool.execute(
        'SELECT user_id, level FROM user_levels WHERE guild_id=? AND level > 0',
        [GUILD_ID]
    );
    if (!users.length) {
        info('no users at level > 0 — nothing to backfill (members will gain roles as they level up)');
    } else {
        let granted = 0, alreadyHad = 0, failed = 0;
        for (const u of users) {
            const earnedTiers = TIERS.filter(t => u.level >= t.level);
            const memberRes = await api('GET', `/guilds/${GUILD_ID}/members/${u.user_id}`);
            if (memberRes?.__err) { failed++; continue; }
            for (const t of earnedTiers) {
                const rid = tierRoleIds[t.level];
                if (!rid) continue;
                if (memberRes.roles.includes(rid)) { alreadyHad++; continue; }
                const r = await api('PUT', `/guilds/${GUILD_ID}/members/${u.user_id}/roles/${rid}`);
                if (r?.__err) failed++; else granted++;
            }
        }
        ok(`backfill: granted=${granted} alreadyHad=${alreadyHad} failed=${failed} across ${users.length} XP-bearing user(s)`);
    }
}
console.log('');

console.log('═════════════════════════════════════════════════════════════');
console.log(' LEVELING SETUP COMPLETE');
console.log('═════════════════════════════════════════════════════════════');
console.log(`#levels channel:        ${levelsCh.id}`);
console.log(`Tier roles created:     ${TIERS.length}  (Pack Howler @ 3 → Pack Legend @ 100)`);
console.log(`level_up_channel_id:    #levels (was #general-chat)`);
console.log(`stream-signup embed:    references #levels for /rank tracking`);
console.log(`self-roles embed:       references #levels for Level-3 progress check`);
console.log('');

await pool.end();
