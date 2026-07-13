// Finalize Lair migration. Idempotent, handles rate limits, does each phase in order:
//   A. Position new roles into sensible hierarchy (colors > levels > Verified > opt-in > Unverified > Muted)
//   B. Prettify top-level category names (✦ ━━━ NAME ━━━ ✦)
//   C. Pre-populate mamabear_xal as a bot-tracked streamer (Twitch, if resolvable)
//   D. Lockdown: deny @everyone ViewChannel on every non-gate channel; grant Verified ViewChannel
//   E. Server-wide announcement in #sleuth-announcements
//   F. MEE6 + Birthday Bot purge (webhooks, integration, kick)
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const state = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/state.json', 'utf8'));
const recon = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/recon.json', 'utf8'));
const CH = state.channels;
const R = state.roles;
const COLOR = 0xCDC3FF;
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

async function rest(method, url, body) {
    for (let i = 0; i < 6; i++) {
        const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (r.status === 404) return null;
        if (!r.ok) { const t = await r.text(); console.log(`  ${method} ${url}: ${r.status} ${t}`); return null; }
        return r.status === 204 ? null : r.json();
    }
    return null;
}

// ═════════════════ PHASE A: role hierarchy ═════════════════
console.log('\n== A. role hierarchy ==');
const currentRoles = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/roles`);
const existingNameToPos = new Map(currentRoles.map(r => [r.name, r.position]));

// Bot Manager goes just below ModBears. Everything else goes in a contiguous block above
// the existing opt-in cluster but below the Lair's bear tiers (Founding/VIB/Honeyed/etc.).
// Target positions (new roles only):
const modbearsPos = existingNameToPos.get('ModBears') ?? 34;
const targetPositions = [
    [R['Bot Manager'],         modbearsPos - 1],
    // Color block
    [R['Purple'],              23],
    [R['Orange'],              22],
    [R['Green'],               21],
    [R['Red'],                 20],
    [R['Yellow'],              19],
    [R['Blue'],                18],
    // Level block (highest level on top)
    [R['Lair Legacy'],         17],
    [R['Lair Legend'],         16],
    [R['Lair Elder'],          15],
    [R['Lair Warrior'],        14],
    [R['Lair Hunter'],         13],
    [R['Lair Sentinel'],       12],
    [R['Shoutout Eligible'],   11],
    [R['Cubs'],                10],
    // Verified anchors the member floor
    [R['Verified'],            9],
    // Self-assignable opt-ins
    [R['Announcements'],       6],
    [R['Music'],               5],
    [R['NSFW Access'],         4],
    // Bottom
    [R['Unverified'],          3],
    [R['Muted'],               2],
];
const body = targetPositions.filter(([id]) => !!id).map(([id, pos]) => ({ id, position: pos }));
await rest('PATCH', `https://discord.com/api/v10/guilds/${GUILD}/roles`, body);
console.log(`  repositioned ${body.length} roles`);

// ═════════════════ PHASE B: category prettification ═════════════════
console.log('\n== B. category prettification ==');
const allChans = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const cats = allChans.filter(c => c.type === 4);
// Skip if already prettified
for (const cat of cats) {
    if (cat.name.startsWith('✦')) continue;
    if (cat.name.includes('ADMIN LOGS')) continue; // already formatted
    const pretty = '✦ ━━━  ' + cat.name.toUpperCase() + '  ━━━ ✦';
    await rest('PATCH', `https://discord.com/api/v10/channels/${cat.id}`, { name: pretty });
    console.log(`  ${cat.name} → ${pretty}`);
}

// ═════════════════ PHASE C: pre-populate mamabear_xal streamer ═════════════════
console.log('\n== C. pre-populate streamer (mamabear_xal) ==');
// Load resolver from the main codebase
const resolverMod = await import('/home/death/CertiFriedUtility/utils/platforms/resolve-identity.js');
const identity = await resolverMod.resolveStreamerIdentity('twitch', 'mamabear_xal');
if (identity) {
    const streamerId = await resolverMod.upsertStreamerByIdentity(pool, 'twitch', identity, '477972657384718336');
    console.log(`  Twitch resolved: ${identity.canonicalUsername} (id ${identity.platformUserId}) → streamer ${streamerId}`);
    const [existingSub] = await pool.execute(
        'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
        [GUILD, streamerId]
    );
    if (existingSub.length) {
        await pool.execute('UPDATE subscriptions SET announcement_channel_id = ?, paused = 0 WHERE subscription_id = ?', [CH.mamaBearLive, existingSub[0].subscription_id]);
        console.log(`  updated existing subscription → #🐻mama-bear-is-live`);
    } else {
        const [ins] = await pool.execute('INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, paused) VALUES (?, ?, ?, 0)', [GUILD, streamerId, CH.mamaBearLive]);
        console.log(`  created subscription ${ins.insertId} → #🐻mama-bear-is-live`);
    }
} else {
    console.log('  Twitch user "mamabear_xal" not resolvable; skipping');
}

