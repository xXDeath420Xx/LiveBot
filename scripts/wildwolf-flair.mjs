// Cosmetic flair pass over WildWolf channels + categories.
// Rename to add emoji prefixes + consistent decoration, update missing topics.
// Channel IDs stay the same — all DB-side references continue to work.
// Idempotent: re-running is a no-op for already-renamed entries.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';

const [botRows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const TOKEN = encryption.decrypt(JSON.parse(botRows[0].bot_token));

async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 250));
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

console.log('═══════════════════════════════════════════════════════════');
console.log(' WildWolf — channel + category flair');
console.log('═══════════════════════════════════════════════════════════\n');

const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);

// Category renames — keep recognizable names; add emoji + middle-dot decoration
const CATEGORY_RENAMES = {
    'START HERE':                  '📜 ・ START HERE',
    '📜 START HERE':                '📜 ・ START HERE',
    'Pack Hangout':                '🐺 ・ PACK HANGOUT',
    'PACK HANGOUT':                '🐺 ・ PACK HANGOUT',
    'WOLFIES DEN':                 '🌙 ・ WOLFIE\'S DEN',
    "WOLFIE'S DEN":                '🌙 ・ WOLFIE\'S DEN',
    'TICKETS':                     '🎫 ・ TICKETS',
    '🎫 TICKETS':                   '🎫 ・ TICKETS',
    'Voice Channels':              '🎙️ ・ VOICE CHANNELS',
    'VOICE CHANNELS':              '🎙️ ・ VOICE CHANNELS',
    'LETS GET DOWN TO BUSINESS':   '🛡️ ・ LETS GET DOWN TO BUSINESS',
    'LOGS':                        '📋 ・ LOGS',
    '📋 LOGS':                      '📋 ・ LOGS',
};

// Channel renames — { exact existing name: new name }
// Names that already start with an emoji (e.g., "Setup and Chill 😆") get nudged
// to a consistent format. Voice channels use a space separator (Discord allows
// mixed case + spaces in voice names); text channels use ・ for the kebab-style.
const CHANNEL_RENAMES = {
    // START HERE
    'rules':                              '📜・rules',
    'welcome':                            '👋・welcome',
    'introduce-yourself':                 '🐾・introduce-yourself',
    'self-roles':                         '🎭・self-roles',
    // PACK HANGOUT
    'general-chat':                       '💬・general-chat',
    'clips-and-highlights':               '🎬・clips-and-highlights',
    'self-promo':                         '📢・self-promo',
    'gallery':                            '🖼️・gallery',
    'wolf-pack-discussions':              '🌲・wolf-pack-discussions',
    'wolf-pack-disussions':               '🌲・wolf-pack-discussions',  // fix existing typo
    'levels':                             '🏆・levels',
    'birthdays':                          '🎂・birthdays',
    'music':                              '🎵・music',
    // WOLFIE'S DEN
    'wolfie-is-live':                     '🔴・wolfie-is-live',
    'plan-for-the-week':                  '📅・plan-for-the-week',
    'collaboration-dates-and-updates':    '🤝・collaboration-dates',
    'ideas-for-stream':                   '💡・ideas-for-stream',
    'links':                              '🔗・links',
    'stream-signup':                      '📡・stream-signup',
    // TICKETS
    'ticket-panel':                       '🎫・ticket-panel',
    'ticket-log':                         '📂・ticket-log',
    // VOICE CHANNELS (voice names can keep spaces + caps)
    'Lobby':                              '🏠 Lobby',
    'Gaming':                             '🎮 Gaming',
    'Chilli area':                        '🌿 Chilli area',
    'Private Gaming':                     '🔒 Private Gaming',
    '1 to 1':                             '👥 1 to 1',
    // STAFF
    'mod-chat':                           '🛡️・mod-chat',
    'bot-setup':                          '🤖・bot-setup',
    'Mod Call':                           '🛡️ Mod Call',
    // LOGS
    'member-log':                         '👥・member-log',
    'message-log':                        '✉️・message-log',
    'mod-log':                            '⚖️・mod-log',
    'voice-log':                          '🎙️・voice-log',
    'channel-log':                        '📁・channel-log',
    'role-log':                           '🔖・role-log',
    'automod-log':                        '🛑・automod-log',
};

