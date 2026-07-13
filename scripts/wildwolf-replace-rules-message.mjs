// Follow-up to wildwolf-setup.mjs: replace the user-authored rules message
// (1506860660980449320) with a bot-owned message so we control it going forward.
//
// Steps:
//   1. Post new bot-owned rules embed in #rules
//   2. Add ✅ reaction to it
//   3. Delete the old user-authored message
//   4. Update reaction_role_panels + verify_config to point at the new message_id
//
// Idempotent: if a bot-owned rules message already exists with matching title,
// the script reuses it instead of posting a new one.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';
const RULES_CH = '1506860523474649239';
const OLD_RULES_MSG = '1506860660980449320';
const VERIFIED_ROLE = '1455255019627479071';

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

const [botRows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
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

console.log('=== WildWolf: replace rules message ===\n');

// Look for an existing bot-owned rules message in the channel
console.log('[1] Scanning #rules for an existing bot-owned rules message…');
const recent = await api('GET', `/channels/${RULES_CH}/messages?limit=50`);
if (recent?.__err) { console.error('failed to fetch recent messages:', recent.__err); process.exit(1); }

let botRulesMsg = recent.find(m => m.author?.id === BOT_ID && m.embeds?.[0]?.title === RULES_EMBED.title);
let newMsgId;

if (botRulesMsg) {
    console.log(`    ↻ found existing bot-owned rules message ${botRulesMsg.id} — patching content`);
    const patch = await api('PATCH', `/channels/${RULES_CH}/messages/${botRulesMsg.id}`, { content: '', embeds: [RULES_EMBED] });
    if (patch?.__err) { console.error('patch failed:', patch.__err); process.exit(1); }
    newMsgId = botRulesMsg.id;
} else {
    console.log('    ✱ no bot-owned rules message found — posting new one');
    const post = await api('POST', `/channels/${RULES_CH}/messages`, { embeds: [RULES_EMBED] });
    if (post?.__err) { console.error('post failed:', post.__err); process.exit(1); }
    newMsgId = post.id;
    console.log(`    ✓ posted new rules message ${newMsgId}`);
}

// Add ✅ reaction
console.log('[2] Adding ✅ reaction…');
const react = await api('PUT', `/channels/${RULES_CH}/messages/${newMsgId}/reactions/%E2%9C%85/@me`);
if (react?.__err) console.log(`    ✗ ${react.__err.status} ${react.__err.body}`);
else console.log('    ✓ ✅ added');

// Delete old user-authored message
console.log('[3] Deleting old user-authored rules message…');
const oldCheck = await api('GET', `/channels/${RULES_CH}/messages/${OLD_RULES_MSG}`);
if (oldCheck?.__err && oldCheck.__err.status === 404) {
    console.log(`    ✓ old message ${OLD_RULES_MSG} already gone`);
} else if (oldCheck?.__err) {
    console.log(`    ⚠ couldn't fetch old message: ${oldCheck.__err.status} ${oldCheck.__err.body}`);
} else {
    const del = await api('DELETE', `/channels/${RULES_CH}/messages/${OLD_RULES_MSG}`);
    if (del?.__err) console.log(`    ✗ delete failed: ${del.__err.status} ${del.__err.body}`);
    else console.log(`    ✓ deleted ${OLD_RULES_MSG}`);
}

// Update DB rows to point at new message_id
console.log('[4] Updating reaction_role_panels + verify_config…');

const [oldPanel] = await pool.execute(
    'SELECT id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND message_id=?',
    [GUILD_ID, RULES_CH, OLD_RULES_MSG]
);
if (oldPanel.length) {
    await pool.execute(
        'UPDATE reaction_role_panels SET message_id=? WHERE id=?',
        [newMsgId, oldPanel[0].id]
    );
    console.log(`    ✓ reaction_role_panels id=${oldPanel[0].id} message_id → ${newMsgId}`);
} else {
    // Maybe a previous run of this script already updated it — check for current
    const [curPanel] = await pool.execute(
        'SELECT id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND message_id=?',
        [GUILD_ID, RULES_CH, newMsgId]
    );
    if (curPanel.length) {
        console.log(`    ✓ reaction_role_panels id=${curPanel[0].id} already points at ${newMsgId}`);
    } else {
        // Insert fresh
        const [ins] = await pool.execute(
            `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
             VALUES (?, ?, ?, 'Wolfie Pack Rules Verify', 'React ✅ to accept the rules and become a Pack Member', '#7179CA', 'standard', 'reaction')`,
            [GUILD_ID, RULES_CH, newMsgId]
        );
        const [mapIns] = await pool.execute(
            `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
             VALUES (?, '✅', 'I Agree', 'success', ?, NULL)`,
            [ins.insertId, VERIFIED_ROLE]
        );
        console.log(`    ✓ inserted reaction_role_panels id=${ins.insertId} + mapping id=${mapIns.insertId}`);
    }
}

await pool.execute(
    'UPDATE verify_config SET gate_message_id=? WHERE guild_id=?',
    [newMsgId, GUILD_ID]
);
console.log(`    ✓ verify_config.gate_message_id → ${newMsgId}`);

console.log(`\nDONE — new rules message: ${newMsgId}`);
await pool.end();
