// Baseline setup for guild 1414753158999179286 (WildWolf / "Wolfie Pack")
// served by custom bot 1507873568095076425 (French Maid Wolfie).
//
// Mirrors the Lair/Wolves-of-Shadows baseline: hard verify gate with backfill,
// Lair-tiered streaming (level 3 + opt-in @Streamers, self_promo curated/disabled),
// full automod/anti-nuke stack, leveling, tickets, structured logging,
// Citizen-default + staff-exception channel permission hardening.
//
// REST-only via the custom bot's decrypted token. Safe to run while PM2 is live.
// Idempotent — re-run to converge.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';

// ── Existing identifiers (pre-discovered via Discord REST inventory) ───
const VERIFIED_ROLE_NAME = 'PACK MEMBERS';     // becomes @Verified
const STAFF_ROLE_NAME    = 'PACK MANAGERS';    // becomes ticket support role
const RULES_CH           = '1506860523474649239';
const RULES_MSG          = '1506860660980449320';
const WELCOME_CH         = '1414753159632388150';
const GENERAL_CHAT_CH    = null; // resolved at runtime — for level-up messages
const WOLFIE_IS_LIVE_CH  = null; // resolved at runtime — stream announcements
const SELF_PROMO_CH      = null; // resolved at runtime — curated, config disabled
const PLAN_FOR_WEEK_CH   = null; // resolved at runtime — auto-publish

// Public channels: only #rules + #welcome stay visible to @everyone.
const PUBLIC_CHANNELS = new Set([RULES_CH, WELCOME_CH]);

// Categories created if missing
const LOGS_CATEGORY_NAME    = '📋 LOGS';
const TICKETS_CATEGORY_NAME = '🎫 TICKETS';

// ── Permission bits ──────────────────────────────────────────────────
const CREATE_INSTANT_INVITE = 1n << 0n;
const KICK_MEMBERS          = 1n << 1n;
const BAN_MEMBERS           = 1n << 2n;
const ADMINISTRATOR         = 1n << 3n;
const MANAGE_CHANNELS       = 1n << 4n;
const MANAGE_GUILD          = 1n << 5n;
const ADD_REACTIONS         = 1n << 6n;
const VIEW_CHANNEL          = 1n << 10n;
const SEND_MESSAGES         = 1n << 11n;
const MANAGE_MESSAGES       = 1n << 13n;
const EMBED_LINKS           = 1n << 14n;
const ATTACH_FILES          = 1n << 15n;
const READ_MESSAGE_HISTORY  = 1n << 16n;
const MENTION_EVERYONE      = 1n << 17n;
const USE_EXTERNAL_EMOJIS   = 1n << 18n;
const CONNECT               = 1n << 20n;
const SPEAK                 = 1n << 21n;
const USE_VAD               = 1n << 25n;
const MANAGE_ROLES          = 1n << 28n;
const MODERATE_MEMBERS      = 1n << 40n;
const CREATE_GUILD_EXPRESSIONS = 1n << 43n;
const CREATE_EVENTS         = 1n << 44n;

const EVERYONE_STRIP_MASK =
    VIEW_CHANNEL | READ_MESSAGE_HISTORY | CREATE_INSTANT_INVITE
    | MENTION_EVERYONE | CREATE_GUILD_EXPRESSIONS | CREATE_EVENTS;

const STAFF_BITS = ADMINISTRATOR | KICK_MEMBERS | BAN_MEMBERS
    | MANAGE_CHANNELS | MANAGE_GUILD | MANAGE_ROLES | MANAGE_MESSAGES | MODERATE_MEMBERS;

const VIEW_PAIR         = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const VOICE_VIEW        = VIEW_PAIR | CONNECT | SPEAK | USE_VAD;
const STAFF_TEXT_ALLOW  = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES
                        | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | MANAGE_MESSAGES;
const STAFF_VOICE_ALLOW = STAFF_TEXT_ALLOW | CONNECT | SPEAK | USE_VAD;

// Roles auto-discovered as staff via permission bits but that should NOT be
// treated as staff for channel access (e.g., "Bot Manager" is a bot-admin
// utility role; "new role" is the unknown ADMINISTRATOR role above the bot —
// owner needs to audit it).
const STAFF_NAME_BLOCKLIST = /^(bots?|bot manager|new role)$/i;

// Channel-name regex — anything matching counts as staff-only regardless of
// permission overwrites. NFKD-normalized.
const STAFF_NAME_RE = /(founders?|^lead[-_]?|admin|moderator|^mod[-_]|^mod$|staff|tickets?|^logs?$|mod-log|mod-chat|mod call|audit|^owner|report|backstage|automod|server[- ]?log|message[- ]?log|member[- ]?log|voice[- ]?log|channel[- ]?log|role[- ]?log|^logs|bot-setup|setup and chill|down to business|lets get down)/i;

const CHANNEL_CLASS_OVERRIDE = {
    // VOICE CHANNELS that are member-private (existing config preserved)
    // Resolved at runtime by name match.
};

function staffName(name) {
    if (!name) return false;
    const norm = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return STAFF_NAME_RE.test(norm);
}

// ─────────── Boot: decrypt bot token ──────────────────────────────────
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

function ok(label, val) { console.log(`    ✓ ${label}: ${val}`); }
function info(label, val) { console.log(`    • ${label}: ${val}`); }
function warn(msg) { console.log(`    ⚠ ${msg}`); }
function err(msg) { console.log(`    ✗ ${msg}`); }

console.log('═════════════════════════════════════════════════════════════════');
console.log(' WildWolf / Wolfie Pack — baseline setup');
console.log(` Guild: ${GUILD_ID}  Bot: ${BOT_ID}`);
console.log('═════════════════════════════════════════════════════════════════\n');

// ─────────── [1] Roles ────────────────────────────────────────────────
console.log('[1] Fetching roles…');
const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
if (roles?.__err) { console.error('roles fetch failed:', roles.__err); process.exit(1); }

