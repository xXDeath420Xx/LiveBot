// Comprehensive fix + reorganization for WildWolf guild 1414753158999179286.
//
// Addresses every issue from the post-setup audit:
//   1. #ticket-panel was STAFF-only — Pack Members couldn't see the button. → Verified-readable, no SEND.
//   2. #stream-signup was STREAMER (browse-only) — wrong for "post your URL here" flow. → Verified-postable.
//   3. Stream-signup needs an instructional pinned embed. → Posted + pinned.
//   4. Notifications/self-roles panel was planned but never built. → Create #self-roles + button panel.
//   5. Rules ✅ reaction → "I Agree" button (no reaction counter), better per-rule formatting.
//   6. Reorganize: 📜 START HERE category at top with rules/welcome/introduce-yourself/self-roles.
//   7. Reposition all categories: START HERE → PACK HANGOUT → WOLFIES DEN → TICKETS → VOICE → staff → LOGS.
//
// Idempotent: re-running converges without duplicating panels or messages.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';

// Resolved identifiers from prior setup runs
const VERIFIED_ROLE  = '1455255019627479071'; // PACK MEMBERS
const STAFF_ROLE     = '1455252916641202226'; // PACK MANAGERS
const STREAMERS_ROLE = '1508616655356428338';
const STREAM_PINGS   = '1508616659416518788';
const EVENT_PINGS    = '1508616661463208036';

const RULES_CH        = '1506860523474649239';
const RULES_MSG       = '1508617120332906526';
const WELCOME_CH      = '1414753159632388150';
const TICKET_PANEL_CH = '1508616682099441726';
const STREAM_SIGNUP_CH = '1508616684703842355';
const WOLFIE_LIVE_CH  = '1455251028399099934';
const INTRO_CH        = null; // resolved at runtime
const PACK_HANGOUT_CAT = null; // resolved at runtime

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
const CONNECT               = 1n << 20n;
const SPEAK                 = 1n << 21n;
const USE_VAD               = 1n << 25n;
const CREATE_PUBLIC_THREADS = 1n << 34n;
const SEND_THREAD_MESSAGES  = 1n << 38n;
const CREATE_PRIVATE_THREADS= 1n << 36n;

const STAFF_BITS = (1n<<1n)|(1n<<2n)|(1n<<3n)|(1n<<4n)|(1n<<5n)|(1n<<28n)|(1n<<13n)|(1n<<40n);
const STAFF_NAME_BLOCKLIST = /^(bots?|bot manager|new role)$/i;

const VIEW_PAIR = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const STAFF_TEXT_ALLOW = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | MANAGE_MESSAGES;

// Boot
const [botRows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
if (!botRows.length) { console.error(`Bot row missing (bot_id=${BOT_ID})`); process.exit(1); }
const TOKEN = encryption.decrypt(JSON.parse(botRows[0].bot_token));

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
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 400) } };
    return res.status === 204 ? null : res.json();
}

function ok(msg) { console.log(`    ✓ ${msg}`); }
function info(msg) { console.log(`    • ${msg}`); }
function warn(msg) { console.log(`    ⚠ ${msg}`); }
function err(msg) { console.log(`    ✗ ${msg}`); }

console.log('════════════════════════════════════════════════════════════');
console.log(' WildWolf — finalize/fix pass');
console.log('════════════════════════════════════════════════════════════\n');

// ─── Roles + channels inventory ───────────────────────────────────────
console.log('[0] Live inventory…');
const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);

const STAFF_IDS = roles
    .filter(r => r.id !== GUILD_ID && r.id !== VERIFIED_ROLE && !r.managed)
    .filter(r => !STAFF_NAME_BLOCKLIST.test(r.name))
    .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
    .sort((a,b) => b.position - a.position)
    .map(r => r.id);

const chByName = (name, type) => channels.find(c => c.name === name && (type === undefined || c.type === type));
const chByNameContains = (re, type) => channels.find(c => re.test(c.name) && (type === undefined || c.type === type));

