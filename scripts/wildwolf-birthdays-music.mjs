// Birthday + Music systems for WildWolf guild 1414753158999179286.
//
// Birthdays:
//   - 🎂 Birthday role (auto-applied on user's birthday by birthday-manager job)
//   - #birthdays channel under Pack Hangout (verified-postable so members can post wishes)
//   - birthday_config row (announcement channel + role + cards enabled)
//   - Pinned signup embed with /birthday-set instructions
//
// Music:
//   - 🎵 DJ role (controls + bypass vote-skip)
//   - #music channel under Pack Hangout (verified VIEW + reaction/select interactions,
//     but SEND restricted — interact via the panel's select-menu instead of chatter)
//   - music_config row (enabled, request channel, allowed voice channels, default volume)
//   - Initial music panel message + music_panels row (panel auto-updates via player events)

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';
const VERIFIED_ROLE = '1455255019627479071'; // PACK MEMBERS

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
const CREATE_PRIVATE_THREADS= 1n << 36n;
const SEND_THREAD_MESSAGES  = 1n << 38n;
const STAFF_BITS = (1n<<1n)|(1n<<2n)|(1n<<3n)|(1n<<4n)|(1n<<5n)|(1n<<28n)|(1n<<13n)|(1n<<40n);
const STAFF_NAME_BLOCKLIST = /^(bots?|bot manager|new role)$/i;
const VIEW_PAIR = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const STAFF_TEXT_ALLOW = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | MANAGE_MESSAGES;

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

const ok = m => console.log(`    ✓ ${m}`);
const info = m => console.log(`    • ${m}`);
const err = m => console.log(`    ✗ ${m}`);

console.log('═══════════════════════════════════════════════════════════');
console.log(' WildWolf — Birthdays + Music');
console.log('═══════════════════════════════════════════════════════════\n');

const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const STAFF_IDS = roles
    .filter(r => r.id !== GUILD_ID && r.id !== VERIFIED_ROLE && !r.managed)
    .filter(r => !STAFF_NAME_BLOCKLIST.test(r.name))
    .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
    .map(r => r.id);

const packHangoutCat = channels.find(c => c.type === 4 && /pack hangout/i.test(c.name));
const voiceCat = channels.find(c => c.type === 4 && /voice channels/i.test(c.name));
info(`Pack Hangout cat=${packHangoutCat?.id}  Voice cat=${voiceCat?.id}  staff roles=${STAFF_IDS.length}`);
console.log('');

// ─── Helper: find or create role ───
async function ensureRole(name, color, opts = {}) {
    let r = roles.find(x => x.name === name);
    if (r) { info(`role exists: ${name} (${r.id})`); return r; }
    r = await api('POST', `/guilds/${GUILD_ID}/roles`, {
        name, color, permissions: '0',
        mentionable: opts.mentionable ?? false,
        hoist: opts.hoist ?? false,
    });
    if (r?.__err) { err(`create ${name}: ${r.__err.body}`); return null; }
    roles.push(r);
    ok(`created role ${name} (${r.id})`);
    return r;
}

// ═══════════════════════════════════════════════════════════════════════
// BIRTHDAYS
// ═══════════════════════════════════════════════════════════════════════
console.log('[1] Birthday role + #birthdays channel…');
const birthdayRole = await ensureRole('🎂 Birthday', 0xff69b4, { mentionable: true });