function findRoleByName(name, exact = true) {
    if (exact) return roles.find(r => r.name === name);
    const re = new RegExp(name, 'i');
    return roles.find(r => re.test(r.name));
}

const verifiedRole = findRoleByName(VERIFIED_ROLE_NAME);
const staffRole    = findRoleByName(STAFF_ROLE_NAME);
if (!verifiedRole) { console.error(`✗ "${VERIFIED_ROLE_NAME}" role not found`); process.exit(1); }
if (!staffRole)    { console.error(`✗ "${STAFF_ROLE_NAME}" role not found`); process.exit(1); }
ok('@Verified target', `${verifiedRole.name} (${verifiedRole.id})`);
ok('Staff (ticket support)', `${staffRole.name} (${staffRole.id})`);

// Auto-discover other staff-bit roles for channel exceptions
const staffRoles = roles
    .filter(r => r.id !== GUILD_ID && r.id !== verifiedRole.id && !r.managed)
    .filter(r => !STAFF_NAME_BLOCKLIST.test(r.name))
    .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
    .sort((a, b) => b.position - a.position);
console.log(`    discovered ${staffRoles.length} staff-tier role(s):`);
for (const r of staffRoles) console.log(`        • ${r.name} (${r.id})`);
const STAFF_IDS = staffRoles.map(r => r.id);

// Find or create supporting roles
async function ensureRole(name, opts = {}) {
    let role = findRoleByName(name);
    if (role) { info(`role exists`, `${name} (${role.id})`); return role; }
    const body = {
        name,
        color: opts.color ?? 0,
        permissions: opts.permissions ?? '0',
        mentionable: opts.mentionable ?? false,
        hoist: opts.hoist ?? false,
    };
    const created = await api('POST', `/guilds/${GUILD_ID}/roles`, body);
    if (created?.__err) { err(`create role ${name}: ${created.__err.status} ${created.__err.body}`); return null; }
    roles.push(created);
    ok(`created role`, `${name} (${created.id})`);
    return created;
}

const streamersRole   = await ensureRole('Streamers',     { color: 0x9146FF, mentionable: true });
const mutedRole       = await ensureRole('Muted',         { color: 0x607d8b });
const streamPingsRole = await ensureRole('Stream Pings',  { color: 0xeb459e, mentionable: true });
const eventPingsRole  = await ensureRole('Event Pings',   { color: 0xfee75c, mentionable: true });

console.log('');

// ─────────── [2] Harden guild-level role permissions ───────────────────
console.log('[2] Hardening guild-level role permissions…');
const everyoneRole = roles.find(r => r.id === GUILD_ID);
const currentEv = BigInt(everyoneRole.permissions);
const targetEv = currentEv & ~EVERYONE_STRIP_MASK;
if (currentEv !== targetEv) {
    const r = await api('PATCH', `/guilds/${GUILD_ID}/roles/${GUILD_ID}`, { permissions: String(targetEv) });
    if (r?.__err) err(`@everyone strip: ${r.__err.status} ${r.__err.body.slice(0,180)}`);
    else          ok('@everyone perms stripped (VIEW/INVITE/READ_HIST/MENTION_EVERYONE/CREATE_GUILD_EXPRESSIONS/CREATE_EVENTS)', `${currentEv} → ${targetEv}`);
} else {
    ok('@everyone already at minimum', String(currentEv));
}

const currentVer = BigInt(verifiedRole.permissions);
const targetVer = currentVer & ~CREATE_INSTANT_INVITE;
if (currentVer !== targetVer) {
    const r = await api('PATCH', `/guilds/${GUILD_ID}/roles/${verifiedRole.id}`, { permissions: String(targetVer) });
    if (r?.__err) err(`@Verified strip: ${r.__err.status} ${r.__err.body.slice(0,180)}`);
    else          ok('@Verified CREATE_INSTANT_INVITE stripped', `${currentVer} → ${targetVer}`);
} else {
    ok('@Verified already lacks CREATE_INSTANT_INVITE', String(currentVer));
}
console.log('');

// ─────────── [3] Fetch channels + scaffold missing ─────────────────────
console.log('[3] Fetching channels…');
let channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
if (channels?.__err) { console.error('channels fetch failed:', channels.__err); process.exit(1); }
channels.sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || a.position - b.position);

function chByName(name, type, parentId) {
    return channels.find(c => c.name === name && (type === undefined || c.type === type) && (parentId === undefined || c.parent_id === parentId));
}
function chByNameContains(needle, type) {
    const re = new RegExp(needle, 'i');
    return channels.find(c => re.test(c.name) && (type === undefined || c.type === type));
}

async function ensureCategory(name) {
    let cat = channels.find(c => c.type === 4 && c.name === name);
    if (cat) { info(`category exists`, `${name} (${cat.id})`); return cat; }
    cat = await api('POST', `/guilds/${GUILD_ID}/channels`, { name, type: 4 });
    if (cat?.__err) { err(`create category ${name}: ${cat.__err.body}`); return null; }
    channels.push(cat);
    ok(`created category`, `${name} (${cat.id})`);
    return cat;
}
async function ensureChannel(name, type, parentId, opts = {}) {
    let ch = channels.find(c => c.name === name && c.type === type);
    if (ch) { info(`channel exists`, `#${name} (${ch.id})`); return ch; }
    const body = { name, type, parent_id: parentId, ...opts };
    ch = await api('POST', `/guilds/${GUILD_ID}/channels`, body);
    if (ch?.__err) { err(`create channel ${name}: ${ch.__err.body}`); return null; }
    channels.push(ch);
    ok(`created channel`, `#${name} (${ch.id})`);
    return ch;
}

