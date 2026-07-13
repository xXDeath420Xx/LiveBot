// Kitsune-style channel-permission lockdown for guild 1428091358522114090
// (Wolves of shadows). Modelled on scripts/kitsune-lockdown.mjs.
//
// End state:
//   - Only #ᴡᴇʟᴄᴏᴍᴇ-👋 and #rules are visible to @everyone (welcome flow needs both).
//   - All other channels require @Verified at minimum.
//   - Staff-tier channels (mod-*, ticket-*, server-logs, *log, Admins) are limited
//     to staff roles + bot.
//   - `Darks and queen stuff` category and children stay member-private.
//
// REST-only via DarkWolf's bot token. Safe to run while PM2 is live.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1428091358522114090';
const BOT_ID   = '1506374126594691092';

// Channels that stay @everyone-visible (welcome + verify gate)
const PUBLIC_CHANNELS = new Set([
    '1428141508804087829',  // ᴡᴇʟᴄᴏᴍᴇ-👋
    '1506378068099338392',  // rules  (has verify button)
]);

// Verified role (the gate)
const VERIFIED_ROLE = '1506378052286812200';

// Role names to exclude from auto-staff classification even though their
// permission bits would otherwise trip STAFF_BITS. `BOTS` is a tagging role
// for bot users — it has Manage Messages so DarkWolf can prune, but it isn't
// staff-tier and shouldn't grant per-channel staff-only allows.
const STAFF_NAME_BLOCKLIST = /^bots?$/i;

const VIEW_CHANNEL          = 1n << 10n;
const READ_MESSAGE_HISTORY  = 1n << 16n;
const CREATE_INSTANT_INVITE = 1n << 0n;
const SEND_MESSAGES         = 1n << 11n;
const EMBED_LINKS           = 1n << 14n;
const ATTACH_FILES          = 1n << 15n;
const ADD_REACTIONS         = 1n << 6n;
const USE_EXTERNAL_EMOJIS   = 1n << 18n;
const MANAGE_MESSAGES       = 1n << 13n;
const CONNECT               = 1n << 20n;
const SPEAK                 = 1n << 21n;
const USE_VAD               = 1n << 25n;
const MENTION_EVERYONE      = 1n << 17n;
const CREATE_GUILD_EXPRESSIONS = 1n << 43n;
const CREATE_EVENTS         = 1n << 44n;

// Bits stripped from @everyone at the guild level. Combines view/invite/history
// (so unverified members can't see channels or invite) with the settings-UI
// surfaces (CREATE_GUILD_EXPRESSIONS surfaces emoji/sticker/soundboard upload
// tabs; CREATE_EVENTS surfaces the events scheduling UI) and MENTION_EVERYONE
// (security — no member should be able to ping the whole guild).
const EVERYONE_STRIP_MASK =
    VIEW_CHANNEL | READ_MESSAGE_HISTORY | CREATE_INSTANT_INVITE
    | MENTION_EVERYONE | CREATE_GUILD_EXPRESSIONS | CREATE_EVENTS;

const PERM_ADMINISTRATOR    = 1n << 3n;
const PERM_KICK             = 1n << 1n;
const PERM_BAN              = 1n << 2n;
const PERM_MANAGE_CHANNELS  = 1n << 4n;
const PERM_MANAGE_GUILD     = 1n << 5n;
const PERM_MANAGE_ROLES     = 1n << 28n;
const PERM_MODERATE         = 1n << 40n;
const STAFF_BITS = PERM_ADMINISTRATOR | PERM_KICK | PERM_BAN | PERM_MANAGE_CHANNELS | PERM_MANAGE_GUILD | PERM_MANAGE_ROLES | MANAGE_MESSAGES | PERM_MODERATE;

const VIEW_PAIR        = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const VOICE_VIEW       = VIEW_PAIR | CONNECT | SPEAK | USE_VAD;
const STAFF_TEXT_ALLOW = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | MANAGE_MESSAGES;
const STAFF_VOICE_ALLOW = STAFF_TEXT_ALLOW | CONNECT | SPEAK | USE_VAD;

// Staff-name regex (NFKD-normalized). Matches log/mod/ticket/staff names.
const STAFF_NAME_RE = /(founders?|^lead[-_]?|admin|moderator|^mod[-_]|^mod$|staff|tickets?|^logs?$|mod-log|mod-chat|audit|^owner|report|backstage|automod|server[- ]?log|message[- ]?log|member[- ]?log|voice[- ]?log|channel[- ]?log|role[- ]?log|^logs|^📜)/i;