const introCh        = chByName('introduce-yourself', 0) || chByNameContains(/introduc/i, 0);
const packHangoutCat = chByNameContains(/pack hangout/i, 4) || channels.find(c => c.type === 4 && c.id === channels.find(x => x.name === 'general-chat')?.parent_id);
const wolfiesDenCat  = chByNameContains(/wolfie.?s.den/i, 4) || channels.find(c => c.type === 4 && c.id === channels.find(x => x.name === 'wolfie-is-live')?.parent_id);
const businessCat    = chByNameContains(/down to business/i, 4);
const voiceCat       = chByNameContains(/^voice channels$/i, 4);
const logsCat        = chByNameContains(/^📋\s*logs$/i, 4) || chByName('📋 LOGS', 4);
const ticketsCat     = chByNameContains(/^🎫\s*tickets$/i, 4) || chByName('🎫 TICKETS', 4);

ok(`Verified=${VERIFIED_ROLE_BLURB(roles)}  Staff IDs=${STAFF_IDS.length}`);
ok(`#introduce-yourself=${introCh?.id}  PACK HANGOUT=${packHangoutCat?.id}  WOLFIES DEN=${wolfiesDenCat?.id}`);
ok(`LETS GET DOWN TO BUSINESS=${businessCat?.id}  VOICE CHANNELS=${voiceCat?.id}  LOGS=${logsCat?.id}  TICKETS=${ticketsCat?.id}`);
console.log('');

function VERIFIED_ROLE_BLURB(rs) {
    const v = rs.find(r => r.id === VERIFIED_ROLE);
    return v ? `${v.name}(${v.id})` : VERIFIED_ROLE;
}