// Resolve existing channels by name
const generalCh    = chByName('general-chat',   0) || chByNameContains('general', 0);
const wolfieLiveCh = chByName('wolfie-is-live', 5) || chByNameContains('is-live', 5) || chByNameContains('live', 5);
const planWeekCh   = chByNameContains('plan-for-the-week', 5) || chByNameContains('plan-for', 5);
const selfPromoCh  = chByName('self-promo', 0) || chByNameContains('self-promo', 0);
const introCh      = chByName('introduce-yourself', 0) || chByNameContains('introduc', 0);
const modChatCh    = chByName('mod-chat', 0);
const businessCat  = chByNameContains('business', 4) || chByNameContains('down to', 4);

info('#general-chat',   generalCh?.id    || 'NOT FOUND');
info('#wolfie-is-live', wolfieLiveCh?.id || 'NOT FOUND');
info('#self-promo',     selfPromoCh?.id  || 'NOT FOUND');
info('#mod-chat',       modChatCh?.id    || 'NOT FOUND');
info('staff category',  businessCat?.id  || 'NOT FOUND');

// Create LOGS category + 7 log channels
console.log('\n[3a] LOGS category + log channels…');
const logsCat = await ensureCategory(LOGS_CATEGORY_NAME);
const memberLogCh   = await ensureChannel('member-log',   0, logsCat?.id);
const messageLogCh  = await ensureChannel('message-log',  0, logsCat?.id);
const modLogCh      = await ensureChannel('mod-log',      0, logsCat?.id);
const voiceLogCh    = await ensureChannel('voice-log',    0, logsCat?.id);
const channelLogCh  = await ensureChannel('channel-log',  0, logsCat?.id);
const roleLogCh     = await ensureChannel('role-log',     0, logsCat?.id);
const automodLogCh  = await ensureChannel('automod-log',  0, logsCat?.id);

// Create TICKETS category + ticket panel + transcript log
console.log('\n[3b] TICKETS category + panel/log channels…');
const ticketsCat   = await ensureCategory(TICKETS_CATEGORY_NAME);
const ticketPanelCh = await ensureChannel('ticket-panel', 0, ticketsCat?.id, {
    topic: 'Click the button below to open a private support ticket with the Pack Managers.',
});
const ticketLogCh  = await ensureChannel('ticket-log', 0, ticketsCat?.id, {
    topic: 'Closed-ticket transcripts archived here.',
});

// Create #stream-signup under WOLFIES DEN (or wherever the live channel lives)
console.log('\n[3c] #stream-signup (Lair-tiered)…');
const streamSignupParent = wolfieLiveCh?.parent_id || null;
const streamSignupCh = await ensureChannel('stream-signup', 0, streamSignupParent, {
    topic: 'Reach **Level 3**, then paste your stream URL here — auto-signs you up for shoutouts in #wolfie-is-live.',
});

console.log('');

// ─────────── [4] Channel permission hardening ──────────────────────────
console.log('[4] Applying channel permission overwrites (Citizen-default + staff-exception)…\n');

const CLASS = { PUBLIC: 'public', VERIFIED: 'verified', STAFF: 'staff', PRIVATE: 'private', STREAMER: 'streamer' };
const VERIFIED_ROLE = verifiedRole.id;
const STREAMERS_ROLE = streamersRole?.id;

// Auto-detect existing PRIVATE voice channels (preserve member-only CONNECT denies)
const privateNamePat = /^(private|1.to.1|^1.1$|invite.only)/i;
for (const c of channels) {
    if ((c.type === 2 || c.type === 13) && privateNamePat.test(c.name)) {
        CHANNEL_CLASS_OVERRIDE[c.id] = CLASS.PRIVATE;
    }
}

// Streamer-class candidates: the stream signup + any pre-existing curated stream-link channels
const streamerNamePat = /^(stream-signup|twitch|youtube|kick|tiktok|trovo|facebook|instagram|twitter)$/i;
for (const c of channels) {
    if (c.type === 0 && streamerNamePat.test(c.name)) {
        CHANNEL_CLASS_OVERRIDE[c.id] = CLASS.STREAMER;
    }
}

function classify(ch, parentCategoryMap) {
    if (PUBLIC_CHANNELS.has(ch.id)) return CLASS.PUBLIC;
    if (CHANNEL_CLASS_OVERRIDE[ch.id]) return CHANNEL_CLASS_OVERRIDE[ch.id];
    if (staffName(ch.name || '')) return CLASS.STAFF;
    if (ch.parent_id && parentCategoryMap?.get(ch.parent_id) === CLASS.STAFF) return CLASS.STAFF;
    if (ch.parent_id && parentCategoryMap?.get(ch.parent_id) === CLASS.STREAMER) return CLASS.STREAMER;
    return CLASS.VERIFIED;
}

function getOrCreate(ow, id, type) {
    let entry = ow.find(o => o.id === id);
    if (!entry) { entry = { id, type, allow: '0', deny: '0' }; ow.push(entry); }
    return entry;
}
function setBits(entry, addAllow = 0n, removeAllow = 0n, addDeny = 0n, removeDeny = 0n) {
    const a = (BigInt(entry.allow || '0') | addAllow) & ~removeAllow;
    const d = (BigInt(entry.deny  || '0') | addDeny)  & ~removeDeny;
    entry.allow = String(a);
    entry.deny  = String(d);
}
function dropIfEmpty(ow, id) {
    const idx = ow.findIndex(o => o.id === id);
    if (idx >= 0 && ow[idx].allow === '0' && ow[idx].deny === '0') ow.splice(idx, 1);
}

function applyPublic(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n, 0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n));
    const v = ow.find(o => o.id === VERIFIED_ROLE);
    if (v) { setBits(v, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n); dropIfEmpty(ow, VERIFIED_ROLE); }
    for (const sid of STAFF_IDS) {
        const s = ow.find(o => o.id === sid);
        if (s) { setBits(s, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n); dropIfEmpty(ow, sid); }
    }
}