const STREAMERS_ROLE = '1428139684290232392';

const CHANNEL_CLASS_OVERRIDE = {
    // Darks and queen stuff (member-private fam category + children)
    '1477038226458939522': 'private',  // Darks and queen stuff (category)
    '1477147656567390312': 'private',  // Darks Wolf Den
    '1477037797385961503': 'private',  // queen-and-darks-chanel
    // 𝐌𝐲 𝐒𝐨𝐜𝐢𝐚𝐥𝐬/𝐒𝐭𝐫𝐞𝐚𝐦 — @Streamers-gated (manually managed; the bot does
    // not auto-track here, @Streamers members post their own links manually).
    '1448802410205151513': 'streamer',  // category
    '1448802659426504704': 'streamer',  // ᴛᴡɪᴛᴄʜ
    '1448802717664546917': 'streamer',  // ʏᴏᴜᴛᴜʙᴇ
    '1448802770902581380': 'streamer',  // ᴋɪᴄᴋ
    '1448802508704059442': 'streamer',  // ɪɴꜱᴛᴀɢʀᴀᴍ
    '1448802562256928911': 'streamer',  // ᴛɪᴋᴛᴏᴋ
    '1448802609556226058': 'streamer',  // ᴛᴡɪᴛᴛᴇʀ
};

function staffName(name) {
    if (!name) return false;
    const norm = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return STAFF_NAME_RE.test(norm);
}

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

console.log('=== Wolves of shadows lockdown ===\n');

// Step 1: roles
console.log('[1] Fetching roles…');
const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
if (roles?.__err) { console.error('roles fetch failed:', roles.__err); process.exit(1); }

const verifiedRole = roles.find(r => r.id === VERIFIED_ROLE);
if (!verifiedRole) { console.error(`Verified role ${VERIFIED_ROLE} missing`); process.exit(1); }
console.log(`    ✓ @Verified → ${verifiedRole.name} (${VERIFIED_ROLE})`);

const staffRoles = roles
    .filter(r => r.id !== GUILD_ID && r.id !== VERIFIED_ROLE && !r.managed)
    .filter(r => !STAFF_NAME_BLOCKLIST.test(r.name))
    .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
    .sort((a, b) => b.position - a.position);
console.log(`[2] Discovered ${staffRoles.length} staff role(s):`);
for (const r of staffRoles) console.log(`    • ${r.name} (${r.id})`);
const STAFF_IDS = staffRoles.map(r => r.id);
console.log('');

// Step 2: harden guild-level @everyone
console.log('[3] Hardening guild-level @everyone permissions…');
const everyoneRole = roles.find(r => r.id === GUILD_ID);
const currentEv = BigInt(everyoneRole.permissions);
const targetEv  = currentEv & ~EVERYONE_STRIP_MASK;
if (currentEv !== targetEv) {
    const r = await api('PATCH', `/guilds/${GUILD_ID}/roles/${GUILD_ID}`, { permissions: String(targetEv) });
    if (r?.__err) console.log(`    ✗ @everyone strip: ${r.__err.status} ${r.__err.body.slice(0,180)}`);
    else          console.log(`    ✓ @everyone perms ${currentEv} → ${targetEv} (stripped VIEW/INVITE/READ_HIST + MENTION_EVERYONE + CREATE_GUILD_EXPRESSIONS + CREATE_EVENTS)`);
} else {
    console.log(`    ✓ @everyone already at minimum (${currentEv})`);
}

const verifiedRoleObj = roles.find(r => r.id === VERIFIED_ROLE);
const currentVer = BigInt(verifiedRoleObj.permissions);
const targetVer  = currentVer & ~CREATE_INSTANT_INVITE;
if (currentVer !== targetVer) {
    const r = await api('PATCH', `/guilds/${GUILD_ID}/roles/${VERIFIED_ROLE}`, { permissions: String(targetVer) });
    if (r?.__err) console.log(`    ✗ @Verified strip: ${r.__err.status} ${r.__err.body.slice(0,180)}`);
    else          console.log(`    ✓ @Verified perms ${currentVer} → ${targetVer}`);
} else {
    console.log(`    ✓ @Verified already lacks CREATE_INSTANT_INVITE`);
}
console.log('');