// ═════════════════ PHASE D: server lockdown ═════════════════
console.log('\n== D. lockdown @everyone ==');
const VIEW = 1n << 10n, SEND = 1n << 11n;
const GATE = CH.rules;
// Gate channel: @everyone allow View, deny SendMessages+AddReactions
await rest('PUT', `https://discord.com/api/v10/channels/${GATE}/permissions/${GUILD}`, {
    type: 0, allow: String(VIEW), deny: String(SEND | (1n << 6n)),
});
// Verified also read-only in gate
await rest('PUT', `https://discord.com/api/v10/channels/${GATE}/permissions/${R['Verified']}`, {
    type: 0, allow: '0', deny: String(SEND),
});
console.log(`  gate channel locked read-only`);

// Every other text/voice/stage/announcement/forum channel: deny @everyone ViewChannel,
// allow Verified ViewChannel. DO NOT touch channels already deliberately gated (NSFW,
// #music, admin-log children) or staff-only (ModBear chat, server-activity, etc.).
const adminLogsKids = new Set(allChans.filter(c => c.parent_id === CH.adminLogsCategory).map(c => c.id));
const alreadyNsfw = new Set(recon.channels.filter(c => c.nsfw).map(c => c.id));
const alreadyMusic = new Set([CH.music]);
const STAFF_ONLY_IDS = new Set([
    '1228385140346982451',   // modbear-chat
    '1367953814694662184',   // server-activity-channel-modbears-only
    '1367984616035713065',   // mama-and-the-modbears-help
    '1222217013888417902',   // mama-bears-bulletin-board (keep Verified visible)
    CH.adminLogsCategory,
    ...adminLogsKids,
]);

// Locked category ids we want uniformly treated
let touched = 0, skipped = 0;
for (const c of allChans) {
    if (c.id === GATE) continue;
    if ([0, 2, 5, 13, 15].indexOf(c.type) === -1) continue; // text, voice, announcement, stage, forum
    if (alreadyNsfw.has(c.id) || alreadyMusic.has(c.id)) { skipped++; continue; }
    if (STAFF_ONLY_IDS.has(c.id)) { skipped++; continue; }
    await rest('PUT', `https://discord.com/api/v10/channels/${c.id}/permissions/${GUILD}`, { type: 0, allow: '0', deny: String(VIEW) });
    await rest('PUT', `https://discord.com/api/v10/channels/${c.id}/permissions/${R['Verified']}`, { type: 0, allow: String(VIEW), deny: '0' });
    touched++;
}
console.log(`  applied lockdown baseline to ${touched} channels (skipped ${skipped})`);

// Staff-only channels: ensure they're truly staff-only (deny Verified explicitly, allow ModBears + Lead + Co-Owner + Mama + BotManager)
const STAFF_ROLES = [R['Mama Bear'], R['Co-Owner/Admin'], R['Lead ModBear'], R['ModBears'], R['Bot Manager']].filter(Boolean);
const STAFF_ALLOW = String(VIEW | (1n << 16n) | SEND | (1n << 14n) | (1n << 15n) | (1n << 6n));
for (const chId of STAFF_ONLY_IDS) {
    const c = allChans.find(x => x.id === chId);
    if (!c) continue;
    // Skip categories; apply to text-like only
    if (c.type === 4) continue;
    await rest('PUT', `https://discord.com/api/v10/channels/${chId}/permissions/${GUILD}`, { type: 0, allow: '0', deny: String(VIEW) });
    await rest('PUT', `https://discord.com/api/v10/channels/${chId}/permissions/${R['Verified']}`, { type: 0, allow: '0', deny: String(VIEW) });
    for (const rid of STAFF_ROLES) {
        await rest('PUT', `https://discord.com/api/v10/channels/${chId}/permissions/${rid}`, { type: 0, allow: STAFF_ALLOW, deny: '0' });
    }
}
console.log(`  staff-only channels re-asserted for ${STAFF_ONLY_IDS.size} ids`);