function applyVerified(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev, 0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n);
    const v = getOrCreate(ow, VERIFIED_ROLE, 0);
    const wantedAllow = isVoice ? VOICE_VIEW : VIEW_PAIR;
    setBits(v, wantedAllow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
    for (const sid of STAFF_IDS) {
        const s = ow.find(o => o.id === sid);
        if (s) { setBits(s, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n); dropIfEmpty(ow, sid); }
    }
}

function applyStaff(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev, 0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n);
    const v = getOrCreate(ow, VERIFIED_ROLE, 0);
    setBits(v, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n),
        VIEW_PAIR | (isVoice ? CONNECT : 0n), 0n);
    for (const sid of STAFF_IDS) {
        const s = getOrCreate(ow, sid, 0);
        const wantedAllow = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
        setBits(s, wantedAllow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
    }
}

function applyStreamer(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev, 0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n);
    // Verified: browse-only — VIEW allow, SEND deny
    const v = getOrCreate(ow, VERIFIED_ROLE, 0);
    const postDeny = SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | ADD_REACTIONS;
    setBits(v,
        isVoice ? VOICE_VIEW : VIEW_PAIR,
        isVoice ? 0n : postDeny,
        isVoice ? 0n : postDeny,
        VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
    // Streamers: full post
    if (STREAMERS_ROLE) {
        const s = getOrCreate(ow, STREAMERS_ROLE, 0);
        const wantedAllow = isVoice
            ? VIEW_PAIR | CONNECT | SPEAK | USE_VAD | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS
            : VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS;
        setBits(s, wantedAllow, 0n, 0n, 0n);
    }
    for (const sid of STAFF_IDS) {
        const sf = getOrCreate(ow, sid, 0);
        const allow = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
        setBits(sf, allow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
    }
}

function applyPrivate(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev, 0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n);
    const vIdx = ow.findIndex(o => o.id === VERIFIED_ROLE);
    if (vIdx >= 0) ow.splice(vIdx, 1);
    const staffMask = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
    for (const sid of STAFF_IDS) {
        const idx = ow.findIndex(o => o.id === sid);
        if (idx >= 0) {
            const s = ow[idx];
            if (BigInt(s.allow || '0') === staffMask && BigInt(s.deny || '0') === 0n) ow.splice(idx, 1);
        }
    }
}

const stats = { patched: 0, unchanged: 0, errored: 0, onboardingFallback: 0, byClass: { public: 0, verified: 0, staff: 0, private: 0, streamer: 0 } };

// Refresh channels list (we added LOGS/TICKETS/stream-signup above)
channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
channels.sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || a.position - b.position);

const parentCategoryMap = new Map();
for (const c of channels) {
    if (c.type === 4) parentCategoryMap.set(c.id, classify(c, parentCategoryMap));
}

// Re-apply LOGS + TICKETS as STAFF after refresh (their child channels inherit via parentCategoryMap)
if (logsCat) CHANNEL_CLASS_OVERRIDE[logsCat.id] = CLASS.STAFF;
if (ticketsCat) CHANNEL_CLASS_OVERRIDE[ticketsCat.id] = CLASS.STAFF;
if (streamSignupCh) CHANNEL_CLASS_OVERRIDE[streamSignupCh.id] = CLASS.STREAMER;
// Rebuild parent map with the overrides applied
parentCategoryMap.clear();
for (const c of channels) {
    if (c.type === 4) parentCategoryMap.set(c.id, classify(c, parentCategoryMap));
}

for (const ch of channels) {
    const klass = classify(ch, parentCategoryMap);
    stats.byClass[klass]++;
    const isCategory = ch.type === 4;
    const isVoice    = ch.type === 2 || ch.type === 13;

    const overwrites = (ch.permission_overwrites || []).map(o => ({
        id: o.id, type: o.type, allow: o.allow, deny: o.deny,
    }));
    const before = JSON.stringify(overwrites);

    if (klass === CLASS.PUBLIC)   applyPublic(overwrites, isVoice);
    if (klass === CLASS.VERIFIED) applyVerified(overwrites, isVoice);
    if (klass === CLASS.STAFF)    applyStaff(overwrites, isVoice);
    if (klass === CLASS.PRIVATE)  applyPrivate(overwrites, isVoice);
    if (klass === CLASS.STREAMER) applyStreamer(overwrites, isVoice);

    dropIfEmpty(overwrites, GUILD_ID);

    const after = JSON.stringify(overwrites);
    if (after === before) { stats.unchanged++; console.log(`    = [${klass}] ${isCategory ? 'CAT' : '#' + ch.name}`); continue; }

    let res = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });
    if (res?.__err && res.__err.body.includes('350003') && klass === CLASS.VERIFIED) {
        // Onboarding-flagged channel — fall back without @everyone deny
        const ev = overwrites.find(o => o.id === GUILD_ID);
        if (ev) { setBits(ev, 0n, 0n, 0n, VIEW_PAIR | (isVoice ? CONNECT : 0n)); dropIfEmpty(overwrites, GUILD_ID); }
        res = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });
        if (!res?.__err) { stats.patched++; stats.onboardingFallback++; console.log(`    ⚠ [${klass}] #${ch.name} — onboarding fallback`); continue; }
    }
    if (res?.__err) { stats.errored++; console.log(`    ✗ [${klass}] ${isCategory ? 'CAT' : '#' + ch.name}: ${res.__err.status} ${res.__err.body.slice(0,180)}`); }
    else            { stats.patched++; console.log(`    ✓ [${klass}] ${isCategory ? 'CAT' : '#' + ch.name}`); }
}

console.log('\n=== Class breakdown ===');
for (const k of Object.keys(stats.byClass)) console.log(`  ${k.padEnd(10)} ${stats.byClass[k]}`);
console.log(`  patched=${stats.patched}  unchanged=${stats.unchanged}  errored=${stats.errored}  onboarding-fallback=${stats.onboardingFallback}`);
console.log('');