// Topics to set where channel has none or a generic one
const TOPIC_DEFAULTS = {
    'rules':                              '📜 Server rules. Click **I Agree** to unlock the rest of the Pack.',
    'welcome':                            '👋 Every new Pack member lands here first. Give them a howl.',
    'introduce-yourself':                 '🐾 Tell the Pack who you are. Name, vibes, what you stream, anything.',
    'general-chat':                       '💬 The main den — hang out, chat about anything, keep it respectful.',
    'clips-and-highlights':               '🎬 Drop your favorite clips, stream highlights, and meme-worthy moments.',
    'self-promo':                         '📢 Curated self-promo. Be tasteful — no rapid-fire link drops.',
    'gallery':                            '🖼️ Art, screenshots, photos, pet pics, anything visual.',
    'wolf-pack-discussions':              '🌲 Long-form discussion threads on whatever you want to dig into.',
    'levels':                             '🏆 XP, rank, level rewards, leaderboard. /rank /leaderboard',
    'birthdays':                          '🎂 Birthday announcements and wishes. Set yours with /birthday-set.',
    'music':                              '🎵 Music playback panel. Add songs via the dropdown.',
    'plan-for-the-week':                  '📅 Wolfie\'s weekly stream plan + collab calendar.',
    'collaboration-dates-and-updates':    '🤝 Collab dates, coordination, partner-stream updates.',
    'ideas-for-stream':                   '💡 Pitch ideas for upcoming streams, games to play, etc.',
    'links':                              '🔗 Useful Pack links — socials, tools, shared resources.',
    'mod-chat':                           '🛡️ Pack Managers internal channel — coordination + planning.',
    'bot-setup':                          '🤖 Bot configuration + logs only Pack Managers care about.',
};

// ─── [1] Category renames ───
console.log('[1] Renaming categories…');
let catRenamed = 0, catSkipped = 0;
for (const c of channels.filter(c => c.type === 4)) {
    const newName = CATEGORY_RENAMES[c.name];
    if (!newName) { console.log(`    = ${c.name} (no rename)`); continue; }
    if (newName === c.name) { catSkipped++; console.log(`    = ${c.name} (already styled)`); continue; }
    const r = await api('PATCH', `/channels/${c.id}`, { name: newName });
    if (r?.__err) console.log(`    ✗ ${c.name} → ${newName}: ${r.__err.body.slice(0,150)}`);
    else { catRenamed++; console.log(`    ✓ ${c.name}  →  ${newName}`); }
}
console.log(`    renamed=${catRenamed}  skipped=${catSkipped}`);
console.log('');

// ─── [2] Channel renames ───
console.log('[2] Renaming channels…');
let chRenamed = 0, chSkipped = 0;
for (const c of channels.filter(c => c.type !== 4)) {
    const newName = CHANNEL_RENAMES[c.name];
    if (!newName) { continue; }
    if (newName === c.name) { chSkipped++; continue; }
    const r = await api('PATCH', `/channels/${c.id}`, { name: newName });
    if (r?.__err) console.log(`    ✗ #${c.name} → ${newName}: ${r.__err.body.slice(0,150)}`);
    else { chRenamed++; console.log(`    ✓ #${c.name}  →  ${newName}`); }
}
console.log(`    renamed=${chRenamed}  skipped=${chSkipped}`);
console.log('');

// ─── [3] Topic fills ───
console.log('[3] Setting missing/generic topics…');
let topicSet = 0;
for (const c of channels.filter(c => c.type === 0)) {
    const base = c.name.replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9-]/gi, '');
    const desired = TOPIC_DEFAULTS[base] || TOPIC_DEFAULTS[c.name];
    if (!desired) continue;
    if (c.topic && c.topic.trim() === desired.trim()) continue;
    if (c.topic && c.topic.length > 10 && !c.topic.startsWith('Customizable')) {
        // existing topic looks meaningful — skip
        continue;
    }
    const r = await api('PATCH', `/channels/${c.id}`, { topic: desired });
    if (r?.__err) console.log(`    ✗ topic #${c.name}: ${r.__err.body.slice(0,150)}`);
    else { topicSet++; console.log(`    ✓ topic #${c.name}`); }
}
console.log(`    topics set=${topicSet}`);
console.log('');

// ─── [4] Verify ───
console.log('[4] Final layout…');
const after = await api('GET', `/guilds/${GUILD_ID}/channels`);
const cats = after.filter(c => c.type === 4).sort((a,b)=>a.position-b.position);
for (const cat of cats) {
    console.log(`\n  ${cat.name}`);
    const kids = after.filter(c => c.parent_id === cat.id).sort((a,b)=>a.position-b.position);
    for (const k of kids) {
        const typeIcon = k.type === 2 ? '🔊' : k.type === 5 ? '📢' : k.type === 15 ? '📋' : k.type === 13 ? '🎤' : '  ';
        console.log(`    ${typeIcon} ${k.name}`);
    }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' FLAIR PASS COMPLETE');
console.log('═══════════════════════════════════════════════════════════');

await pool.end();