// Step 3: fetch channels + classify
console.log('[4] Fetching channels…');
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
channels.sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || a.position - b.position);

const CLASS = { PUBLIC: 'public', VERIFIED: 'verified', STAFF: 'staff', PRIVATE: 'private', STREAMER: 'streamer' };

function classify(ch, parentCategoryMap) {
    if (PUBLIC_CHANNELS.has(ch.id)) return CLASS.PUBLIC;
    if (CHANNEL_CLASS_OVERRIDE[ch.id]) return CHANNEL_CLASS_OVERRIDE[ch.id];
    if (staffName(ch.name || '')) return CLASS.STAFF;
    if (ch.parent_id && parentCategoryMap?.get(ch.parent_id) === CLASS.STAFF) return CLASS.STAFF;
    if (ch.parent_id && parentCategoryMap?.get(ch.parent_id) === CLASS.PRIVATE) {
        const ow = ch.permission_overwrites || [];
        const everyoneOw = ow.find(o => o.id === GUILD_ID);
        const everyoneDeniesView = everyoneOw && (BigInt(everyoneOw.deny || '0') & VIEW_CHANNEL) === VIEW_CHANNEL;
        const hasMemberOw = ow.some(o => o.type === 1);
        if (everyoneDeniesView && hasMemberOw) return CLASS.PRIVATE;
    }
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
        0n,
        0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n)
    );
    const v = ow.find(o => o.id === VERIFIED_ROLE);
    if (v) { setBits(v, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n); dropIfEmpty(ow, VERIFIED_ROLE); }
    for (const sid of STAFF_IDS) {
        const s = ow.find(o => o.id === sid);
        if (s) { setBits(s, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n); dropIfEmpty(ow, sid); }
    }
}

function applyVerified(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev,
        0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n
    );
    const v = getOrCreate(ow, VERIFIED_ROLE, 0);
    const wantedAllow = isVoice ? VOICE_VIEW : VIEW_PAIR;
    setBits(v, wantedAllow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
    for (const sid of STAFF_IDS) {
        const s = ow.find(o => o.id === sid);
        if (s) {
            setBits(s, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n);
            dropIfEmpty(ow, sid);
        }
    }
}

function applyStaff(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev,
        0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n
    );
    const v = getOrCreate(ow, VERIFIED_ROLE, 0);
    setBits(v,
        0n,
        VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n),
        VIEW_PAIR | (isVoice ? CONNECT : 0n),
        0n
    );
    for (const sid of STAFF_IDS) {
        const s = getOrCreate(ow, sid, 0);
        const wantedAllow = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
        setBits(s, wantedAllow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
    }
}

function applyStreamer(ow, isVoice) {
    // Streamer-class policy (updated 2026-05-20): VIEW open to @Verified,
    // POST gated to @Streamers. Verified members can browse streamer
    // channels (discover whose content lives where) but can't post — only
    // members who self-assigned the Lv-3-gated @Streamers role can drop links.
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev,
        0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n
    );
    // @Verified: VIEW + READ_HIST allowed (browse-only); POST bits explicitly denied.
    const v = getOrCreate(ow, VERIFIED_ROLE, 0);
    const verifiedPostDeny = SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | ADD_REACTIONS;
    setBits(v,
        isVoice ? VOICE_VIEW : VIEW_PAIR,
        isVoice ? 0n : verifiedPostDeny,
        isVoice ? 0n : verifiedPostDeny,
        VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n),
    );
    // @Streamers: VIEW + post bits (text) / voice bits (voice)
    const s = getOrCreate(ow, STREAMERS_ROLE, 0);
    const wantedAllow = isVoice
        ? VIEW_PAIR | CONNECT | SPEAK | USE_VAD | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS
        : VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS;
    setBits(s, wantedAllow, 0n, 0n, 0n);
    // Staff: full staff allow
    for (const sid of STAFF_IDS) {
        const sf = getOrCreate(ow, sid, 0);
        const allow = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
        setBits(sf, allow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
    }
}