// ─────────── [5] Backfill @Verified on all current humans ──────────────
console.log('[5] Backfilling @Verified on all current humans…');
let afterId = '0';
const humans = [];
while (true) {
    const batch = await api('GET', `/guilds/${GUILD_ID}/members?limit=1000&after=${afterId}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const m of batch) if (!m.user.bot) humans.push(m);
    if (batch.length < 1000) break;
    afterId = batch[batch.length - 1].user.id;
}
let granted = 0, alreadyHad = 0, failed = 0;
for (const m of humans) {
    if (m.roles.includes(VERIFIED_ROLE)) { alreadyHad++; continue; }
    const r = await api('PUT', `/guilds/${GUILD_ID}/members/${m.user.id}/roles/${VERIFIED_ROLE}`);
    if (r?.__err) { failed++; err(`backfill ${m.user.username}: ${r.__err.status}`); }
    else granted++;
}
ok('backfill', `granted=${granted} alreadyHad=${alreadyHad} failed=${failed} (of ${humans.length} humans)`);
console.log('');

// ─────────── [6] Rules message: edit in place + add reaction ───────────
console.log('[6] Updating rules message + ✅ reaction…');
const RULES_EMBED = {
    type: 'rich',
    title: '🐺 Wolfie Pack Rules',
    description: [
        `Good evening, my beautiful Wolfie Pack! Please react with an emote once you have read this so I know you've seen it.`,
        ``,
        `I will be returning to streaming shortly! I am aware that some things have changed recently within various streams and communities, so I am establishing some new rules. I will also be going over these on stream when I go live:`,
        ``,
        `**Leave the drama at the door.** In the nicest way possible, it does not matter which community you come from—everyone must be respectful. If you see someone in my stream that you do not get along with, keep it between yourself and that person. This is my stream, and these are my rules. Please respect one another.`,
        ``,
        `**Zero tolerance for toxicity.** If I catch anyone breaking my rules, I will personally block you. I will not tolerate nastiness or chat abuse. This is a relaxing, chill space where people from various communities come together to hang out. When you visit my stream, you must follow my rules. This also applies during collaborations.`,
        ``,
        `**No exceptions.** These rules apply to absolutely everyone. This includes new viewers, long-time Pack members, and Mods.`,
        ``,
        `**Mod accountability.** If you are a Mod and you break these rules, your mod privileges will be revoked immediately without warning, and further action will be taken. There will be no second chances.`,
        ``,
        `Please know that I love you all, no matter what community you are from. Once you step into my chat, it does not matter who else is there; we stand together as a pack, and no fighting is allowed. If you do not agree with these rules, you are well within your right to leave, but these are the boundaries I am setting for all future streams.`,
        ``,
        `── React with ✅ below to confirm you've read these rules and unlock the rest of the server. ──`,
    ].join('\n'),
    color: 0x7179CA,
};

const patchRes = await api('PATCH', `/channels/${RULES_CH}/messages/${RULES_MSG}`, {
    content: '',
    embeds: [RULES_EMBED],
    components: [],
});
if (patchRes?.__err) err(`patch rules message: ${patchRes.__err.status} ${patchRes.__err.body}`);
else ok('rules message patched', RULES_MSG);

// Add ✅ reaction (idempotent — Discord ignores duplicate self-reactions)
const reactRes = await api('PUT', `/channels/${RULES_CH}/messages/${RULES_MSG}/reactions/%E2%9C%85/@me`);
if (reactRes?.__err) err(`add reaction: ${reactRes.__err.status} ${reactRes.__err.body}`);
else ok('✅ reaction added', RULES_MSG);