let birthdaysCh = channels.find(c => c.type === 0 && c.name === 'birthdays');
if (!birthdaysCh) {
    const verifiedAllow = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | ADD_REACTIONS | USE_EXTERNAL_EMOJIS;
    const overwrites = [
        { id: GUILD_ID,      type: 0, allow: '0',                   deny: String(VIEW_PAIR | CREATE_INSTANT_INVITE) },
        { id: VERIFIED_ROLE, type: 0, allow: String(verifiedAllow), deny: '0' },
    ];
    for (const sid of STAFF_IDS) overwrites.push({ id: sid, type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' });
    birthdaysCh = await api('POST', `/guilds/${GUILD_ID}/channels`, {
        name: 'birthdays',
        type: 0,
        parent_id: packHangoutCat?.id,
        topic: '🎂 Birthday announcements and wishes. Set yours with /birthday-set.',
        permission_overwrites: overwrites,
    });
    if (birthdaysCh?.__err) { err(`create #birthdays: ${birthdaysCh.__err.body}`); process.exit(1); }
    ok(`created #birthdays (${birthdaysCh.id})`);
} else {
    info(`#birthdays exists (${birthdaysCh.id})`);
}

await pool.execute(`
    INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, message_template, birthday_role_id, cards_enabled, default_card_type)
    VALUES (?, ?, 1, ?, ?, 1, 'classic')
    ON DUPLICATE KEY UPDATE announcement_channel_id=VALUES(announcement_channel_id), enabled=1,
        message_template=VALUES(message_template), birthday_role_id=VALUES(birthday_role_id), cards_enabled=1`,
    [GUILD_ID, birthdaysCh.id, '🎂 Happy birthday, {mention}! The whole Pack wishes you an amazing day! 🎉🐺', birthdayRole?.id]
);
ok(`birthday_config: channel=${birthdaysCh.id}  role=${birthdayRole?.id}`);

// Pinned signup embed
{
    const embed = {
        type: 'rich',
        title: '🎂 Wolfie Pack Birthdays',
        description: [
            `> Tell the Pack when your birthday is and we'll throw you a party!`,
            ``,
            `### 📅 Setting your birthday`,
            `Use \`/birthday-set\` and pick your **month + day** (no year required — it's optional).`,
            ``,
            `### 🎁 What happens on your day?`,
            `> • You get the **🎂 Birthday** role for 24 hours`,
            `> • A custom birthday card is posted in this channel`,
            `> • The Pack gets a heads-up so we can shower you with love`,
            ``,
            `### 🛠️ Useful commands`,
            `> \`/birthday-set\` — set yours`,
            `> \`/birthday-remove\` — remove it`,
            `> \`/birthday-list\` — see upcoming birthdays in the Pack`,
            ``,
            `*Your birth year (if you share it) is never displayed — only the day & month.*`,
        ].join('\n'),
        color: 0xff69b4,
    };
    const recent = await api('GET', `/channels/${birthdaysCh.id}/messages?limit=20`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === embed.title) : null;
    let msgId;
    if (existing) {
        const upd = await api('PATCH', `/channels/${birthdaysCh.id}/messages/${existing.id}`, { embeds: [embed] });
        msgId = existing.id;
        if (upd?.__err) err(`patch: ${upd.__err.body}`);
        else ok(`patched birthdays embed ${msgId}`);
    } else {
        const post = await api('POST', `/channels/${birthdaysCh.id}/messages`, { embeds: [embed] });
        if (!post?.__err) { msgId = post.id; ok(`posted birthdays embed ${msgId}`); }
        else err(`post: ${post.__err.body}`);
    }
    if (msgId) {
        const pin = await api('PUT', `/channels/${birthdaysCh.id}/pins/${msgId}`);
        if (pin?.__err && !pin.__err.body.includes('Cannot pin')) info(`pin: ${pin.__err.body.slice(0,100)}`);
        else ok('pinned');
    }
}
console.log('');

// ═══════════════════════════════════════════════════════════════════════
// MUSIC
// ═══════════════════════════════════════════════════════════════════════
console.log('[2] DJ role + #music channel…');
const djRole = await ensureRole('🎵 DJ', 0x1abc9c, { mentionable: true });

let musicCh = channels.find(c => c.type === 0 && c.name === 'music');
if (!musicCh) {
    // Music channel: Verified can VIEW + ADD_REACTIONS + interact with select menus,
    // but SEND is restricted to staff + @DJ so the channel stays panel-only.
    const verifiedAllow = VIEW_PAIR | ADD_REACTIONS | USE_EXTERNAL_EMOJIS;
    const verifiedDeny  = SEND_MESSAGES | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS | SEND_THREAD_MESSAGES;
    const overwrites = [
        { id: GUILD_ID,      type: 0, allow: '0',                   deny: String(VIEW_PAIR | CREATE_INSTANT_INVITE) },
        { id: VERIFIED_ROLE, type: 0, allow: String(verifiedAllow), deny: String(verifiedDeny) },
        { id: djRole.id,     type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' },
    ];
    for (const sid of STAFF_IDS) overwrites.push({ id: sid, type: 0, allow: String(STAFF_TEXT_ALLOW), deny: '0' });
    musicCh = await api('POST', `/guilds/${GUILD_ID}/channels`, {
        name: 'music',
        type: 0,
        parent_id: packHangoutCat?.id,
        topic: '🎵 Music playback panel. Add songs via the dropdown — DJ controls are interactive.',
        permission_overwrites: overwrites,
    });
    if (musicCh?.__err) { err(`create #music: ${musicCh.__err.body}`); process.exit(1); }
    ok(`created #music (${musicCh.id})`);
} else {
    info(`#music exists (${musicCh.id})`);
}

// Discover voice channels (allow all public ones except the obvious private ones)
const voiceChannels = channels.filter(c => (c.type === 2 || c.type === 13) && !/private|1.to.1|^1.1$|mod call|setup and chill/i.test(c.name));
const voiceIds = voiceChannels.map(c => c.id);
info(`music can play in ${voiceIds.length} voice channels: ${voiceChannels.map(c=>c.name).join(', ')}`);

// music_config insert/update
await pool.execute(`
    INSERT INTO music_config (guild_id, is_enabled, enabled, text_channel_ids, voice_channel_ids, dj_role_id, default_volume, request_channel_id, autoplay_enabled, autoplay_source, vote_skip_enabled, vote_skip_percentage)
    VALUES (?, 1, 1, ?, ?, ?, 50, ?, 0, 'youtube', 1, 50)
    ON DUPLICATE KEY UPDATE is_enabled=1, enabled=1, text_channel_ids=VALUES(text_channel_ids),
        voice_channel_ids=VALUES(voice_channel_ids), dj_role_id=VALUES(dj_role_id), request_channel_id=VALUES(request_channel_id)`,
    [GUILD_ID, JSON.stringify([musicCh.id]), JSON.stringify(voiceIds), djRole?.id, musicCh.id]
);
ok(`music_config: channel=${musicCh.id}  voice channels=${voiceIds.length}  dj=${djRole?.id}`);

// Post initial idle music panel embed (panel will be live-updated by the player on first /play)
{
    // Match the idle-state embed shape from core/music-panel.js#buildEmbed (queue empty case)
    const embed = {
        type: 'rich',
        author: { name: 'Live Music Player' },
        title: 'The queue is empty',
        description: 'Add a song using the dropdown menu below to get started.',
        color: 0x2B2D31,
        footer: { text: 'Use the controls below to manage the music.' },
    };
    // The panel components are built by the bot when it loads; we post a placeholder
    // with no components and let MusicPanel.updatePanel() repopulate them on first
    // player event. Posting bare embed avoids stale button state in the meantime.
    const recent = await api('GET', `/channels/${musicCh.id}/messages?limit=20`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && (m.embeds?.[0]?.author?.name === embed.author.name || m.embeds?.[0]?.title === embed.title)) : null;
    let msgId;
    if (existing) {
        const upd = await api('PATCH', `/channels/${musicCh.id}/messages/${existing.id}`, { embeds: [embed] });
        msgId = existing.id;
        if (upd?.__err) err(`patch: ${upd.__err.body}`);
        else ok(`patched music panel ${msgId}`);
    } else {
        const post = await api('POST', `/channels/${musicCh.id}/messages`, { embeds: [embed] });
        if (!post?.__err) { msgId = post.id; ok(`posted music panel ${msgId}`); }
        else err(`post: ${post.__err.body}`);
    }
    if (msgId) {
        await pool.execute(
            `INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), message_id=VALUES(message_id)`,
            [GUILD_ID, musicCh.id, msgId]
        );
        ok(`music_panels row written`);
    }
}

// Also post a short usage/info embed pinned above the panel so members know how to use it
{
    const embed = {
        type: 'rich',
        title: '🎵 How to use the Music Panel',
        description: [
            `> Join a voice channel, then drive the playback below — no commands needed.`,
            ``,
            `### 🎧 Quick start`,
            `\`1.\` Join one of the open voice channels (Lobby / Gaming / Chilli area)`,
            `\`2.\` Open the **Add a song** dropdown below the panel`,
            `\`3.\` Pick **Add song/playlist by name or URL** and paste a Twitch/YouTube/Spotify link or search query`,
            `\`4.\` Use the buttons to ▶️ pause, ⏭️ skip, 🔁 loop, 🔀 shuffle, 🔉/🔊 volume`,
            ``,
            `### 🛡️ DJ role`,
            `Members with the **🎵 DJ** role get full control + bypass vote-skips.`,
            `Ask a Pack Manager to grant it, or earn it through staff promotion.`,
            ``,
            `### 🤖 AI DJ`,
            `Pick **Start an AI DJ session** in the dropdown to auto-generate a playlist.`,
            ``,
            `*Slash alternatives: \`/play\`, \`/skip\`, \`/queue\`, \`/stop\` — all work too.*`,
        ].join('\n'),
        color: 0x1abc9c,
    };
    const recent = await api('GET', `/channels/${musicCh.id}/messages?limit=20`);
    const existing = Array.isArray(recent) ? recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === embed.title) : null;
    let msgId;
    if (existing) {
        const upd = await api('PATCH', `/channels/${musicCh.id}/messages/${existing.id}`, { embeds: [embed] });
        msgId = existing.id;
        if (upd?.__err) err(`patch: ${upd.__err.body}`);
        else ok(`patched music how-to ${msgId}`);
    } else {
        const post = await api('POST', `/channels/${musicCh.id}/messages`, { embeds: [embed] });
        if (!post?.__err) { msgId = post.id; ok(`posted music how-to ${msgId}`); }
        else err(`post: ${post.__err.body}`);
    }
    if (msgId) {
        const pin = await api('PUT', `/channels/${musicCh.id}/pins/${msgId}`);
        if (pin?.__err && !pin.__err.body.includes('Cannot pin')) info(`pin: ${pin.__err.body.slice(0,100)}`);
        else ok('pinned');
    }
}
console.log('');

console.log('═══════════════════════════════════════════════════════════');
console.log(' BIRTHDAYS + MUSIC COMPLETE');
console.log('═══════════════════════════════════════════════════════════');
console.log(`#birthdays:   ${birthdaysCh.id}  (🎂 Birthday role=${birthdayRole?.id})`);
console.log(`#music:       ${musicCh.id}      (🎵 DJ role=${djRole?.id}, ${voiceIds.length} voice channels)`);
console.log('');
console.log('Restart the bot if needed: pm2 restart CertiFriedUtility');

await pool.end();