// ─── [1] Create #self-roles channel (under PACK HANGOUT for now; moved later) ───
console.log('[1] Ensuring #self-roles channel exists…');
let selfRolesCh = chByName('self-roles', 0);
if (!selfRolesCh) {
    const verifiedAllow = VIEW_PAIR | ADD_REACTIONS;
    const verifiedDeny  = SEND_MESSAGES | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS | SEND_THREAD_MESSAGES;
    const overwrites = [
        { id: GUILD_ID,        type: 0, allow: '0',                       deny: String(VIEW_PAIR | CREATE_INSTANT_INVITE) },
        { id: VERIFIED_ROLE,   type: 0, allow: String(verifiedAllow),     deny: String(verifiedDeny) },
    ];
    for (const sid of STAFF_IDS) overwrites.push({ id: sid, type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' });
    selfRolesCh = await api('POST', `/guilds/${GUILD_ID}/channels`, {
        name: 'self-roles',
        type: 0,
        parent_id: packHangoutCat?.id,
        topic: 'Pick up your notification + opt-in roles below. Click a button to grant — click again to remove.',
        permission_overwrites: overwrites,
    });
    if (selfRolesCh?.__err) { err(`create #self-roles: ${selfRolesCh.__err.body}`); process.exit(1); }
    channels.push(selfRolesCh);
    ok(`created #self-roles (${selfRolesCh.id})`);
} else {
    info(`#self-roles exists (${selfRolesCh.id})`);
}
console.log('');

// ─── [2] Fix #ticket-panel perms (Verified-readable, no SEND) ───
console.log('[2] Fixing #ticket-panel permissions (Verified can see the button)…');
{
    const verifiedAllow = VIEW_PAIR | ADD_REACTIONS;
    const verifiedDeny  = SEND_MESSAGES | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS | SEND_THREAD_MESSAGES;
    const overwrites = [
        { id: GUILD_ID,      type: 0, allow: '0',                   deny: String(VIEW_PAIR | CREATE_INSTANT_INVITE) },
        { id: VERIFIED_ROLE, type: 0, allow: String(verifiedAllow), deny: String(verifiedDeny) },
    ];
    for (const sid of STAFF_IDS) overwrites.push({ id: sid, type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' });
    const r = await api('PATCH', `/channels/${TICKET_PANEL_CH}`, { permission_overwrites: overwrites });
    if (r?.__err) err(`patch ticket-panel: ${r.__err.body}`);
    else ok('#ticket-panel is now Verified-readable (no SEND — button-only)');
}

// ─── [3] Fix #stream-signup perms (Verified can post URLs) ───
console.log('[3] Fixing #stream-signup permissions (Verified can post URLs)…');
{
    const verifiedAllow = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | ADD_REACTIONS | USE_EXTERNAL_EMOJIS;
    const overwrites = [
        { id: GUILD_ID,      type: 0, allow: '0',                   deny: String(VIEW_PAIR | CREATE_INSTANT_INVITE) },
        { id: VERIFIED_ROLE, type: 0, allow: String(verifiedAllow), deny: '0' },
    ];
    for (const sid of STAFF_IDS) overwrites.push({ id: sid, type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' });
    const r = await api('PATCH', `/channels/${STREAM_SIGNUP_CH}`, { permission_overwrites: overwrites });
    if (r?.__err) err(`patch stream-signup: ${r.__err.body}`);
    else ok('#stream-signup is now Verified-postable');
}
console.log('');

// ─── [4] Post stream-signup instructional embed (pinned) ───
console.log('[4] Posting #stream-signup instructional embed…');
{
    const embed = {
        type: 'rich',
        title: '📡 Stream Signup',
        description: [
            `> Reach **Level 3** in the server, then drop your stream URL in this channel — the bot will auto-add you to the shoutout system and announce your streams in <#${WOLFIE_LIVE_CH}>.`,
            ``,
            `### Supported platforms`,
            `**Twitch** · **Kick** · **YouTube** · **TikTok** · **Trovo** · **Facebook Gaming**`,
            ``,
            `### How it works`,
            `\`1.\` Hit **Level 3** from chatting / voice activity`,
            `\`2.\` Paste your stream URL here (one per line if you have multiple)`,
            `\`3.\` Bot DMs you confirmation`,
            `\`4.\` When you go live, your stream is announced in <#${WOLFIE_LIVE_CH}>`,
            ``,
            `> *Pre-Level-3 posts will be cleaned up automatically.*`,
            ``,
            `### Want to opt-into the @Streamers role?`,
            `Pick it up from the button panel in <#${selfRolesCh.id}> — also gated to **Level 3**.`,
        ].join('\n'),
        color: 0x9146FF,
    };
    const recent = await api('GET', `/channels/${STREAM_SIGNUP_CH}/messages?limit=50`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === embed.title) : null;
    let msgId;
    if (existing) {
        const upd = await api('PATCH', `/channels/${STREAM_SIGNUP_CH}/messages/${existing.id}`, { embeds: [embed], components: [] });
        msgId = existing.id;
        if (upd?.__err) err(`patch stream-signup embed: ${upd.__err.body}`);
        else ok(`patched existing stream-signup embed ${msgId}`);
    } else {
        const post = await api('POST', `/channels/${STREAM_SIGNUP_CH}/messages`, { embeds: [embed] });
        if (post?.__err) { err(`post stream-signup embed: ${post.__err.body}`); }
        else { msgId = post.id; ok(`posted stream-signup embed ${msgId}`); }
    }
    if (msgId) {
        const pin = await api('PUT', `/channels/${STREAM_SIGNUP_CH}/pins/${msgId}`);
        if (pin?.__err && !pin.__err.body.includes('Cannot pin')) info(`pin returned: ${pin.__err.body.slice(0,100)}`);
        else ok('pinned');
        await pool.execute('UPDATE stream_signup_config SET stream_signup_message_id=? WHERE guild_id=?', [msgId, GUILD_ID]);
    }
}
console.log('');

// ─── [5] Post #self-roles Notifications panel (buttons) ───
console.log('[5] Posting #self-roles Notifications panel…');
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
            `> *If you're under Level 3, the bot will let you know and the role won't be granted.*`,
        ].join('\n'),
        color: 0x7179CA,
    };
    const buttons = {
        type: 1,
        components: [
            { type: 2, style: 1, label: 'Stream Pings', emoji: { name: '🔔' }, custom_id: `rr_${STREAM_PINGS}` },
            { type: 2, style: 1, label: 'Event Pings',  emoji: { name: '🎉' }, custom_id: `rr_${EVENT_PINGS}` },
            { type: 2, style: 1, label: 'Streamers',    emoji: { name: '📺' }, custom_id: `rr_${STREAMERS_ROLE}` },
        ],
    };
    const recent = await api('GET', `/channels/${selfRolesCh.id}/messages?limit=50`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === embed.title) : null;
    let panelMsgId;
    if (existing) {
        const upd = await api('PATCH', `/channels/${selfRolesCh.id}/messages/${existing.id}`, { embeds: [embed], components: [buttons] });
        panelMsgId = existing.id;
        if (upd?.__err) err(`patch panel: ${upd.__err.body}`);
        else ok(`patched existing self-roles panel ${panelMsgId}`);
    } else {
        const post = await api('POST', `/channels/${selfRolesCh.id}/messages`, { embeds: [embed], components: [buttons] });
        if (post?.__err) { err(`post panel: ${post.__err.body}`); }
        else { panelMsgId = post.id; ok(`posted self-roles panel ${panelMsgId}`); }
    }
    if (panelMsgId) {
        const [existingPanel] = await pool.execute(
            'SELECT id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND message_id=?',
            [GUILD_ID, selfRolesCh.id, panelMsgId]
        );
        let panelId;
        if (existingPanel.length) {
            panelId = existingPanel[0].id;
            await pool.execute(
                `UPDATE reaction_role_panels SET panel_name='Self-Assign Roles', description='Notification + opt-in roles', embed_color='#7179CA', panel_mode='standard', interaction_type='button', max_selections=3 WHERE id=?`,
                [panelId]
            );
            info(`reaction_role_panels updated id=${panelId}`);
        } else {
            const [ins] = await pool.execute(
                `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type, max_selections)
                 VALUES (?, ?, ?, 'Self-Assign Roles', 'Notification + opt-in roles', '#7179CA', 'standard', 'button', 3)`,
                [GUILD_ID, selfRolesCh.id, panelMsgId]
            );
            panelId = ins.insertId;
            ok(`reaction_role_panels inserted id=${panelId}`);
        }
        // Clean + reinsert mappings for idempotency
        await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id=?', [panelId]);
        await pool.execute(`INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level) VALUES (?, '🔔', 'Stream Pings', 'primary', ?, NULL)`, [panelId, STREAM_PINGS]);
        await pool.execute(`INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level) VALUES (?, '🎉', 'Event Pings', 'primary', ?, NULL)`, [panelId, EVENT_PINGS]);
        await pool.execute(`INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level) VALUES (?, '📺', 'Streamers', 'primary', ?, 3)`, [panelId, STREAMERS_ROLE]);
        ok('reaction_role_mappings × 3 (Stream Pings, Event Pings, Streamers[min_level=3])');
    }
}
console.log('');

// ─── [6] Rules message — convert to button + reformat ───
console.log('[6] Rewriting rules message — button style + better formatting…');
{
    const rulesEmbed = {
        type: 'rich',
        title: '🐺 WOLFIE PACK — Server Rules',
        description: [
            `> Good evening, my beautiful **Wolfie Pack**! Click the **I Agree** button below once you've read this so I know you've seen it.`,
            ``,
            `I will be returning to streaming shortly! I am aware that some things have changed recently within various streams and communities, so I am establishing some new rules. I will also be going over these on stream when I go live.`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `## 🚫  Rule 1 — Leave the drama at the door`,
            `In the nicest way possible, **it does not matter which community you come from** — everyone must be respectful. If you see someone in my stream that you do not get along with, **keep it between yourself and that person**.`,
            `> *This is my stream, and these are my rules. Please respect one another.*`,
            ``,
            `## ⚠️  Rule 2 — Zero tolerance for toxicity`,
            `If I catch anyone breaking my rules, **I will personally block you.** I will not tolerate nastiness or chat abuse.`,
            `This is a **relaxing, chill space** where people from various communities come together to hang out. When you visit my stream, you must follow my rules.`,
            `> **This also applies during collaborations.**`,
            ``,
            `## 🚷  Rule 3 — No exceptions`,
            `These rules apply to **absolutely everyone**:`,
            `> • New viewers`,
            `> • Long-time Pack members`,
            `> • **Mods**`,
            ``,
            `## 🛡️  Rule 4 — Mod accountability`,
            `If you are a Mod and you break these rules:`,
            `> • Your **mod privileges will be revoked immediately, without warning**`,
            `> • **Further action will be taken**`,
            `> • **There will be no second chances**`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `Please know that **I love you all**, no matter what community you are from. Once you step into my chat, it does not matter who else is there — **we stand together as a Pack, and no fighting is allowed.**`,
            ``,
            `If you do not agree with these rules, you are well within your right to leave, but **these are the boundaries I am setting for all future streams.** 🐺`,
            ``,
            `### ⬇️  Click **I Agree** below to unlock the rest of the server`,
        ].join('\n'),
        color: 0x7179CA,
    };
    const rulesButton = {
        type: 1,
        components: [{
            type: 2, style: 3, label: 'I Agree',
            emoji: { name: '✅' },
            custom_id: `rr_${VERIFIED_ROLE}`,
        }],
    };

    const patch = await api('PATCH', `/channels/${RULES_CH}/messages/${RULES_MSG}`, {
        content: '',
        embeds: [rulesEmbed],
        components: [rulesButton],
    });
    if (patch?.__err) err(`patch rules: ${patch.__err.body}`);
    else ok('rules embed re-formatted + button attached');

    // Remove ALL ✅ reactions (gets rid of the counter UI under the message)
    const clearReact = await api('DELETE', `/channels/${RULES_CH}/messages/${RULES_MSG}/reactions/%E2%9C%85`);
    if (clearReact?.__err) info(`clear reactions: ${clearReact.__err.body.slice(0,150)}`);
    else ok('cleared ✅ reactions (no counter)');

    // Switch reaction_role_panels to button mode + wire redirect to #self-roles
    await pool.execute(
        `UPDATE reaction_role_panels
         SET interaction_type='button', post_assign_redirect_channel_id=?
         WHERE guild_id=? AND channel_id=? AND message_id=?`,
        [selfRolesCh.id, GUILD_ID, RULES_CH, RULES_MSG]
    );
    ok(`reaction_role_panels switched to interaction_type='button' + redirect → #self-roles`);
}
console.log('');

// ─── [7] Reorganize: create 📜 START HERE + move channels + reposition categories ───
console.log('[7] Reorganizing channels into 📜 START HERE category…');

// Re-fetch the channel list (we may have new things since [1])
const channels2 = await api('GET', `/guilds/${GUILD_ID}/channels`);
let startHereCat = channels2.find(c => c.type === 4 && /start.here|📜/.test(c.name));
if (!startHereCat) {
    // Inherit Verified-class overwrites on the category itself
    const verifiedAllow = VIEW_PAIR;
    const everyoneDeny  = VIEW_PAIR | CREATE_INSTANT_INVITE;
    const overwrites = [
        { id: GUILD_ID,      type: 0, allow: '0',                   deny: String(everyoneDeny) },
        { id: VERIFIED_ROLE, type: 0, allow: String(verifiedAllow), deny: '0' },
    ];
    for (const sid of STAFF_IDS) overwrites.push({ id: sid, type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' });
    startHereCat = await api('POST', `/guilds/${GUILD_ID}/channels`, {
        name: '📜 START HERE',
        type: 4,
        permission_overwrites: overwrites,
    });
    if (startHereCat?.__err) { err(`create START HERE: ${startHereCat.__err.body}`); process.exit(1); }
    ok(`created 📜 START HERE (${startHereCat.id})`);
} else {
    info(`📜 START HERE exists (${startHereCat.id})`);
}

// Move target channels into START HERE
const moves = [
    { ch: chByName('rules', 0),            pos: 0 },
    { ch: chByName('welcome', 0),          pos: 1 },
    { ch: introCh,                          pos: 2 },
    { ch: chByName('self-roles', 0) || selfRolesCh, pos: 3 },
].filter(m => m.ch?.id);

console.log(`    moving ${moves.length} channel(s) into START HERE…`);
const bulkChild = moves.map(m => ({
    id: m.ch.id,
    position: m.pos,
    parent_id: startHereCat.id,
    lock_permissions: false,  // keep our per-channel overwrites intact
}));
if (bulkChild.length) {
    const r = await api('PATCH', `/guilds/${GUILD_ID}/channels`, bulkChild);
    if (r?.__err) err(`move children: ${r.__err.body}`);
    else ok(`moved ${bulkChild.length} channel(s) into START HERE`);
}

// Reposition top-level categories: START HERE → PACK HANGOUT → WOLFIES DEN → TICKETS → VOICE → staff → LOGS
const catOrder = [
    startHereCat,
    packHangoutCat,
    wolfiesDenCat,
    ticketsCat,
    voiceCat,
    businessCat,
    logsCat,
].filter(Boolean);

const bulkCats = catOrder.map((c, idx) => ({ id: c.id, position: idx }));
if (bulkCats.length) {
    const r = await api('PATCH', `/guilds/${GUILD_ID}/channels`, bulkCats);
    if (r?.__err) err(`reposition cats: ${r.__err.body}`);
    else ok(`repositioned ${bulkCats.length} categories: ${catOrder.map(c=>c.name).join(' → ')}`);
}
console.log('');

// ─── [8] Verify & summary ────────────────────────────────────────────
console.log('[8] Verifying…');
const verifyChannels = await api('GET', `/guilds/${GUILD_ID}/channels`);

const ticketPanel = verifyChannels.find(c => c.id === TICKET_PANEL_CH);
const verOw = ticketPanel.permission_overwrites?.find(o => o.id === VERIFIED_ROLE);
const verAllowsView = verOw && (BigInt(verOw.allow) & VIEW_CHANNEL) === VIEW_CHANNEL;
const verDeniesSend = verOw && (BigInt(verOw.deny) & SEND_MESSAGES) === SEND_MESSAGES;
console.log(`    #ticket-panel: Verified VIEW=${verAllowsView ? '✓' : '❌'}  Verified SEND deny=${verDeniesSend ? '✓' : '❌'}`);

const streamSignup = verifyChannels.find(c => c.id === STREAM_SIGNUP_CH);
const ssOw = streamSignup.permission_overwrites?.find(o => o.id === VERIFIED_ROLE);
const ssAllowsView = ssOw && (BigInt(ssOw.allow) & VIEW_CHANNEL) === VIEW_CHANNEL;
const ssAllowsSend = ssOw && (BigInt(ssOw.allow) & SEND_MESSAGES) === SEND_MESSAGES;
console.log(`    #stream-signup: Verified VIEW=${ssAllowsView ? '✓' : '❌'}  Verified SEND=${ssAllowsSend ? '✓' : '❌'}`);

const startHereAfter = verifyChannels.find(c => c.id === startHereCat.id);
const sortedCats = verifyChannels.filter(c => c.type === 4).sort((a,b)=>a.position-b.position);
console.log(`    category order: ${sortedCats.map(c => c.name).join(' → ')}`);

const startHereChildren = verifyChannels.filter(c => c.parent_id === startHereCat.id).sort((a,b)=>a.position-b.position);
console.log(`    📜 START HERE children: ${startHereChildren.map(c => '#'+c.name).join(', ')}`);

// DB checks
const [rrPanels] = await pool.execute(
    `SELECT id, panel_name, interaction_type, post_assign_redirect_channel_id FROM reaction_role_panels WHERE guild_id=?`,
    [GUILD_ID]
);
console.log(`    reaction_role_panels: ${rrPanels.length} row(s)`);
for (const p of rrPanels) console.log(`      • id=${p.id} "${p.panel_name}" type=${p.interaction_type} redirect=${p.post_assign_redirect_channel_id || '—'}`);

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log(' FINALIZE COMPLETE');
console.log('════════════════════════════════════════════════════════════');

await pool.end();