// reaction_role_panels + reaction_role_mappings (interaction_type='reaction')
const [existingPanel] = await pool.execute(
    'SELECT id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND message_id=?',
    [GUILD_ID, RULES_CH, RULES_MSG]
);
let rulesPanelId;
if (existingPanel.length) {
    rulesPanelId = existingPanel[0].id;
    await pool.execute(
        `UPDATE reaction_role_panels SET panel_name=?, description=?, embed_color=?, panel_mode='standard', interaction_type='reaction' WHERE id=?`,
        ['Wolfie Pack Rules Verify', 'React ✅ to accept the rules and become a Pack Member', '#7179CA', rulesPanelId]
    );
    info('reaction_role_panels updated', `id=${rulesPanelId}`);
} else {
    const [ins] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
         VALUES (?, ?, ?, 'Wolfie Pack Rules Verify', 'React ✅ to accept the rules and become a Pack Member', '#7179CA', 'standard', 'reaction')`,
        [GUILD_ID, RULES_CH, RULES_MSG]
    );
    rulesPanelId = ins.insertId;
    ok('reaction_role_panels inserted', `id=${rulesPanelId}`);
}

const [existingMap] = await pool.execute(
    'SELECT id FROM reaction_role_mappings WHERE panel_id=? AND role_id=?',
    [rulesPanelId, VERIFIED_ROLE]
);
if (!existingMap.length) {
    await pool.execute(
        `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
         VALUES (?, '✅', 'I Agree', 'success', ?, NULL)`,
        [rulesPanelId, VERIFIED_ROLE]
    );
    ok('reaction_role_mappings inserted', `panel=${rulesPanelId} → ${VERIFIED_ROLE_NAME}`);
} else {
    info('reaction_role_mappings exists', `panel=${rulesPanelId} → ${VERIFIED_ROLE_NAME}`);
}

// verify_config
await pool.execute(`
    INSERT INTO verify_config (guild_id, verified_role_id, gate_channel_id, gate_message_id, enabled, unverified_kick_days)
    VALUES (?, ?, ?, ?, 1, 0)
    ON DUPLICATE KEY UPDATE verified_role_id=VALUES(verified_role_id), gate_channel_id=VALUES(gate_channel_id),
        gate_message_id=VALUES(gate_message_id), enabled=1`,
    [GUILD_ID, VERIFIED_ROLE, RULES_CH, RULES_MSG]
);
ok('verify_config', `gate=${RULES_CH} msg=${RULES_MSG}`);
console.log('');

// ─────────── [7] DB config writes ──────────────────────────────────────
console.log('[7] Writing DB config rows…');

// welcome_settings — overwrite with themed message
const WELCOME_MSG = `🐺 Welcome to the **Wolfie Pack**, {user}!\n\nHead to <#${RULES_CH}> and react ✅ on the rules to unlock the rest of the server. We stand together as a pack — glad to have you with us.`;
await pool.execute(`
    INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, welcome_banner_enabled, card_title_text, card_subtitle_text)
    VALUES (?, ?, ?, 1, 1, ?, ?)
    ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), message=VALUES(message), banner_enabled=1, welcome_banner_enabled=1,
        card_title_text=VALUES(card_title_text), card_subtitle_text=VALUES(card_subtitle_text)`,
    [GUILD_ID, WELCOME_CH, WELCOME_MSG, '🐺 Welcome to the Wolfie Pack, {user}!', 'Member #{memberCount} • {server}']
);
ok('welcome_settings', WELCOME_CH);

// level_config — preserve existing xp_per_message (20) + cooldown (60)
await pool.execute(`
    INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, xp_per_voice_minute, voice_xp_enabled, level_up_message, level_up_channel_id)
    VALUES (?, 1, 20, 60, 5, 1, '🐺 {user} just leveled up to **Level {level}**! Howl with the pack!', ?)
    ON DUPLICATE KEY UPDATE enabled=1, voice_xp_enabled=1, level_up_message=VALUES(level_up_message), level_up_channel_id=VALUES(level_up_channel_id)`,
    [GUILD_ID, generalCh?.id || WELCOME_CH]
);
ok('level_config', `level-ups → ${generalCh?.id ? '#general-chat' : '#welcome'}`);

// level_role_rewards — DELETE + INSERT (no UNIQUE on guild_id,level)
await pool.execute('DELETE FROM level_role_rewards WHERE guild_id = ?', [GUILD_ID]);
const levelRewards = [
    [5,  verifiedRole.id],                        // tier 1
    // Higher tiers can be added later via dashboard; intentionally minimal so we don't auto-create role
];
for (const [lvl, rid] of levelRewards) {
    if (rid) await pool.execute('INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?)', [GUILD_ID, lvl, rid]);
}
ok('level_role_rewards', `${levelRewards.length} tier(s)`);

// logging_config + log_event_config (32 events)
const enabledEvents = [
    'memberJoin','memberLeave','memberUpdate','messageDelete','messageUpdate','channelPinsUpdate',
    'ban','unban','memberKick','memberTimeout','automodAction','automodRuleCreate','automodRuleUpdate','automodRuleDelete','inviteCreate','inviteDelete',
    'voiceUpdate','channelCreate','channelDelete','channelUpdate','threadCreate','threadDelete','threadUpdate',
    'stageInstanceCreate','stageInstanceDelete','stageInstanceUpdate','scheduledEventCreate','scheduledEventDelete','scheduledEventUpdate',
    'roleCreate','roleDelete','roleUpdate',
];
await pool.execute(`
    INSERT INTO logging_config (guild_id, log_channel_id, enabled, enabled_events)
    VALUES (?, ?, 1, ?)
    ON DUPLICATE KEY UPDATE log_channel_id=VALUES(log_channel_id), enabled=1, enabled_events=VALUES(enabled_events)`,
    [GUILD_ID, modLogCh?.id, JSON.stringify(enabledEvents)]
);
await pool.execute('DELETE FROM log_event_config WHERE guild_id = ?', [GUILD_ID]);
const routes = [
    ['memberJoin',memberLogCh?.id,'#43B581'],['memberLeave',memberLogCh?.id,'#E67E22'],['memberUpdate',memberLogCh?.id,'#3498DB'],
    ['messageDelete',messageLogCh?.id,'#E74C3C'],['messageUpdate',messageLogCh?.id,'#F1C40F'],['channelPinsUpdate',messageLogCh?.id,'#3498DB'],
    ['ban',modLogCh?.id,'#8B0000'],['unban',modLogCh?.id,'#43B581'],['memberKick',modLogCh?.id,'#E74C3C'],['memberTimeout',modLogCh?.id,'#E67E22'],
    ['automodAction',automodLogCh?.id,'#9B59B6'],['automodRuleCreate',automodLogCh?.id,'#43B581'],['automodRuleUpdate',automodLogCh?.id,'#3498DB'],['automodRuleDelete',automodLogCh?.id,'#E74C3C'],
    ['inviteCreate',modLogCh?.id,'#3498DB'],['inviteDelete',modLogCh?.id,'#E67E22'],
    ['voiceUpdate',voiceLogCh?.id,'#9B59B6'],
    ['channelCreate',channelLogCh?.id,'#43B581'],['channelDelete',channelLogCh?.id,'#E74C3C'],['channelUpdate',channelLogCh?.id,'#3498DB'],
    ['threadCreate',channelLogCh?.id,'#43B581'],['threadDelete',channelLogCh?.id,'#E74C3C'],['threadUpdate',channelLogCh?.id,'#3498DB'],
    ['stageInstanceCreate',channelLogCh?.id,'#43B581'],['stageInstanceDelete',channelLogCh?.id,'#E74C3C'],['stageInstanceUpdate',channelLogCh?.id,'#3498DB'],
    ['scheduledEventCreate',channelLogCh?.id,'#43B581'],['scheduledEventDelete',channelLogCh?.id,'#E74C3C'],['scheduledEventUpdate',channelLogCh?.id,'#3498DB'],
    ['roleCreate',roleLogCh?.id,'#43B581'],['roleDelete',roleLogCh?.id,'#E74C3C'],['roleUpdate',roleLogCh?.id,'#3498DB'],
];
for (const [evt, ch, color] of routes) {
    if (!ch) continue;
    await pool.execute('INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id, embed_color) VALUES (?, ?, 1, ?, ?)', [GUILD_ID, evt, ch, color]);
}
ok('logging_config + log_event_config', `${routes.length} events routed`);

// moderation_config
await pool.execute(`
    INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE mod_log_channel_id=VALUES(mod_log_channel_id), muted_role_id=VALUES(muted_role_id)`,
    [GUILD_ID, modLogCh?.id, mutedRole?.id]
);
ok('moderation_config', `mod_log=${modLogCh?.id}  muted=${mutedRole?.id}`);

// Apply Muted role channel-level denies (SEND/REACT/SPEAK)
if (mutedRole?.id) {
    const MUTE_DENY = String(SEND_MESSAGES | ADD_REACTIONS | SPEAK | (1n<<35n) | (1n<<36n));
    let mutedApplied = 0;
    for (const c of channels) {
        if (![0, 2, 5, 13, 15].includes(c.type)) continue;
        const r = await api('PUT', `/channels/${c.id}/permissions/${mutedRole.id}`, { type: 0, allow: '0', deny: MUTE_DENY });
        if (!r?.__err) mutedApplied++;
    }
    ok('Muted role overrides', `applied to ${mutedApplied} channels`);
}

// ticket_panels — single "Wolfie Pack Support" panel in #ticket-panel
if (ticketPanelCh?.id && ticketsCat?.id) {
    const ticketEmbed = {
        type: 'rich',
        title: '🎫 Wolfie Pack Support',
        description: [
            `Need help with something? Click **Create Ticket** below and a private channel will be opened just for you and the **Pack Managers**.`,
            ``,
            `Use this for:`,
            `• Server / role / channel issues`,
            `• Reporting another member`,
            `• Stream-tech questions`,
            `• Anything you'd rather discuss in private`,
        ].join('\n'),
        color: 0x7179CA,
    };
    const ticketBtn = { type: 1, components: [{ type: 2, style: 1, label: 'Create Ticket', emoji: { name: '🎫' }, custom_id: 'ticket_create' }] };

    const [exPanel] = await pool.execute('SELECT panel_id, panel_message_id FROM ticket_panels WHERE guild_id=? AND panel_channel_id=?', [GUILD_ID, ticketPanelCh.id]);
    let panelMsgId;
    if (exPanel.length && exPanel[0].panel_message_id) {
        panelMsgId = exPanel[0].panel_message_id;
        const upd = await api('PATCH', `/channels/${ticketPanelCh.id}/messages/${panelMsgId}`, { embeds: [ticketEmbed], components: [ticketBtn] });
        if (upd?.__err) {
            // Message likely deleted — post fresh
            const fresh = await api('POST', `/channels/${ticketPanelCh.id}/messages`, { embeds: [ticketEmbed], components: [ticketBtn] });
            if (!fresh?.__err) panelMsgId = fresh.id;
        }
    } else {
        const msg = await api('POST', `/channels/${ticketPanelCh.id}/messages`, { embeds: [ticketEmbed], components: [ticketBtn] });
        if (!msg?.__err) panelMsgId = msg.id;
    }
    if (panelMsgId) {
        await pool.execute(`
            INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, panel_message_id, embed_title, embed_description, embed_color, button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
            VALUES (?, 'Wolfie Pack Support', ?, ?, ?, ?, '#7179CA', 'Create Ticket', '🎫', ?, ?, 'ticket-{username}', 1, ?, ?, 1)
            ON DUPLICATE KEY UPDATE panel_message_id=VALUES(panel_message_id), embed_title=VALUES(embed_title), embed_description=VALUES(embed_description), embed_color=VALUES(embed_color),
                ticket_category_id=VALUES(ticket_category_id), support_role_id=VALUES(support_role_id), log_channel_id=VALUES(log_channel_id), alert_channel_id=VALUES(alert_channel_id), is_active=1`,
            [GUILD_ID, ticketPanelCh.id, panelMsgId, ticketEmbed.title, ticketEmbed.description, ticketsCat.id, staffRole.id, ticketLogCh?.id, modChatCh?.id || modLogCh?.id]
        );
        ok('ticket_panels', `panel_msg=${panelMsgId}`);
    } else {
        err('ticket panel message could not be created');
    }
}

// self_promo_config — DISABLED but configured (Lair-tiered model)
await pool.execute(`
    INSERT INTO self_promo_config (guild_id, enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked, announcement_channel_id, same_channel)
    VALUES (?, 0, ?, ?, 0, 0, 1, 0, ?, 0)
    ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), allowed_platforms=VALUES(allowed_platforms), announcement_channel_id=VALUES(announcement_channel_id)`,
    [GUILD_ID, selfPromoCh?.id, JSON.stringify(['twitch','kick','youtube','tiktok','trovo','facebook']), wolfieLiveCh?.id]
);
ok('self_promo_config', 'DISABLED (Lair-tiered — dashboard toggle available later)');

// stream_signup_config — Lair-tiered, level gate 3
if (streamSignupCh?.id && wolfieLiveCh?.id) {
    await pool.execute(`
        INSERT INTO stream_signup_config (guild_id, stream_signup_channel_id, stream_announcement_channel_id, level_gate)
        VALUES (?, ?, ?, 3)
        ON DUPLICATE KEY UPDATE stream_signup_channel_id=VALUES(stream_signup_channel_id), stream_announcement_channel_id=VALUES(stream_announcement_channel_id), level_gate=3`,
        [GUILD_ID, streamSignupCh.id, wolfieLiveCh.id]
    );
    ok('stream_signup_config', `signup=${streamSignupCh.id} → announce=${wolfieLiveCh.id} (gate=3)`);
} else {
    warn(`stream_signup_config skipped — signup=${streamSignupCh?.id} live=${wolfieLiveCh?.id}`);
}

// guild_streamer_auto_track — @Streamers role auto-tracks on stream
if (streamersRole?.id && wolfieLiveCh?.id) {
    const [exTrack] = await pool.execute('SELECT auto_id FROM guild_streamer_auto_track WHERE guild_id=? AND role_id=?', [GUILD_ID, streamersRole.id]);
    if (exTrack.length) {
        await pool.execute(`UPDATE guild_streamer_auto_track SET announcement_channel_id=?, enabled=1 WHERE auto_id=?`, [wolfieLiveCh.id, exTrack[0].auto_id]);
        info('guild_streamer_auto_track updated', `auto_id=${exTrack[0].auto_id}`);
    } else {
        await pool.execute(`INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, enabled, delete_on_end, edit_on_end) VALUES (?, ?, ?, 1, 1, 0)`, [GUILD_ID, streamersRole.id, wolfieLiveCh.id]);
        ok('guild_streamer_auto_track inserted', `role=@Streamers → announce=${wolfieLiveCh.id}`);
    }
}

// Protection stack — alerts → #mod-log
const alertCh = modLogCh?.id;
await pool.execute(`INSERT INTO anti_nuke_config (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id) VALUES (?, 1, 3, 3, 5, 'strip_roles', ?) ON DUPLICATE KEY UPDATE enabled=1, max_channel_deletes=VALUES(max_channel_deletes), max_role_deletes=VALUES(max_role_deletes), max_kick_bans=VALUES(max_kick_bans), action_on_trigger=VALUES(action_on_trigger), alert_channel_id=VALUES(alert_channel_id)`, [GUILD_ID, alertCh]);
await pool.execute(`INSERT INTO raid_detection_config (guild_id, enabled, join_threshold, join_timeframe_seconds, new_account_age_hours, new_account_ratio, action, alert_channel_id, mute_duration_minutes, purge_messages) VALUES (?, 1, 10, 30, 24, 0.50, 'mute', ?, 60, 1) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD_ID, alertCh]);
await pool.execute(`INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id) VALUES (?, 1, 5, 2, 3.00, 1.50, 2.00, 'delete+warn', ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD_ID, alertCh]);
await pool.execute(`INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id) VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD_ID, alertCh]);
await pool.execute(`INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, log_detections, report_channel_id) VALUES (?, 1, 'delete', 60, ?, 1, ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id), report_channel_id=VALUES(report_channel_id)`, [GUILD_ID, alertCh, alertCh]);
await pool.execute(`INSERT INTO invite_filter_config (guild_id, enabled, use_whitelist, action, log_channel_id) VALUES (?, 1, 0, 'delete_warn', ?) ON DUPLICATE KEY UPDATE enabled=1, log_channel_id=VALUES(log_channel_id)`, [GUILD_ID, alertCh]);
await pool.execute(`INSERT INTO global_ban_config (guild_id, enabled, action_critical, action_high, action_medium, action_low, alert_channel_id, log_actions, check_on_join, check_on_message, auto_aggregate_opt_in) VALUES (?, 1, 'ban', 'ban', 'kick', 'alert', ?, 1, 1, 0, 1) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id), check_on_join=1`, [GUILD_ID, alertCh]);
ok('protection stack', 'anti_nuke + raid + adaptive_spam + selfbot + phishing + invite_filter + global_ban');

// auto_publisher_config — auto-publish announcement channels
await pool.execute(`INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, 1) ON DUPLICATE KEY UPDATE is_enabled=1`, [GUILD_ID]);
ok('auto_publisher_config', 'enabled (announcement channels auto-publish)');

console.log('');

// ─────────── [8] Summary ───────────────────────────────────────────────
console.log('═════════════════════════════════════════════════════════════════');
console.log(' SETUP COMPLETE');
console.log('═════════════════════════════════════════════════════════════════');
console.log(`Verify gate:        @${VERIFIED_ROLE_NAME} (${VERIFIED_ROLE}) — gate msg ${RULES_MSG} in #rules`);
console.log(`Backfill:           granted=${granted}, alreadyHad=${alreadyHad}, failed=${failed} (of ${humans.length} humans)`);
console.log(`Roles created:      Streamers, Muted, Stream Pings, Event Pings (where missing)`);
console.log(`Channels created:   LOGS category + 7 log channels, TICKETS category + ticket-panel/ticket-log, #stream-signup`);
console.log(`Channel perms:      ${stats.byClass.public} public / ${stats.byClass.verified} verified / ${stats.byClass.staff} staff / ${stats.byClass.streamer} streamer / ${stats.byClass.private} private`);
console.log(`Streaming model:    Lair-tiered (level gate 3, opt-in @Streamers); self_promo DISABLED`);
console.log(`Logging:            ${routes.length} events routed across 7 log channels (master → #mod-log)`);
console.log(`Tickets:            Wolfie Pack Support panel in #ticket-panel`);
console.log(`Protection:         anti_nuke + raid + adaptive_spam + selfbot + phishing + invite + global_ban → #mod-log`);
console.log('');
console.log('⚠ WARNINGS to surface to the owner:');
console.log('  • "new role" (ADMINISTRATOR, position above bot) — owner should audit/remove if unused');
console.log('  • Two hardcoded user permission overwrites preserved on staff category');
console.log('  • Channel-permission hardening is destructive in the sense that any pre-existing');
console.log('    @everyone allow-VIEW on non-public channels has been stripped. Pack Members get');
console.log('    access via the @Verified (PACK MEMBERS) role.');
console.log('');
console.log('Next steps:');
console.log(`  1. node scripts/deploy-commands-to-bot.js ${BOT_ID}`);
console.log('  2. pm2 restart CertiFriedUtility (so the bot picks up the new configs)');
console.log('  3. Smoke-test in Discord (see plan verification section)');
console.log('');

await pool.end();