function applyPrivate(ow, isVoice) {
    const ev = getOrCreate(ow, GUILD_ID, 0);
    setBits(ev,
        0n,
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
        0n
    );
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

// Step 4: apply
console.log(`[5] Applying overwrites to ${channels.length} channels (incl. categories)…\n`);
const stats = { patched: 0, unchanged: 0, errored: 0, onboardingFallback: 0, byClass: { public: 0, verified: 0, staff: 0, private: 0, streamer: 0 } };
const parentCategoryMap = new Map();
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
    if (after === before) {
        stats.unchanged++;
        console.log(`    = [${klass}] ${isCategory ? 'CAT' : '#' + ch.name} (${ch.id})`);
        continue;
    }

    let res = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });

    if (res?.__err && res.__err.body.includes('350003') && klass === CLASS.VERIFIED) {
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
console.log('\n=== Run stats ===');
console.log(`  Patched:                      ${stats.patched}`);
console.log(`  Onboarding-flagged fallback:  ${stats.onboardingFallback}`);
console.log(`  Unchanged (no diff):          ${stats.unchanged}`);
console.log(`  Errored:                      ${stats.errored}`);

// Step 5: verification
console.log('\n[6] Verification pass…');
const verifyRoles    = await api('GET', `/guilds/${GUILD_ID}/roles`);
const verifyChannels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const everyoneAfter  = verifyRoles.find(r => r.id === GUILD_ID);
const everyonePerms  = BigInt(everyoneAfter.permissions);
const viewLeak   = (everyonePerms & VIEW_CHANNEL)          === VIEW_CHANNEL;
const inviteLeak = (everyonePerms & CREATE_INSTANT_INVITE) === CREATE_INSTANT_INVITE;
console.log(`  Guild @everyone VIEW_CHANNEL:           ${viewLeak ? '❌ LEAK' : '✓ stripped'}`);
console.log(`  Guild @everyone CREATE_INSTANT_INVITE:  ${inviteLeak ? '❌ LEAK' : '✓ stripped'}`);

const verifyCatMap = new Map();
for (const c of verifyChannels) if (c.type === 4) verifyCatMap.set(c.id, classify(c, verifyCatMap));

const leaksView = [], leaksInvite = [], missingVerified = [], missingStreamerAllow = [];
for (const ch of verifyChannels) {
    if (ch.type === 4) continue;
    const klass = classify(ch, verifyCatMap);
    const ow = ch.permission_overwrites || [];
    const ev = ow.find(o => o.id === GUILD_ID);
    const v  = ow.find(o => o.id === VERIFIED_ROLE);
    const s  = ow.find(o => o.id === STREAMERS_ROLE);
    const evAllowsView   = ev && (BigInt(ev.allow || '0') & VIEW_CHANNEL)          === VIEW_CHANNEL;
    const evAllowsInvite = ev && (BigInt(ev.allow || '0') & CREATE_INSTANT_INVITE) === CREATE_INSTANT_INVITE;
    const verifiedAllow  = v  && (BigInt(v.allow  || '0') & VIEW_CHANNEL)          === VIEW_CHANNEL;
    const streamerAllow  = s  && (BigInt(s.allow  || '0') & VIEW_CHANNEL)          === VIEW_CHANNEL;
    if (evAllowsView   && !PUBLIC_CHANNELS.has(ch.id)) leaksView.push(ch);
    if (evAllowsInvite && !PUBLIC_CHANNELS.has(ch.id)) leaksInvite.push(ch);
    if (klass === CLASS.VERIFIED && !verifiedAllow) missingVerified.push(ch);
    if (klass === CLASS.STREAMER && !streamerAllow) missingStreamerAllow.push(ch);
}

console.log(`\n  @everyone allow-VIEW leaks   (≠ PUBLIC_CHANNELS): ${leaksView.length}`);
for (const c of leaksView) console.log(`    ❌ #${c.name} (${c.id})`);
console.log(`  @everyone allow-INVITE leaks (≠ PUBLIC_CHANNELS): ${leaksInvite.length}`);
for (const c of leaksInvite) console.log(`    ❌ #${c.name} (${c.id})`);
console.log(`  VERIFIED channels missing @Verified allow:        ${missingVerified.length}`);
for (const c of missingVerified) console.log(`    ❌ #${c.name} (${c.id})`);
console.log(`  STREAMER channels missing @Streamers allow:       ${missingStreamerAllow.length}`);
for (const c of missingStreamerAllow) console.log(`    ❌ #${c.name} (${c.id})`);

await pool.end();
console.log('\nDone.');