// ═════════════════ PHASE E: server-wide announcement ═════════════════
console.log('\n== E. announcement ==');
const announceEmbeds = [
    { title: "🐻 Mama Bear's Lair — Major Upgrade", color: COLOR, description:
        "The Lair just got a big infrastructure refresh.\n\n" +
        "Your existing roles, channels, and history are untouched — we just added a ton of new systems underneath. Take a lap and see what's new." },
    { title: "📜 Verify once, stay forever", color: COLOR, description:
        "Head to **#welcome-and-rules-channel**, read through, and click **I accept the rules** to confirm you're in the Lair on your own terms.\n\n" +
        "• All current members have been grandfathered in — you don't need to re-verify.\n" +
        "• New joiners who don't accept within **7 days** get auto-removed to keep the list real." },
    { title: "🎭 Self-assignable roles in #roles", color: COLOR, description:
        "Head to **#roles** to toggle:\n\n" +
        "• **🎨 Colors** (6 shades — one at a time)\n" +
        "• **🐻 Follower Tier** — Lair Bear + Honeyed Lair Bear self-assign\n" +
        "• **🎮 Gaming opt-ins** — Twitch Streamer + Palia Community\n" +
        "• **🔔 Notifications** — Announcements pings, Music channel access\n" +
        "• **🔞 NSFW Access** — confirms you're of legal age to see age-restricted channels" },
    { title: "📈 Level system", color: COLOR, description:
        "Chat earns XP (1 msg per 60s). Rewards ladder:\n\n" +
        "• **L1 Cubs** • **L3 Shoutout Eligible** • **L5 Lair Sentinel** • **L10 Lair Hunter**\n" +
        "• **L15 Lair Warrior** • **L20 Lair Elder** • **L25 Lair Legend** • **L30 Lair Legacy**\n\n" +
        "**XP resets on the 1st of each month.** Drop below L3 and your auto-shoutouts pause until you earn it again." },
    { title: "🎬 Auto-Shoutouts for streamers", color: COLOR, description:
        `Reach **level 3**, then paste your stream URL in **#stream-signup**. You'll be auto-added to the rotation and announced in <#${CH.whosLiveNow}> when you go live.\n\n` +
        "**Supported:** Twitch, Kick, YouTube, TikTok, Trovo, Facebook.\n\n" +
        "Below level 3? Your post is removed + you get a DM. Non-links in that channel are also removed." },
    { title: "🎂 Birthdays imported", color: COLOR, description:
        `57 birthdays were ported over from Birthday Bot's announcement history. Run **\`/birthday set\`** if yours is missing or wrong. Announcements still land in **#bearthday-channel**.` },
    { title: "🛡️ Behind the scenes", color: COLOR, description:
        "Full protection stack is live: anti-nuke, anti-raid, adaptive spam, self-bot detection, phishing filter, Discord-invite filter, global ban network, native AutoMod. All alerts route to **#mod-log**.\n\n" +
        "**32 event types** are logged across 6 staff-only channels (member / message / mod / voice / channel / role). Hierarchy churn is intentionally suppressed — no position-shuffle spam." },
    { title: "🛠️ Support + Suggestions", color: COLOR, description:
        "Need a mod? Use **#mama-and-the-modbears-help**. Got a suggestion? Drop it in **#the-suggestion-box**." },
    { title: "🐻 One Last Thing", color: COLOR, description:
        "Bot is **CertiFried Utility** running the whole stack behind the scenes. If anything looks off — panels broken, log spam, a feature you remember not working — open a ticket and we'll sort it.\n\n" +
        "**Welcome home, Sleuth.**" },
];
const announceMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.announcements}/messages`, {
    content: '@everyone', allowed_mentions: { parse: ['everyone'] }, embeds: announceEmbeds,
});
console.log(`  announcement posted: ${announceMsg?.id}`);

// ═════════════════ PHASE F: MEE6 + Birthday Bot purge ═════════════════
console.log('\n== F. MEE6 + Birthday Bot purge ==');
const MEE6_ID = '159985870458322944';
const BIRTHDAY_BOT_ID = '656621136808902656';

// Delete all MEE6 webhooks
const webhooks = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/webhooks`);
let whDeleted = 0;
for (const w of webhooks || []) {
    const isMee6 = /mee6/i.test(w.name || '') || w.owner?.id === MEE6_ID || w.application_id === '159985415099514880';
    if (isMee6) {
        await rest('DELETE', `https://discord.com/api/v10/webhooks/${w.id}`);
        whDeleted++;
    }
}
console.log(`  deleted ${whDeleted} MEE6 webhooks`);

// Delete MEE6 integration + Birthday Bot integration
const integrations = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/integrations`);
for (const i of integrations || []) {
    if (i.name === 'MEE6' || i.name === 'Birthday Bot') {
        await rest('DELETE', `https://discord.com/api/v10/guilds/${GUILD}/integrations/${i.id}`);
        console.log(`  deleted integration: ${i.name}`);
    }
}

// Kick the bot accounts (in case integration delete didn't remove them)
for (const [name, id] of [['MEE6', MEE6_ID], ['Birthday Bot', BIRTHDAY_BOT_ID]]) {
    const r = await rest('DELETE', `https://discord.com/api/v10/guilds/${GUILD}/members/${id}`);
    if (r === null) console.log(`  kicked (or already gone): ${name}`);
}

// ═════════════════ done ═════════════════
await pool.end();
console.log('\n✦ ALL DONE ✦');
